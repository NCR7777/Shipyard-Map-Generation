import type { Facility, Issue, Source, YardMap, Zone } from './model';
import { contentHash } from './serialization';
import { sameValue } from './value';
import { sourceId } from './geometrySources';
import { TopologyError } from './topologyEditing';

export const SEMANTIC_NAMESPACE = 'org.shipyard.fast_trace.semantic';
export type SemanticField = 'kind' | 'name';
export interface SemanticPatchItem {
  entityType: 'facilities' | 'zones'; entityId: string; field: SemanticField;
  before: string; after: string; origin: 'inferred'; evidenceGrade: 'high' | 'medium' | 'low'; evidence: string; imageRef: string;
}
export interface SemanticPatchFile { formatVersion: '1.0'; mapId: string; baseMapContentHash: string; patches: SemanticPatchItem[] }
export interface SemanticFieldState {
  origin: 'inferred' | 'manual'; locked: boolean; sourceRef: string;
  evidenceGrade?: 'high' | 'medium' | 'low'; evidence?: string; imageRef?: string; before?: string; after?: string;
}
export interface SemanticPatchPreview {
  ok: boolean; issues: Issue[]; readyCount: number;
  items: { index: number; patch: SemanticPatchItem; status: 'ready' | 'protected' | 'low_evidence' | 'semantic_impact' | 'unchanged'; reason: string }[];
}
export interface ApplySemanticPatchCommand { type: 'applySemanticPatch'; patch: SemanticPatchFile }
type SemanticEntity = Facility | Zone;
const FACILITY_KINDS = ['building', 'workshop', 'yard', 'assembly', 'dock', 'quay', 'other'];
const ZONE_KINDS = ['unclassified', 'work', 'drivable', 'forbidden', 'water', 'buffer', 'waiting', 'obstacle'];
const IMPACT_ZONE_KINDS = ['drivable', 'forbidden', 'water', 'obstacle'];
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function text(value: unknown, limit = 2048): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
function issue(code: string, message: string, jsonPath = ''): Issue { return { code, severity: 'error', jsonPath, message, suggestedAction: '保留当前地图，修正补丁或重新导出当前版本的补标包。' }; }

export function getSemanticFieldState(entity: SemanticEntity, field: SemanticField): SemanticFieldState | null {
  const payload = entity.extensions?.[SEMANTIC_NAMESPACE];
  if (!object(payload) || !object(payload.fields)) return null;
  const value = payload.fields[field];
  return object(value) && (value.origin === 'inferred' || value.origin === 'manual') && typeof value.locked === 'boolean' && typeof value.sourceRef === 'string' ? value as unknown as SemanticFieldState : null;
}
export function isInferredSemantic(entity: SemanticEntity, field: SemanticField = 'kind'): boolean { return getSemanticFieldState(entity, field)?.origin === 'inferred'; }
function assertNamespace(map: YardMap, entity?: SemanticEntity): void {
  const declaration = map.extensionNamespaces[SEMANTIC_NAMESPACE];
  if (declaration && (declaration.version !== '1.0' || declaration.category !== 'metadata')) throw new TopologyError('SEMANTIC_NAMESPACE_CONFLICT', '语义注释命名空间已有不兼容声明。');
  const payload = entity?.extensions?.[SEMANTIC_NAMESPACE];
  if (payload !== undefined && (!object(payload) || !exactKeys(payload, ['fields']) || !object(payload.fields) || Object.keys(payload.fields).some(field => !['kind', 'name'].includes(field) || !getSemanticFieldState(entity!, field as SemanticField)))) throw new TopologyError('SEMANTIC_NAMESPACE_CONFLICT', '保留未知语义注释载荷，不能自动覆盖。');
}
function writeField(map: YardMap, entity: SemanticEntity, field: SemanticField, state: SemanticFieldState): void {
  assertNamespace(map, entity);
  map.extensionNamespaces[SEMANTIC_NAMESPACE] ??= { version: '1.0', category: 'metadata' };
  const payload = entity.extensions?.[SEMANTIC_NAMESPACE] as { fields: Record<string, SemanticFieldState> } | undefined;
  entity.extensions = { ...entity.extensions, [SEMANTIC_NAMESPACE]: { fields: { ...payload?.fields, [field]: state } } };
}
function protectedField(map: YardMap, entity: SemanticEntity, patch: SemanticPatchItem): boolean {
  const state = getSemanticFieldState(entity, patch.field);
  if (state?.locked || state?.origin === 'manual') return true;
  const source = map.sources[entity.provenance.fieldSources?.[patch.field] ?? ''];
  if (source?.category === 'surveyed') return true;
  if (state?.origin === 'inferred') return false;
  if (patch.field === 'kind') return entity.kind !== (patch.entityType === 'facilities' ? 'building' : 'unclassified');
  return !/^(建筑|区域)\d+$/.test(entity.name);
}

/** Strict file-boundary parser and one batch preview; no arbitrary JSON paths are executable. */
export function previewSemanticPatch(map: YardMap, input: unknown): SemanticPatchPreview {
  const result: SemanticPatchPreview = { ok: false, issues: [], items: [], readyCount: 0 };
  if (!object(input) || !exactKeys(input, ['formatVersion', 'mapId', 'baseMapContentHash', 'patches']) || input.formatVersion !== '1.0' || !text(input.mapId, 128) || !text(input.baseMapContentHash, 128) || !Array.isArray(input.patches) || !input.patches.length || input.patches.length > 4096) {
    result.issues.push(issue('SEMANTIC_PATCH_FORMAT', '补丁必须为 1.0 格式，包含地图绑定和 1 至 4096 项限字段语义建议。')); return result;
  }
  if (input.mapId !== map.mapId || input.baseMapContentHash !== contentHash(map)) { result.issues.push(issue('SEMANTIC_PATCH_STALE', '补丁基于另一地图或过期内容，请重新导出补标包。')); return result; }
  try { assertNamespace(map); } catch (error) { result.issues.push(issue('SEMANTIC_NAMESPACE_CONFLICT', (error as Error).message)); return result; }
  const seen = new Set<string>();
  for (const [index, value] of input.patches.entries()) {
    const path = '/patches/' + index;
    if (!object(value) || !exactKeys(value, ['entityType', 'entityId', 'field', 'before', 'after', 'origin', 'evidenceGrade', 'evidence', 'imageRef']) || !['facilities', 'zones'].includes(String(value.entityType)) || !text(value.entityId, 128) || !['kind', 'name'].includes(String(value.field)) || typeof value.before !== 'string' || !text(value.after, 256) || value.origin !== 'inferred' || !['high', 'medium', 'low'].includes(String(value.evidenceGrade)) || !text(value.evidence) || !text(value.imageRef, 1024) || /^[\\/]|^[A-Za-z]+:/.test(String(value.imageRef)) || String(value.imageRef).split(/[\\/]/).includes('..')) {
      result.issues.push(issue('SEMANTIC_PATCH_FIELD', '仅接收设施/区域的 kind 或 name、旧新值与完整推测证据；几何和运行参数不在允许名单。', path)); continue;
    }
    const patch = value as unknown as SemanticPatchItem, key = patch.entityType + '/' + patch.entityId + '/' + patch.field;
    const entity = map[patch.entityType][patch.entityId];
    if (!entity || seen.has(key)) { result.issues.push(issue('SEMANTIC_PATCH_REFERENCE', '实体不存在或同一字段重复出现。', path)); continue; }
    seen.add(key);
    try { assertNamespace(map, entity); } catch (error) { result.issues.push(issue('SEMANTIC_NAMESPACE_CONFLICT', (error as Error).message, path)); continue; }
    if (entity[patch.field] !== patch.before) { result.issues.push(issue('SEMANTIC_PATCH_BEFORE', '字段旧值与当前地图不一致。', path + '/before')); continue; }
    if (patch.field === 'kind' && !(patch.entityType === 'facilities' ? FACILITY_KINDS : ZONE_KINDS).includes(patch.after)) { result.issues.push(issue('SEMANTIC_PATCH_KIND', '该类别不在已实现的类别列表内。', path + '/after')); continue; }
    let status: SemanticPatchPreview['items'][number]['status'] = 'ready', reason = '可批量应用；仍标记为推测。';
    if (patch.after === patch.before) { status = 'unchanged'; reason = '字段值未改变。'; }
    else if (protectedField(map, entity, patch)) { status = 'protected'; reason = '保留人工已定、已锁定或既有明确类别。'; }
    else if (patch.evidenceGrade === 'low') { status = 'low_evidence'; reason = '证据不足，保留通用类别供后续复核。'; }
    else if (patch.field === 'kind' && patch.entityType === 'zones' && IMPACT_ZONE_KINDS.includes(patch.after)) { status = 'semantic_impact'; reason = '该类别影响通行或障碍解释，需要独立研究配置；本语义批次不修改。'; }
    result.items.push({ index, patch, status, reason });
    if (status === 'ready') result.readyCount++;
  }
  result.ok = result.issues.length === 0;
  return result;
}

/** Mutates only the standard command's disposable candidate, once for the whole accepted batch. */
export function runSemanticPatch(map: YardMap, command: ApplySemanticPatchCommand): void {
  const preview = previewSemanticPatch(map, command.patch);
  if (!preview.ok) { const first = preview.issues[0]!; throw new TopologyError(first.code, first.message, first.jsonPath); }
  const source: Source = { name: 'Codex 用途推测（未现场核验）', category: 'imagery_derived', description: JSON.stringify({ origin: 'inferred', baseMapContentHash: command.patch.baseMapContentHash, meaning: '原始影像与上下文辅助分类；证据等级不是准确率，不改变人工轮廓、物理限制或资源。' }) };
  const id = sourceId(map, 'source_semantic_inferred', source);
  for (const item of preview.items) {
    if (item.status !== 'ready') continue;
    map.sources[id] ??= source;
    const patch = item.patch, entity = map[patch.entityType][patch.entityId]!;
    const oldSource = entity.provenance.fieldSources?.[patch.field];
    if (patch.field === 'name') entity.name = patch.after;
    else if (patch.entityType === 'facilities') map.facilities[patch.entityId]!.kind = patch.after as Facility['kind'];
    else map.zones[patch.entityId]!.kind = patch.after as Zone['kind'];
    entity.provenance = { ...entity.provenance, sourceRefs: [...new Set([...(entity.provenance.sourceRefs ?? []), ...(oldSource ? [oldSource] : []), id])], fieldSources: { ...entity.provenance.fieldSources, [patch.field]: id } };
    writeField(map, entity, patch.field, { origin: 'inferred', locked: false, sourceRef: id, evidenceGrade: patch.evidenceGrade, evidence: patch.evidence, imageRef: patch.imageRef, before: patch.before, after: patch.after });
  }
}

/** Existing property commands mark explicit user overrides, so later model batches cannot overwrite them. */
export function recordManualSemanticChanges(map: YardMap, before: SemanticEntity, after: SemanticEntity, fields: readonly SemanticField[]): void {
  const changed = fields.filter(field => !sameValue(before[field], after[field]));
  if (!changed.length) return;
  const source: Source = { name: '人工确定的类别或名称', category: 'drawing', description: '用户通过编辑器明确修改的语义字段，优先于后续模型推测；不代表测绘几何或物理参数。' };
  const id = sourceId(map, 'source_semantic_manual', source); map.sources[id] ??= source;
  for (const field of changed) {
    const previous = before.provenance.fieldSources?.[field];
    after.provenance = { ...after.provenance, sourceRefs: [...new Set([...(after.provenance.sourceRefs ?? []), ...(previous ? [previous] : []), id])], fieldSources: { ...after.provenance.fieldSources, [field]: id } };
    writeField(map, after, field, { origin: 'manual', locked: true, sourceRef: id, before: before[field], after: after[field] });
  }
}
