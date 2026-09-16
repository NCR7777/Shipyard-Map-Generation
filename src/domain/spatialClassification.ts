import type { Issue, PhysicalValue, YardMap } from './model';
import type { DesignAssumption } from './commands';
import { sameValue } from './value';

export const SPATIAL_CLASSIFICATION_NAMESPACE = 'org.shipyard.spatial_classification';
export type SpatialCollection = 'facilities' | 'zones';
export interface SpatialClassDefinition { id: string; label: string; appliesTo: [SpatialCollection] }
export interface SpatialClassification { classId: string; depthM?: PhysicalValue; depthReference?: string }
export interface SetSpatialClassesCommand { type: 'setSpatialClasses'; customClasses: SpatialClassDefinition[] }
const NS = SPATIAL_CLASSIFICATION_NAMESPACE;
const ROOT = '/extensions/' + NS;
const DECLARATION = '/extensionNamespaces/' + NS;
const DEPTH_FIELD = NS + '.depthM';
const COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
const builtin = (kind: SpatialCollection, entries: [string, string][]): SpatialClassDefinition[] => entries.map(([id, label]) => ({ id, label, appliesTo: [kind] }));
export const BUILTIN_SPATIAL_CLASSES: readonly SpatialClassDefinition[] = [
  ...builtin('facilities', [['building', '通用建筑'], ['workshop', '生产厂房'], ['warehouse', '仓库'], ['office', '办公楼'], ['residential', '宿舍/生活建筑'], ['power_house', '动力站房'], ['maintenance_workshop', '维修厂房'], ['paint_workshop', '涂装厂房'], ['assembly_workshop', '装配厂房'], ['security_house', '门卫室']]),
  ...builtin('zones', [['unclassified', '未分类区域'], ['dry_dock', '干船坞'], ['yard', '堆场'], ['assembly_yard', '总组场地'], ['quay', '码头作业区'], ['water', '水域'], ['parking', '停车区'], ['buffer', '缓冲区'], ['slipway', '船台区域'], ['logistics', '物流作业区'], ['road_reserve', '道路预留区'], ['restricted', '禁入区']]),
];
export class SpatialClassificationError extends Error {
  constructor(readonly code: string, message: string, readonly path: string) { super(message); }
}
function fail(code: string, message: string, path: string): never { throw new SpatialClassificationError(code, message, path); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function text(value: unknown, limit: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= limit; }
function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  const key = Object.keys(value).find(key => !allowed.includes(key));
  if (key !== undefined) fail('SPATIAL_CLASSIFICATION_FIELD', '不支持的分类字段：' + key + '；原始数据不会被覆盖。', path + '/' + key);
}
function validId(value: unknown): value is string { return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value); }
function assertNamespace(map: YardMap): void {
  const declaration = map.extensionNamespaces[NS];
  if (declaration && (declaration.version !== '1.0' || declaration.category !== 'metadata')) fail('SPATIAL_CLASSIFICATION_VERSION', '分类扩展版本或类别不受支持；保留原数据，仅禁止编辑该扩展。', DECLARATION);
}
function parseClasses(value: unknown, path = ROOT + '/customClasses'): SpatialClassDefinition[] {
  if (!Array.isArray(value) || value.length > 128) fail('SPATIAL_CLASSES_FORMAT', '自定义分类必须为最多 128 项的数组。', path);
  const ids = new Set(BUILTIN_SPATIAL_CLASSES.map(item => item.id));
  return value.map((entry: unknown, index) => {
    const p = path + '/' + index;
    if (!object(entry)) fail('SPATIAL_CLASSES_FORMAT', '分类定义必须是对象。', p);
    keys(entry, ['id', 'label', 'appliesTo'], p);
    if (!validId(entry.id) || ids.has(entry.id)) fail('SPATIAL_CLASS_ID', '分类 ID 必须是唯一稳定的小写字母、数字或下划线，不得占用内置分类 ID。', p + '/id');
    if (!text(entry.label, 80)) fail('SPATIAL_CLASS_LABEL', '分类名称必须为 1 至 80 个字符。', p + '/label');
    if (!Array.isArray(entry.appliesTo) || entry.appliesTo.length !== 1 || !['facilities', 'zones'].includes(entry.appliesTo[0])) fail('SPATIAL_CLASS_SCOPE', '建筑与区域分类必须分开，每个分类只适用于一个集合。', p + '/appliesTo');
    ids.add(entry.id);
    return { id: entry.id, label: entry.label, appliesTo: [entry.appliesTo[0] as SpatialCollection] };
  });
}
function catalog(map: YardMap): SpatialClassDefinition[] {
  assertNamespace(map);
  const root = map.extensions[NS];
  if (root === undefined) return [];
  if (!object(root)) fail('SPATIAL_CLASSES_FORMAT', '分类目录必须为对象。', ROOT);
  keys(root, ['customClasses'], ROOT);
  return parseClasses(root.customClasses);
}
function parseClassification(map: YardMap, kind: SpatialCollection, value: unknown, path: string, classes: readonly SpatialClassDefinition[]): SpatialClassification {
  if (!object(value)) fail('SPATIAL_CLASSIFICATION_FORMAT', '对象分类必须为明确的分类声明。', path);
  keys(value, ['classId', 'depthM', 'depthReference'], path);
  const definition = classes.find(entry => entry.id === value.classId);
  if (!definition) fail('SPATIAL_CLASS_REFERENCE', '详细分类不存在，不能保存悬空分类引用。', path + '/classId');
  if (!definition.appliesTo.includes(kind)) fail('SPATIAL_CLASS_SCOPE', '建筑与区域不能混用分类。', path + '/classId');
  if (kind === 'facilities' && (value.depthM !== undefined || value.depthReference !== undefined)) fail('SPATIAL_DEPTH_SCOPE', '结构深度仅属于区域；建筑不能声明干船坞深度。', path + '/depthM');
  if (value.depthReference !== undefined && !text(value.depthReference, 200)) fail('SPATIAL_DEPTH_REFERENCE', '深度参照面必须为非空文字，最多 200 个字符。', path + '/depthReference');
  if (value.depthM !== undefined) {
    if (!object(value.depthM)) fail('SPATIAL_DEPTH_VALUE', '结构深度必须明确为已知值或未知。', path + '/depthM');
    const depth = value.depthM;
    if (depth.state === 'known') {
      keys(depth, ['state', 'value', 'sourceRef'], path + '/depthM');
      if (typeof depth.value !== 'number' || !Number.isFinite(depth.value) || depth.value <= 0) fail('SPATIAL_DEPTH_VALUE', '结构深度必须是向参照面下方量取的有限正数，单位 m。', path + '/depthM/value');
      if (!text(value.depthReference, 200)) fail('SPATIAL_DEPTH_REFERENCE', '已知深度必须明确参照面，例如坞口标高或已知高程基准。', path + '/depthReference');
      if (typeof depth.sourceRef !== 'string' || !Object.hasOwn(map.sources, depth.sourceRef)) fail('KNOWN_SOURCE_REQUIRED', '已知深度必须引用现有来源，或明确提交设计假设。', path + '/depthM/sourceRef');
    } else if (depth.state === 'unknown') {
      keys(depth, ['state', 'reason'], path + '/depthM');
      if (depth.reason !== undefined && !text(depth.reason, 2000)) fail('SPATIAL_DEPTH_VALUE', '未知深度的说明必须为非空文字，最多 2000 个字符。', path + '/depthM/reason');
    } else fail('SPATIAL_DEPTH_VALUE', '结构深度只接受已知正数或未知，不以无限制、不适用或空值代替。', path + '/depthM/state');
  }
  return structuredClone(value) as unknown as SpatialClassification;
}
function entityPath(kind: SpatialCollection, id: string): string { return '/' + kind + '/' + id.replace(/~/g, '~0').replace(/\//g, '~1') + '/extensions/' + NS; }
function asIssue(error: unknown): Issue {
  const e = error as SpatialClassificationError;
  return { code: e.code, severity: 'error', jsonPath: e.path, message: e.message, suggestedAction: '修正分类、适用范围或深度来源；保留现有几何与引用。' };
}
/** Called at JSON/command boundaries; unknown metadata versions remain losslessly readable. */
export function inspectSpatialClassification(map: YardMap): { supported: boolean; issues: Issue[] } {
  const declaration = map.extensionNamespaces[NS];
  if (declaration && (declaration.version !== '1.0' || declaration.category !== 'metadata')) return { supported: false, issues: [{ code: 'SPATIAL_CLASSIFICATION_VERSION', severity: 'warning', jsonPath: DECLARATION, message: '分类扩展版本或类别不受支持；未校验其载荷，保留原数据。', suggestedAction: '普通属性仍可编辑；使用支持该版本的工具编辑分类。' }] };
  let classes: SpatialClassDefinition[];
  try { classes = [...BUILTIN_SPATIAL_CLASSES, ...catalog(map)]; } catch (error) { return { supported: false, issues: [asIssue(error)] }; }
  const issues: Issue[] = [];
  if (map.metadata.extensions?.[NS] !== undefined) issues.push({ code: 'SPATIAL_CLASS_SCOPE', severity: 'error', jsonPath: '/metadata/extensions/' + NS, message: '分类目录应保存到地图根 extensions，不能保存到 metadata 内。', suggestedAction: '保留原数据并修正扩展位置。' });
  for (const kind of ['facilities', 'zones'] as const) for (const [id, entity] of Object.entries(map[kind])) {
    const value = entity.extensions?.[NS];
    if (value !== undefined) try { parseClassification(map, kind, value, entityPath(kind, id), classes); } catch (error) { issues.push(asIssue(error)); }
  }
  for (const kind of COLLECTIONS.filter(kind => kind !== 'facilities' && kind !== 'zones')) for (const [id, entity] of Object.entries(map[kind])) if (entity.extensions?.[NS] !== undefined) issues.push({ code: 'SPATIAL_CLASS_SCOPE', severity: 'error', jsonPath: '/' + kind + '/' + id + '/extensions/' + NS, message: '空间分类只能声明在建筑或区域对象上。', suggestedAction: '保留该对象原有数据，修正分类扩展的所属集合。' });
  return { supported: !issues.length, issues };
}
export function getSpatialClasses(map: YardMap, kind?: SpatialCollection): SpatialClassDefinition[] {
  let custom: SpatialClassDefinition[] = [];
  try { custom = catalog(map); } catch { /* Unknown declarations cannot supply editable custom definitions. */ }
  return structuredClone([...BUILTIN_SPATIAL_CLASSES, ...custom].filter(entry => !kind || entry.appliesTo.includes(kind)));
}
export function getSpatialClassification(map: YardMap, kind: SpatialCollection, id: string): SpatialClassification | undefined {
  const value = map[kind][id]?.extensions?.[NS];
  if (value === undefined) return undefined;
  try { return parseClassification(map, kind, value, entityPath(kind, id), [...BUILTIN_SPATIAL_CLASSES, ...catalog(map)]); } catch { return undefined; }
}
export function spatialClassificationEditable(map: YardMap, kind?: SpatialCollection, id?: string): boolean {
  try {
    const classes = [...BUILTIN_SPATIAL_CLASSES, ...catalog(map)];
    if (kind && id) {
      const entity = map[kind][id]; if (!entity) return false;
      if (entity.extensions?.[NS] !== undefined) parseClassification(map, kind, entity.extensions[NS], entityPath(kind, id), classes);
    }
    return true;
  } catch { return false; }
}
export function allocateSpatialClassId(map: YardMap): string {
  const ids = new Set(getSpatialClasses(map).map(entry => entry.id));
  let index = 1; while (ids.has('custom_class_' + String(index).padStart(3, '0'))) index++;
  return 'custom_class_' + String(index).padStart(3, '0');
}
/** Mutates a disposable command candidate, never the caller's current map. */
export function setSpatialClasses(map: YardMap, customClasses: SpatialClassDefinition[]): void {
  catalog(map);
  const next = parseClasses(customClasses);
  const classes = [...BUILTIN_SPATIAL_CLASSES, ...next];
  for (const kind of ['facilities', 'zones'] as const) for (const [id, entity] of Object.entries(map[kind])) if (entity.extensions?.[NS] !== undefined) parseClassification(map, kind, entity.extensions[NS], entityPath(kind, id), classes);
  map.extensionNamespaces[NS] ??= { version: '1.0', category: 'metadata' };
  map.extensions[NS] = { customClasses: next };
}
export function applySpatialClassification(map: YardMap, kind: SpatialCollection, id: string, input: SpatialClassification | null, assumption?: DesignAssumption): void {
  const classes = [...BUILTIN_SPATIAL_CLASSES, ...catalog(map)], entity = map[kind][id];
  if (!entity) fail('SPATIAL_CLASS_REFERENCE', '待分类对象不存在。', '/' + kind + '/' + id);
  const path = entityPath(kind, id), previous = entity.extensions?.[NS];
  const old = previous === undefined ? undefined : parseClassification(map, kind, previous, path, classes);
  if (sameValue(previous, input) || previous === undefined && input === null) return;
  const value = structuredClone(input);
  if (value?.depthM?.state === 'known' && !value.depthM.sourceRef && assumption) {
    if (typeof assumption.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(assumption.id) || ['constructor', 'prototype', '__proto__'].includes(assumption.id)) fail('SPATIAL_SOURCE_ID', '设计假设来源 ID 必须是安全的稳定标识。', '/sources');
    if (COLLECTIONS.some(kind => Object.hasOwn(map[kind], assumption.id))) fail('DUPLICATE_ENTITY_ID', '设计假设来源 ID 已存在；如需复用现有来源，请明确填写 sourceRef。', '/sources/' + assumption.id);
    map.sources[assumption.id] = { name: assumption.name ?? '人工结构深度设计假设', category: 'design_assumption', description: assumption.description ?? '用户明确输入的结构深度假设；从声明的参照面向下量取，未经现场测量核验。' };
    value.depthM.sourceRef = assumption.id;
  }
  if (value !== null) parseClassification(map, kind, value, path, classes);
  const oldSource = old?.depthM?.state === 'known' ? old.depthM.sourceRef : undefined;
  const oldFieldSource = entity.provenance.fieldSources?.[DEPTH_FIELD];
  if (!sameValue(old?.depthM, value?.depthM) && (oldSource || oldFieldSource)) entity.provenance.sourceRefs = [...new Set([...(entity.provenance.sourceRefs ?? []), ...[oldSource, oldFieldSource].filter((source): source is string => !!source)])];
  if (value?.depthM?.state === 'known') entity.provenance.fieldSources = { ...entity.provenance.fieldSources, [DEPTH_FIELD]: value.depthM.sourceRef! };
  else if (entity.provenance.fieldSources) { delete entity.provenance.fieldSources[DEPTH_FIELD]; if (!Object.keys(entity.provenance.fieldSources).length) delete entity.provenance.fieldSources; }
  if (value === null) {
    if (entity.extensions) { delete entity.extensions[NS]; if (!Object.keys(entity.extensions).length) delete entity.extensions; }
  } else {
    map.extensionNamespaces[NS] ??= { version: '1.0', category: 'metadata' };
    entity.extensions = { ...entity.extensions, [NS]: value };
  }
}
