import { useEffect, useRef, useState } from 'react';
import type { YardMap } from '../domain/model';
import type { RasterAssetBytes, RasterAssetStorePort } from '../editor/projectController';
import { IndexedDBProjectStore } from '../adapters/projectStore';
import { decodeRaster, readRasterFile, RasterFileError, type DecodedRaster } from '../adapters/rasterFiles';

export interface BackgroundAssetItem { id: string; image: HTMLImageElement | null; status: 'loading' | 'ready' | 'missing' | 'error'; error?: string }
interface Inputs { projectId: string | null; assets: YardMap['assets']; layers: YardMap['backgroundLayers']; store?: RasterAssetStorePort }

/** Asset IO has a project generation; no asynchronous response may alter a newer project's scene. */
export function useBackgroundAssets(inputs: Inputs) {
  const [defaultStore] = useState(() => new IndexedDBProjectStore());
  const store = inputs.store ?? defaultStore;
  const latest = useRef(inputs); latest.current = inputs;
  const generation = useRef(0), cache = useRef(new Map<string, { decoded: DecodedRaster; asset: RasterAssetBytes }>());
  const cacheProject = useRef<string | null>(null), alive = useRef(true);
  const [retry, setRetry] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; items: BackgroundAssetItem[] }>({ key: '', items: [] });
  // Transform, camera and vector edits don't change a byte/decode request.
  const descriptors = Object.entries(inputs.layers).map(([id, layer]) => ({ id, asset: inputs.assets[layer.assetId] }));
  const key = JSON.stringify([inputs.projectId, descriptors.map(({ id, asset }) => [id, asset?.sha256, asset?.mediaType, asset?.widthPx, asset?.heightPx])]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; ++generation.current; for (const value of cache.current.values()) value.decoded.dispose(); cache.current.clear(); };
  }, []);
  useEffect(() => {
    const token = ++generation.current, projectId = inputs.projectId;
    let active = true;
    if (cacheProject.current !== projectId) { for (const value of cache.current.values()) value.decoded.dispose(); cache.current.clear(); cacheProject.current = projectId; }
    const needed = new Set(descriptors.map(item => item.asset?.sha256));
    for (const [hash, value] of cache.current) if (!needed.has(hash)) { value.decoded.dispose(); cache.current.delete(hash); }
    const owns = () => active && alive.current && token === generation.current && latest.current.projectId === projectId;
    const requests = new Map<string, Promise<{ decoded: DecodedRaster; asset: RasterAssetBytes } | null>>();
    const items: BackgroundAssetItem[] = descriptors.map(({ id }) => ({ id, image: null, status: 'loading' }));
    setLoaded({ key, items: [...items] });
    for (const [index, descriptor] of descriptors.entries()) void (async () => {
      const { id, asset } = descriptor;
      try {
        if (!projectId || !asset) throw new RasterFileError('RASTER_MISSING_REFERENCE', '底图资源引用缺失或工程尚未恢复。');
        if (!requests.has(asset.sha256)) requests.set(asset.sha256, (async () => {
          const cached = cache.current.get(asset.sha256); if (cached) return cached;
          const bytes = await store.getAssetBytes(projectId, asset.sha256); if (!bytes || !owns()) return null;
          const decoded = await decodeRaster(bytes);
          if (!owns()) { decoded.dispose(); return null; }
          const value = { asset: bytes, decoded }; cache.current.set(asset.sha256, value); return value;
        })());
        const result = await requests.get(asset.sha256)!;
        if (!owns()) return;
        if (!result) items[index] = { id, image: null, status: 'missing', error: '未找到匹配 SHA 的本地底图；矢量地图仍可编辑，可重新关联同一文件。' };
        else if (asset.mediaType !== result.asset.mimeType || asset.widthPx !== undefined && asset.widthPx !== result.asset.width || asset.heightPx !== undefined && asset.heightPx !== result.asset.height) {
          throw new RasterFileError('RASTER_METADATA_MISMATCH', '地图声明的底图格式或尺寸与字节不一致。');
        } else items[index] = { id, image: result.decoded.image, status: 'ready' };
      } catch (error) {
        if (!owns()) return;
        items[index] = { id, image: null, status: 'error', error: error instanceof Error ? error.message : String(error) };
      }
      if (owns()) setLoaded({ key, items: [...items] });
    })();
    return () => { active = false; };
    // key is the exact immutable subset consumed by loading; avoid reload on equivalent map object clones.
  }, [key, store, retry]);

  async function persistFile(file: File, expectedProjectId: string, expectedSha256?: string): Promise<RasterAssetBytes> {
    const token = generation.current;
    const owns = () => alive.current && latest.current.projectId === expectedProjectId && token === generation.current;
    const stale = () => { throw new RasterFileError('RASTER_STALE_PROJECT', '底图读取期间工程或底图集合已改变；未提交地图修改，请在当前工程重试。'); };
    if (!expectedProjectId || !owns()) return stale();
    const asset = await readRasterFile(file);
    if (expectedSha256 !== undefined && asset.sha256 !== expectedSha256) throw new RasterFileError('RASTER_HASH_MISMATCH', '所选图片与地图声明 SHA 不同；未替换任何底图。');
    if (!owns()) return stale();
    const decoded = await decodeRaster(asset);
    try {
      if (!owns()) return stale();
      await store.putAssetBytes(expectedProjectId, asset);
      if (!owns()) return stale();
      const existing = cache.current.get(asset.sha256);
      if (existing) decoded.dispose(); else cache.current.set(asset.sha256, { asset, decoded });
      setRetry(value => value + 1);
      return asset;
    } catch (error) { decoded.dispose(); throw error; }
  }
  return { items: loaded.key === key ? loaded.items : descriptors.map(({ id }): BackgroundAssetItem => ({ id, image: null, status: 'loading' })), persistFile, reload: () => setRetry(value => value + 1) };
}
