import type { Asset, BackgroundLayer, Source, YardMap } from './model';
import type { CommandAffectedRef } from './commands';
import { inspectPlanning } from './planning';
import { sameValue } from './value';
import { rejectOpaqueTopologyReferences } from './topologyEditing';
import { backgroundDeterminant, backgroundFrame, validBackgroundTransform, type BackgroundTransform } from '../geometry/backgrounds';

export const BACKGROUND_PIXEL_CONVENTION = 'top_left_x_right_y_down_exif_normalized' as const;
export interface BackgroundSourceInput { id: string; value: Source }
interface BackgroundAssetInput { assetId: string; asset: Asset; source?: BackgroundSourceInput }
export type BackgroundCommand =
  | ({ type: 'addBackground'; id: string; layer: BackgroundLayer } & BackgroundAssetInput)
  | { type: 'updateBackgroundTransform'; id: string; imageToWorld: BackgroundTransform }
  | { type: 'deleteBackground'; id: string }
  | ({ type: 'replaceBackgroundAsset'; id: string } & BackgroundAssetInput);
export class BackgroundError extends Error {
  constructor(readonly code: string, message: string, readonly path = '') { super(message); }
}
export interface BackgroundInspection { supported: boolean; reasons: string[] }
export function inspectAsset(asset: Asset): BackgroundInspection {
  const reasons: string[] = [];
  const path = asset.path;
  if (typeof path !== 'string' || !path.startsWith('assets/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\:]/.test(path) || [...path].some(char => char.charCodeAt(0) < 32)) reasons.push('图片路径必须是 assets/ 下安全的本地相对路径。');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(asset.mediaType) || !/^[a-f0-9]{64}$/.test(asset.sha256)) reasons.push('仅支持带 SHA-256 的 PNG、JPEG、WebP 本地图片。');
  if (!Number.isSafeInteger(asset.widthPx) || !Number.isSafeInteger(asset.heightPx) || (asset.widthPx ?? 0) <= 0 || (asset.heightPx ?? 0) <= 0) reasons.push('图片需要明确的正整数像素尺寸。');
  if (Object.keys(asset.extensions ?? {}).length) reasons.push('图片含未支持扩展，完整保留但不编辑。');
  return { supported: reasons.length === 0, reasons };
}
export function inspectBackground(map: YardMap, id: string): BackgroundInspection {
  const layer = Object.hasOwn(map.backgroundLayers, id) ? map.backgroundLayers[id] : undefined;
  if (!layer) return { supported: false, reasons: ['底图不存在。'] };
  const asset = Object.hasOwn(map.assets, layer.assetId) ? map.assets[layer.assetId] : undefined;
  const reasons = asset ? [...inspectAsset(asset).reasons] : ['底图引用的图片不存在。'];
  if (layer.pixelConvention !== BACKGROUND_PIXEL_CONVENTION) reasons.push('未支持该像素原点或 EXIF 方向约定。');
  if (!['manual', 'similarity', 'affine'].includes(layer.method)) reasons.push('底图配准方法未支持。');
  if (!validBackgroundTransform(layer.imageToWorld)) reasons.push('底图仿射变换必须有限且非奇异。');
  else if (asset && inspectAsset(asset).supported) {
    try { backgroundFrame(layer.imageToWorld, asset.widthPx!, asset.heightPx!); }
    catch { reasons.push('底图世界范围超出有限数值。'); }
  }
  if (Object.keys(layer.extensions ?? {}).length) reasons.push('底图含未支持扩展（可能包含校准残差），完整保留但不编辑。');
  return { supported: reasons.length === 0, reasons };
}
export function isBackgroundCommand(command: { type: string }): command is BackgroundCommand {
  return ['addBackground', 'updateBackgroundTransform', 'deleteBackground', 'replaceBackgroundAsset'].includes(command.type);
}
const COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
function usedIds(map: YardMap): Set<string> {
  return new Set([...COLLECTIONS.flatMap(kind => Object.keys(map[kind])), ...inspectPlanning(map).slots.map(slot => slot.id)]);
}
function setEntry<T>(collection: Record<string, T>, id: string, value: T): void {
  Object.defineProperty(collection, id, { value: structuredClone(value), enumerable: true, writable: true, configurable: true });
}
function addAsset(map: YardMap, command: BackgroundAssetInput, refs: CommandAffectedRef[]): void {
  const inspection = inspectAsset(command.asset);
  if (!inspection.supported) throw new BackgroundError('BACKGROUND_ASSET_UNSUPPORTED', inspection.reasons.join(' '), '/assets/' + command.assetId);
  if (command.source) {
    if (command.source.id !== command.asset.sourceRef) throw new BackgroundError('BACKGROUND_SOURCE_MISMATCH', '图片来源必须与新增来源 ID 相符。');
    if (usedIds(map).has(command.source.id) && !sameValue(map.sources[command.source.id], command.source.value)) throw new BackgroundError('DUPLICATE_ENTITY_ID', '来源 ID 已被其他内容占用。');
    if (!Object.hasOwn(map.sources, command.source.id)) {
      setEntry(map.sources, command.source.id, command.source.value);
      refs.push({ kind: 'sources', id: command.source.id });
    }
  }
  if (!Object.hasOwn(map.sources, command.asset.sourceRef)) throw new BackgroundError('BACKGROUND_SOURCE_REQUIRED', '图片需要已有或同时提供的明确来源。');
  if (usedIds(map).has(command.assetId)) {
    if (!sameValue(map.assets[command.assetId], command.asset)) throw new BackgroundError('DUPLICATE_ENTITY_ID', '图片 ID 已被其他内容占用。');
  } else {
    for (const asset of Object.values(map.assets)) if (asset.path === command.asset.path && !sameValue(asset, command.asset)) throw new BackgroundError('BACKGROUND_ASSET_PATH_CONFLICT', '同一路径已绑定其他图片声明，不能覆盖。');
    setEntry(map.assets, command.assetId, command.asset);
  }
  refs.push({ kind: 'assets', id: command.assetId }, { kind: 'sources', id: command.asset.sourceRef });
}

/** Mutates only a private command candidate. Asset bytes are resolved by the project layer. */
export function runBackgroundCommand(map: YardMap, command: BackgroundCommand): CommandAffectedRef[] {
  const keys = command.type === 'addBackground' ? ['type', 'id', 'layer', 'assetId', 'asset', 'source']
    : command.type === 'replaceBackgroundAsset' ? ['type', 'id', 'assetId', 'asset', 'source']
      : command.type === 'updateBackgroundTransform' ? ['type', 'id', 'imageToWorld'] : ['type', 'id'];
  if (Object.keys(command).some(key => !keys.includes(key))) throw new BackgroundError('UNSUPPORTED_PATCH', '底图命令包含未经支持的字段。');
  const previous = Object.hasOwn(map.backgroundLayers, command.id) ? map.backgroundLayers[command.id] : undefined;
  const before = previous ? structuredClone(previous) : null;
  const refs: CommandAffectedRef[] = [{ kind: 'backgroundLayers', id: command.id }];
  if (command.type === 'addBackground') {
    if (usedIds(map).has(command.id) || command.id === command.assetId || command.id === command.source?.id) throw new BackgroundError('DUPLICATE_ENTITY_ID', '底图 ID 已存在或与新增对象冲突。');
    if (command.layer.assetId !== command.assetId) throw new BackgroundError('BACKGROUND_ASSET_MISMATCH', '底图和图片 ID 必须一致。');
    addAsset(map, command, refs);
    setEntry(map.backgroundLayers, command.id, command.layer);
  } else {
    const inspection = inspectBackground(map, command.id);
    if (!inspection.supported || !previous) throw new BackgroundError('BACKGROUND_UNSUPPORTED', inspection.reasons.join(' '), '/backgroundLayers/' + command.id);
    refs.push({ kind: 'assets', id: previous.assetId });
    if (command.type === 'deleteBackground') {
      rejectOpaqueTopologyReferences(map, [command.id]);
      delete map.backgroundLayers[command.id];
    } else if (command.type === 'updateBackgroundTransform') {
      if (!validBackgroundTransform(command.imageToWorld)) throw new BackgroundError('BACKGROUND_TRANSFORM_INVALID', '底图变换必须有限且非奇异。');
      if (Math.sign(backgroundDeterminant(previous.imageToWorld)) !== Math.sign(backgroundDeterminant(command.imageToWorld))) throw new BackgroundError('BACKGROUND_MIRROR_REJECTED', '手动调整不能反转底图朝向。');
      if (sameValue(previous.imageToWorld, command.imageToWorld)) return [];
      previous.imageToWorld = [...command.imageToWorld];
      previous.method = 'manual';
    } else {
      if (previous.assetId === command.assetId && sameValue(map.assets[command.assetId], command.asset)) return [];
      addAsset(map, command, refs);
      previous.assetId = command.assetId;
      previous.method = 'manual';
    }
  }
  const after = map.backgroundLayers[command.id];
  if (after) {
    const inspection = inspectBackground(map, command.id);
    if (!inspection.supported) throw new BackgroundError('BACKGROUND_UNSUPPORTED', inspection.reasons.join(' '), '/backgroundLayers/' + command.id);
  }
  const ids = usedIds(map);
  let sourceId = 'source_editor_background', suffix = 0;
  while (ids.has(sourceId)) sourceId = 'source_editor_background_' + ++suffix;
  map.sources[sourceId] = {
    name: '底图编辑沿革', category: 'design_assumption',
    description: JSON.stringify({
      operation: command.type, backgroundId: command.id,
      before: before && {
        assetId: before.assetId, assetSHA256: map.assets[before.assetId]?.sha256,
        imageToWorld: before.imageToWorld, method: before.method, provenance: before.provenance,
      },
      after: after ? {
        assetId: after.assetId, assetSHA256: map.assets[after.assetId]?.sha256,
        imageToWorld: after.imageToWorld, method: after.method,
      } : null,
      ...(command.type === 'deleteBackground' ? { retainedControlPoints: before?.controlPoints } : {}),
      calibrationStatus: after?.method === 'manual'
        ? 'manual_unverified_control_points_retained_no_valid_residual'
        : 'imported_calibration_not_independently_verified',
    }),
  };
  refs.push({ kind: 'sources', id: sourceId });
  if (after) {
    const fields = (['assetId', 'imageToWorld', 'method'] as const).filter(field => !before || !sameValue(before[field], after[field]));
    const provenance = after.provenance;
    provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), ...Object.values(provenance.fieldSources ?? {}), sourceId])];
    for (const field of fields) provenance.fieldSources = { ...provenance.fieldSources, [field]: sourceId };
  }
  return [...new Map(refs.map(ref => [ref.kind + '/' + ref.id, ref])).values()];
}
