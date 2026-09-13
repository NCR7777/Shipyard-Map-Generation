import type { Polygon, Vec3, YardMap } from './model';
import { PLANNING_NAMESPACE } from './planning';
import { sameValue } from './value';
import { projectPolyline } from '../geometry/roads';
import { pointInPolygon } from '../geometry/relations';
import { GEOMETRY_TOLERANCE_M as EPS } from '../geometry/polygons';

export class OwnerEditError extends Error {
  constructor(readonly code: string, message: string, readonly path: string) { super(message); }
}
export function roadOwner(map: YardMap, id: string): string | undefined {
  const fields = map.roads[id]?.extensions?.[PLANNING_NAMESPACE] as { ownerEntityId?: string } | undefined;
  return fields?.ownerEntityId;
}
export function pointOwner(point: { facilityId?: string; zoneId?: string }): string | undefined {
  return point.facilityId ?? point.zoneId;
}
/** Core references only. Metadata, containment and names never grant ownership. */
export function nodeOwners(map: YardMap, nodeId: string): { owners: Set<string>; businessPoint: boolean; unownedPoint: boolean } {
  const owners = new Set<string>(); let businessPoint = false, unownedPoint = false;
  for (const point of Object.values(map.accessPoints)) if (point.nodeId === nodeId) { owners.add(point.facilityId); businessPoint = true; }
  for (const point of Object.values(map.servicePoints)) if (point.nodeId === nodeId || point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === nodeId) {
    const owner = pointOwner(point);
    if (owner) owners.add(owner); else unownedPoint = true;
    businessPoint = true;
  }
  for (const [id, road] of Object.entries(map.roads)) if (road.fromNodeId === nodeId || road.toNodeId === nodeId) {
    const owner = roadOwner(map, id); if (owner) owners.add(owner);
  }
  return { owners, businessPoint, unownedPoint };
}
/** A dedicated leaf access may stretch its single declared edge without claiming that edge is owned. */
export function privateNodeOwner(map: YardMap, nodeId: string): string | undefined {
  const refs = nodeOwners(map, nodeId);
  if (!refs.owners.size && !refs.unownedPoint) return undefined;
  if (refs.owners.size !== 1 || refs.unownedPoint) throw new OwnerEditError('OWNER_SHARED_NODE', '该点被多个归属或未声明归属的作业点共用；请先明确独立入口。', '/nodes/' + nodeId);
  const owner = [...refs.owners][0]!;
  const roads = Object.entries(map.roads).filter(([, road]) => road.fromNodeId === nodeId || road.toNodeId === nodeId);
  const external = roads.filter(([id]) => roadOwner(map, id) !== owner);
  if (external.length && !(refs.businessPoint && roads.length === 1 && !roadOwner(map, external[0]![0]))) {
    throw new OwnerEditError('OWNER_PUBLIC_NODE', '该入口与公共道路或其他对象共用节点；公共节点保持固定，请建立独立入口后再移动。', '/nodes/' + nodeId);
  }
  return owner;
}

/** Candidate positions only; caller still validates and previews the entire atomic boundary command. */
export function boundaryEntranceAdjustments(map: YardMap, facilityId: string, boundary: Polygon): { id: string; position: Vec3 }[] {
  const result: { id: string; position: Vec3 }[] = [], seen = new Set<string>();
  const facility = map.facilities[facilityId]; if (!facility) return result;
  for (const [id, access] of Object.entries(map.accessPoints)) {
    if (access.facilityId !== facilityId || seen.has(access.nodeId)) continue;
    const position = map.nodes[access.nodeId]!.position;
    if (pointInPolygon(position, facility.boundary) !== 'boundary' || pointInPolygon(position, boundary) === 'boundary') continue;
    if (privateNodeOwner(map, access.nodeId) !== facilityId) throw new OwnerEditError('OWNER_ENTRANCE_REPAIR_UNSUPPORTED', 'Entrance does not have a private owner authority node.', `/accessPoints/${id}/nodeId`);
    const candidates = [boundary.outer, ...boundary.holes].flatMap(ring => ring.slice(1).map((end, i) => projectPolyline(position, [ring[i]!, end]))).filter(value => value !== null);
    candidates.sort((a, b) => a.offsetM - b.offsetM);
    const nearest = candidates[0];
    if (!nearest || candidates[1] && Math.abs(candidates[1].offsetM - nearest.offsetM) <= EPS || Math.abs(nearest.position[2] - position[2]) > EPS) throw new OwnerEditError('OWNER_ENTRANCE_REPAIR_AMBIGUOUS', 'No unique planar boundary projection is available.', `/accessPoints/${id}/nodeId`);
    seen.add(access.nodeId); result.push({ id, position: [nearest.position[0], nearest.position[1], position[2]] });
  }
  return result;
}
/** Explicit adjacent road IDs for an optional batch; stops at branches or semantic boundaries. */
export function continuousRoadIds(map: YardMap, startId: string): string[] {
  if (!map.roads[startId]) return [];
  const selected = new Set([startId]);
  const signature = (id: string, at: string) => {
    const road = map.roads[id]!;
    return road.direction === 'both' || road.direction === 'unknown' ? road.direction : (road.direction === 'forward') === (road.toNodeId === at) ? 'in' : 'out';
  };
  const walk = (initialId: string, initialNode: string) => {
    let id = initialId, node = initialNode;
    while (true) {
      if (nodeOwners(map, node).businessPoint) break;
      const incident = Object.keys(map.roads).filter(key => map.roads[key]!.fromNodeId === node || map.roads[key]!.toNodeId === node);
      if (incident.length !== 2) break;
      const nextId = incident.find(key => key !== id)!; if (selected.has(nextId)) break;
      const a = map.roads[id]!, b = map.roads[nextId]!;
      if ((a.fromNodeId === node) === (b.fromNodeId === node) || a.direction !== b.direction || roadOwner(map, id) !== roadOwner(map, nextId) || ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps', 'resourceIds'].some(field => !sameValue(a[field as keyof typeof a], b[field as keyof typeof b]))) break;
      const first = signature(id, node), second = signature(nextId, node);
      if (first === 'both' || first === 'unknown' ? first !== second : second !== (first === 'in' ? 'out' : 'in')) break;
      selected.add(nextId); id = nextId; node = b.fromNodeId === node ? b.toNodeId : b.fromNodeId;
    }
  };
  const road = map.roads[startId]!; walk(startId, road.fromNodeId); walk(startId, road.toNodeId);
  return [...selected];
}
