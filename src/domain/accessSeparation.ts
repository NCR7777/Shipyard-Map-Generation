import type { Issue, Vec3, YardMap } from './model';
import type { QuickTraceCommand, QuickTraceResult } from './drawingDefaults';
import { inspectPlanning } from './planning';
import { TopologyError } from './topologyEditing';

/** An entrance moved off a node it does not own alone (a public junction on its building's wall, say) onto a new node of its
 *  own, together with its building's node-proxy service points on that node, and joined back to the old node by a straight
 *  connector, all in one transaction. The old node keeps its place, roads and turns; it becomes a plain node when no entrance
 *  or service point is left on it. The connector is traced as a drawn road is (`quickTraceRoad`: its width, both ways, the
 *  non-U-turn permissions at the old node), so the entrance stays reachable exactly as before.
 *
 *  This is the case `detachAccessPoint` (EA01) does not cover: an entrance directly on a public junction with no internal
 *  branch of its own to split. Without it such an entrance can never move, and every outline change or move of its building
 *  that would carry it is refused. */
export interface SeparateAccessPointCommand {
  type: 'separateAccessPoint';
  id: string;
  /** The new node's ID. */
  nodeId: string;
  /** Where the new node goes: same height as the old node, somewhere else. */
  position: Vec3;
  /** The connector's width (m, finite and positive). */
  connectorWidthM: number;
}
type Trace = (map: YardMap, command: Extract<QuickTraceCommand, { type: 'quickTraceRoad' }>) => QuickTraceResult;
export interface AccessSeparationInfo { supported: true; oldNodeId: string; servicePointIds: string[] }

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const collections = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
function fail(code: string, message: string, path: string): never { throw new TopologyError(code, message, path); }

function candidate(map: YardMap, id: string): AccessSeparationInfo {
  const access = map.accessPoints[id], path = '/accessPoints/' + id;
  if (!access || !map.facilities[access.facilityId] || !map.nodes[access.nodeId]) fail('ACCESS_SEPARATE_MISSING', '请选择现有设施入口。', path);
  const oldNodeId = access.nodeId, servicePointIds: string[] = [];
  for (const [serviceId, service] of Object.entries(map.servicePoints)) {
    const arrival = service.arrival;
    // An internal route entering at the old node (named, or implied by the entrance it goes through) would lose its start.
    const entersHere = arrival?.mode === 'explicit_internal' && (arrival.entryNodeId === oldNodeId || service.nodeId === oldNodeId || !arrival.entryNodeId && service.accessPointId === id);
    if (entersHere && (service.facilityId ?? service.zoneId) === access.facilityId) {
      fail('ACCESS_SEPARATE_ARRIVAL', `作业点「${service.name}」有从这个入口进入的内部通道，拆出入口会改变它的到达方式，这种情况不能自动拆出（入口挂在公共路口、有一条本建筑内部支路时，应沿支路拆分）。`, '/servicePoints/' + serviceId + '/arrival');
    }
    // The building's own point at the entrance goes with it; anyone else's stays on the old node.
    if (service.nodeId === oldNodeId && service.facilityId === access.facilityId && arrival?.mode !== 'explicit_internal') servicePointIds.push(serviceId);
  }
  for (const [resourceId, resource] of Object.entries(map.resources)) {
    if (resource.appliesTo.some(ref => ref.entityType === 'nodes' && ref.entityId === oldNodeId)) fail('ACCESS_SEPARATE_RESOURCES', `资源「${resource.name}」作用于原节点，拆出后它该留在原节点还是随入口移动无法确定，这种情况不能自动拆出。`, '/resources/' + resourceId);
  }
  return { supported: true, oldNodeId, servicePointIds };
}

/** Whether the entrance can be separated, and what goes with it; or why not, as an issue. */
export function inspectAccessSeparation(map: YardMap, id: string): AccessSeparationInfo | { supported: false; issues: Issue[] } {
  try { return candidate(map, id); }
  catch (error) {
    if (!(error instanceof TopologyError)) throw error;
    return { supported: false, issues: [{ code: error.code, severity: 'error', jsonPath: error.path, entityType: 'accessPoints', entityId: id,
      message: error.message, suggestedAction: '保留公共路网与全部声明，按提示处理依赖后再拆出入口。' }] };
  }
}

/** Mutates only the command layer's disposable candidate; `trace` is the kernel's road tracing. */
export function runAccessSeparation(map: YardMap, command: SeparateAccessPointCommand, trace: Trace): { geometryPreservedRoadIds: string[] } {
  const info = candidate(map, command.id), access = map.accessPoints[command.id]!, old = map.nodes[info.oldNodeId]!;
  const occupied = new Set([...collections.flatMap(kind => Object.keys(map[kind])), ...inspectPlanning(map).slots.map(slot => slot.id)]);
  if (typeof command.nodeId !== 'string' || !ID.test(command.nodeId) || occupied.has(command.nodeId)) fail('ACCESS_SEPARATE_ID_CONFLICT', '新节点 ID 非法、重复或已被使用。', '/nodes/' + command.nodeId);
  const position = command.position;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) fail('ACCESS_SEPARATE_POSITION', '新节点坐标必须是三个有限米制数值。', '/nodes/' + command.nodeId);
  if (position[2] !== old.position[2]) fail('LOCAL_NONPLANAR_EDIT', '新入口节点必须与原节点在同一水平面 Z。', '/nodes/' + command.nodeId);
  if (Math.hypot(position[0] - old.position[0], position[1] - old.position[1]) <= 1e-6) fail('ACCESS_SEPARATE_POSITION', '新入口节点不能与原节点重合。', '/nodes/' + command.nodeId);
  if (!Number.isFinite(command.connectorWidthM) || command.connectorWidthM <= 0) fail('ACCESS_SEPARATE_CONNECTOR', '接驳路宽度必须为有限正数。', '/accessPoints/' + command.id);
  const facility = map.facilities[access.facilityId]!;
  map.nodes[command.nodeId] = { name: access.name + '节点', position: [...position], kind: 'access', provenance: {
    category: 'drawing', ...facility.provenance.sourceRefs?.length ? { sourceRefs: [...facility.provenance.sourceRefs] } : {},
    note: `人工拆出入口：入口「${access.name}」从共用节点 ${info.oldNodeId} 移到自己的节点；原节点及其道路、转向保持不变。` } };
  access.nodeId = command.nodeId;
  for (const id of info.servicePointIds) map.servicePoints[id]!.nodeId = command.nodeId;
  const standing = Object.values(map.accessPoints).some(point => point.nodeId === info.oldNodeId)
    || Object.values(map.servicePoints).some(point => point.nodeId === info.oldNodeId || point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === info.oldNodeId);
  if (!standing && (old.kind === 'access' || old.kind === 'service')) old.kind = 'ordinary';
  try {
    return trace(map, { type: 'quickTraceRoad', points: [[...position], [...old.position]], startConnection: { kind: 'node', nodeId: command.nodeId },
      endConnection: { kind: 'node', nodeId: info.oldNodeId }, disconnect: false, defaults: { widthM: command.connectorWidthM, direction: 'both', connectNewCrossings: false } });
  } catch (error) {
    if (error instanceof TopologyError) fail('ACCESS_SEPARATE_CONNECTOR', '接驳路不能接回原节点：' + error.message + ' 整个拆出未提交。', error.path);
    throw error;
  }
}
