import type { Issue, Vec3, YardMap } from './model';
import { OwnerEditError, privateNodeOwner, roadOwner } from './ownerEditing';
import { inspectPlanning } from './planning';
import { TopologyError } from './topologyEditing';

/** An entrance moved off a node it does not own alone (a public junction on its building's wall, say) onto a new node of its
 *  own. Only the entrance moves: the old node keeps its place, roads, turns and every service point on it, so what was on the
 *  road network stays on it (the user's decision, 2026-09-25: roads at the old node stay as they are, and none is added). The
 *  old node becomes a plain node when nothing is left standing on it. No road is built: the entrance leaves the road network
 *  until one is drawn to it.
 *
 *  This is the case `detachAccessPoint` (EA01) does not cover: an entrance directly on a public junction with no internal
 *  branch of its own to split. Without it such an entrance can never move, and every outline change or move of its building
 *  that would carry it is refused. */
export interface SeparateAccessPointCommand {
  type: 'separateAccessPoint';
  id: string;
  /** The new node's ID. */
  nodeId: string;
  /** Where the new node goes: same height as the old node, clear of every existing node. */
  position: Vec3;
}
export interface AccessSeparationInfo { supported: true; oldNodeId: string }

const ID = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/** The new node keeps at least this far from every existing node (the validator's near-unconnected-node distance). */
const NODE_CLEAR_M = 0.5;
const collections = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
function fail(code: string, message: string, path: string): never { throw new TopologyError(code, message, path); }

function candidate(map: YardMap, id: string): AccessSeparationInfo {
  const access = map.accessPoints[id], path = '/accessPoints/' + id;
  if (!access || !map.facilities[access.facilityId] || !map.nodes[access.nodeId]) fail('ACCESS_SEPARATE_MISSING', '请选择现有设施入口。', path);
  const oldNodeId = access.nodeId;
  // On a node of its own it already slides along the wall; separating it would only cut it off its own road.
  let owner: string | undefined;
  try { owner = privateNodeOwner(map, oldNodeId); } catch (error) { if (!(error instanceof OwnerEditError)) throw error; }
  if (owner === access.facilityId) fail('ACCESS_SEPARATE_OWN_NODE', `入口「${access.name}」已在本建筑自己的节点上，可以直接移动，不需要拆出。`, path + '/nodeId');
  // The building's own road at the old node (an internal branch) would be left on a node without its entrance.
  for (const [roadId, road] of Object.entries(map.roads)) if ((road.fromNodeId === oldNodeId || road.toNodeId === oldNodeId) && roadOwner(map, roadId) === access.facilityId) {
    fail('ACCESS_SEPARATE_BRANCH', `原节点上接着本建筑自己的道路「${road.name}」（内部支路），只移走入口会让这条支路留在没有入口的节点上，这种情况不能自动拆出（应沿支路拆分）。`, '/roads/' + roadId);
  }
  for (const [serviceId, service] of Object.entries(map.servicePoints)) {
    const arrival = service.arrival;
    // An internal route entering at the old node (named, or implied by the entrance it goes through) would lose its start.
    const entersHere = arrival?.mode === 'explicit_internal' && (arrival.entryNodeId === oldNodeId || service.nodeId === oldNodeId || !arrival.entryNodeId && service.accessPointId === id);
    if (entersHere && (service.facilityId ?? service.zoneId) === access.facilityId) {
      fail('ACCESS_SEPARATE_ARRIVAL', `作业点「${service.name}」有从这个入口进入的内部通道，拆出入口会改变它的到达方式，这种情况不能自动拆出（入口挂在公共路口、有一条本建筑内部支路时，应沿支路拆分）。`, '/servicePoints/' + serviceId + '/arrival');
    }
  }
  for (const [resourceId, resource] of Object.entries(map.resources)) {
    if (resource.appliesTo.some(ref => ref.entityType === 'nodes' && ref.entityId === oldNodeId)) fail('ACCESS_SEPARATE_RESOURCES', `资源「${resource.name}」作用于原节点，拆出后它该留在原节点还是随入口移动无法确定，这种情况不能自动拆出。`, '/resources/' + resourceId);
  }
  return { supported: true, oldNodeId };
}

/** Whether the entrance can be separated; or why not, as an issue. */
export function inspectAccessSeparation(map: YardMap, id: string): AccessSeparationInfo | { supported: false; issues: Issue[] } {
  try { return candidate(map, id); }
  catch (error) {
    if (!(error instanceof TopologyError)) throw error;
    return { supported: false, issues: [{ code: error.code, severity: 'error', jsonPath: error.path, entityType: 'accessPoints', entityId: id,
      message: error.message, suggestedAction: '保留公共路网与全部声明，按提示处理依赖后再拆出入口。' }] };
  }
}

/** Mutates only the command layer's disposable candidate. */
export function runAccessSeparation(map: YardMap, command: SeparateAccessPointCommand): void {
  const info = candidate(map, command.id), access = map.accessPoints[command.id]!, old = map.nodes[info.oldNodeId]!;
  const occupied = new Set([...collections.flatMap(kind => Object.keys(map[kind])), ...inspectPlanning(map).slots.map(slot => slot.id)]);
  if (typeof command.nodeId !== 'string' || !ID.test(command.nodeId) || occupied.has(command.nodeId)) fail('ACCESS_SEPARATE_ID_CONFLICT', '新节点 ID 非法、重复或已被使用。', '/nodes/' + command.nodeId);
  const position = command.position;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) fail('ACCESS_SEPARATE_POSITION', '新节点坐标必须是三个有限米制数值。', '/nodes/' + command.nodeId);
  if (position[2] !== old.position[2]) fail('LOCAL_NONPLANAR_EDIT', '新入口节点必须与原节点在同一水平面 Z。', '/nodes/' + command.nodeId);
  for (const node of Object.values(map.nodes)) if (Math.hypot(position[0] - node.position[0], position[1] - node.position[1], position[2] - node.position[2]) < NODE_CLEAR_M) {
    fail('ACCESS_SEPARATE_POSITION', `新入口节点离已有节点「${node.name}」不到 ${NODE_CLEAR_M} m。`, '/nodes/' + command.nodeId);
  }
  access.nodeId = command.nodeId;
  const standing = Object.values(map.accessPoints).some(point => point.nodeId === info.oldNodeId)
    || Object.values(map.servicePoints).some(point => point.nodeId === info.oldNodeId || point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === info.oldNodeId);
  // The old node's kind is not a topology field, so its change is written down on the new node.
  const retyped = !standing && (old.kind === 'access' || old.kind === 'service') ? old.kind : undefined;
  const facility = map.facilities[access.facilityId]!;
  map.nodes[command.nodeId] = { name: access.name + '节点', position: [...position], kind: 'access', provenance: {
    category: 'drawing', ...facility.provenance.sourceRefs?.length ? { sourceRefs: [...facility.provenance.sourceRefs] } : {},
    note: `人工拆出入口：入口「${access.name}」从共用节点 ${info.oldNodeId} 移到自己的节点；原节点及其道路、转向、作业点保持不变${retyped ? `，原节点上已无入口或作业点，类型由 ${retyped} 改为 ordinary` : ''}；入口未接路。` } };
  if (retyped) old.kind = 'ordinary';
}
