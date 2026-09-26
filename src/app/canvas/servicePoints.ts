import { commandSupport, type MapCommand } from '../../domain/commands';
import type { MapNode, ServicePoint, Vec3, YardMap } from '../../domain/model';
import { nodeOwners } from '../../domain/ownerEditing';
import { PLANNING_NAMESPACE } from '../../domain/planning';
import { isInferredSemantic } from '../../domain/semanticPatch';
import { polygonArea2D, pointInRing } from '../../geometry/polygons';
import type { Camera } from '../../geometry/coordinates';
import { ENTRANCE_PX, SAME_PLACE_PX } from './entrances';
import { translateCommand } from './movePreview';

/** The service point tool (S). A click on an entrance puts the point on the entrance's node, reached there (node proxy, with
 *  the in-site transfer assumption chosen in the tool options) and linked to that entrance: complete in one click. A click on
 *  a node already inside a building or zone puts the point on that node; anywhere else inside one the point gets a node of its
 *  own. Those two are drafts with no declared arrival, as the old tool's "place now, connect later"; a new node goes only
 *  where a road can later be drawn to it. */

export type ServiceOwner = { kind: 'facilities' | 'zones'; id: string };
/** `node`: a node already there that the point stands on (not an entrance's). */
export interface ServiceSpot { owner: ServiceOwner; point: Vec3; entrance: string | null; node: string | null }
export type Transfer = 'included_in_service_duration' | 'excluded_from_model';
export const TRANSFER_LABELS: Record<Transfer, string> = { included_in_service_duration: '场内转运计入作业时长', excluded_from_model: '场内转运不在模型内' };
/** The note the kernel requires a node proxy to state, for a point placed on an entrance. */
export const proxyNote = (transfer: Transfer) => `在入口节点作业（作业点工具放置）；${TRANSFER_LABELS[transfer]}。`;

const within = (world: Vec3, boundary: { outer: readonly Vec3[]; holes: readonly (readonly Vec3[])[] }) =>
  pointInRing(world, boundary.outer) !== 'outside' && boundary.holes.every(hole => pointInRing(world, hole) === 'outside');

/** Where a click puts a service point: on an entrance within 12 px (of a building; on a node two buildings' entrances share,
 *  the one whose building is under the pointer); else in, or on the outer outline of, the smallest building under the
 *  pointer, else of the smallest zone (never in a hole or on its edge), on a node of the same height already there within
 *  6 px if any. Hidden layers are passed over (an entrance of a hidden building too). */
export function serviceSpot(map: YardMap, world: Vec3, camera: Camera, hidden: readonly string[] = []): ServiceSpot | null {
  let best: { id: string; d: number; under: boolean } | null = null;
  if (!hidden.includes('accessPoints') && !hidden.includes('facilities')) for (const [id, entrance] of Object.entries(map.accessPoints)) {
    const node = map.nodes[entrance.nodeId], facility = map.facilities[entrance.facilityId];
    const d = node ? Math.hypot(node.position[0] - world[0], node.position[1] - world[1]) : Infinity;
    if (!facility || d > ENTRANCE_PX / camera.scale) continue;
    const under = pointInRing(world, facility.boundary.outer) !== 'outside';
    if (!best || d < best.d - 1e-9 || Math.abs(d - best.d) <= 1e-9 && under && !best.under) best = { id, d, under };
  }
  if (best) {
    const entrance = map.accessPoints[best.id]!;
    return { owner: { kind: 'facilities', id: entrance.facilityId }, point: [...map.nodes[entrance.nodeId]!.position], entrance: best.id, node: null };
  }
  for (const kind of ['facilities', 'zones'] as const) {
    if (hidden.includes(kind)) continue;
    let owner: { id: string; area: number } | null = null;
    for (const [id, item] of Object.entries(map[kind])) {
      if (!within(world, item.boundary)) continue;
      const area = polygonArea2D(item.boundary);
      if (!owner || area < owner.area) owner = { id, area };
    }
    if (!owner) continue;
    const boundary = map[kind][owner.id]!.boundary, z = boundary.outer[0]![2], tolerance = SAME_PLACE_PX / camera.scale;
    let node: { id: string; d: number } | null = null;
    for (const [id, candidate] of Object.entries(map.nodes)) {
      const d = Math.hypot(candidate.position[0] - world[0], candidate.position[1] - world[1]);
      if (d < tolerance && candidate.position[2] === z && within(candidate.position, boundary) && (!node || d < node.d)) node = { id, d };
    }
    return { owner: { kind, id: owner.id }, point: node ? [...map.nodes[node.id]!.position] : [world[0], world[1], z], entrance: null, node: node?.id ?? null };
  }
  return null;
}

/** Why a point cannot go there, or null. A node already there must not belong to anything else, and standing on it must not
 *  stop its owner moving (the node becomes the owner's, and a road end whose road bends cannot be stretched: the entrance
 *  tool's rule); a new node only where a road can later be drawn to it: not inside a workshop (public roads may not enter
 *  one; a point there is reached by an internal route from an entrance), a building closed to vehicles, or a forbidden,
 *  water or obstacle zone. */
export function serviceRefusal(map: YardMap, spot: ServiceSpot): string | null {
  if (spot.entrance) return null;
  const owner = map[spot.owner.kind][spot.owner.id]!;
  if (spot.node) {
    const refs = nodeOwners(map, spot.node), other = [...refs.owners].find(id => id !== spot.owner.id);
    if (other || refs.unownedPoint) return `此处的节点「${map.nodes[spot.node]!.name}」已属于${other ? `「${(map.facilities[other] ?? map.zones[other])?.name ?? other}」` : '没有声明归属的作业点'}，不能再放「${owner.name}」的作业点。`;
    // The pointer hovers here many times per second; the kernel's move check takes tens of milliseconds on large maps.
    let known = stops.get(map); if (!known) stops.set(map, known = new Map());
    const key = spot.owner.kind + '/' + spot.owner.id + '\u0000' + spot.node;
    if (!known.has(key)) known.set(key, wouldStopMoving(map, spot));
    return known.get(key)!;
  }
  if (spot.owner.kind === 'facilities') {
    const facility = map.facilities[spot.owner.id]!;
    if (facility.kind === 'workshop' && !isInferredSemantic(facility)) return pointInRing(spot.point, facility.boundary.outer) === 'boundary'
      ? `这里在厂房「${facility.name}」的外边界上，但不是入口：请先用入口工具（E）在这里加入口，再点入口放作业点。`
      : `「${facility.name}」是厂房，新道路不能穿进厂房，这里放下的作业点接不上路：请在它的入口处放作业点（厂房内部经内部通道到达的作业点以后在向导中添加）。`;
  } else {
    const zone = map.zones[spot.owner.id]!;
    if (zone.passability === 'forbidden' || ['water', 'forbidden', 'obstacle'].includes(zone.kind)) return `「${zone.name}」是水域、障碍或禁入区域，不能放陆上作业点。`;
  }
  // Inside a space closed to roads (its own owner or another object under the point: the kernel's list of spaces a road band
  // may not cross), a road could never reach the new node.
  const closed = [...Object.values(map.zones).filter(zone => zone.passability === 'forbidden'),
    ...Object.values(map.facilities).filter(facility => (facility.extensions?.[PLANNING_NAMESPACE] as { vehicleAccess?: string } | undefined)?.vehicleAccess === 'forbidden')]
    .find(space => within(spot.point, space.boundary));
  if (closed) return `这里在「${closed.name}」内，那里禁止车辆通行，道路画不进来，这里放下的作业点接不上路。`;
  return null;
}

const stops = new WeakMap<YardMap, Map<string, string | null>>();
/** Why standing on the node would stop the owner moving (it could before), by the kernel's rules on the map with the point. */
function wouldStopMoving(map: YardMap, spot: ServiceSpot): string | null {
  const ownerField = spot.owner.kind === 'facilities' ? { facilityId: spot.owner.id } : { zoneId: spot.owner.id };
  const probe = { ...map, servicePoints: { ...map.servicePoints, ['\u0000service-probe']: { name: '', kind: 'other', nodeId: spot.node!, ...ownerField, resourceIds: [], provenance: { category: 'drawing' } } } } as YardMap;
  const move = translateCommand({ nodes: [], roads: [], [spot.owner.kind]: [spot.owner.id] }, [0.001, 0, 0]);
  if (!commandSupport(map, move).allowed) return null;
  const after = commandSupport(probe, move);
  if (after.allowed) return null;
  const issue = after.issues.find(item => item.severity === 'error'), owner = `「${map[spot.owner.kind][spot.owner.id]!.name}」`;
  const road = issue?.code === 'STATIC_CONNECTOR_SHAPE_UNSUPPORTED' && issue.entityId ? map.roads[issue.entityId] : undefined;
  return `作业点若用节点「${map.nodes[spot.node!]!.name}」，这个节点就归${owner}，${road ? `道路「${road.name}」有折点或独立几何，${owner}移动时内核不能伸缩它` : `内核会拒绝${owner}的整体移动（${issue?.message ?? '原因未说明'}）`}，${owner}将不能移动。请在旁边另点一处（离它 6 px 内都算这里，放大后可以点得更近）。`;
}

/** 作业点001, 作业点002, …: the first number no service point of this owner uses. */
export function nextServiceName(map: YardMap, owner: ServiceOwner): string {
  const key = owner.kind === 'facilities' ? 'facilityId' : 'zoneId';
  const used = new Set(Object.values(map.servicePoints).filter(point => point[key] === owner.id).map(point => point.name));
  for (let n = 1; ; n++) { const name = '作业点' + String(n).padStart(3, '0'); if (!used.has(name)) return name; }
}

/** A point of this owner and kind already there (on the entrance's or the reused node, or within 6 px): a second click. */
export function serviceAt(map: YardMap, spot: ServiceSpot, kind: ServicePoint['kind'], camera: Camera): string | null {
  const key = spot.owner.kind === 'facilities' ? 'facilityId' : 'zoneId', tolerance = SAME_PLACE_PX / camera.scale;
  const at = spot.entrance ? map.accessPoints[spot.entrance]!.nodeId : spot.node;
  for (const [id, point] of Object.entries(map.servicePoints)) {
    if (point[key] !== spot.owner.id || point.kind !== kind) continue;
    const node = map.nodes[point.nodeId];
    if (at ? point.nodeId === at : !!node && Math.hypot(node.position[0] - spot.point[0], node.position[1] - spot.point[1]) < tolerance) return id;
  }
  return null;
}

/** The command for one click (one undo step). */
export function serviceCommand(map: YardMap, spot: ServiceSpot, kind: ServicePoint['kind'], transfer: Transfer, ids: { point: string; node: string }): { command: MapCommand; name: string } {
  const name = nextServiceName(map, spot.owner), owner = map[spot.owner.kind][spot.owner.id];
  if (!owner) throw new RangeError('所属对象已不在地图中。');
  const provenance = { category: 'drawing' as const, ...owner.provenance.sourceRefs?.length ? { sourceRefs: [...owner.provenance.sourceRefs] } : {} };
  const ownerField = spot.owner.kind === 'facilities' ? { facilityId: spot.owner.id } : { zoneId: spot.owner.id };
  if (spot.entrance) {
    const entrance = map.accessPoints[spot.entrance]!;
    const servicePoint: ServicePoint = { name, kind, nodeId: entrance.nodeId, ...ownerField, accessPointId: spot.entrance, resourceIds: [],
      arrival: { mode: 'node_proxy', transferAssumption: transfer, note: proxyNote(transfer) },
      provenance: { ...provenance, note: `人工点选入口「${entrance.name}」，作业点放在入口节点上。` } };
    return { name, command: { type: 'addServicePoint', id: ids.point, servicePoint } };
  }
  if (spot.node) {
    const servicePoint: ServicePoint = { name, kind, nodeId: spot.node, ...ownerField, resourceIds: [],
      provenance: { ...provenance, note: `人工点选所属对象内已有的节点「${map.nodes[spot.node]!.name}」；到达方式未声明（草稿）。` } };
    return { name, command: { type: 'addServicePoint', id: ids.point, servicePoint } };
  }
  const note = '人工点选所属对象内部的位置；作业点有自己的节点，未接路，到达方式未声明（草稿）。';
  const node: MapNode = { name: name + '节点', position: [...spot.point], kind: 'service', provenance: { ...provenance, note } };
  const servicePoint: ServicePoint = { name, kind, nodeId: ids.node, ...ownerField, resourceIds: [], provenance: { ...provenance, note } };
  return { name, command: { type: 'addServicePoint', id: ids.point, servicePoint, newNode: { id: ids.node, node } } };
}
