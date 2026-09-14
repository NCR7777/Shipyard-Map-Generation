import type { ArcRef, MapRoad, PhysicalValue, ServicePoint, Vec3, YardMap } from './model';
import type { MapCommand, SplitMapping } from './commands';
import { TopologyError, enumerateMergeTurns, mergeNodes, splitPosition, type ApprovedMovement } from './topologyEditing';
import { newNode, newRoad, newAccessPoint, newServicePoint } from './factory';
import { pointInRing } from '../geometry/polygons';
import { inspectPlanning, PLANNING_NAMESPACE } from './planning';
import { nodeOwners, roadOwner } from './ownerEditing';

export type ConnectedPointOwner = { kind: 'facilities' | 'zones'; id: string };
export type ConnectedPointConnection =
  | { kind: 'node'; nodeId: string }
  | { kind: 'road'; roadId: string; distanceM: number; nodeId: string; newRoadIds: [string, string] };
interface CommonPoint {
  type: 'createConnectedPoint'; pointId: string; name: string;
  source: { id: string; name?: string; description?: string };
  resourceIds?: string[];
}
interface NewConnectedGeometry {
  nodeId: string; position: Vec3; connectorRoadId: string;
  connector: { direction: MapRoad['direction']; widthM: PhysicalValue };
  connection: ConnectedPointConnection;
  /** New explicit junction ID if the connection node has no junction. */
  junctionId: string;
  approvedMovements?: ApprovedMovement[];
}
export type ConnectedPointCommand = CommonPoint & (
  | ({ kind: 'accessPoint'; owner: { kind: 'facilities'; id: string } } & NewConnectedGeometry)
  | { kind: 'servicePoint'; owner: { kind: 'facilities'; id: string }; serviceKind: ServicePoint['kind'];
      arrival: { mode: 'node_proxy'; accessPointId: string; transferAssumption: 'included_in_service_duration' | 'excluded_from_model'; note: string } }
  | ({ kind: 'servicePoint'; owner: ConnectedPointOwner; serviceKind: ServicePoint['kind'];
      arrival: { mode: 'explicit_internal'; accessPointId?: string; entryNodeId?: string;
        /** Explicit existing route from the owner's access/entry node to connection, using post-split IDs. */
        prefixPath: ArcRef[] } } & NewConnectedGeometry)
);
export type ConnectedPointSplit = (map: YardMap, command: Extract<MapCommand, { type: 'splitRoad' }>) => SplitMapping;
export interface ConnectedPointResult { geometryPreservedRoadIds: string[]; proposedMovements: Omit<ApprovedMovement, 'id'>[] }

function fail(code: string, message: string, path = ''): never { throw new TopologyError(code, message, path); }
const collections = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
function freeIds(map: YardMap, ids: string[]) {
  const occupied = new Set([...collections.flatMap(kind => Object.keys(map[kind])), ...inspectPlanning(map).slots.map(slot => slot.id)]);
  for (const id of ids) {
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id) || occupied.has(id)) fail('CONNECTED_POINT_ID_CONFLICT', '新对象 ID 非法、重复或已被使用。', '/id/' + id);
    occupied.add(id);
  }
}
function pathEnd(map: YardMap, start: string, arcs: ArcRef[], owner: string): string {
  if (!Array.isArray(arcs) || arcs.length > 2047) fail('CONNECTED_POINT_PATH_LIMIT', '内部到达路径必须是最多 2047 段的显式列表。');
  let at = start;
  for (const arc of arcs) {
    const road = map.roads[arc.roadId];
    if (!road || roadOwner(map, arc.roadId) !== owner) fail('CONNECTED_POINT_PATH_OWNER', '内部前缀路径必须完全属于选定设施或区域。', '/roads/' + arc.roadId);
    if (!['forward', 'backward'].includes(arc.direction) || road.direction !== 'both' && road.direction !== arc.direction) fail('CONNECTED_POINT_PATH_DIRECTION', '内部前缀路径方向必须明确允许。', '/roads/' + arc.roadId + '/direction');
    const from = arc.direction === 'forward' ? road.fromNodeId : road.toNodeId;
    if (from !== at) fail('CONNECTED_POINT_PATH_CONTINUITY', '内部前缀路径必须从已声明入口连续到接入位置。', '/roads/' + arc.roadId);
    at = arc.direction === 'forward' ? road.toNodeId : road.fromNodeId;
  }
  return at;
}
/** Mutates only the caller's disposable candidate. The command layer validates and commits once. */
export function runConnectedPoint(map: YardMap, command: ConnectedPointCommand, split: ConnectedPointSplit): ConnectedPointResult {
  if (map.schemaVersion === '0.1.0') fail('CONNECTED_POINT_SCHEMA', '请先显式升级到支持到达语义的地图版本。');
  if (!['facilities', 'zones'].includes(command.owner?.kind) || !Object.hasOwn(map[command.owner.kind], command.owner.id)) fail('CONNECTED_POINT_OWNER', '请选择现有设施或区域。');
  if (command.kind !== 'accessPoint' && command.kind !== 'servicePoint') fail('CONNECTED_POINT_KIND', '未知的入口/作业点创建动作。');
  if (typeof command.name !== 'string' || !command.name.trim()) fail('CONNECTED_POINT_NAME', '入口或作业点名称不能为空。');
  if (!command.source || typeof command.source.id !== 'string') fail('CONNECTED_POINT_SOURCE', '创建动作需要明确设计来源。');
  const owner = map[command.owner.kind][command.owner.id]!;
  const resources = command.resourceIds ?? [];
  if (!Array.isArray(resources) || resources.length > 256 || new Set(resources).size !== resources.length || resources.some(id => !Object.hasOwn(map.resources, id))) fail('CONNECTED_POINT_RESOURCE', '资源必须是不重复的现有资源 ID，不创建或猜测容量。');
  const provenance = { category: 'design_assumption' as const, sourceRefs: [command.source.id] };
  let service: ServicePoint | undefined, accessNode: string | undefined;
  const proxy = command.kind === 'servicePoint' && command.arrival?.mode === 'node_proxy';
  if (command.kind === 'servicePoint') {
    if (!['loading', 'unloading', 'parking', 'berth', 'other'].includes(command.serviceKind) || !command.arrival) fail('CONNECTED_POINT_ARRIVAL', '作业类型和到达方式必须明确选择。');
    if (command.owner.kind === 'facilities') {
      const ap = command.arrival.accessPointId ? map.accessPoints[command.arrival.accessPointId] : undefined;
      if (!ap || ap.facilityId !== command.owner.id) fail('CONNECTED_POINT_ACCESS_OWNER', '设施作业点必须选择同一设施的明确入口。', '/accessPoints/' + command.arrival.accessPointId);
      if (command.arrival.mode === 'explicit_internal' && command.arrival.entryNodeId !== undefined) fail('CONNECTED_POINT_ENTRY_CONFLICT', '设施入口已给出唯一权威起点，不允许另填 entryNodeId。');
      accessNode = ap.nodeId;
    } else {
      if (command.arrival.mode !== 'explicit_internal' || command.arrival.accessPointId || !command.arrival.entryNodeId || !Object.hasOwn(map.nodes, command.arrival.entryNodeId)) fail('CONNECTED_POINT_ZONE_ENTRY', '区域内部作业点必须显式选择现有 entryNodeId，不能借用其他设施入口。');
      accessNode = command.arrival.entryNodeId;
    }
    if (command.arrival.mode === 'node_proxy') {
      if (!['included_in_service_duration', 'excluded_from_model'].includes(command.arrival.transferAssumption) || typeof command.arrival.note !== 'string' || !command.arrival.note.trim()) fail('CONNECTED_POINT_PROXY_ASSUMPTION', '入口代理必须明确转运假设和说明。');
      service = { ...newServicePoint(accessNode!, command.name, command.serviceKind), facilityId: command.owner.id, accessPointId: command.arrival.accessPointId, arrival: { mode: 'node_proxy', transferAssumption: command.arrival.transferAssumption, note: command.arrival.note }, resourceIds: [...resources], provenance };
    } else if (command.arrival.mode !== 'explicit_internal') fail('CONNECTED_POINT_ARRIVAL', '不能猜测未声明的到达方式。');
  } else if (command.owner.kind !== 'facilities' || resources.length) fail('CONNECTED_POINT_ACCESS_OWNER', '入口只能属于设施；资源请显式关联作业点，不能丢弃资源选择。');
  const geometryPreservedRoadIds: string[] = [];
  let proposedMovements: Omit<ApprovedMovement, 'id'>[] = [];
  if (proxy) {
    if ('position' in command || 'nodeId' in command || 'connection' in command || 'connectorRoadId' in command || 'approvedMovements' in command) fail('CONNECTED_POINT_PROXY_GEOMETRY', '入口代理复用入口节点，不能同时创建或移动几何。');
    freeIds(map, [command.pointId, command.source.id]);
  } else {
    if (!('position' in command) || !Array.isArray(command.position) || command.position.length !== 3 || !command.position.every(Number.isFinite)) fail('CONNECTED_POINT_POSITION', '位置必须为三个有限世界坐标。');
    const geometry = command as ConnectedPointCommand & NewConnectedGeometry;
    const { connection } = geometry;
    if (!geometry.connector || !['forward', 'backward', 'both', 'unknown'].includes(geometry.connector.direction) || !geometry.connector.widthM || !['known', 'unknown', 'unrestricted', 'not_applicable'].includes(geometry.connector.widthM.state)) fail('CONNECTED_POINT_CONNECTOR_PARAMETERS', '请明确接入段方向与宽度状态。');
    if (geometry.connector.widthM.state === 'known' && (!Number.isFinite(geometry.connector.widthM.value) || geometry.connector.widthM.value <= 0)) fail('CONNECTED_POINT_CONNECTOR_WIDTH', '接入段已知宽度必须为有限正数。');
    if (command.kind === 'servicePoint' && !['forward', 'both'].includes(geometry.connector.direction)) fail('CONNECTED_POINT_CONNECTOR_DIRECTION', '显式内部到达要求接入段从入口朝作业点的方向已明确允许；未知方向保持待配置。');
    if (!connection || !['node', 'road'].includes(connection.kind)) fail('CONNECTED_POINT_CONNECTION', '必须显式选择接入节点或道路。');
    const approvals = geometry.approvedMovements ?? [];
    if (!Array.isArray(approvals) || approvals.length > 4096) fail('INVALID_TOPOLOGY_MOVEMENTS', '新增许可必须是有界的明确批准列表。');
    freeIds(map, [command.pointId, command.source.id, geometry.nodeId, geometry.connectorRoadId, ...approvals.map(v => v.id), ...(connection.kind === 'road' ? [connection.nodeId, ...connection.newRoadIds] : []), ...(!Object.hasOwn(map.junctions, geometry.junctionId) ? [geometry.junctionId] : [])]);
    let targetNode: string;
    if (connection.kind === 'road') {
      const target = map.roads[connection.roadId];
      if (!target) fail('CONNECTED_POINT_CONNECTION', '接入道路不存在。', '/roads/' + connection.roadId);
      const targetOwner = roadOwner(map, connection.roadId);
      if (command.kind === 'accessPoint' ? !!targetOwner : targetOwner !== command.owner.id) fail('CONNECTED_POINT_TARGET_OWNER', '入口接入公共路；内部作业点只能接入同一 owner 的内部道路。', '/roads/' + connection.roadId);
      const position = splitPosition(map, connection.roadId, connection.distanceM);
      if (position[2] !== geometry.position[2]) fail('LOCAL_NONPLANAR_EDIT', '接入不得改变 Z 或跨越未建模的高差。');
      if (Object.hasOwn(map.junctions, geometry.junctionId)) fail('CONNECTED_POINT_JUNCTION', '新道路切分点需要预分配的新路口 ID。');
      map.nodes[connection.nodeId] = { ...newNode(position), provenance };
      map.junctions[geometry.junctionId] = { name: '用户明确接入', nodeIds: [connection.nodeId], model: 'explicit_movements', resourceIds: [], provenance };
      split(map, { type: 'splitRoad', id: connection.roadId, distanceM: connection.distanceM, nodeId: connection.nodeId, existingNode: true, newRoadIds: connection.newRoadIds });
      geometryPreservedRoadIds.push(...connection.newRoadIds); targetNode = connection.nodeId;
    } else {
      targetNode = connection.nodeId;
      if (!Object.hasOwn(map.nodes, targetNode)) fail('CONNECTED_POINT_CONNECTION', '接入节点不存在。', '/nodes/' + targetNode);
    }
    const target = map.nodes[targetNode]!;
    if (target.position[2] !== geometry.position[2] || owner.boundary.outer.some(p => p[2] !== geometry.position[2])) fail('LOCAL_NONPLANAR_EDIT', '本次创建仅支持同一明确水平面的 owner、入口和接入道路。');
    if (Math.hypot(target.position[0] - geometry.position[0], target.position[1] - geometry.position[1]) <= 1e-6) fail('CONNECTED_POINT_ZERO_CONNECTOR', '新点与接入位置重合；请选择复用入口代理，不能生成零长道路。');
    if (command.kind === 'accessPoint') {
      if (pointInRing(geometry.position, owner.boundary.outer) !== 'boundary') fail('CONNECTED_POINT_ACCESS_BOUNDARY', '新入口须位于选定设施的外边界。', '/facilities/' + command.owner.id + '/boundary');
      const incident = Object.keys(map.roads).filter(id => map.roads[id]!.fromNodeId === targetNode || map.roads[id]!.toNodeId === targetNode);
      if (!incident.some(id => !roadOwner(map, id))) fail('CONNECTED_POINT_PUBLIC_TARGET', '请选择有明确公共道路的接入节点。', '/nodes/' + targetNode);
    } else {
      if (command.arrival.mode !== 'explicit_internal') fail('CONNECTED_POINT_ARRIVAL', '新内部几何需要显式内部到达。');
      if (pointInRing(geometry.position, owner.boundary.outer) === 'outside' || owner.boundary.holes.some(h => pointInRing(geometry.position, h) !== 'outside')) fail('CONNECTED_POINT_OUTSIDE_OWNER', '作业位置必须位于选定 owner 的有效范围。');
      if (pathEnd(map, accessNode!, command.arrival.prefixPath, command.owner.id) !== targetNode) fail('CONNECTED_POINT_PATH_TARGET', '前缀路径没有到达选中的接入节点；请明确完整入口路线。');
      const ownership = nodeOwners(map, targetNode);
      if ([...ownership.owners].some(id => id !== command.owner.id) || ownership.unownedPoint) fail('CONNECTED_POINT_TARGET_OWNER', '内部路线接入点存在其他归属，不能自动接通。', '/nodes/' + targetNode);
      const planning = inspectPlanning(map);
      if (planning.present && !planning.supported) fail('STATIC_CONTENTS_UNSUPPORTED', '当前静态归属契约不受支持。');
      map.extensionNamespaces[PLANNING_NAMESPACE] ??= { version: '1.0', category: 'behavior' };
      service = { ...newServicePoint(geometry.nodeId, command.name, command.serviceKind), ...(command.owner.kind === 'facilities' ? { facilityId: command.owner.id, accessPointId: command.arrival.accessPointId } : { zoneId: command.owner.id }), arrival: { mode: 'explicit_internal', ...(command.owner.kind === 'zones' ? { entryNodeId: accessNode } : {}), internalPath: [...structuredClone(command.arrival.prefixPath), { roadId: geometry.connectorRoadId, direction: 'forward' }] }, resourceIds: [...resources], provenance };
    }
    map.nodes[geometry.nodeId] = { ...newNode(geometry.position, command.name), provenance };
    // Reuse TE01 merge turn checks on a disposable, co-located joining node; no public node moves.
    let joinId = 'node_connected_point_join', suffix = 0;
    while (collections.some(kind => Object.hasOwn(map[kind], joinId)) || inspectPlanning(map).slots.some(slot => slot.id === joinId) || joinId === command.pointId || joinId === command.source.id || joinId === geometry.junctionId || approvals.some(v => v.id === joinId)) joinId = 'node_connected_point_join_' + ++suffix;
    freeIds(map, [joinId]);
    map.nodes[joinId] = { ...structuredClone(target), provenance };
    const connector = { ...newRoad(joinId, geometry.nodeId, [], command.name + ' 接入段'), direction: geometry.connector.direction, widthM: geometry.connector.widthM.state === 'known' ? { state: 'known' as const, value: geometry.connector.widthM.value, sourceRef: command.source.id } : structuredClone(geometry.connector.widthM), provenance };
    if (command.kind === 'servicePoint') connector.extensions = { [PLANNING_NAMESPACE]: { role: 'internal', ownerEntityId: command.owner.id, physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } };
    map.roads[geometry.connectorRoadId] = connector;
    const junctions = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(targetNode));
    if (!junctions.length) {
      freeIds(map, [geometry.junctionId]);
      map.junctions[geometry.junctionId] = { name: '用户明确接入', nodeIds: [targetNode], model: 'explicit_movements', resourceIds: [], provenance };
    } else if (junctions.length !== 1 || (connection.kind === 'node' && junctions[0]![0] !== geometry.junctionId)) fail('CONNECTED_POINT_JUNCTION', '接入路口不匹配；请使用现有路口 ID，不创建重复路口。');
    proposedMovements = enumerateMergeTurns(map, { sourceNodeId: joinId, targetNodeId: targetNode });
    const oldMovements = new Set(Object.keys(map.movements));
    mergeNodes(map, joinId, targetNode, approvals);
    for (const [id, movement] of Object.entries(map.movements)) if (!oldMovements.has(id)) movement.provenance = structuredClone(provenance);
    if (command.kind === 'accessPoint') map.accessPoints[command.pointId] = { ...newAccessPoint(command.owner.id, geometry.nodeId, command.name), provenance };
  }
  map.sources[command.source.id] = { name: command.source.name?.trim() || '入口/作业点连接设计', category: 'design_assumption', description: command.source.description ?? '用户显式选择归属、位置、接入和到达方式；未作现场测量或自动批准新转向。' };
  if (service) map.servicePoints[command.pointId] = service;
  if (command.owner.kind === 'facilities') {
    const facility = map.facilities[command.owner.id]!, field = command.kind === 'accessPoint' ? 'accessPointIds' : 'servicePointIds';
    facility[field] = [...facility[field], command.pointId];
    facility.provenance = { ...facility.provenance, sourceRefs: [...new Set([...(facility.provenance.sourceRefs ?? []), ...(facility.provenance.fieldSources?.[field] ? [facility.provenance.fieldSources[field]!] : []), command.source.id])], fieldSources: { ...facility.provenance.fieldSources, [field]: command.source.id } };
  }
  for (const id of resources) {
    const resource = map.resources[id]!;
    const ref = { entityType: 'servicePoints' as const, entityId: command.pointId };
    if (!resource.appliesTo.some(v => v.entityType === ref.entityType && v.entityId === ref.entityId)) resource.appliesTo.push(ref);
    resource.provenance = { ...resource.provenance, sourceRefs: [...new Set([...(resource.provenance.sourceRefs ?? []), ...(resource.provenance.fieldSources?.appliesTo ? [resource.provenance.fieldSources.appliesTo] : []), command.source.id])], fieldSources: { ...resource.provenance.fieldSources, appliesTo: command.source.id } };
  }
  return { geometryPreservedRoadIds, proposedMovements };
}
