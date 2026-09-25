import { MAX_RASTER_BYTES, rasterBytes } from '../../adapters/rasterFiles';
import { inspectBackground, type BackgroundInspection } from '../../domain/backgrounds';
import type { Asset, BackgroundLayer, Vec3, YardMap } from '../../domain/model';
import { ProjectPersistenceError, type RasterAssetBytes } from '../../editor/projectController';
import { backgroundFrame, type BackgroundTransform } from '../../geometry/backgrounds';
import { onAdopt, projects, projectStore } from './project';
import { notify, store, type AppState } from './store';

/** `levels[k]` is the image at 1/2^k resolution; level 0 is the original. */
export type Raster = { status: 'loading' } | { status: 'ready'; levels: readonly ImageBitmap[] } | { status: 'missing'; message?: string } | { status: 'error'; message: string };
export interface LayerInfo { id: string; layer: BackgroundLayer; asset: Asset | undefined; support: BackgroundInspection }
export interface BackgroundDraw { id: string; levels: readonly ImageBitmap[]; transform: BackgroundTransform; opacity: number }

/** Own origin (port 5180) and own database: the old editor's projects and images are never read or written here. */
// Images are stored with the project that uses them (by content hash, so another project's copy is found and copied);
// a map without a browser project keeps them under its map ID.
const assets = projectStore;
export const owner = (map: YardMap) => projects.state.active?.projectId ?? map.mapId;
export const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function backgroundLayers(map: YardMap): LayerInfo[] {
  return Object.entries(map.backgroundLayers).map(([id, layer]) => ({ id, layer, asset: map.assets[layer.assetId], support: inspectBackground(map, id) }));
}
/** Image hashes the canvas can draw for this map: supported layers only. */
export const wantedHashes = (map: YardMap | undefined) => new Set(map ? backgroundLayers(map).filter(info => info.support.supported).map(info => info.asset!.sha256) : []);

/** Union of the supported layers' footprints, known from the map alone. */
export function backgroundBounds(map: YardMap, ids?: readonly string[]): { min: Vec3; max: Vec3 } | null {
  const corners = backgroundLayers(map).filter(info => info.support.supported && (!ids || ids.includes(info.id)))
    .flatMap(info => backgroundFrame(info.layer.imageToWorld, info.asset!.widthPx!, info.asset!.heightPx!).corners);
  if (!corners.length) return null;
  const xs = corners.map(point => point[0]), ys = corners.map(point => point[1]);
  return { min: [Math.min(...xs), Math.min(...ys), 0], max: [Math.max(...xs), Math.max(...ys), 0] };
}

/** The images to draw. Hiding the background type in the layer table hides them all; each layer also has its own switch. */
export function drawableBackgrounds(map: YardMap, rasters: AppState['rasters'], view: AppState['backgroundView'], hiddenTypes: readonly string[] = []): BackgroundDraw[] {
  if (hiddenTypes.includes('backgroundLayers')) return [];
  return backgroundLayers(map).flatMap(info => {
    const raster = info.support.supported ? rasters[info.asset!.sha256] : undefined;
    if (raster?.status !== 'ready' || view.hidden.includes(info.id)) return [];
    return [{ id: info.id, levels: raster.levels, transform: info.layer.imageToWorld, opacity: view.opacity[info.id] ?? 1 }];
  });
}

export const release = (raster: Raster) => { if (raster.status === 'ready') raster.levels.forEach(level => level.close()); };
/** Decodes once and prepares halved copies down to about 1024 px, off the main thread. Drawing then uses the level nearest the
 *  screen resolution: without them the browser re-samples the full 4105 × 4351 Hanwha image on the first zoom step (~90 ms stall). */
export async function decode(asset: RasterAssetBytes): Promise<ImageBitmap[]> {
  // ImageBitmap stays decoded; an <img> outside the DOM may be discarded and re-decoded mid-pan.
  const levels = [await createImageBitmap(new Blob([asset.bytes], { type: asset.mimeType }))];
  try {
    if (levels[0]!.width !== asset.width || levels[0]!.height !== asset.height) throw new Error('解码尺寸与文件声明不一致。');
    for (let last = levels[0]!; Math.max(last.width, last.height) > 1024; levels.push(last)) {
      last = await createImageBitmap(last, { resizeWidth: Math.ceil(last.width / 2), resizeHeight: Math.ceil(last.height / 2), resizeQuality: 'medium' });
    }
    return levels;
  } catch (error) { levels.forEach(level => level.close()); throw error; }
}
/** Stores a result only while the open map still draws that image; late results for a closed map are released. */
export function settle(sha: string, raster: Raster): boolean {
  if (!wantedHashes(store.get().session?.map).has(sha)) { release(raster); return false; }
  store.set(({ rasters }) => {
    const previous = rasters[sha];
    if (previous && previous !== raster) release(previous);
    return { rasters: { ...rasters, [sha]: raster } };
  });
  return true;
}

/** After a map opens: release images it does not use, then load the ones this browser already stored. */
export async function loadStoredRasters(map: YardMap): Promise<void> {
  const wanted = wantedHashes(map), kept: Record<string, Raster> = {};
  for (const [sha, raster] of Object.entries(store.get().rasters)) {
    if (wanted.has(sha)) kept[sha] = raster; else release(raster);
  }
  const pending = [...wanted].filter(sha => !kept[sha] || kept[sha].status === 'missing' || kept[sha].status === 'error');
  for (const sha of pending) kept[sha] = { status: 'loading' };
  store.set({ rasters: kept });
  await Promise.all(pending.map(async sha => {
    let bytes: RasterAssetBytes | null;
    // An unavailable database only means the image has to be chosen again; stored bytes that fail their check are an error.
    try { bytes = await assets.getAssetBytes(owner(map), sha); }
    catch (error) {
      settle(sha, error instanceof ProjectPersistenceError && error.code !== 'ASSET_HASH_MISMATCH' ? { status: 'missing', message: message(error) } : { status: 'error', message: message(error) });
      return;
    }
    try { settle(sha, bytes ? { status: 'ready', levels: await decode(bytes) } : { status: 'missing' }); }
    catch (error) { settle(sha, { status: 'error', message: message(error) }); }
  }));
}

export interface ImageSource { name: string; size: number; read(): Promise<ArrayBuffer> }
const hex = (digest: ArrayBuffer) => [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');

/** Images are matched to the map's declared images by SHA-256 of their bytes, never by file name. They are read one at a time
 *  and anything unmatched is dropped at once. Quiet offers (every image of a package) skip images that belong to nothing here;
 *  an image whose hash matches is always reported if it then fails its checks. `reported` tells the caller a message is showing. */
export async function offerImages(files: readonly ImageSource[], quiet = false): Promise<{ loaded: number; reported: boolean }> {
  const none = { loaded: 0, reported: false };
  const map = store.get().session?.map; if (!map || !files.length) return none;
  const layers = backgroundLayers(map).filter(info => info.support.supported);
  if (!layers.length) {
    if (quiet) return none;
    notify(Object.keys(map.backgroundLayers).length ? '地图中的底图都不受支持，图片未载入；原因见图层页。' : '当前地图没有记录底图，图片未载入。要把图片加为底图，请用「添加底图…」。', 'error');
    return { loaded: 0, reported: true };
  }
  // A package offers every image it holds; once each layer has its image there is nothing left to look for.
  const complete = () => layers.every(info => store.get().rasters[info.asset!.sha256]?.status === 'ready');
  if (quiet && complete()) return none;
  const loaded: string[] = [], rejected: string[] = []; let unsaved = false;
  for (const file of files) {
    if (quiet && loaded.length && complete()) break;
    let matched = false;
    try {
      if (file.size > MAX_RASTER_BYTES) { if (!quiet) rejected.push(`${file.name} 超过 32 MiB`); continue; }
      const bytes = await file.read(), sha = hex(await crypto.subtle.digest('SHA-256', bytes));
      const asset = layers.find(info => info.asset!.sha256 === sha)?.asset;
      if (!asset) { if (!quiet) rejected.push(`${file.name} 与地图记录的底图不是同一张图片（SHA-256 不同）`); continue; }
      matched = true;
      const raster = await rasterBytes(bytes);
      if (asset.widthPx !== raster.width || asset.heightPx !== raster.height || asset.mediaType !== raster.mimeType) { rejected.push(`${file.name} 的尺寸或格式与地图记录不一致`); continue; }
      if (store.get().rasters[sha]?.status !== 'ready') {
        try { await assets.putAssetBytes(owner(map), raster); } catch { unsaved = true; }
        if (!settle(sha, { status: 'ready', levels: await decode(raster) })) continue;
      }
      loaded.push(file.name);
    } catch (error) { if (!quiet || matched) rejected.push(`${file.name}：${message(error)}`); }
  }
  // The user may have opened another map meanwhile; its own messages stand.
  if (store.get().session?.map !== map || quiet && !loaded.length && !rejected.length) return { loaded: loaded.length, reported: false };
  const parts = [loaded.length ? `已载入底图 ${loaded.join('、')}` : '', rejected.length ? `未载入：${rejected.join('；')}` : '',
    unsaved ? '浏览器数据库不可用，下次打开需要重新选择图片' : ''].filter(Boolean);
  notify(parts.join('。') + '。', rejected.length ? 'error' : 'info');
  return { loaded: loaded.length, reported: true };
}

// Every adopted project (opened, recovered, switched to) loads its stored images.
onAdopt(loadStoredRasters);
