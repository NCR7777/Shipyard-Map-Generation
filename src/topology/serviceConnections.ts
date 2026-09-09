import type { ArcRef, Issue, ServicePoint, YardMap } from '../domain/model';
import { pointInRing } from '../geometry/polygons';
import { roadLength } from '../geometry/roads';

export interface ServiceConnectionSummary {
  servicePointId: string;
  nodeId: string;
  owner: { kind: 'facility' | 'zone'; id: string } | null;
  incidentRoadIds: string[];
  arrivalMode: 'undeclared' | 'node_proxy' | 'explicit_internal';
  internalPathStatus: 'not_declared' | 'not_required' | 'incomplete' | 'continuous';
  internalPathLengthM: number | null;
  status: 'blocked' | 'unchecked';
  issues: Issue[];
  unchecked: string[];
}

/** Primary zone ownership is declared on the point. No second editable membership list. */
export function zoneServicePointIds(map: YardMap, zoneId: string): string[] {
  return Object.entries(map.servicePoints).filter(([, point]) => point.zoneId === zoneId).map(([id]) => id).sort();
}

const escape = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const sameArc = (a: ArcRef, b: ArcRef) => a.roadId === b.roadId && a.direction === b.direction;

/** Checks declared endpoint attachment and explicit arc sequences; never searches or publishes a path. */
export function inspectServiceConnection(map: YardMap, servicePointId: string): ServiceConnectionSummary {
  return inspectWithLengthCache(map, servicePointId, new Map());
}

/** One ephemeral cache per bulk inspection; lengths are never persisted or editable. */
export function inspectServiceConnections(map: YardMap): ServiceConnectionSummary[] {
  const lengths = new Map<string, number>();
  return Object.keys(map.servicePoints).map(id => inspectWithLengthCache(map, id, lengths));
}

function inspectWithLengthCache(map: YardMap, servicePointId: string, lengths: Map<string, number>): ServiceConnectionSummary {
  const point: ServicePoint | undefined = Object.hasOwn(map.servicePoints, servicePointId) ? map.servicePoints[servicePointId] : undefined;
  const path = '/servicePoints/' + escape(servicePointId);
  const summary: ServiceConnectionSummary = {
    servicePointId, nodeId: point?.nodeId ?? '',
    owner: point?.facilityId ? { kind: 'facility', id: point.facilityId } : point?.zoneId ? { kind: 'zone', id: point.zoneId } : null,
    incidentRoadIds: [], arrivalMode: point?.arrival?.mode ?? 'undeclared',
    internalPathStatus: 'not_declared', internalPathLengthM: null, status: 'unchecked', issues: [],
    unchecked: ['network_reachability', 'turn_rules', 'physical_clearance', 'resource_execution', 'external_access'],
  };
  function add(code: string, suffix: string, message: string, severity: 'warning' | 'error' = 'warning', blocked = true) {
    summary.issues.push({ code, severity, entityType: 'servicePoints', entityId: servicePointId, jsonPath: path + suffix, message,
      suggestedAction: '检查显式归属、节点、道路方向与到达声明；本阶段不发布可达路径。',
      ...(point && Object.hasOwn(map.nodes, point.nodeId) ? { location: { position: [...map.nodes[point.nodeId]!.position] as [number, number, number] } } : {}),
    });
    if (blocked) summary.status = 'blocked';
  }
  if (!point) { add('DANGLING_REFERENCE', '', '服务点不存在。', 'error'); return summary; }
  const node = Object.hasOwn(map.nodes, point.nodeId) ? map.nodes[point.nodeId] : undefined;
  if (!node) add('DANGLING_REFERENCE', '/nodeId', '服务点的权威节点不存在。', 'error');
  if (point.facilityId && !Object.hasOwn(map.facilities, point.facilityId)) add('DANGLING_REFERENCE', '/facilityId', '归属设施不存在。', 'error');
  if (point.accessPointId && !Object.hasOwn(map.accessPoints, point.accessPointId)) add('DANGLING_REFERENCE', '/accessPointId', '关联设施入口不存在。', 'error');
  if (point.facilityId && point.accessPointId && Object.hasOwn(map.accessPoints, point.accessPointId) && map.accessPoints[point.accessPointId]!.facilityId !== point.facilityId) add('SERVICE_ACCESS_FACILITY_CONFLICT', '/accessPointId', '服务点与入口的设施归属不一致。', 'error');
  if (point.facilityId && point.zoneId) add('SERVICE_OWNER_CONFLICT', '/zoneId', '设施与区域不能同时作为服务点的主归属。', 'error');
  if (point.zoneId && point.accessPointId) add('SERVICE_OWNER_CONFLICT', '/accessPointId', '区域归属不能同时引用设施入口。', 'error');
  if (!point.facilityId && !point.zoneId) add('SERVICE_OWNER_UNDECLARED', '', '服务点尚未声明设施或区域主归属，仅作草稿。');
  if (point.accessPointId && !point.facilityId) add('SERVICE_ACCESS_OWNER_UNDECLARED', '/facilityId', '引用设施入口时须明确其设施归属。');
  if (point.zoneId) {
    const zone = Object.hasOwn(map.zones, point.zoneId) ? map.zones[point.zoneId] : undefined;
    if (!zone) add('DANGLING_REFERENCE', '/zoneId', '归属区域不存在。', 'error');
    else if (['water', 'forbidden', 'obstacle'].includes(zone.kind) || zone.passability === 'forbidden')
      add('SERVICE_ZONE_LAND_ACCESS_UNSUPPORTED', '/zoneId', '水域、禁入或障碍区域尚不支持普通陆上服务接入；添加服务点不会改变区域通行语义。');
  }
  let inbound = 0;
  for (const [id, road] of Object.entries(map.roads)) {
    if (road.fromNodeId !== point.nodeId && road.toNodeId !== point.nodeId) continue;
    summary.incidentRoadIds.push(id);
    if (road.direction === 'unknown') add('SERVICE_ROAD_DIRECTION_UNDECLARED', '/nodeId', `接入道路 ${id} 方向未声明，不能确认到达方向。`);
    if (road.direction === 'both' || (road.direction === 'forward' && road.toNodeId === point.nodeId) || (road.direction === 'backward' && road.fromNodeId === point.nodeId)) inbound++;
  }
  summary.incidentRoadIds.sort();
  if (!summary.incidentRoadIds.length) add('SERVICE_NODE_UNCONNECTED', '/nodeId', '目标节点不是任何道路的显式端点；落在折线中部或坐标重合不表示接路，请显式拆分/连接。');
  else if (!inbound) add('SERVICE_NO_INBOUND_ARC', '/nodeId', '没有已声明允许进入该节点的道路弧。');

  const arrival = point.arrival;
  if (!arrival) { add('SERVICE_ARRIVAL_UNDECLARED', '/arrival', '到达抽象尚未声明；旧图不会自动补成代理或内部路径。'); return summary; }
  if (arrival.mode === 'node_proxy') {
    summary.internalPathStatus = 'not_required';
    if (!arrival.note.trim()) add('PROXY_ASSUMPTION_EMPTY', '/arrival/note', '节点代理必须写明未建模场内转运的处理边界。', 'error');
    const facility = point.facilityId && Object.hasOwn(map.facilities, point.facilityId) ? map.facilities[point.facilityId] : undefined;
    if (node && facility?.kind === 'workshop' && pointInRing(node.position, facility.boundary.outer) === 'inside'
      && facility.boundary.holes.every(ring => pointInRing(node.position, ring) === 'outside'))
      add('PROXY_INSIDE_BUILDING', '/nodeId', '节点代理位于厂房外环内部且不在孔洞中；请核对边界/入口位置，不能以代理声明代替穿墙路线。');
    add('SERVICE_ROUTE_UNCHECKED', '/arrival', '代理目标已声明，但全网起点可达性、转向、资源及物理通行仍未校验。', 'warning', false);
    return summary;
  }
  summary.internalPathStatus = 'incomplete';
  let entryNodeId: string | undefined;
  if (point.accessPointId) {
    if (arrival.entryNodeId !== undefined) add('INTERNAL_ENTRY_CONFLICT', '/arrival/entryNodeId', '设施入口已给出权威起点，不允许第二份 entryNodeId。', 'error');
    if (Object.hasOwn(map.accessPoints, point.accessPointId)) entryNodeId = map.accessPoints[point.accessPointId]!.nodeId;
  } else if (point.facilityId) {
    if (arrival.entryNodeId !== undefined) add('INTERNAL_ENTRY_CONFLICT', '/arrival/entryNodeId', '设施内部服务须使用所属设施的入口，不能另填 entryNodeId 绕过入口关联。', 'error');
    add('INTERNAL_ACCESS_UNDECLARED', '/accessPointId', '设施内部服务尚未指定同设施入口。');
  } else {
    entryNodeId = arrival.entryNodeId;
    if (!entryNodeId) add('INTERNAL_ENTRY_UNDECLARED', '/arrival/entryNodeId', '区域或独立服务点的内部通路须显式声明起始节点。');
  }
  if (entryNodeId && !Object.hasOwn(map.nodes, entryNodeId)) add('DANGLING_REFERENCE', '/arrival/entryNodeId', '内部通路起始节点不存在。', 'error');
  if (!arrival.internalPath.length) { add('INTERNAL_PATH_UNDECLARED', '/arrival/internalPath', '尚未声明入口到目标的内部道路序列；入口关联不会产生瞬移。'); return summary; }
  let previousEnd: string | undefined;
  let lengthM = 0;
  let complete = !!entryNodeId && !!node;
  for (let index = 0; index < arrival.internalPath.length; index++) {
    const arc = arrival.internalPath[index]!;
    const suffix = '/arrival/internalPath/' + index;
    const road = Object.hasOwn(map.roads, arc.roadId) ? map.roads[arc.roadId] : undefined;
    if (!road) { add('DANGLING_REFERENCE', suffix + '/roadId', '内部道路引用不存在。', 'error'); complete = false; previousEnd = undefined; continue; }
    const start = arc.direction === 'forward' ? road.fromNodeId : road.toNodeId;
    const end = arc.direction === 'forward' ? road.toNodeId : road.fromNodeId;
    if (road.direction === 'unknown') add('INTERNAL_PATH_DIRECTION_UNDECLARED', suffix, '内部道路方向未知，尚不能确认该方向允许通行。');
    else if (road.direction !== 'both' && road.direction !== arc.direction) { add('INTERNAL_PATH_DIRECTION_FORBIDDEN', suffix + '/direction', '内部道路声明方向禁止此弧。', 'error'); complete = false; }
    if (index === 0 && entryNodeId && start !== entryNodeId) { add('INTERNAL_PATH_START_MISMATCH', suffix, '首道路弧没有从显式入口节点出发。', 'error'); complete = false; }
    if (index > 0 && previousEnd !== start) { add('INTERNAL_PATH_DISCONTINUOUS', suffix, '内部道路序列的相邻端点 ID 不连续；相交或重合不连通。', 'error'); complete = false; }
    if (index === arrival.internalPath.length - 1 && end !== point.nodeId) { add('INTERNAL_PATH_END_MISMATCH', suffix, '内部道路序列没有终止于该服务点 nodeId。', 'error'); complete = false; }
    if (index > 0 && Object.values(map.movements).some(movement => !movement.allowed && sameArc(movement.incomingArc, arrival.internalPath[index - 1]!) && sameArc(movement.outgoingArc, arc))) {
      add('INTERNAL_TURN_FORBIDDEN', suffix, '显式转向规则禁止此道路衔接。', 'error'); complete = false;
    }
    if (Object.hasOwn(map.nodes, road.fromNodeId) && Object.hasOwn(map.nodes, road.toNodeId)) {
      if (!lengths.has(arc.roadId)) lengths.set(arc.roadId, roadLength(map, arc.roadId));
      lengthM += lengths.get(arc.roadId)!;
    }
    else complete = false;
    previousEnd = end;
  }
  if (complete && Number.isFinite(lengthM)) { summary.internalPathStatus = 'continuous'; summary.internalPathLengthM = lengthM; }
  else summary.status = 'blocked';
  add('SERVICE_ROUTE_UNCHECKED', '/arrival/internalPath', '已检查显式道路序列的节点连续性；仍未发布全网可达路径、允许转向或资源/物理通行。', 'warning', false);
  return summary;
}
