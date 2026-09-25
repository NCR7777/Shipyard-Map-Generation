import type { SceneKind } from '../../adapters/contracts';
import { ENTITY_RECORDS, type YardMap } from '../../domain/model';
import { KIND_LABELS } from './labels';

/** Does this record cite the source through its provenance, a known physical value, or (assets) its own sourceRef? */
function citesSource(entity: object, id: string): boolean {
  const record = entity as { provenance?: { sourceRefs?: string[]; fieldSources?: Record<string, string> }; sourceRef?: unknown };
  if (record.sourceRef === id || record.provenance?.sourceRefs?.includes(id) || Object.values(record.provenance?.fieldSources ?? {}).includes(id)) return true;
  return Object.values(entity).some(value => typeof value === 'object' && value !== null && value.state === 'known' && value.sourceRef === id);
}

/** Direct references only, both directions, for every ID field of the v0.3 model; nothing is inferred from proximity. */
export function relatedKeys(map: YardMap, kind: SceneKind, id: string): [string, string][] {
  const out: [string, string][] = [];
  if (kind === 'nodes') {
    for (const [roadId, road] of Object.entries(map.roads)) if (road.fromNodeId === id || road.toNodeId === id) out.push(['连接道路', 'roads/' + roadId]);
    for (const [pointId, point] of Object.entries(map.accessPoints)) if (point.nodeId === id) out.push(['入口', 'accessPoints/' + pointId]);
    for (const [pointId, point] of Object.entries(map.servicePoints)) if (point.nodeId === id) out.push(['作业点', 'servicePoints/' + pointId]);
    for (const [junctionId, junction] of Object.entries(map.junctions)) if (junction.nodeIds.includes(id)) out.push(['路口', 'junctions/' + junctionId]);
    for (const [pointId, point] of Object.entries(map.servicePoints)) if (point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === id) out.push(['以此为通道入口', 'servicePoints/' + pointId]);
  } else if (kind === 'roads') {
    const road = map.roads[id]!;
    out.push(['起点', 'nodes/' + road.fromNodeId], ['终点', 'nodes/' + road.toNodeId]);
    for (const [movementId, movement] of Object.entries(map.movements)) if (movement.incomingArc.roadId === id || movement.outgoingArc.roadId === id) out.push(['转向', 'movements/' + movementId]);
    for (const resourceId of road.resourceIds) out.push(['资源', 'resources/' + resourceId]);
    for (const [pointId, point] of Object.entries(map.servicePoints)) if (point.arrival?.mode === 'explicit_internal' && point.arrival.internalPath.some(arc => arc.roadId === id)) out.push(['经此通道作业点', 'servicePoints/' + pointId]);
  } else if (kind === 'facilities') {
    const facility = map.facilities[id]!;
    facility.accessPointIds.forEach(pointId => out.push(['入口', 'accessPoints/' + pointId]));
    facility.servicePointIds.forEach(pointId => out.push(['作业点', 'servicePoints/' + pointId]));
    if (facility.assetId) out.push(['图片资源', 'assets/' + facility.assetId]);
  } else if (kind === 'zones') {
    for (const [pointId, point] of Object.entries(map.servicePoints)) if (point.zoneId === id) out.push(['作业点', 'servicePoints/' + pointId]);
    map.zones[id]!.resourceIds?.forEach(resourceId => out.push(['资源', 'resources/' + resourceId]));
  } else if (kind === 'junctions') {
    const junction = map.junctions[id]!;
    junction.nodeIds.forEach(nodeId => out.push(['节点', 'nodes/' + nodeId]));
    for (const [movementId, movement] of Object.entries(map.movements)) if (movement.junctionId === id) out.push(['转向', 'movements/' + movementId]);
    junction.resourceIds.forEach(resourceId => out.push(['资源', 'resources/' + resourceId]));
  } else if (kind === 'movements') {
    const movement = map.movements[id]!;
    out.push(['路口', 'junctions/' + movement.junctionId], ['驶入道路', 'roads/' + movement.incomingArc.roadId], ['驶出道路', 'roads/' + movement.outgoingArc.roadId]);
    movement.resourceIds.forEach(resourceId => out.push(['资源', 'resources/' + resourceId]));
  } else if (kind === 'resources') {
    map.resources[id]!.appliesTo.forEach(ref => out.push(['作用于' + KIND_LABELS[ref.entityType], ref.entityType + '/' + ref.entityId]));
    for (const owner of ['roads', 'junctions', 'movements', 'servicePoints', 'zones'] as const) for (const [entityId, entity] of Object.entries(map[owner])) {
      const key = owner + '/' + entityId;
      if (entity.resourceIds?.includes(id) && !out.some(([, listed]) => listed === key)) out.push(['被' + KIND_LABELS[owner] + '引用', key]);
    }
  } else if (kind === 'assets') {
    out.push(['来源', 'sources/' + map.assets[id]!.sourceRef]);
    for (const [facilityId, facility] of Object.entries(map.facilities)) if (facility.assetId === id) out.push(['被建筑使用', 'facilities/' + facilityId]);
    for (const [layerId, layer] of Object.entries(map.backgroundLayers)) if (layer.assetId === id) out.push(['被底图使用', 'backgroundLayers/' + layerId]);
  } else if (kind === 'backgroundLayers') {
    out.push(['图片资源', 'assets/' + map.backgroundLayers[id]!.assetId]);
  } else if (kind === 'sources') {
    for (const collection of ENTITY_RECORDS) for (const [entityId, entity] of Object.entries(map[collection])) if (citesSource(entity, id)) out.push(['被' + KIND_LABELS[collection] + '引用', collection + '/' + entityId]);
  } else if (kind === 'accessPoints') {
    const point = map.accessPoints[id]!;
    out.push(['所属建筑', 'facilities/' + point.facilityId], ['节点', 'nodes/' + point.nodeId]);
    for (const [pointId, service] of Object.entries(map.servicePoints)) if (service.accessPointId === id) out.push(['经此入口作业点', 'servicePoints/' + pointId]);
  } else if (kind === 'servicePoints') {
    const point = map.servicePoints[id]!;
    out.push(['节点', 'nodes/' + point.nodeId]);
    if (point.facilityId) out.push(['所属建筑', 'facilities/' + point.facilityId]);
    if (point.zoneId) out.push(['所属区域', 'zones/' + point.zoneId]);
    if (point.accessPointId) out.push(['接入入口', 'accessPoints/' + point.accessPointId]);
    if (point.arrival?.mode === 'explicit_internal') {
      if (point.arrival.entryNodeId) out.push(['通道入口节点', 'nodes/' + point.arrival.entryNodeId]);
      point.arrival.internalPath.forEach((arc, index) => out.push([`内部通道 ${index + 1}`, 'roads/' + arc.roadId]));
    }
    point.resourceIds.forEach(resourceId => out.push(['资源', 'resources/' + resourceId]));
  }
  // Resources also name what they apply to; add that reverse reference unless the object already lists the resource.
  for (const [resourceId, resource] of Object.entries(map.resources)) {
    const key = 'resources/' + resourceId;
    if (resource.appliesTo.some(ref => ref.entityType === kind && ref.entityId === id) && !out.some(([, listed]) => listed === key)) out.push(['作用于此的资源', key]);
  }
  return out;
}
