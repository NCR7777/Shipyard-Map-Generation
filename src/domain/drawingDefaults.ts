import type { MapRoad, Polygon, Provenance, RoadGeometry, Source, Vec3, YardMap } from './model';
import type { MapCommand, SplitMapping } from './commands';
import { newFacility, newNode, newRoad, newZone } from './factory';
import { sourceId } from './geometrySources';
import { inspectPlanning } from './planning';
import { enumerateMergeTurns, mergeNodes, splitPosition, TopologyError } from './topologyEditing';
import { roadLength } from '../geometry/roads';
import { sameValue } from './value';
import { applySpatialClassification, type SpatialClassification } from './spatialClassification';
import { roadForMap, getRoadPath, pathLength, pathToRoadGeometry, movePathAnchor, intersectPaths, boundsOfPath, type ResolvedPath } from '../geometry/roadPath';

export interface QuickTraceDefaults { widthM: number; direction?: 'both' | 'forward' | 'backward'; connectNewCrossings?: boolean }
export const DEFAULT_QUICK_TRACE_DEFAULTS: Readonly<QuickTraceDefaults> = Object.freeze({ widthM: 12, direction: 'both', connectNewCrossings: true });
export type QuickTraceConnection = { kind: 'node'; nodeId: string } | { kind: 'road'; roadId: string; distanceM: number };
export type QuickTraceCommand =
  | { type: 'quickTraceRoad'; points: Vec3[]; geometry?: RoadGeometry; defaults?: QuickTraceDefaults; startConnection?: QuickTraceConnection; endConnection?: QuickTraceConnection; disconnect?: boolean }
  | { type: 'quickTraceBoundary'; kind: 'building' | 'area'; boundary: Polygon; classification?: SpatialClassification };
type SplitRoad = (map: YardMap, command: Extract<MapCommand, { type: 'splitRoad' }>) => SplitMapping;
export interface QuickTraceResult { geometryPreservedRoadIds: string[]; entityId: string }
const COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
const EPSILON_M = 1e-6;
const DRAWING_SOURCE: Source = { name: '快速描图：人工轮廓', category: 'drawing', description: '用户在本地米制绘图平面手工描绘；可参考底图，未经独立现场核验。通用建筑和区域用途待补标。' };
function fail(code: string, message: string, path = ''): never { throw new TopologyError(code, message, path); }

export function allocateMapIds(map: YardMap): (prefix: string) => string {
  const used = new Set([...COLLECTIONS.flatMap(kind => Object.keys(map[kind])), ...inspectPlanning(map).slots.map(slot => slot.id)]);
  return prefix => { let n = 1, id: string; do { id = prefix + String(n++).padStart(3, '0'); } while (used.has(id)); used.add(id); return id; };
}
function numberedName(entities: Record<string, { name: string }>, prefix: string): string {
  const names = new Set(Object.values(entities).map(entity => entity.name));
  let n = 1; while (names.has(prefix + String(n).padStart(3, '0'))) n++;
  return prefix + String(n).padStart(3, '0');
}
function drawingProvenance(map: YardMap): Provenance {
  const id = sourceId(map, 'source_quick_trace_drawing_v1', DRAWING_SOURCE);
  map.sources[id] ??= { ...DRAWING_SOURCE };
  return { category: 'drawing', sourceRefs: [id], note: '人工描形；用途未确认。' };
}
function defaultsSource(map: YardMap, defaults: QuickTraceDefaults): string {
  const source: Source = { name: '快速描图默认配置 quick_trace_v1', category: 'design_assumption', description: JSON.stringify({ profile: 'quick_trace_v1', widthM: defaults.widthM, direction: defaults.direction ?? 'both', connectNewCrossings: defaults.connectNewCrossings ?? true, turns: 'explicit_connection_direction_compatible_non_uturn', meaning: '新建绘图设计假设；不代表实测净宽、现场交通管理或车辆可行性。' }) };
  const id = sourceId(map, 'source_quick_trace_defaults_v1', source);
  map.sources[id] ??= source;
  return id;
}
function checkPoints(points: Vec3[]): void {
  if (!Array.isArray(points) || points.length < 2 || points.length > 4096 || points.some(p => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite))) fail('QUICK_TRACE_POINTS', '道路需要 2 至 4096 个有限世界坐标点。');
  if (points.some(p => p[2] !== points[0]![2])) fail('LOCAL_NONPLANAR_EDIT', '快速描图保持同一个明确绘图平面。');
}

/** Only explicit endpoint candidates connect. A nearby line or ordinary crossing never changes the old graph. */
function connectionTarget(map: YardMap, connection: QuickTraceConnection | undefined, point: Vec3): { point: Vec3; nodeId?: string; cut?: { roadId: string; distanceM: number } } {
  if (!connection) return { point: [...point] };
  let target: Vec3;
  let nodeId: string | undefined;
  let cut: { roadId: string; distanceM: number } | undefined;
  if (connection.kind === 'node') {
    const node = map.nodes[connection.nodeId];
    if (!node) fail('QUICK_TRACE_CONNECTION', '接入节点不存在。', '/nodes/' + connection.nodeId);
    target = node.position; nodeId = connection.nodeId;
  } else if (connection.kind === 'road') {
    const road = map.roads[connection.roadId];
    if (!road) fail('QUICK_TRACE_CONNECTION', '接入道路不存在。', '/roads/' + connection.roadId);
    const length = roadLength(map, connection.roadId);
    if (!Number.isFinite(connection.distanceM) || connection.distanceM < 0 || connection.distanceM > length) fail('INVALID_SPLIT_POSITION', '接入里程必须位于选定道路上。');
    if (connection.distanceM <= EPSILON_M) nodeId = road.fromNodeId;
    else if (connection.distanceM >= length - EPSILON_M) nodeId = road.toNodeId;
    else cut = { roadId: connection.roadId, distanceM: connection.distanceM };
    target = nodeId ? map.nodes[nodeId]!.position : splitPosition(map, connection.roadId, connection.distanceM);
  } else return fail('QUICK_TRACE_CONNECTION', '未知接入类型。');
  if (target[2] !== point[2]) fail('LOCAL_NONPLANAR_EDIT', '不同声明高程不能通过描图吸附自动连接。');
  return { point: [...target], ...(nodeId ? { nodeId } : {}), ...(cut ? { cut } : {}) };
}

export interface QuickTraceCrossing { roadId: string; roadDistanceM: number; distanceM: number; point: Vec3 }
function profileRoad(map: YardMap, road: MapRoad): boolean {
  const source = map.sources[road.provenance.fieldSources?.direction ?? ''];
  if (source?.category !== 'design_assumption') return false;
  try { return (JSON.parse(source.description) as { profile?: unknown }).profile === 'quick_trace_v1'; } catch { return false; }
}
function tracePath(points: readonly Vec3[], geometry?: RoadGeometry): ResolvedPath {
  return { anchors: points.map(point => [...point]), spans: geometry ? structuredClone(geometry.spans) : points.slice(1).map(() => ({ kind: 'line' as const })) };
}
function traceCrossings(map: YardMap, path: ResolvedPath): { crossings: QuickTraceCrossing[]; ambiguous: boolean; converged: boolean } {
  const crossings: QuickTraceCrossing[] = [], total = pathLength(path).lengthM;
  let ambiguous = false, converged = true;
  const box = boundsOfPath(path), margin = 0.01;
  // ponytail: linear scan of declared quick-trace roads behind a bounding-box reject; a spatial index only if roads reach the tens of thousands.
  // A road whose box is apart from the trace cannot cross it, so its (non-)convergence no longer blocks this trace.
  for (const [roadId, road] of Object.entries(map.roads)) {
    if (!profileRoad(map, road)) continue;
    const other = getRoadPath(map, roadId), near = boundsOfPath(other);
    if (near.min[0] > box.max[0] + margin || near.max[0] < box.min[0] - margin || near.min[1] > box.max[1] + margin || near.max[1] < box.min[1] - margin) continue;
    const all = [...other.anchors, ...other.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : [])];
    if (all.some(p => p[2] !== path.anchors[0]![2])) continue;
    const result = intersectPaths(path, other);
    ambiguous ||= result.ambiguous; converged &&= result.converged;
    for (const hit of result.intersections) if (hit.a.sM > EPSILON_M && hit.a.sM < total - EPSILON_M && !crossings.some(crossing => crossing.roadId === roadId && Math.abs(crossing.distanceM - hit.a.sM) <= EPSILON_M)) {
      crossings.push({ roadId, roadDistanceM: hit.b.sM, distanceM: hit.a.sM, point: hit.point });
    }
  }
  return { crossings: crossings.sort((a, b) => a.distanceM - b.distanceM), ambiguous, converged };
}
/** Same curve intersection kernel as the commit, with no IDs, mutations, full validation or hashes. */
export function getQuickTraceCrossings(map: YardMap, points: readonly Vec3[], geometry?: RoadGeometry): QuickTraceCrossing[] {
  return points.length < 2 ? [] : traceCrossings(map, tracePath(points, geometry)).crossings;
}/** Mutates one disposable command candidate; history, validation and persistence stay in applyMapCommand. */
export function runQuickTrace(map: YardMap, command: QuickTraceCommand, split: SplitRoad): QuickTraceResult {
  if (command.type === 'quickTraceBoundary') {
    if (String(map.schemaVersion) !== '0.3.0') fail('QUICK_TRACE_SCHEMA', '通用建筑/区域需要先将工作副本升级为 0.3.0。');
    if (command.kind !== 'building' && command.kind !== 'area') fail('QUICK_TRACE_KIND', '只能新建通用建筑或区域。');
    const provenance = drawingProvenance(map), allocate = allocateMapIds(map);
    const collection = command.kind === 'building' ? 'facilities' : 'zones';
    const entityId = allocate(command.kind === 'building' ? 'facility_trace_' : 'zone_trace_');
    const name = numberedName(map[collection], command.kind === 'building' ? '建筑' : '区域');
    if (command.kind === 'building') map.facilities[entityId] = { ...newFacility(command.boundary, name, 'building'), provenance };
    else map.zones[entityId] = { ...newZone(command.boundary, name, 'unclassified'), provenance };
    if (command.classification !== undefined) applySpatialClassification(map, collection, entityId, command.classification);
    return { entityId, geometryPreservedRoadIds: [] };
  }
  checkPoints(command.points);
  if (command.geometry) {
    if (map.schemaVersion !== '0.3.0') fail('QUICK_TRACE_SCHEMA', '曲线描图需要先将工作副本升级为 0.3.0。');
    if (command.geometry.kind !== 'path' || !sameValue(command.geometry.anchors, command.points.slice(1, -1)) || command.geometry.spans.length !== command.points.length - 1) fail('QUICK_TRACE_GEOMETRY', '道路点必须与路径内部锚点及 span 数量一致。');
    const controls = command.geometry.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : []);
    if (controls.some(point => !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite) || point[2] !== command.points[0]![2])) fail('LOCAL_NONPLANAR_EDIT', '曲线控制点必须是同一绘图平面的有限坐标。');
  }
  const defaults = { ...DEFAULT_QUICK_TRACE_DEFAULTS, ...command.defaults, direction: command.defaults?.direction ?? 'both' as const };
  if (!Number.isFinite(defaults.widthM) || defaults.widthM <= 0 || !['both', 'forward', 'backward'].includes(defaults.direction!)) fail('QUICK_TRACE_DEFAULTS', '新道路宽度必须为有限正数，方向必须是双向或明确单向。');
  const endpoints = [connectionTarget(map, command.disconnect ? undefined : command.startConnection, command.points[0]!), connectionTarget(map, command.disconnect ? undefined : command.endConnection, command.points.at(-1)!)];
  const points = [endpoints[0]!.point, ...structuredClone(command.points.slice(1, -1)), endpoints[1]!.point];
  if (points.some((point, i) => i > 0 && Math.hypot(point[0] - points[i - 1]![0], point[1] - points[i - 1]![1]) <= EPSILON_M)) fail('QUICK_TRACE_ZERO_SEGMENT', '相邻道路锚点不能重合。');
  let path = tracePath(command.points, command.geometry);
  path = movePathAnchor(path, 0, endpoints[0]!.point);
  path = movePathAnchor(path, path.anchors.length - 1, endpoints[1]!.point);
  const crossingReport = command.disconnect || defaults.connectNewCrossings === false ? { crossings: [], ambiguous: false, converged: true } : traceCrossings(map, path);
  if (crossingReport.ambiguous || !crossingReport.converged) fail('QUICK_TRACE_CROSSING_AMBIGUOUS', '重叠或切触交点尚不能确定连接，请明确选择分支，或按 Alt 本次不连接。');
  const crossings = crossingReport.crossings;
  const crossingTargets = crossings.map(crossing => ({ ...connectionTarget(map, { kind: 'road', roadId: crossing.roadId, distanceM: crossing.roadDistanceM }, crossing.point), distanceM: crossing.distanceM }));
  const targets = [...endpoints, ...crossingTargets];
  const provenance = drawingProvenance(map), profileSource = defaultsSource(map, defaults), allocate = allocateMapIds(map);
  const preserved = new Set<string>();
  // Descending cuts preserve original chainage even when both ends join the same old road.
  for (const roadId of new Set(targets.flatMap(endpoint => endpoint.cut ? [endpoint.cut.roadId] : []))) {
    let retained = roadId;
    const cuts = targets.filter(endpoint => endpoint.cut?.roadId === roadId).sort((a, b) => b.cut!.distanceM - a.cut!.distanceM);
    let previousDistance = Infinity, previousNode: string | undefined;
    for (const endpoint of cuts) {
      const distanceM = endpoint.cut!.distanceM;
      if (Math.abs(previousDistance - distanceM) <= EPSILON_M) { endpoint.nodeId = previousNode; continue; }
      const nodeId = allocate('node_trace_'), newRoadIds: [string, string] = [allocate('road_trace_'), allocate('road_trace_')];
      split(map, { type: 'splitRoad', id: retained, distanceM, nodeId, newRoadIds });
      preserved.delete(retained); newRoadIds.forEach(id => preserved.add(id));
      endpoint.nodeId = nodeId; retained = newRoadIds[0]; previousDistance = distanceM; previousNode = nodeId;
    }
  }
  const nodeIds = endpoints.map((endpoint, i) => {
    const id = allocate('node_trace_');
    map.nodes[id] = endpoint.nodeId ? structuredClone(map.nodes[endpoint.nodeId]!) : { ...newNode(points[i === 0 ? 0 : points.length - 1]!, '道路端点'), provenance: structuredClone(provenance) };
    return id;
  });
  const entityId = allocate('road_trace_'), name = numberedName(map.roads, '道路');
  const road: MapRoad = { ...newRoad(nodeIds[0]!, nodeIds[1]!, points.slice(1, -1), name), direction: defaults.direction!, widthM: { state: 'known', value: defaults.widthM, sourceRef: profileSource }, provenance: { ...provenance, sourceRefs: [...provenance.sourceRefs!, profileSource], fieldSources: { widthM: profileSource, direction: profileSource }, note: '人工描形；宽度、方向与明确接路时新增非掉头许可采用 quick_trace_v1 设计假设。限高、承载、速度保持未知。' } };
  const storedRoad = roadForMap(map, road);
  if (command.geometry && storedRoad.geometry) storedRoad.geometry = pathToRoadGeometry(path);
  map.roads[entityId] = storedRoad;
  const oldMovements = new Set(Object.keys(map.movements)), oldJunctions = new Set(Object.keys(map.junctions));
  for (const [i, endpoint] of endpoints.entries()) if (endpoint.nodeId) {
    const approvedMovements = enumerateMergeTurns(map, { sourceNodeId: nodeIds[i]!, targetNodeId: endpoint.nodeId }).map(turn => ({ ...turn, id: allocate('movement_trace_') }));
    mergeNodes(map, nodeIds[i]!, endpoint.nodeId, approvedMovements);
  }
  let retainedRoadId = entityId;
  let previousDistance = Infinity, previousTarget: string | undefined;
  for (const target of crossingTargets.sort((a, b) => b.distanceM - a.distanceM)) {
    if (Math.abs(previousDistance - target.distanceM) <= EPSILON_M) {
      if (previousTarget !== target.nodeId) fail('QUICK_TRACE_CROSSING_AMBIGUOUS', '重合交点对应不同网络节点，请明确选择本次接入分支。');
      continue;
    }
    const nodeId = allocate('node_trace_'), newRoadIds: [string, string] = [allocate('road_trace_'), allocate('road_trace_')];
    split(map, { type: 'splitRoad', id: retainedRoadId, distanceM: target.distanceM, nodeId, newRoadIds });
    const approvals = enumerateMergeTurns(map, { sourceNodeId: nodeId, targetNodeId: target.nodeId! }).map(turn => ({ ...turn, id: allocate('movement_trace_') }));
    mergeNodes(map, nodeId, target.nodeId!, approvals);
    retainedRoadId = newRoadIds[0]; previousDistance = target.distanceM; previousTarget = target.nodeId;
  }
  for (const [id, movement] of Object.entries(map.movements)) if (!oldMovements.has(id)) movement.provenance = { category: 'design_assumption', sourceRefs: [profileSource] };
  for (const [id, junction] of Object.entries(map.junctions)) if (!oldJunctions.has(id)) junction.provenance = { category: 'design_assumption', sourceRefs: [profileSource] };
  return { entityId: retainedRoadId, geometryPreservedRoadIds: [...preserved] };
}
