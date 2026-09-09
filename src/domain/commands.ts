import type { AccessPoint, Facility, Issue, MapNode, MapRoad, PhysicalValue, ServicePoint, Vec3, YardMap, Zone } from './model';
import { validateMap } from '../validation/validate';
import { mapCapabilities } from './capabilities';
import { contentHash, serializeMap } from './serialization';
import { transformPolygon } from '../geometry/polygons';
import { polylineLength2D, roadPoints } from '../geometry/roads';
import { newNode } from './factory';

export interface Selection { nodes: string[]; roads: string[]; facilities?: string[]; zones?: string[]; accessPoints?: string[]; servicePoints?: string[] }
export const SELECTION_KINDS = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints'] as const;
export type SelectionKind = typeof SELECTION_KINDS[number];
export type FullSelection = Record<SelectionKind, string[]>;
export type FacilityMovePolicy = 'boundaryOnly' | 'withAssociatedNodes';
export interface DesignAssumption { id: string; name?: string; description?: string }
export interface SplitMapping { oldRoadId: string; newRoadIds: [string, string]; nodeId: string }
export const LINEAGE_NAMESPACE = 'org.shipyard.editor.lineage';
export const SPLIT_TOLERANCE_M = 1e-6;
interface NewPointNode { id: string; node: MapNode }
export type MapCommand =
  | { type: 'addNode'; id: string; node: MapNode }
  | { type: 'addRoad'; id: string; road: MapRoad }
  | { type: 'updateNode'; id: string; patch: Partial<Pick<MapNode, 'name' | 'position'>> }
  | { type: 'updateRoad'; id: string; patch: Partial<Pick<MapRoad, 'name' | 'shapePoints' | 'direction' | 'widthM' | 'heightLimitM' | 'massLimitKg' | 'speedLimitMps'>>; designAssumption?: DesignAssumption }
  | { type: 'addFacility'; id: string; facility: Facility }
  | { type: 'updateFacility'; id: string; patch: Partial<Pick<Facility, 'name' | 'kind' | 'boundary' | 'heightM'>>; designAssumption?: DesignAssumption }
  | { type: 'addZone'; id: string; zone: Zone }
  | { type: 'updateZone'; id: string; patch: Partial<Pick<Zone, 'name' | 'kind' | 'boundary' | 'passability'>> }
  | { type: 'addAccessPoint'; id: string; accessPoint: AccessPoint; newNode?: NewPointNode }
  | { type: 'updateAccessPoint'; id: string; patch: Partial<Pick<AccessPoint, 'name' | 'facilityId' | 'nodeId'>>; newNode?: NewPointNode }
  | { type: 'addServicePoint'; id: string; servicePoint: ServicePoint; newNode?: NewPointNode }
  | { type: 'updateServicePoint'; id: string; patch: Partial<Pick<ServicePoint, 'name' | 'kind' | 'nodeId'>> & { facilityId?: string | null; accessPointId?: string | null }; newNode?: NewPointNode }
  | { type: 'renameMap'; name: string }
  | { type: 'translateSelection'; selection: Selection; delta: Vec3; facilityMovePolicy?: FacilityMovePolicy }
  | { type: 'rotateSelection'; selection: Selection; pivot: Vec3; angleRad: number; facilityMovePolicy?: FacilityMovePolicy }
  | { type: 'duplicateSelection'; selection: Selection; delta: Vec3; idMap: Record<string, string>; associationPolicy?: 'retainFacility' | 'rejectExternal' }
  | { type: 'deleteSelection'; selection: Selection; facilityPolicy?: 'reject' | 'withAssociatedPoints'; orphanNodes?: 'keep' | 'deleteUnused' }
  | { type: 'splitRoad'; id: string; distanceM: number; nodeId: string; existingNode?: boolean; newRoadIds: [string, string] };

export interface Transaction { before: YardMap; after: YardMap; label: string }
export type CommandResult =
  | { ok: true; map: YardMap; changed: boolean; transaction?: Transaction; mapping?: SplitMapping }
  | { ok: false; issues: Issue[] };
class CommandError extends Error { constructor(readonly code: string, message: string, readonly path = '') { super(message); } }
function problem(code: string, message: string, jsonPath = ''): Issue {
  const parts = jsonPath.split('/');
  return { code, severity: 'error', jsonPath, message, ...(SELECTION_KINDS.includes(parts[1] as SelectionKind) && parts[2] ? { entityType: parts[1], entityId: parts[2] } : {}), suggestedAction: '检查选中对象、显式策略、引用和输入后重试。' };
}
function fail(code: string, message: string, path = ''): never { throw new CommandError(code, message, path); }
export function normalizeSelection(selection: Selection): FullSelection {
  const result = {} as FullSelection;
  for (const kind of SELECTION_KINDS) {
    const values = selection[kind] ?? [];
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('INVALID_SELECTION', '选择必须是 ID 数组。');
    result[kind] = [...new Set(values)].sort();
  }
  return result;
}
function assertSelection(map: YardMap, selection: Selection): FullSelection {
  const selected = normalizeSelection(selection);
  for (const kind of SELECTION_KINDS) for (const id of selected[kind]) if (!Object.hasOwn(map[kind], id)) fail('INVALID_COMMAND', `不存在 ${kind}/${id}`);
  return selected;
}
function addFacilityMembers(map: YardMap, selected: FullSelection): void {
  for (const id of selected.facilities) {
    selected.accessPoints.push(...map.facilities[id]!.accessPointIds);
    selected.servicePoints.push(...map.facilities[id]!.servicePointIds);
  }
}
function addPointNodes(map: YardMap, selected: FullSelection): void {
  for (const id of selected.accessPoints) selected.nodes.push(map.accessPoints[id]!.nodeId);
  for (const id of selected.servicePoints) selected.nodes.push(map.servicePoints[id]!.nodeId);
}
/** Copy closure includes facility membership and point coordinates, never adjacent external roads. */
export function closureSelection(map: YardMap, selection: Selection): FullSelection {
  const selected = assertSelection(map, selection);
  addFacilityMembers(map, selected);
  for (const id of selected.servicePoints) {
    const access = map.servicePoints[id]!.accessPointId;
    if (access) selected.accessPoints.push(access);
  }
  addPointNodes(map, selected);
  for (const id of selected.roads) selected.nodes.push(map.roads[id]!.fromNodeId, map.roads[id]!.toNodeId);
  return normalizeSelection(selected);
}
export function selectionImpact(map: YardMap, selection: Selection, facilityMovePolicy: FacilityMovePolicy = 'boundaryOnly'): { selection: FullSelection; affectedRoadIds: string[]; sharedNodeIds: string[] } {
  const selected = assertSelection(map, selection);
  if (facilityMovePolicy === 'withAssociatedNodes') addFacilityMembers(map, selected);
  else if (facilityMovePolicy !== 'boundaryOnly') fail('INVALID_MOVE_POLICY', '未知设施移动策略。');
  addPointNodes(map, selected);
  for (const id of selected.roads) selected.nodes.push(map.roads[id]!.fromNodeId, map.roads[id]!.toNodeId);
  const complete = normalizeSelection(selected); const nodes = new Set(complete.nodes); const roads = new Set(complete.roads); const shared = new Set<string>();
  const affectedRoadIds: string[] = [];
  for (const [id, road] of Object.entries(map.roads)) {
    if (roads.has(id) || nodes.has(road.fromNodeId) || nodes.has(road.toNodeId)) affectedRoadIds.push(id);
    if (!roads.has(id)) for (const nodeId of [road.fromNodeId, road.toNodeId]) if (nodes.has(nodeId)) shared.add(nodeId);
  }
  return { selection: complete, affectedRoadIds: affectedRoadIds.sort(), sharedNodeIds: [...shared].sort() };
}
export function freezeMap(map: YardMap): YardMap {
  const freeze = (value: unknown): void => { if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } };
  freeze(map); return map;
}
function existsId(map: YardMap, id: string): boolean {
  return (['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const).some(key => Object.hasOwn(map[key], id));
}
function put<T>(map: YardMap, collection: Record<string, T>, id: string, value: T): void {
  if (existsId(map, id)) fail('DUPLICATE_ENTITY_ID', 'ID 已存在：' + id);
  Object.defineProperty(collection, id, { value: structuredClone(value), writable: true, enumerable: true, configurable: true });
}
function checkPatch(patch: object, keys: readonly string[]): void { if (Object.keys(patch).some(key => !keys.includes(key))) fail('UNSUPPORTED_PATCH', '补丁包含未经此命令支持的字段。'); }
function checkVector(vector: Vec3): void { if (!Array.isArray(vector) || vector.length !== 3 || vector.some(value => !Number.isFinite(value))) fail('INVALID_COMMAND', '必须输入三个有限米制数值。'); }
function moved(position: Vec3, delta: Vec3): Vec3 { checkVector(delta); return [position[0] + delta[0], position[1] + delta[1], position[2] + delta[2]]; }
function transformSelection(map: YardMap, selected: FullSelection, transform: (point: Vec3) => Vec3): void {
  for (const id of selected.nodes) map.nodes[id]!.position = transform(map.nodes[id]!.position);
  for (const id of selected.roads) map.roads[id]!.shapePoints = map.roads[id]!.shapePoints.map(transform);
  for (const id of selected.facilities) map.facilities[id]!.boundary = transformPolygon(map.facilities[id]!.boundary, transform);
  for (const id of selected.zones) map.zones[id]!.boundary = transformPolygon(map.zones[id]!.boundary, transform);
}
function addPointNode(map: YardMap, nodeId: string, candidate?: NewPointNode): void {
  if (!candidate) return;
  if (candidate.id !== nodeId) fail('POINT_NODE_MISMATCH', '新节点 ID 必须等于点的 nodeId。');
  put(map, map.nodes, candidate.id, candidate.node);
}
function facilityMember(map: YardMap, kind: 'accessPointIds' | 'servicePointIds', pointId: string, oldFacility?: string, newFacility?: string): void {
  if (oldFacility === newFacility) return;
  if (oldFacility && Object.hasOwn(map.facilities, oldFacility)) map.facilities[oldFacility]![kind] = map.facilities[oldFacility]![kind].filter(id => id !== pointId);
  if (newFacility) {
    if (!Object.hasOwn(map.facilities, newFacility)) fail('DANGLING_REFERENCE', '设施不存在：' + newFacility);
    const ids = map.facilities[newFacility]![kind]; if (!ids.includes(pointId)) ids.push(pointId);
  }
}
function samePhysicalValue(a: PhysicalValue | undefined, b: PhysicalValue | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.state !== b.state) return false;
  if (a.state === 'known' && b.state === 'known') return a.value === b.value && a.sourceRef === b.sourceRef;
  return a.state !== 'known' && b.state !== 'known' && a.reason === b.reason;
}
function physicalSources(map: YardMap, previous: MapRoad | Facility, entity: MapRoad | Facility, fields: readonly string[], assumption?: DesignAssumption): void {
  let created = false;
  for (const field of fields) {
    const value = (entity as unknown as Record<string, PhysicalValue>)[field];
    const old = (previous as unknown as Record<string, PhysicalValue>)[field];
    if (!value || samePhysicalValue(value, old)) continue;
    if (value.state !== 'known') {
      if (entity.provenance.fieldSources && Object.hasOwn(entity.provenance.fieldSources, field)) {
        delete entity.provenance.fieldSources[field];
        if (Object.keys(entity.provenance.fieldSources).length === 0) delete entity.provenance.fieldSources;
      }
      continue;
    }
    if (!value.sourceRef) {
      if (!assumption) fail('KNOWN_SOURCE_REQUIRED', `${field} 新的已知值缺少来源，请显式声明设计假设。`);
      if (!created) {
        put(map, map.sources, assumption.id, { name: assumption.name ?? '人工设计参数假设', category: 'design_assumption', description: assumption.description ?? '用户在编辑器中明确输入的设计假设，未经现场测量核验。' });
        created = true;
      }
      value.sourceRef = assumption.id;
    }
    entity.provenance.fieldSources = { ...entity.provenance.fieldSources, [field]: value.sourceRef };
  }
}
function copySelection(map: YardMap, command: Extract<MapCommand, { type: 'duplicateSelection' }>): void {
  const selected = closureSelection(map, command.selection); const sourceIds = SELECTION_KINDS.flatMap(kind => selected[kind]); const targets = new Set<string>();
  for (const kind of SELECTION_KINDS) for (const id of selected[kind]) {
    if (Object.keys(map[kind][id]!.extensions ?? {}).length) fail('UNSUPPORTED_COPY_SEMANTICS', '对象扩展可能含未知引用，不能安全复制：' + id);
    const target = Object.hasOwn(command.idMap, id) ? command.idMap[id] : undefined;
    if (!target || existsId(map, target) || targets.has(target)) fail('INVALID_COPY_ID_MAP', '副本 ID 必须完整、新建且唯一。');
    targets.add(target);
  }
  if (Object.keys(command.idMap).length !== sourceIds.length) fail('INVALID_COPY_ID_MAP', 'ID 映射必须恰好覆盖复制闭包。');
  for (const kind of ['accessPoints', 'servicePoints'] as const) for (const id of selected[kind]) {
    const facilityId = map[kind][id]!.facilityId;
    if (facilityId && !selected.facilities.includes(facilityId) && command.associationPolicy !== 'retainFacility') fail('EXTERNAL_FACILITY_ASSOCIATION', '单独复制点须明确选择仍归属原设施；设施整体复制不会连接回旧设施。');
  }
  for (const id of selected.nodes) { const node = structuredClone(map.nodes[id]!); node.position = moved(node.position, command.delta); put(map, map.nodes, command.idMap[id]!, node); }
  for (const id of selected.roads) {
    const road = structuredClone(map.roads[id]!); road.fromNodeId = command.idMap[road.fromNodeId]!; road.toNodeId = command.idMap[road.toNodeId]!;
    road.shapePoints = road.shapePoints.map(point => moved(point, command.delta)); put(map, map.roads, command.idMap[id]!, road);
  }
  for (const id of selected.facilities) {
    const facility = structuredClone(map.facilities[id]!); facility.boundary = transformPolygon(facility.boundary, point => moved(point, command.delta));
    facility.accessPointIds = facility.accessPointIds.map(pointId => command.idMap[pointId]!); facility.servicePointIds = facility.servicePointIds.map(pointId => command.idMap[pointId]!);
    put(map, map.facilities, command.idMap[id]!, facility);
  }
  for (const id of selected.zones) { const zone = structuredClone(map.zones[id]!); zone.boundary = transformPolygon(zone.boundary, point => moved(point, command.delta)); put(map, map.zones, command.idMap[id]!, zone); }
  for (const id of selected.accessPoints) {
    const point = structuredClone(map.accessPoints[id]!); point.nodeId = command.idMap[point.nodeId]!; point.facilityId = Object.hasOwn(command.idMap, point.facilityId) ? command.idMap[point.facilityId]! : point.facilityId;
    put(map, map.accessPoints, command.idMap[id]!, point); facilityMember(map, 'accessPointIds', command.idMap[id]!, undefined, point.facilityId);
  }
  for (const id of selected.servicePoints) {
    const point = structuredClone(map.servicePoints[id]!); point.nodeId = command.idMap[point.nodeId]!;
    if (point.facilityId) point.facilityId = Object.hasOwn(command.idMap, point.facilityId) ? command.idMap[point.facilityId]! : point.facilityId;
    if (point.accessPointId) point.accessPointId = command.idMap[point.accessPointId]!;
    put(map, map.servicePoints, command.idMap[id]!, point); facilityMember(map, 'servicePointIds', command.idMap[id]!, undefined, point.facilityId);
  }
}
function deleteSelection(map: YardMap, command: Extract<MapCommand, { type: 'deleteSelection' }>): void {
  const selected = assertSelection(map, command.selection);
  for (const id of selected.facilities) {
    const facility = map.facilities[id]!;
    if ((facility.accessPointIds.length || facility.servicePointIds.length) && command.facilityPolicy !== 'withAssociatedPoints') fail('FACILITY_HAS_POINTS', '设施有关联点，请明确选择一并删除成员点并处理其节点。', '/facilities/' + id);
  }
  if (command.facilityPolicy === 'withAssociatedPoints') addFacilityMembers(map, selected);
  const deleted = normalizeSelection(selected); const candidateNodes = new Set<string>();
  for (const kind of ['accessPoints', 'servicePoints'] as const) for (const id of deleted[kind]) candidateNodes.add(map[kind][id]!.nodeId);
  for (const [id, service] of Object.entries(map.servicePoints)) if (!deleted.servicePoints.includes(id) && service.accessPointId && deleted.accessPoints.includes(service.accessPointId)) fail('ENTITY_IN_USE', '服务点仍引用待删除入口，请显式一并选择服务点。', '/servicePoints/' + id + '/accessPointId');
  for (const id of deleted.accessPoints) { facilityMember(map, 'accessPointIds', id, map.accessPoints[id]!.facilityId); delete map.accessPoints[id]; }
  for (const id of deleted.servicePoints) { facilityMember(map, 'servicePointIds', id, map.servicePoints[id]!.facilityId); delete map.servicePoints[id]; }
  for (const kind of ['facilities', 'zones', 'roads'] as const) for (const id of deleted[kind]) delete map[kind][id];
  const uses = (nodeId: string): string | null => {
    for (const [id, road] of Object.entries(map.roads)) for (const field of ['fromNodeId', 'toNodeId'] as const) if (road[field] === nodeId) return '/roads/' + id + '/' + field;
    for (const kind of ['accessPoints', 'servicePoints'] as const) for (const [id, point] of Object.entries(map[kind])) if (point.nodeId === nodeId) return '/' + kind + '/' + id + '/nodeId';
    return null;
  };
  for (const id of deleted.nodes) { const path = uses(id); if (path) fail('ENTITY_IN_USE', '节点 ' + id + ' 仍被引用；保留它或显式一并选择依赖对象。', path); }
  if (command.orphanNodes === 'deleteUnused') for (const id of candidateNodes) if (!uses(id)) deleted.nodes.push(id);
  for (const id of deleted.nodes) delete map.nodes[id];
}
interface Lineage { version: '1.0.0'; roadSplits: (SplitMapping & { distanceM: number; originalLengthM: number })[] }
function splitRoad(map: YardMap, command: Extract<MapCommand, { type: 'splitRoad' }>): SplitMapping {
  assertSelection(map, { nodes: [], roads: [command.id] });
  const road = map.roads[command.id]!;
  if (road.resourceIds.length || road.corridorPolygon || Object.keys(road.extensions ?? {}).length || road.observedLengthM)
    fail('UNSUPPORTED_SPLIT_REFERENCES', '道路含资源、人工边界、扩展或登记长度，尚不能安全拆分其语义。');
  for (const collection of ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'sources'] as const)
    if (Object.values(map[collection]).some(entity => Object.keys(entity.extensions ?? {}).length)) fail('UNSUPPORTED_SPLIT_REFERENCES', '实体扩展可能引用原道路，尚不支持安全重写。');
  if (Object.keys(map.extensions).some(key => key !== LINEAGE_NAMESPACE) || Object.keys(map.metadata.extensions ?? {}).length || Object.keys(map.movements).length || Object.keys(map.resources).length) fail('UNSUPPORTED_SPLIT_REFERENCES', '扩展、转向或资源可能引用原道路；拆分前需支持其明确重写。');
  const declaration = map.extensionNamespaces[LINEAGE_NAMESPACE]; const payload = map.extensions[LINEAGE_NAMESPACE];
  if (declaration && (declaration.version !== '1.0.0' || declaration.category !== 'metadata')) fail('LINEAGE_CONFLICT', '道路沿革命名空间已由不兼容声明占用。');
  let lineage: Lineage = { version: '1.0.0', roadSplits: [] };
  if (payload !== undefined) {
    if (!payload || typeof payload !== 'object' || !('version' in payload) || payload.version !== '1.0.0' || !('roadSplits' in payload) || !Array.isArray(payload.roadSplits) || Object.keys(payload).some(key => !['version', 'roadSplits'].includes(key))) fail('LINEAGE_CONFLICT', '不覆盖未知道路沿革载荷。');
    if (payload.roadSplits.some(entry => !entry || typeof entry !== 'object' || typeof entry.oldRoadId !== 'string' || typeof entry.nodeId !== 'string' || !Array.isArray(entry.newRoadIds) || entry.newRoadIds.length !== 2 || entry.newRoadIds.some((id: unknown) => typeof id !== 'string') || !Number.isFinite(entry.distanceM) || !Number.isFinite(entry.originalLengthM) || Object.keys(entry).some(key => !['oldRoadId', 'newRoadIds', 'nodeId', 'distanceM', 'originalLengthM'].includes(key)))) fail('LINEAGE_CONFLICT', '不覆盖未知沿革条目。');
    lineage = structuredClone(payload) as Lineage;
  }
  const points = roadPoints(map, command.id); const length = polylineLength2D(points);
  if (!Number.isFinite(command.distanceM) || command.distanceM <= SPLIT_TOLERANCE_M || command.distanceM >= length - SPLIT_TOLERANCE_M) fail('INVALID_SPLIT_POSITION', '切分里程必须严格位于道路内部，距端点大于 1e-6 m。');
  if (command.newRoadIds.length !== 2 || command.newRoadIds[0] === command.newRoadIds[1] || command.newRoadIds.some(id => existsId(map, id)) || command.newRoadIds.includes(command.nodeId)) fail('INVALID_SPLIT_IDS', '拆分需要两个新道路 ID，且不能与节点或现有实体冲突。');
  let accumulated = 0; let index = -1; let position: Vec3 | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!; const b = points[i + 1]!; const segment = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (segment > 0 && accumulated + segment >= command.distanceM) { const t = (command.distanceM - accumulated) / segment; position = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]; index = i; break; }
    accumulated += segment;
  }
  if (!position || index < 0) fail('INVALID_SPLIT_POSITION', '无法定位切分点。');
  if (command.existingNode) {
    if (!Object.hasOwn(map.nodes, command.nodeId) || command.nodeId === road.fromNodeId || command.nodeId === road.toNodeId) fail('INVALID_SPLIT_NODE', '显式复用节点必须存在且不同于原端点。');
    const existing = map.nodes[command.nodeId]!.position;
    if (Math.hypot(existing[0] - position[0], existing[1] - position[1], existing[2] - position[2]) > SPLIT_TOLERANCE_M) fail('INVALID_SPLIT_NODE', '已有节点不在切分点 1e-6 m 容差内。');
    position = [...existing];
  } else { const node = newNode(position, road.name + ' / 拆分点'); node.provenance = structuredClone(road.provenance); put(map, map.nodes, command.nodeId, node); }
  const clean = (values: Vec3[]) => values.filter((point, i) => i === 0 || point.some((value, axis) => value !== values[i - 1]![axis]));
  const left = clean([...points.slice(0, index + 1), position]); const right = clean([position, ...points.slice(index + 1)]);
  if (Math.abs(polylineLength2D(left) + polylineLength2D(right) - length) > SPLIT_TOLERANCE_M) fail('SPLIT_LENGTH_MISMATCH', '拆分后水平长度不守恒（容差 1e-6 m）。');
  const first = { ...structuredClone(road), toNodeId: command.nodeId, shapePoints: left.slice(1, -1) };
  const second = { ...structuredClone(road), fromNodeId: command.nodeId, shapePoints: right.slice(1, -1) };
  put(map, map.roads, command.newRoadIds[0], first); put(map, map.roads, command.newRoadIds[1], second); delete map.roads[command.id];
  const mapping: SplitMapping = { oldRoadId: command.id, newRoadIds: [...command.newRoadIds], nodeId: command.nodeId };
  lineage.roadSplits.push({ ...mapping, distanceM: command.distanceM, originalLengthM: length });
  map.extensionNamespaces[LINEAGE_NAMESPACE] = declaration ?? { version: '1.0.0', category: 'metadata' };
  map.extensions[LINEAGE_NAMESPACE] = lineage;
  return mapping;
}

export function applyMapCommand(input: YardMap, command: MapCommand): CommandResult {
  const initial = validateMap(input);
  if (!initial.ok) return { ok: false, issues: initial.issues };
  if (!mapCapabilities(input).editable) return { ok: false, issues: [problem('READ_ONLY_MAP', '该地图含未支持的高级实体或行为，整图只读保护。')] };
  const next = structuredClone(input); let mapping: SplitMapping | undefined;
  try {
    switch (command.type) {
      case 'addNode': put(next, next.nodes, command.id, command.node); break;
      case 'addRoad': put(next, next.roads, command.id, command.road); break;
      case 'updateNode':
        assertSelection(next, { nodes: [command.id], roads: [] }); checkPatch(command.patch, ['name', 'position']); next.nodes[command.id] = { ...next.nodes[command.id]!, ...structuredClone(command.patch) }; break;
      case 'updateRoad': {
        assertSelection(next, { nodes: [], roads: [command.id] }); checkPatch(command.patch, ['name', 'shapePoints', 'direction', 'widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps']);
        const previous = next.roads[command.id]!; const road = { ...previous, ...structuredClone(command.patch), provenance: structuredClone(previous.provenance) };
        physicalSources(next, previous, road, ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps'], command.designAssumption); next.roads[command.id] = road; break;
      }
      case 'addFacility':
        if (command.facility.accessPointIds.length || command.facility.servicePointIds.length) fail('FACILITY_MEMBER_COMMAND_REQUIRED', '先添加空成员设施，再通过点命令原子关联成员。');
        put(next, next.facilities, command.id, command.facility); break;
      case 'updateFacility': {
        assertSelection(next, { nodes: [], roads: [], facilities: [command.id] }); checkPatch(command.patch, ['name', 'kind', 'boundary', 'heightM']);
        const previous = next.facilities[command.id]!; const facility = { ...previous, ...structuredClone(command.patch), provenance: structuredClone(previous.provenance) };
        physicalSources(next, previous, facility, ['heightM'], command.designAssumption); next.facilities[command.id] = facility; break;
      }
      case 'addZone': put(next, next.zones, command.id, command.zone); break;
      case 'updateZone': assertSelection(next, { nodes: [], roads: [], zones: [command.id] }); checkPatch(command.patch, ['name', 'kind', 'boundary', 'passability']); next.zones[command.id] = { ...next.zones[command.id]!, ...structuredClone(command.patch) }; break;
      case 'addAccessPoint':
        addPointNode(next, command.accessPoint.nodeId, command.newNode); put(next, next.accessPoints, command.id, command.accessPoint); facilityMember(next, 'accessPointIds', command.id, undefined, command.accessPoint.facilityId); break;
      case 'updateAccessPoint': {
        assertSelection(next, { nodes: [], roads: [], accessPoints: [command.id] }); checkPatch(command.patch, ['name', 'facilityId', 'nodeId']);
        const previous = next.accessPoints[command.id]!; const point = { ...previous, ...structuredClone(command.patch) };
        addPointNode(next, point.nodeId, command.newNode); facilityMember(next, 'accessPointIds', command.id, previous.facilityId, point.facilityId); next.accessPoints[command.id] = point; break;
      }
      case 'addServicePoint':
        addPointNode(next, command.servicePoint.nodeId, command.newNode); put(next, next.servicePoints, command.id, command.servicePoint); facilityMember(next, 'servicePointIds', command.id, undefined, command.servicePoint.facilityId); break;
      case 'updateServicePoint': {
        assertSelection(next, { nodes: [], roads: [], servicePoints: [command.id] }); checkPatch(command.patch, ['name', 'kind', 'nodeId', 'facilityId', 'accessPointId']);
        const previous = next.servicePoints[command.id]!; const point = structuredClone(previous);
        for (const [field, value] of Object.entries(command.patch)) { if (value === null) delete (point as unknown as Record<string, unknown>)[field]; else Object.defineProperty(point, field, { value: structuredClone(value), writable: true, enumerable: true, configurable: true }); }
        addPointNode(next, point.nodeId, command.newNode); facilityMember(next, 'servicePointIds', command.id, previous.facilityId, point.facilityId); next.servicePoints[command.id] = point; break;
      }
      case 'renameMap': next.metadata.name = command.name; break;
      case 'translateSelection': case 'rotateSelection': {
        const selection = assertSelection(next, command.selection);
        if (selection.facilities.length && command.facilityMovePolicy === undefined) fail('FACILITY_MOVE_POLICY_REQUIRED', '移动设施前必须明确仅边界或连同关联节点。');
        const impact = selectionImpact(next, selection, command.facilityMovePolicy);
        if (command.type === 'translateSelection') transformSelection(next, impact.selection, point => moved(point, command.delta));
        else {
          checkVector(command.pivot); if (!Number.isFinite(command.angleRad)) fail('INVALID_COMMAND', '旋转角度必须为有限弧度。');
          const c = Math.cos(command.angleRad); const s = Math.sin(command.angleRad); const [px, py] = command.pivot;
          transformSelection(next, impact.selection, point => [px + c * (point[0] - px) - s * (point[1] - py), py + s * (point[0] - px) + c * (point[1] - py), point[2]]);
        } break;
      }
      case 'duplicateSelection': copySelection(next, command); break;
      case 'deleteSelection': deleteSelection(next, command); break;
      case 'splitRoad': mapping = splitRoad(next, command); break;
      default: return { ok: false, issues: [problem('UNKNOWN_COMMAND', '未支持的领域命令。')] };
    }
  } catch (error) { return { ok: false, issues: [problem(error instanceof CommandError ? error.code : 'INVALID_COMMAND', error instanceof Error ? error.message : '命令输入无效。', error instanceof CommandError ? error.path : '')] }; }
  const report = validateMap(next);
  if (!report.ok) return { ok: false, issues: report.issues };
  if (contentHash(input) === contentHash(next)) return { ok: true, map: input, changed: false };
  next.revision = input.revision + 1;
  const finalReport = validateMap(next); if (!finalReport.ok) return { ok: false, issues: finalReport.issues };
  try { serializeMap(next); } catch (error) { return { ok: false, issues: [problem('JSON_SIZE_LIMIT', error instanceof Error ? error.message : '规范化 JSON 超过限制。')] }; }
  const before = freezeMap(structuredClone(input)); const after = freezeMap(next);
  return { ok: true, map: after, changed: true, transaction: { before, after, label: command.type }, ...(mapping ? { mapping } : {}) };
}
