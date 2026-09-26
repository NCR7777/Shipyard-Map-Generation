import { applyMapCommand, commandSupport, type MapCommand, type Selection } from '../../domain/commands';
import type { ConnectedPointCommand } from '../../domain/connectedPoint';
import type { MapNode, Polygon, ServicePoint, Vec3, YardMap } from '../../domain/model';
import { nodeOwners, roadOwner } from '../../domain/ownerEditing';
import { PLANNING_NAMESPACE } from '../../domain/planning';
import { isInferredSemantic } from '../../domain/semanticPatch';
import { polygonArea2D, pointInRing } from '../../geometry/polygons';
import { polylineWithinPolygon } from '../../geometry/relations';
import type { Camera } from '../../geometry/coordinates';
import { inspectServiceConnection } from '../../topology/serviceConnections';
import { ENTRANCE_PX, SAME_PLACE_PX } from './entrances';
import { translateCommand } from './movePreview';

/** The service point tool (S). A click on an entrance puts the point on the entrance's node, reached there (node proxy, with
 *  the in-site transfer assumption chosen in the tool options) and linked to that entrance: complete in one click. Elsewhere
 *  inside a building the point gets a node of its own and, by default, its own internal route: one straight road, owned by
 *  the building, from the nearest entrance's node (how the real maps' internal points are reached). A click on a node already
 *  inside a building or zone puts the point on that node, and elsewhere inside a zone (or a building, the tool options set to
 *  drafts) the point gets a node of its own: drafts with no declared arrival, as the old tool's "place now, connect later";
 *  a draft's new node goes only where a road can later be drawn to it. */

export type ServiceOwner = { kind: 'facilities' | 'zones'; id: string };
/** `node`: a node already there that the point stands on (not an entrance's). */
export interface ServiceSpot { owner: ServiceOwner; point: Vec3; entrance: string | null; node: string | null }
export type Transfer = 'included_in_service_duration' | 'excluded_from_model';
export const TRANSFER_LABELS: Record<Transfer, string> = { included_in_service_duration: '场内转运计入作业时长', excluded_from_model: '场内转运不在模型内' };
/** Inside a building: the point reached by its own internal route from an entrance, or a draft to connect later. */
export type Inside = 'internal' | 'draft';
export const INSIDE_LABELS: Record<Inside, string> = { internal: '经内部通道', draft: '草稿' };
/** What a click with the tool does, by how a point inside a building is reached (the tool options). */
export const serviceStep = (inside: Inside) => inside === 'internal'
  ? '点入口：在入口节点作业；点建筑内部：经内部通道连到最近的可用入口；点区域内部或已有节点：草稿。Esc 结束'
  : '点入口：在入口节点作业；点建筑或区域内部、已有节点：草稿（厂房内部除外）。Esc 结束';
/** The note the kernel requires a node proxy to state: on an entrance's node, or on the point's own node. */
export const proxyNote = (transfer: Transfer, own = false) => `${own ? '在作业点自己的节点作业，车辆经道路到达' : '在入口节点作业'}；${TRANSFER_LABELS[transfer]}。`;
/** A note ending with the transfer sentence these notes end with (the tool's since P3b2b too) has it restated for another
 *  assumption; any other note is kept as it is. */
export function restatedNote(note: string, from: Transfer, to: Transfer): string {
  const sentence = '；' + TRANSFER_LABELS[from] + '。';
  return note.endsWith(sentence) ? note.slice(0, -sentence.length) + '；' + TRANSFER_LABELS[to] + '。' : note;
}

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

/** Whether the point gets an internal route (inside a building, on a node of its own, the options set so). */
export const routed = (spot: ServiceSpot, inside: Inside) => inside === 'internal' && spot.owner.kind === 'facilities' && !spot.entrance && !spot.node;

/** Whether the straight route from an entrance stays in the building once in it: an entrance off the outline (a designed
 *  access point, as on several real maps) is joined by a route that crosses the wall once, as the real maps' routes do; it
 *  must not leave again through a concave corner or a hole. (A route from outside that first grazes a convex corner and then
 *  enters is refused as well: the first meeting counts as the entry; the real maps have no such route.) */
function staysIn(from: Vec3, to: Vec3, boundary: { outer: readonly Vec3[]; holes: readonly (readonly Vec3[])[] }): boolean {
  let t = pointInRing(from, boundary.outer) === 'outside' ? Infinity : 0;
  const dx = to[0] - from[0], dy = to[1] - from[1];
  // Where the route first meets the outer outline: the smallest parameter of its crossings with the outline's edges.
  if (t) for (let i = 1; i < boundary.outer.length; i++) {
    const a = boundary.outer[i - 1]!, b = boundary.outer[i]!, ex = b[0] - a[0], ey = b[1] - a[1], denominator = dx * ey - dy * ex;
    if (denominator === 0) continue;
    const s = ((a[0] - from[0]) * ey - (a[1] - from[1]) * ex) / denominator, u = ((a[0] - from[0]) * dy - (a[1] - from[1]) * dx) / denominator;
    if (s >= 0 && s <= 1 && u >= 0 && u <= 1) t = Math.min(t, s);
  }
  if (!Number.isFinite(t)) return false;
  return polylineWithinPolygon([[from[0] + t * dx, from[1] + t * dy, from[2]], to], boundary as Polygon, () => {});
}

/** The entrance an internal route to the point starts from: of the building's entrances, the nearest one at the point's
 *  height whose node is the building's alone (the kernel's rule) and whose straight route stays in the building once in
 *  it; or why none can be used (the nearest one's reason). */
export function routeEntrance(map: YardMap, spot: ServiceSpot): { entrance: string } | { refusal: string } {
  const facility = map.facilities[spot.owner.id]!;
  const entrances = facility.accessPointIds.map(id => ({ id, node: map.nodes[map.accessPoints[id]?.nodeId ?? ''] }))
    .filter(entry => !!entry.node).map(entry => ({ ...entry, d: Math.hypot(entry.node!.position[0] - spot.point[0], entry.node!.position[1] - spot.point[1]) }))
    .sort((a, b) => a.d - b.d);
  if (!entrances.length) return { refusal: `「${facility.name}」还没有入口：先用入口工具（E）加入口，或在绘图选项里把「建筑内部」改为「${INSIDE_LABELS.draft}」。` };
  let refusal = '';
  for (const { id, node } of entrances) {
    const name = `入口「${map.accessPoints[id]!.name}」`, refs = nodeOwners(map, map.accessPoints[id]!.nodeId);
    const why = node!.position[2] !== spot.point[2] ? `${name}与这里不在同一高度。`
      : [...refs.owners].some(owner => owner !== spot.owner.id) || refs.unownedPoint ? `${name}的节点还属于其他对象，内部通道不能从那里出发。`
      : !staysIn(node!.position, spot.point, facility.boundary) ? `从${name}到这里的直线进入「${facility.name}」后会再穿出它的轮廓（凹角或孔洞）：换个位置，或在绘图选项里改为「${INSIDE_LABELS.draft}」。`
      : '';
    if (!why) return { entrance: id };
    refusal ||= why;
  }
  return { refusal };
}

/** Why a point cannot go there, or null. A node already there must not belong to anything else, and standing on it must not
 *  stop its owner moving (the node becomes the owner's, and a road end whose road bends cannot be stretched: the entrance
 *  tool's rule); a node of its own not in a space closed to vehicles, nor in a forbidden, water or obstacle zone; as a draft,
 *  only where a road can later be drawn to it: not inside a workshop (public roads may not enter one). Where an internal
 *  route can start is `routeEntrance`'s to say. */
export function serviceRefusal(map: YardMap, spot: ServiceSpot, inside: Inside): string | null {
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
    if (facility.kind === 'workshop' && !isInferredSemantic(facility)) {
      if (pointInRing(spot.point, facility.boundary.outer) === 'boundary') return `这里在厂房「${facility.name}」的外边界上，但不是入口：请先用入口工具（E）在这里加入口，再点入口放作业点。`;
      if (inside === 'draft') return `「${facility.name}」是厂房，新道路不能穿进厂房，这里放下的草稿作业点接不上路：在绘图选项里把「建筑内部」改为「${INSIDE_LABELS.internal}」，或在入口处放作业点。`;
    }
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

/** The point with its internal route from the entrance (one undo step): the kernel's connected point, the route one straight
 *  two-way road of the given width, owned by the building; the entrance's junction reused if it has one. Every turn the kernel
 *  proposes between the route and the roads already at the entrance's node (never a U-turn, never against a one-way road) is
 *  approved, both ways in and out as on the real maps, and the source says so. `turns`: how many. */
export function routedCommand(map: YardMap, spot: ServiceSpot, entrance: string, kind: ServicePoint['kind'], widthM: number,
  ids: { point: string; node: string; road: string; junction: string; source: string; movement: () => string }): { command: ConnectedPointCommand; name: string; turns: number } {
  const name = nextServiceName(map, spot.owner), access = map.accessPoints[entrance]!;
  const junction = Object.entries(map.junctions).find(([, item]) => item.nodeIds.includes(access.nodeId))?.[0] ?? ids.junction;
  const command: ConnectedPointCommand = {
    type: 'createConnectedPoint', kind: 'servicePoint', pointId: ids.point, name, owner: { kind: 'facilities', id: spot.owner.id }, serviceKind: kind,
    arrival: { mode: 'explicit_internal', accessPointId: entrance, prefixPath: [] },
    source: { id: ids.source, name: '作业点工具：内部通道', description: `人工点选「${map.facilities[spot.owner.id]!.name}」内部的作业位置，从入口「${access.name}」建直线内部通道；`
      + '入口处通道与已有道路之间的进出转向（不含掉头）由工具按内核建议全部批准；位置、宽度与这些转向都是设计假设，未经现场核验。' },
    nodeId: ids.node, position: [...spot.point], connectorRoadId: ids.road, connector: { direction: 'both', widthM: { state: 'known', value: widthM } },
    connection: { kind: 'node', nodeId: access.nodeId }, junctionId: junction,
  };
  const turns = commandSupport(map, command).proposedMovements ?? [];
  return { name, turns: turns.length, command: { ...command, approvedMovements: turns.map(turn => ({ ...turn, id: ids.movement() })) } };
}

/** A point of this owner reached by an internal route that ends on the node already there: another kind put there is reached
 *  the same way (not a draft, which could only be declared a node proxy inside the building). */
export function sharedRoute(map: YardMap, spot: ServiceSpot): string | null {
  const key = spot.owner.kind === 'facilities' ? 'facilityId' : 'zoneId';
  return !spot.node ? null : Object.entries(map.servicePoints).find(([, point]) => point.nodeId === spot.node && point[key] === spot.owner.id && point.arrival?.mode === 'explicit_internal')?.[0] ?? null;
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
    const shared = sharedRoute(map, spot), along = shared ? map.servicePoints[shared]! : undefined;
    const servicePoint: ServicePoint = { name, kind, nodeId: spot.node, ...ownerField, resourceIds: [],
      ...along ? { ...along.accessPointId ? { accessPointId: along.accessPointId } : {}, arrival: structuredClone(along.arrival) } : {},
      provenance: { ...provenance, note: `人工点选所属对象内已有的节点「${map.nodes[spot.node]!.name}」；` + (along ? `与作业点「${along.name}」经同一内部通道到达。` : '到达方式未声明（草稿）。') } };
    return { name, command: { type: 'addServicePoint', id: ids.point, servicePoint } };
  }
  const note = '人工点选所属对象内部的位置；作业点有自己的节点，未接路，到达方式未声明（草稿）。';
  const node: MapNode = { name: name + '节点', position: [...spot.point], kind: 'service', provenance: { ...provenance, note } };
  const servicePoint: ServicePoint = { name, kind, nodeId: ids.node, ...ownerField, resourceIds: [], provenance: { ...provenance, note } };
  return { name, command: { type: 'addServicePoint', id: ids.point, servicePoint, newNode: { id: ids.node, node } } };
}

/** Roads at a node that belong to no building or zone: the public network. */
export const publicRoadsAt = (map: YardMap, nodeId: string) =>
  Object.keys(map.roads).filter(id => (map.roads[id]!.fromNodeId === nodeId || map.roads[id]!.toNodeId === nodeId) && !roadOwner(map, id)).length;
/** Roads are drawn only on 0.3 maps (the road tool asks to upgrade first). */
export const upgradeNote = (map: YardMap) => map.schemaVersion === '0.3.0' ? '' : '（这张地图画路前要先升级到 0.3）';

/** The kernel's findings in plain words where its own are technical. */
const CHECK_TEXT: Record<string, (map: YardMap) => string> = {
  SERVICE_NODE_UNCONNECTED: map => `节点还没有接路：用道路工具从它画路接入路网${upgradeNote(map)}；道路只是从旁经过不算接上。`,
  SERVICE_ARRIVAL_UNDECLARED: () => '到达方式未声明（草稿）：接好路后把到达方式改为「节点代理」。',
  SERVICE_NO_INBOUND_ARC: () => '连着的道路都只能驶离这个节点，车辆进不来。',
  PROXY_INSIDE_BUILDING: () => '节点代理的节点在厂房轮廓内部，车辆不能穿墙到达：请核对轮廓与入口位置。',
  SERVICE_OWNER_UNDECLARED: () => '没有声明所属建筑或区域，只是草稿。',
};
/** How the point connects: the kernel's check of its node and declared arrival, and for an internal route whether its entrance
 *  is on the public network (the kernel stops at the entrance; other points' internal routes there do not count). Never a
 *  claim that the whole network reaches it. */
export function serviceCheck(map: YardMap, id: string): { summary: string; lines: string[] } {
  const result = inspectServiceConnection(map, id), point = map.servicePoints[id]!;
  const lines = result.issues.filter(issue => issue.code !== 'SERVICE_ROUTE_UNCHECKED').map(issue => CHECK_TEXT[issue.code]?.(map) ?? issue.message);
  const entrance = point.arrival?.mode === 'explicit_internal' && point.accessPointId ? map.accessPoints[point.accessPointId] : undefined;
  if (entrance && !publicRoadsAt(map, entrance.nodeId)) lines.push(`入口「${entrance.name}」的节点还没有接公共道路：从它画路即可接入路网${upgradeNote(map)}。`);
  const length = result.internalPathLengthM;
  return { lines, summary: lines.length ? `需要处理 ${lines.length} 项` : length !== null ? `内部通道连续，长 ${Number(length.toFixed(1))} m` : `连着 ${result.incidentRoadIds.length} 条道路，到达方式已声明` };
}

/** What a delete takes along with the points it removes (selected, or members of a building or zone deleted with theirs):
 *  their internal routes' roads owned by their building or zone (a public road on a route stays: other traffic uses it) that no
 *  remaining point's route uses, and the points' own nodes at those roads' ends once nothing is left on them. The turns on
 *  those roads go with them (the caller deletes with the kernel's cascade). */
export function ownRoutes(map: YardMap, selection: Selection, members: boolean): { roads: string[]; nodes: string[] } {
  const owners = new Set(members ? [...selection.facilities ?? [], ...selection.zones ?? []] : []);
  const gone = new Set([...selection.servicePoints ?? [], ...Object.keys(map.servicePoints).filter(id => owners.has(map.servicePoints[id]!.facilityId ?? map.servicePoints[id]!.zoneId ?? ''))]);
  const route = (id: string) => { const arrival = map.servicePoints[id]!.arrival; return arrival?.mode === 'explicit_internal' ? arrival.internalPath.map(arc => arc.roadId) : []; };
  const own = (id: string) => { const point = map.servicePoints[id]!; return route(id).filter(road => roadOwner(map, road) === (point.facilityId ?? point.zoneId)); };
  const kept = Object.keys(map.servicePoints).filter(id => !gone.has(id)), used = new Set(kept.flatMap(route));
  const roads = [...new Set([...gone].flatMap(own))].filter(id => map.roads[id] && !used.has(id) && !selection.roads.includes(id));
  const removed = new Set([...roads, ...selection.roads]);
  const nodes = [...new Set([...gone].map(id => map.servicePoints[id]!.nodeId))].filter(node => !selection.nodes.includes(node)
    && roads.some(id => map.roads[id]!.fromNodeId === node || map.roads[id]!.toNodeId === node)
    && Object.entries(map.roads).every(([id, road]) => road.fromNodeId !== node && road.toNodeId !== node || removed.has(id))
    && !kept.some(id => map.servicePoints[id]!.nodeId === node) && !Object.values(map.accessPoints).some(access => access.nodeId === node));
  return { roads, nodes };
}

export interface DeleteOptions { cascade: boolean; members: boolean; orphans: boolean; routes: boolean }
/** The delete dialog's command. With `routes`, the routes only the deleted points use go along (`ownRoutes`), their turns by
 *  the kernel's cascade. The cascade is used for them unasked only when nothing else selected is a node or road (it would act
 *  on those too) and it leaves every resource as it was (the cascade also clears resources' references to what it deletes;
 *  as for any other point, only the ticked option may do that). `held`: why it was not, the delete then refused unless the
 *  cascade is ticked. */
export function deleteCommand(map: YardMap, selection: Selection, options: DeleteOptions): { command: MapCommand; own: { roads: string[]; nodes: string[] }; held: string | null } {
  const own = ownRoutes(map, selection, options.members), withRoutes = options.routes && own.roads.length > 0;
  const command = (cascade: boolean): MapCommand => ({ type: 'deleteSelection',
    selection: withRoutes ? { ...selection, roads: [...selection.roads, ...own.roads], nodes: [...selection.nodes, ...own.nodes] } : selection,
    topologyPolicy: cascade ? 'cascade' : 'reject', orphanNodes: options.orphans ? 'deleteUnused' : 'keep',
    facilityPolicy: options.members ? 'withAssociatedPoints' : 'reject', zonePolicy: options.members ? 'withAssociatedPoints' : 'reject' });
  if (options.cascade || !withRoutes) return { command: command(options.cascade), own, held: null };
  if (selection.nodes.length || selection.roads.length)
    return { command: command(false), own, held: '同时选中了其他道路或节点：通道上有转向，要连带删除通道，请勾选「关联的道路、转向…」（它对选中的其他道路与节点同样生效）。' };
  const cascaded = command(true), result = applyMapCommand(map, cascaded);
  if (result.ok && JSON.stringify(result.map.resources) !== JSON.stringify(map.resources))
    return { command: command(false), own, held: '本次删除的对象关联着资源：删除会清掉资源里对它们的引用（容量保留），要删除请勾选「关联的道路、转向…」。' };
  return { command: cascaded, own, held: null };
}
