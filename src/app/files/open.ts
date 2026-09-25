import { MAX_RASTER_BYTES } from '../../adapters/rasterFiles';
import { MAX_JSON_BYTES } from '../../domain/model';
import { backgroundLayers, offerImages, type ImageSource } from '../state/backgrounds';
import { importMap } from '../state/project';
import { notify, parseMapText, store } from '../state/store';
import { readZip } from './zip';

interface Candidate { label: string; content: string; detail: string }
const IMAGE = /\.(png|jpe?g|webp)$/i, JSON_FILE = /\.json$/i;
/** Images read automatically from one package; beyond this the user picks images explicitly. */
const MAX_PACKAGE_IMAGE_BYTES = 512 * 1024 * 1024;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function text(bytes: ArrayBuffer, name: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new Error(`${name} 必须使用 UTF-8 编码。`); }
}
/** Calibration, receipt and compiled-map JSON sit next to maps; only a document with a schema version, map ID and metadata is a map. */
function candidate(bytes: ArrayBuffer, label: string, strict = true): Candidate | null {
  let content: string;
  try { content = text(bytes, label); } catch (error) { if (strict) throw error; return null; }
  let value: Record<string, unknown>;
  try { value = JSON.parse(content) as Record<string, unknown>; } catch { return null; }
  if (!value || typeof value !== 'object' || typeof value.schemaVersion !== 'string' || typeof value.mapId !== 'string' || typeof value.metadata !== 'object') return null;
  // A short summary tells a traced map from an empty one before it is opened.
  const count = (key: string) => value[key] && typeof value[key] === 'object' ? Object.keys(value[key]).length : 0;
  const objects = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints'].reduce((sum, key) => sum + count(key), 0);
  return { label, content, detail: `底图 ${count('backgroundLayers')} 层 · 对象 ${objects} 个` };
}

/** Opens a map, then its images. One toast slot: whatever the image step reported stands; otherwise a package note
 *  (images not read) and any missing images are told in one message, so neither hides the other. */
async function openMap(label: string, content: string, images: readonly ImageSource[], quiet = false, note = ''): Promise<void> {
  // The map becomes a browser project, whose stored images are loaded before the chosen ones are matched.
  const parsed = parseMapText(content, label);
  if (!parsed || !(await importMap(parsed, label))) return;
  const map = store.get().session!.map;
  const { loaded, reported } = await offerImages(images, quiet);
  if (store.get().session?.map !== map || reported) return;
  // Without this, a missing image is only visible on the Layers tab.
  const missing = backgroundLayers(map).filter(info => info.support.supported && store.get().rasters[info.asset!.sha256]?.status !== 'ready').length;
  const hint = missing && !loaded ? `有 ${missing} 张底图还没有图片：在「图层」页选择原图即可（按内容匹配，文件名不限）。` : '';
  if (note || hint) notify(`已打开 ${label}。${note}${hint}`, note ? 'error' : 'info');
}

/** Opens one map from the chosen files: a map JSON or a zip package, plus any images for its background layers.
 *  Several candidate maps ask the user to pick one; images alone go to the map that is already open. */
export async function openFiles(files: readonly File[]): Promise<void> {
  if (!files.length) return;
  try {
    const sources: ImageSource[] = files.map(file => ({ name: file.name, size: file.size, read: () => file.arrayBuffer() }));
    const zips = sources.filter(source => /\.zip$/i.test(source.name));
    if (zips.length > 1 || zips.length && sources.some(source => JSON_FILE.test(source.name))) { notify('一次只能打开一张地图：请只选一个 zip 包，或者地图 JSON 加上它的图片。', 'error'); return; }
    const ignored = sources.filter(source => !IMAGE.test(source.name) && !JSON_FILE.test(source.name) && !/\.zip$/i.test(source.name)).map(source => source.name);
    if (ignored.length) notify(`已忽略 ${ignored.join('、')}：只支持地图 JSON、zip 包和 PNG / JPEG / WebP 图片。`);
    if (zips[0]) { await openPackage(zips[0]); return; }

    const images = sources.filter(source => IMAGE.test(source.name)), candidates: Candidate[] = [];
    for (const source of sources.filter(item => JSON_FILE.test(item.name))) {
      if (source.size > MAX_JSON_BYTES) throw new Error(`${source.name} 超过 10 MiB。`);
      const found = candidate(await source.read(), source.name);
      if (found) candidates.push(found);
    }
    if (!candidates.length && sources.some(source => JSON_FILE.test(source.name))) { notify('所选 JSON 都不是船厂地图（缺少 schemaVersion、mapId 或 metadata）。', 'error'); return; }
    if (!candidates.length) {
      if (!store.get().session) { notify('请先打开地图，再添加底图图片。', 'error'); return; }
      await offerImages(images); return;
    }
    choose(candidates.map(found => ({ label: found.label, detail: found.detail, open: () => openMap(found.label, found.content, images) })));
  } catch (error) { notify(`无法打开：${message(error)}`, 'error'); }
}

/** Every image in a package is offered to the chosen map and matched by content, wherever it sits
 *  (acceptance folders keep maps apart from their images); images for other maps are skipped quietly. */
async function openPackage(zip: ImageSource): Promise<void> {
  const entries = readZip(await zip.read(), Math.max(MAX_JSON_BYTES, MAX_RASTER_BYTES)), candidates: Candidate[] = [];
  for (const entry of entries.filter(item => JSON_FILE.test(item.name) && item.size <= MAX_JSON_BYTES)) {
    // Other JSON in a package may use another encoding; only the files the user picked must be UTF-8.
    const found = candidate(await entry.read(), entry.name, false);
    if (found) candidates.push(found);
  }
  if (!candidates.length) { notify(`${zip.name} 中没有船厂地图。`, 'error'); return; }
  let images = entries.filter(entry => IMAGE.test(entry.name) && entry.size <= MAX_RASTER_BYTES), note = '';
  if (images.reduce((sum, entry) => sum + entry.size, 0) > MAX_PACKAGE_IMAGE_BYTES) {
    note = '包内图片合计超过 512 MiB，未自动读取；请另外选择需要的底图图片。';
    images = [];
  }
  choose(candidates.map(found => ({ label: found.label, detail: found.detail, open: () => openMap(`${zip.name} › ${found.label}`, found.content, images, true, note) })));
}

function choose(options: readonly { label: string; detail: string; open: () => Promise<void> }[]): void {
  const run = (open: () => Promise<void>) => { open().catch(error => notify(`无法打开：${message(error)}`, 'error')); };
  if (options.length === 1) { run(options[0]!.open); return; }
  store.set({ overlay: 'mapChoice', mapChoice: options.map(option => ({ label: option.label, detail: option.detail, open: () => { store.set({ overlay: null, mapChoice: null }); run(option.open); } })) });
}
