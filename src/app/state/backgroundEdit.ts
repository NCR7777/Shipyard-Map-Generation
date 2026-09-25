import { resolveBackgroundCalibration, type BackgroundCalibrationResult } from '../../adapters/backgroundCalibration';
import { MAX_RASTER_BYTES, rasterBytes } from '../../adapters/rasterFiles';
import type { MapCommand } from '../../domain/commands';
import { BACKGROUND_PIXEL_CONVENTION, inspectBackground } from '../../domain/backgrounds';
import { MAX_JSON_BYTES, type Asset, type BackgroundLayer, type Vec2, type YardMap } from '../../domain/model';
import { KIND_LABELS } from '../ui/labels';
import { sameValue } from '../../domain/value';
import type { RasterAssetBytes } from '../../editor/projectController';
import { backgroundFrame, type BackgroundTransform } from '../../geometry/backgrounds';
import { initialPlacement, measuredScale, replacementTransform, withField, type NumericField } from '../canvas/backgroundAdjust';
import { uid } from '../canvas/movePreview';
import { backgroundBounds, backgroundLayers, decode, message, owner, release, settle, wantedHashes } from './backgrounds';
import { setTool } from './draft';
import { apply, applyAll, editBlock, lockedMessage, MERGE_MS } from './edit';
import { projectStore } from './project';
import { frameBounds, notify, sceneOf, store, type AppState } from './store';

/** Adding, adjusting, replacing and deleting background images (P3d1). Every change to the map is one command through the
 *  edit gateway, so it is one undo step, checked by the kernel, and recorded in the map's background lineage. */

export const backgroundKey = (id: string) => 'backgroundLayers/' + id;
/** What a background command writes: the layer, its image declaration, and a lineage source. */
const WRITTEN = ['backgroundLayers', 'assets', 'sources'] as const;
const IMAGE = /\.(png|jpe?g|webp)$/i, JSON_FILE = /\.json$/i;
const MAX_CALIBRATION_FILES = 12;
export interface PickedFile { name: string; size: number; read(): Promise<ArrayBuffer>; text(): Promise<string> }
export const pickedFile = (file: File): PickedFile => ({ name: file.name, size: file.size, read: () => file.arrayBuffer(), text: () => file.text() });

/** Why this layer cannot be adjusted now, or null. */
export function adjustRefusal(state: AppState, id: string): string | null {
  const map = state.session?.map; if (!map) return '请先打开地图';
  const blocked = editBlock(state.session); if (blocked) return blocked;
  if (!Object.hasOwn(map.backgroundLayers, id)) return '底图已不在当前地图中。';
  const support = inspectBackground(map, id); if (!support.supported) return '底图不受支持：' + support.reasons.join(' ');
  // Every change writes the layer, touches its image declaration and adds a lineage source: a lock on any of them refuses it.
  const locked = WRITTEN.filter(kind => state.drawing.lockedTypes.includes(kind));
  if (locked[0] === 'backgroundLayers') return '底图图层已锁定，可在「图层」页解锁。';
  if (locked.length) return `调整底图会写入已锁定的图层（${locked.map(kind => KIND_LABELS[kind]).join('、')}），可在「图层」页解锁。`;
  if (state.drawing.hiddenTypes.includes('backgroundLayers') || state.backgroundView.hidden.includes(id)) return '底图已隐藏，显示后才能调整。';
  const raster = state.rasters[map.assets[map.backgroundLayers[id]!.assetId]!.sha256];
  if (raster?.status !== 'ready') return '这张底图的图片还没有载入，选择原图后才能调整。';
  return null;
}
/** Adjusting starts only on request: at other times a background can be neither picked nor moved. It selects the layer
 *  (the inspector shows its fields) and leaves any drawing tool. */
export function startAdjust(id: string): boolean {
  const refusal = adjustRefusal(store.get(), id);
  if (refusal) { notify(refusal, 'error'); return false; }
  setTool('select');
  store.set(({ panels, mapEpoch }) => ({ selection: [backgroundKey(id)], adjusting: { id, epoch: mapEpoch, keepAspect: true, measure: null },
    panels: { ...panels, right: true }, rightTab: 'properties' }));
  return true;
}
export function stopAdjust(): void { if (store.get().adjusting) store.set({ adjusting: null }); }
// Adjusting ends by itself when its layer can no longer be adjusted, or the user turns to anything else: another selection,
// another tool, another map.
store.subscribe(() => {
  const state = store.get(), adjusting = state.adjusting; if (!adjusting) return;
  const keep = state.mapEpoch === adjusting.epoch && state.tool === 'select' && state.selection.length === 1 && state.selection[0] === backgroundKey(adjusting.id)
    && !adjustRefusal(state, adjusting.id);
  if (!keep) store.set({ adjusting: null });
});

export interface AdjustedLayer { id: string; transform: BackgroundTransform; width: number; height: number }
export function adjustedLayer(map: YardMap, id: string): AdjustedLayer | null {
  const layer = Object.hasOwn(map.backgroundLayers, id) ? map.backgroundLayers[id] : undefined, asset = layer && map.assets[layer.assetId];
  return layer && asset?.widthPx && asset.heightPx ? { id, transform: layer.imageToWorld, width: asset.widthPx, height: asset.heightPx } : null;
}
/** The layer being adjusted, with its image size and transform. */
export function adjusted(state: AppState = store.get()): AdjustedLayer | null {
  const id = state.adjusting?.id, map = state.session?.map;
  return id && map ? adjustedLayer(map, id) : null;
}
/** One transform change. An unchanged transform (a click without a drag) is not a change and says nothing. */
export function setTransform(id: string, next: BackgroundTransform, label: string, merge?: string): boolean {
  const layer = store.get().session?.map.backgroundLayers[id]; if (!layer) return false;
  if (sameValue(layer.imageToWorld, next)) return true;
  return apply({ type: 'updateBackgroundTransform', id, imageToWorld: next }, label, merge);
}
/** Arrow keys while adjusting: 0.1 m, Shift 1 m; a run of nudges is one undo step. */
/** The run of nudges under way: where it began and how many 0.1 m steps it has gone. Counting steps from the start, rather
 *  than adding 0.1 to a position that already carries rounding, brings the image back exactly when the steps cancel out. */
let nudges: { id: string; base: BackgroundTransform; last: BackgroundTransform; x: number; y: number; at: number } | null = null;
export function nudgeBackground(dx: number, dy: number): void {
  const current = adjusted(); if (!current) return;
  const t = current.transform, run = nudges;
  // The same run while the keys keep coming and nothing else has moved the image (an undo, a drag, a field).
  const same = run && run.id === current.id && performance.now() - run.at < MERGE_MS && sameValue(run.last, t);
  const from = same ? run : { id: current.id, base: t, x: 0, y: 0 };
  const x = from.x + Math.round(dx * 10), y = from.y + Math.round(dy * 10), b = from.base;
  const next: BackgroundTransform = [b[0], b[1], b[2], b[3], b[4] + x / 10, b[5] + y / 10];
  // The run is re-applied from where it began: one lineage record in the map for the whole run, not one per key press.
  if (sameValue(t, next) || apply({ type: 'updateBackgroundTransform', id: current.id, imageToWorld: next }, '微调底图', 'nudge-background:' + current.id, undefined, true)) {
    nudges = { id: current.id, base: b, last: next, x, y, at: performance.now() };
  }
}
/** A numeric field: true when applied (or unchanged), false when the gateway refused, a string for bad input. */
export function setField(field: NumericField, text: string): boolean | string {
  const current = adjusted(); if (!current) return '底图已不在调整中。';
  const value = text.trim() ? Number(text) : NaN;
  if (!Number.isFinite(value)) return '必须是有限数。';
  let next: BackgroundTransform;
  try { next = withField(current.transform, current.width, current.height, field, value, store.get().adjusting!.keepAspect); }
  catch (error) { return message(error); }
  return setTransform(current.id, next, '调整底图');
}
export function setKeepAspect(keepAspect: boolean): void {
  store.set(({ adjusting }) => adjusting ? { adjusting: { ...adjusting, keepAspect } } : {});
}

/** Setting the scale from a known length: two picked image points, then the real distance. */
export function startMeasure(): void { store.set(({ adjusting }) => adjusting ? { adjusting: { ...adjusting, measure: [] } } : {}); }
export function cancelMeasure(): void { store.set(({ adjusting }) => adjusting?.measure ? { adjusting: { ...adjusting, measure: null } } : {}); }
/** A point must be on the image; a third click starts again from it. */
export function measurePoint(pixel: Vec2): void {
  const layer = adjusted(), adjusting = store.get().adjusting; if (!layer || !adjusting?.measure) return;
  if (!(pixel[0] >= 0 && pixel[0] <= layer.width && pixel[1] >= 0 && pixel[1] <= layer.height)) { notify('量距的点要点在底图上。', 'error'); return; }
  store.set({ adjusting: { ...adjusting, measure: adjusting.measure.length < 2 ? [...adjusting.measure, pixel] : [pixel] } });
}
export function applyMeasure(text: string): boolean | string {
  const current = adjusted(), points = store.get().adjusting?.measure;
  if (!current || points?.length !== 2) return '请先在底图上点两个点。';
  const metres = text.trim() ? Number(text) : NaN;
  let next: BackgroundTransform;
  try { next = measuredScale(current.transform, points[0]!, points[1]!, metres); }
  catch (error) { return message(error); }
  if (!setTransform(current.id, next, '量距定比例')) return false;
  cancelMeasure();
  notify(`已按实际长度 ${metres} m 定比例：第一点不动，整张底图等比缩放。`);
  return true;
}

interface Prepared { raster: RasterAssetBytes; levels: ImageBitmap[] }
/** Reads and checks one image and decodes it for drawing; the caller owns the decoded levels. */
async function prepare(file: PickedFile): Promise<Prepared> {
  if (file.size > MAX_RASTER_BYTES) throw new Error('图片超过 32 MiB。');
  const raster = await rasterBytes(await file.read());
  return { raster, levels: await decode(raster) };
}
/** One image operation at a time: two reads racing could both pass the duplicate check, or replace one layer twice. */
let reading = false;
async function oneAtATime(file: PickedFile, run: () => Promise<boolean>): Promise<boolean> {
  if (reading) { notify('正在读取上一张图片，稍候再选。', 'error'); return false; }
  reading = true;
  // A large image takes a moment to check and decode.
  notify(`正在读取 ${file.name}…`);
  try { return await run(); } finally { reading = false; }
}
/** The map's image declaration for these bytes: an existing identical one is reused (with its source), else a new one. */
function assetFor(map: YardMap, raster: RasterAssetBytes, source: () => { name: string; category: 'imagery_derived' | 'design_assumption'; description: string }) {
  const existing = Object.entries(map.assets).find(([, asset]) => asset.sha256 === raster.sha256 && asset.mediaType === raster.mimeType
    && asset.widthPx === raster.width && asset.heightPx === raster.height);
  const sourceId = existing?.[1].sourceRef ?? uid('source_background'), assetId = existing?.[0] ?? uid('asset');
  const extension = raster.mimeType === 'image/jpeg' ? 'jpg' : raster.mimeType === 'image/png' ? 'png' : 'webp';
  const asset: Asset = existing?.[1] ?? { path: `assets/${raster.sha256}.${extension}`, sha256: raster.sha256, mediaType: raster.mimeType, widthPx: raster.width, heightPx: raster.height, sourceRef: sourceId };
  // A reused declaration keeps its source; only a missing one is supplied.
  return { assetId, asset, ...Object.hasOwn(map.sources, asset.sourceRef) ? {} : { source: { id: asset.sourceRef, value: source() } } };
}
/** Bytes are stored before the map refers to them, so a saved map never points at an image this browser lacks.
 *  A database that cannot store them only means the image has to be chosen again next time. */
async function storeBytes(map: YardMap, raster: RasterAssetBytes): Promise<boolean> {
  try { await projectStore.putAssetBytes(owner(map), raster); return true; } catch { return false; }
}
const UNSTORED = '浏览器数据库不可用，下次打开需要重新选择这张图片。';
/** Makes decoded levels drawable before the command that uses them, so the new layer is never seen without its image
 *  (adjusting would end at once). Returns what to do if the command is refused: drop them unless a layer uses the image. */
function stage(sha: string, levels: ImageBitmap[]): () => void {
  if (store.get().rasters[sha]?.status === 'ready') { levels.forEach(level => level.close()); return () => {}; }
  const raster = { status: 'ready' as const, levels };
  store.set(({ rasters }) => { const previous = rasters[sha]; if (previous) release(previous); return { rasters: { ...rasters, [sha]: raster } }; });
  return () => {
    if (wantedHashes(store.get().session?.map).has(sha) || store.get().rasters[sha] !== raster) return;
    release(raster);
    store.set(({ rasters }) => { const rest = { ...rasters }; delete rest[sha]; return { rasters: rest }; });
  };
}
const IDENTITY_NOTE = '像素角点为左上原点，X 右、Y 下；文件身份匹配不等于独立测量精度认证。';
/** Why a background command would be refused before anything is read or stored: read-only map, or a locked layer it writes. */
function writeRefusal(): string | null {
  return editBlock() ?? lockedMessage(WRITTEN.map(kind => ({ kind })));
}
/** A layer (other than `except`) that already shows this image. */
function twinOf(map: YardMap, sha: string, except?: string) {
  return backgroundLayers(map).find(info => info.id !== except && info.asset?.sha256 === sha);
}
/** The coordinate reference of a standard calibration file among `texts`, if one names it. */
function anchorOf(texts: readonly { text: string }[]): string | null {
  for (const { text } of texts) {
    try {
      const value = JSON.parse(text) as { format?: unknown; coordinateFrame?: { geographicAnchor?: { crs?: unknown } } };
      const crs = value?.coordinateFrame?.geographicAnchor?.crs;
      if (value?.format === 'BG01_background_calibration_v1' && typeof crs === 'string') return crs;
    } catch { /* not JSON: the adapter already said so */ }
  }
  return null;
}
/** Why chosen calibration files cannot place this image; a new map's missing geographic anchor is named as the cause. */
function calibrationRefusal(map: YardMap, texts: readonly { text: string }[], calibration: Extract<BackgroundCalibrationResult, { ok: false }>): string {
  const anchor = calibration.code === 'BG_FRAME_MISMATCH' && !map.coordinateFrame.geographicAnchor ? anchorOf(texts) : null;
  if (anchor) return `校准文件的坐标框架带地理锚点（${anchor}），这张地图没有（新建的地图都没有），两者不是同一坐标框架，校准文件用不上，未添加底图。`
    + '可以不选校准文件先手动放置、再用「量距定比例」定比例；或把它加到已采用该坐标框架的地图上（例如从原工程导入的地图）。';
  return `校准文件未通过（${calibration.code}）：${calibration.message} 未添加底图；不选校准文件即可先手动放置。`;
}

/** Adds one image (with optional calibration files in the old tool's format) as a new background layer. Without calibration
 *  it is placed over the map's content and adjusting starts at once. */
export async function addBackground(files: readonly PickedFile[]): Promise<boolean> {
  const images = files.filter(file => IMAGE.test(file.name)), documents = files.filter(file => JSON_FILE.test(file.name));
  const ignored = files.filter(file => !IMAGE.test(file.name) && !JSON_FILE.test(file.name));
  if (images.length !== 1) { notify('请选择一张 PNG、JPEG 或 WebP 图片；可以同时选择它的校准 JSON。', 'error'); return false; }
  if (documents.length > MAX_CALIBRATION_FILES || documents.some(file => file.size > MAX_JSON_BYTES)) { notify(`校准 JSON 最多 ${MAX_CALIBRATION_FILES} 份，每份不超过 10 MiB。`, 'error'); return false; }
  const start = store.get(), refusal = writeRefusal(); if (refusal) { notify(refusal, 'error'); return false; }
  const file = images[0]!;
  return oneAtATime(file, () => add(start, file, documents, ignored));
}
async function add(start: AppState, file: PickedFile, documents: readonly PickedFile[], ignored: readonly PickedFile[]): Promise<boolean> {
  let prepared: Prepared, texts: { name: string; text: string }[];
  try { prepared = await prepare(file); }
  catch (error) { notify(`${file.name} 未添加：${message(error)}`, 'error'); return false; }
  const { raster, levels } = prepared;
  const drop = (text: string) => { levels.forEach(level => level.close()); notify(text, 'error'); return false; };
  try { texts = await Promise.all(documents.map(async document => ({ name: document.name, text: await document.text() }))); }
  catch (error) { return drop(`校准文件读取失败：${message(error)}`); }
  // Reading takes a moment: the map may have been replaced meanwhile.
  const now = store.get(), map = now.session?.map;
  if (!map || now.mapEpoch !== start.mapEpoch) return drop('读取图片期间打开了另一张地图，未添加底图。');
  const twinText = (twin: ReturnType<typeof twinOf> & object) => `这张图片已是底图「${twin.layer.name || twin.id}」，未重复添加；要重新放置请用「调整」。`;
  const twin = twinOf(map, raster.sha256); if (twin) return drop(twinText(twin));
  const calibration: BackgroundCalibrationResult = resolveBackgroundCalibration({ image: { sha256: raster.sha256, widthPx: raster.width, heightPx: raster.height }, coordinateFrame: map.coordinateFrame, documents: texts });
  // Calibration files that were chosen but do not apply are refused too: the user meant this image to be calibrated.
  if (!calibration.ok && texts.length) return drop(calibrationRefusal(map, texts, calibration));
  const calibrated = calibration.ok;
  // A refusal known now stores nothing (the bytes would stay in the database unused).
  const blocked = writeRefusal(); if (blocked) return drop(blocked);
  const stored = await storeBytes(map, raster);
  if (store.get().mapEpoch !== start.mapEpoch) return drop('读取图片期间打开了另一张地图，未添加底图。');
  const current = store.get().session!.map, id = uid('background');
  // Storing takes a moment too: an undo meanwhile can bring back a layer showing this image.
  const late = twinOf(current, raster.sha256); if (late) return drop(twinText(late));
  const { assetId, asset, source } = assetFor(current, raster, () => ({
    name: file.name, category: calibrated ? 'imagery_derived' : 'design_assumption',
    description: JSON.stringify({ operation: 'background_import', originalFilename: file.name, imageSha256: raster.sha256,
      calibration: calibration.ok ? { status: 'ok', method: calibration.method, sourceEvidence: calibration.sourceEvidence, notes: calibration.notes } : { status: 'uncalibrated' }, note: IDENTITY_NOTE }),
  }));
  const imageToWorld = calibration.ok ? calibration.imageToWorld : initialPlacement(raster.width, raster.height, sceneOf(current).bounds ?? backgroundBounds(current));
  const command: MapCommand = { type: 'addBackground', id, assetId, asset, ...source ? { source } : {}, layer: {
    name: file.name, assetId, imageToWorld, pixelConvention: BACKGROUND_PIXEL_CONVENTION, method: calibrated ? 'affine' : 'manual',
    controlPoints: calibration.ok ? calibration.controlPoints : [],
    provenance: { category: calibrated ? 'imagery_derived' : 'design_assumption', sourceRefs: [asset.sourceRef],
      note: calibration.ok ? '已匹配图片身份与完整坐标框架；精度未独立核验。证据：' + JSON.stringify(calibration.sourceEvidence) : '尚未校准：初始位置只是覆盖地图现有内容的猜测，不能视为配准。' },
  } };
  const unstage = stage(raster.sha256, levels);
  if (!apply(command, '添加底图')) { unstage(); return false; }
  const bounds = backgroundBounds(store.get().session!.map, [id]); if (bounds) frameBounds(bounds);
  const extra = [ignored.length ? `已忽略 ${ignored.map(item => item.name).join('、')}` : '', stored ? '' : UNSTORED].filter(Boolean).join('；');
  if (calibrated) { notify(`已添加底图「${file.name}」，按校准文件放置。${extra}`); return true; }
  // Added either way; when adjusting cannot start (the background type is hidden, say), the message says both.
  const cannot = adjustRefusal(store.get(), id);
  if (cannot) notify(`已添加底图「${file.name}」（未校准），暂不能调整：${cannot}${extra}`);
  else if (startAdjust(id)) notify(`已添加底图「${file.name}」（未校准）：拖动、拉角或「量距定比例」确定位置与比例，完成后点「完成调整」。${extra}`);
  return true;
}

/** Replaces a layer's image. Its ground stays: same top-left corner and width, and the same height when the aspect ratios
 *  agree. Replacing and re-fitting are one undo step. The same image again only reloads it. */
export async function replaceBackground(id: string, file: PickedFile): Promise<boolean> {
  if (!IMAGE.test(file.name)) { notify('请选择一张 PNG、JPEG 或 WebP 图片。', 'error'); return false; }
  const start = store.get(), refusal = writeRefusal(); if (refusal) { notify(refusal, 'error'); return false; }
  return oneAtATime(file, () => replace(start, id, file));
}
async function replace(start: AppState, id: string, file: PickedFile): Promise<boolean> {
  let prepared: Prepared;
  try { prepared = await prepare(file); }
  catch (error) { notify(`${file.name} 未替换：${message(error)}`, 'error'); return false; }
  const { raster, levels } = prepared;
  const drop = (text: string, tone: 'info' | 'error' = 'error') => { levels.forEach(level => level.close()); notify(text, tone); return false; };
  // Checked before the bytes are stored (not to store them for nothing) and again after, against the map as it is then:
  // meanwhile an undo can remove the layer, or bring back another one showing this image.
  const check = (map: YardMap | undefined): { map: YardMap; before: BackgroundLayer; old: Asset & { widthPx: number; heightPx: number } } | string => {
    if (!map || store.get().mapEpoch !== start.mapEpoch) return '读取图片期间打开了另一张地图，未替换底图。';
    const before = Object.hasOwn(map.backgroundLayers, id) ? map.backgroundLayers[id] : undefined, old = before && map.assets[before.assetId];
    if (!before || !old?.widthPx || !old.heightPx || !inspectBackground(map, id).supported) return '这层底图已不在当前地图中或不受支持，未替换。';
    // The same image again only reloads it; another layer's image is refused, as when adding.
    if (old.sha256 !== raster.sha256) {
      const twin = twinOf(map, raster.sha256, id); if (twin) return `这张图片已是底图「${twin.layer.name || twin.id}」，未替换。`;
      const blocked = writeRefusal(); if (blocked) return blocked;
    }
    return { map, before, old: old as Asset & { widthPx: number; heightPx: number } };
  };
  const first = check(store.get().session?.map); if (typeof first === 'string') return drop(first);
  const stored = await storeBytes(first.map, raster);
  const checked = check(store.get().session?.map); if (typeof checked === 'string') return drop(checked);
  const { map: current, before, old } = checked;
  if (old.sha256 === raster.sha256) {
    if (!settle(raster.sha256, { status: 'ready', levels })) return drop('这层底图已不在当前地图中，未替换。');
    notify('所选图片与当前底图是同一张（SHA-256 相同），已重新载入，地图未改动。' + (stored ? '' : UNSTORED));
    return true;
  }
  const { assetId, asset, source } = assetFor(current, raster, () => ({
    name: file.name, category: 'design_assumption',
    description: JSON.stringify({ operation: 'explicit_image_replacement', originalFilename: file.name, imageSha256: raster.sha256, replacedSha256: old.sha256, note: IDENTITY_NOTE }),
  }));
  const fitted = replacementTransform(before.imageToWorld, { width: old.widthPx, height: old.heightPx }, { width: raster.width, height: raster.height });
  const commands: MapCommand[] = [{ type: 'replaceBackgroundAsset', id, assetId, asset, ...source ? { source } : {} }];
  // The kernel keeps the transform; the new pixel size needs the fitted one to cover the same ground. Both are one undo step.
  if (!sameValue(fitted.transform, before.imageToWorld)) commands.push({ type: 'updateBackgroundTransform', id, imageToWorld: fitted.transform });
  const unstage = stage(raster.sha256, levels);
  if (!applyAll(commands, '替换底图图片')) { unstage(); return false; }
  notify(`已替换底图图片为「${file.name}」：${fitted.sameGround ? '保持原来的地面范围' : '保持左上角和宽度；宽高比与原图不同，高度随之改变，请检查对齐'}。${stored ? '' : UNSTORED}`, fitted.sameGround ? 'info' : 'error');
  return true;
}

/** Removes the layer only; its image declaration and bytes stay, so undo brings it back as it was. */
export function deleteBackground(id: string): boolean {
  const layer = store.get().session?.map.backgroundLayers[id]; if (!layer) return false;
  const locked = lockedMessage([{ kind: 'backgroundLayers' }]); if (locked) { notify(locked, 'error'); return false; }
  if (!apply({ type: 'deleteBackground', id }, '删除底图')) return false;
  notify(`已删除底图「${layer.name || id}」，可撤销。`);
  return true;
}

/** Numbers the fields show for a transform. */
export function transformFields(t: BackgroundTransform, width: number, height: number) {
  const frame = backgroundFrame(t, width, height);
  return { x: t[4], y: t[5], width: frame.widthM, height: frame.heightM, angle: frame.rotationRad * 180 / Math.PI, resolution: frame.scaleXMPerPx, resolutionY: frame.scaleYMPerPx };
}
