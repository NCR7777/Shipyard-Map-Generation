import { commandSupport, type MapCommand, type Selection } from '../../domain/commands';
import type { AccessPoint, MapNode, Vec3, YardMap } from '../../domain/model';
import { nodeOwners, OwnerEditError, privateNodeOwner } from '../../domain/ownerEditing';
import { GEOMETRY_TOLERANCE_M, pointInRing } from '../../geometry/polygons';
import { pointInPolygon } from '../../geometry/relations';
import type { Camera } from '../../geometry/coordinates';
import { translateCommand } from './movePreview';

/** Where an entrance goes: a point on a building's outer outline (holes are never entrances). The kernel does not require
 *  that of a plain `addAccessPoint`; this tool does, as the old tool's entrance placement did, and later edits keep it so. */

/** How close (screen pixels) the pointer must be to an outline to place an entrance on it. */
export const ENTRANCE_PX = 12;
/** Within this distance of an outline corner the corner itself is taken. */
export const CORNER_PX = 8;
/** Entrances of one building closer than this are the same place: 1 cm, or 6 px on screen when that is more (a second click
 *  a few pixels off is a slip, not a second door). */
export const SAME_PLACE_M = 0.01;
export const SAME_PLACE_PX = 6;

export interface EntranceSpot { facilityId: string; point: Vec3; corner: boolean; distanceM: number }

/** The nearest point of `ring` (closed) to `world`, snapped to a corner within `cornerM`. */
function nearestOnRing(ring: readonly Vec3[], world: Vec3, cornerM: number): { point: Vec3; distanceM: number; corner: boolean } | null {
  let best: { point: Vec3; distanceM: number; corner: boolean } | null = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) continue;
    const t = Math.max(0, Math.min(1, ((world[0] - a[0]) * dx + (world[1] - a[1]) * dy) / length2));
    const point: Vec3 = [a[0] + t * dx, a[1] + t * dy, a[2] + t * (b[2] - a[2])];
    const distanceM = Math.hypot(world[0] - point[0], world[1] - point[1]);
    if (!best || distanceM < best.distanceM) best = { point, distanceM, corner: false };
  }
  if (!best) return null;
  // The nearest corner near the pointer wins: entrances at building corners are common and hard to hit exactly.
  let corner: { point: Vec3; distanceM: number; corner: boolean } | null = null;
  for (const vertex of ring.slice(0, -1)) {
    const distanceM = Math.hypot(world[0] - vertex[0], world[1] - vertex[1]);
    if (distanceM <= cornerM && (!corner || distanceM < corner.distanceM)) corner = { point: [...vertex], distanceM, corner: true };
  }
  return corner ?? best;
}

/** The entrance position for the pointer: the nearest point of a building's outer outline within 12 px, the building
 *  under the pointer winning a tie (two buildings sharing a wall). `only` limits it to one building. */
export function entranceSpot(map: YardMap, world: Vec3, camera: Camera, only: string | null = null): EntranceSpot | null {
  const tolerance = ENTRANCE_PX / camera.scale, cornerM = CORNER_PX / camera.scale;
  let best: EntranceSpot | null = null, bestInside = false;
  for (const [facilityId, facility] of Object.entries(map.facilities)) {
    if (only && facilityId !== only) continue;
    const ring = facility.boundary.outer;
    // A quick box test first: large maps have hundreds of buildings and the pointer moves often.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of ring) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    if (world[0] < minX - tolerance || world[0] > maxX + tolerance || world[1] < minY - tolerance || world[1] > maxY + tolerance) continue;
    const near = nearestOnRing(ring, world, cornerM);
    if (!near || near.distanceM > tolerance) continue;
    const inside = pointInRing(world, ring) !== 'outside';
    const closer = !best || near.distanceM < best.distanceM - 1e-9, tie = !!best && Math.abs(near.distanceM - best.distanceM) <= 1e-9;
    if (closer || (tie && inside && !bestInside)) { best = { facilityId, ...near }; bestInside = inside; }
  }
  return best;
}

/** The nearest point of a building's outer outline, however far: where a dragged entrance lands. */
export function projectToOutline(map: YardMap, facilityId: string, world: Vec3): Vec3 | null {
  const facility = map.facilities[facilityId];
  return facility ? nearestOnRing(facility.boundary.outer, world, 0)?.point ?? null : null;
}

/** Whether an entrance lies on its building's outline, as the kernel judges it (same plane, within its tolerance). Entrances
 *  off the outline are deliberate too: research access points drawn outside or inside a building (EA01 maps have 147). */
export function onOutline(map: YardMap, entranceId: string): boolean {
  const entrance = map.accessPoints[entranceId], node = entrance && map.nodes[entrance.nodeId], facility = entrance && map.facilities[entrance.facilityId];
  if (!node || !facility) return false;
  return Math.abs(node.position[2] - facility.boundary.outer[0]![2]) <= GEOMETRY_TOLERANCE_M && pointInPolygon(node.position, facility.boundary) === 'boundary';
}

/** The kernel's rule for whether a node is its building's alone, and so may move: it refuses a node shared with other
 *  owners (`OWNER_SHARED_NODE`) or one on public roads beyond a single unowned connector (`OWNER_PUBLIC_NODE`). */
function privateTo(map: YardMap, nodeId: string): string | undefined {
  try { return privateNodeOwner(map, nodeId); } catch (error) { if (error instanceof OwnerEditError) return undefined; throw error; }
}
/** Whether the kernel lets this entrance move. One on a public junction or a node shared with other owners stays put (the
 *  EA01 maps gave 115 such entrances nodes of their own for that reason). */
export function entranceMovable(map: YardMap, entranceId: string): boolean {
  const entrance = map.accessPoints[entranceId];
  return !!entrance && privateTo(map, entrance.nodeId) === entrance.facilityId;
}

/** The entrance a drag of this selection must keep on its building's outline: the selection is one object (the entrance, a
 *  service point on its node, or the node itself), and its node carries exactly one entrance, on the outline, free to move.
 *  After an entrance is split off a junction its building's service point usually stands on the same node, and a press there
 *  takes the service point (its marker comes first). */
function slidingEntrance(map: YardMap, selection: Selection): string | null {
  const items = Object.entries(selection).flatMap(([kind, list]) => ((list ?? []) as string[]).map(id => [kind, id] as const));
  if (items.length !== 1) return null;
  const [kind, id] = items[0]!;
  const nodeId = kind === 'accessPoints' ? map.accessPoints[id]?.nodeId : kind === 'servicePoints' ? map.servicePoints[id]?.nodeId : kind === 'nodes' ? id : undefined;
  const entrances = nodeId === undefined ? [] : Object.keys(map.accessPoints).filter(entrance => map.accessPoints[entrance]!.nodeId === nodeId);
  return entrances.length === 1 && onOutline(map, entrances[0]!) && entranceMovable(map, entrances[0]!) ? entrances[0]! : null;
}

/** For a drag that must keep an entrance on its building's outline (see `slidingEntrance`): the move that keeps it there,
 *  for a pointer at `world` (the press was at `start`). Anything else (other objects in the selection, an entrance off the
 *  outline, one without its node) moves freely (undefined), and the kernel keeps its relation to the building as before or
 *  refuses a fixed one with its reason. */
export function entranceSlide(map: YardMap, selection: Selection, start: Vec3): ((world: Vec3) => Vec3) | undefined {
  const id = slidingEntrance(map, selection); if (!id) return undefined;
  const entrance = map.accessPoints[id]!, origin = map.nodes[entrance.nodeId]!.position;
  return world => {
    const on = projectToOutline(map, entrance.facilityId, [origin[0] + world[0] - start[0], origin[1] + world[1] - start[1], origin[2]]);
    return on ? [on[0] - origin[0], on[1] - origin[1], 0] : [0, 0, 0];
  };
}

/** 入口001, 入口002, …: the first number no entrance of this building uses. */
export function nextEntranceName(map: YardMap, facilityId: string): string {
  const used = new Set(Object.values(map.accessPoints).filter(point => point.facilityId === facilityId).map(point => point.name));
  for (let n = 1; ; n++) { const name = '入口' + String(n).padStart(3, '0'); if (!used.has(name)) return name; }
}

/** An entrance of this building already at the point (within `toleranceM`, at least 1 cm). */
export function entranceAt(map: YardMap, facilityId: string, point: Vec3, toleranceM = SAME_PLACE_M): string | null {
  const tolerance = Math.max(SAME_PLACE_M, toleranceM);
  for (const [id, entrance] of Object.entries(map.accessPoints)) {
    if (entrance.facilityId !== facilityId) continue;
    const node = map.nodes[entrance.nodeId];
    if (node && Math.hypot(node.position[0] - point[0], node.position[1] - point[1]) < tolerance && node.position[2] === point[2]) return id;
  }
  return null;
}

/** An existing node at a spot on the outline, and why an entrance may not use it (null when it may). */
export interface NodeHere { id: string; refused: { label: string; message: string } | null }

/** The nearest existing node on this building's outer outline at the point (within `toleranceM`, same height): a road end
 *  there, say. The entrance then uses it, so it is on that road at once; otherwise a second node would lie on top of it,
 *  unconnected. "On the outline" is within 1 cm of it: road ends a few 1e-7 m off a wall are rounding, not design.
 *  A node that would not stay this building's alone (a public junction, another building's entrance node) is not used:
 *  the entrance and possibly the building could no longer move, the defect EA01 repaired. Nor is one that would stop the
 *  building moving (a road end whose road bends). `refused` says why. */
export function nodeAt(map: YardMap, facilityId: string, point: Vec3, toleranceM: number): NodeHere | null {
  const facility = map.facilities[facilityId]; if (!facility) return null;
  let best: string | null = null, bestM = Math.max(SAME_PLACE_M, toleranceM);
  for (const [id, node] of Object.entries(map.nodes)) {
    const distanceM = Math.hypot(node.position[0] - point[0], node.position[1] - point[1]);
    if (distanceM >= bestM) continue;
    // On the outline at its height there (the spot is on it too, so at the spot's height).
    const on = nearestOnRing(facility.boundary.outer, node.position, 0);
    if (on && on.distanceM <= SAME_PLACE_M && Math.abs(on.point[2] - node.position[2]) <= GEOMETRY_TOLERANCE_M) { best = id; bestM = distanceM; }
  }
  if (best === null) return null;
  // The pointer hovers here many times per second; the kernel's move check below takes tens of milliseconds on large maps.
  let known = refusals.get(map); if (!known) refusals.set(map, known = new Map());
  const key = facilityId + '\u0000' + best;
  if (!known.has(key)) known.set(key, reuseRefusal(map, facilityId, best));
  return { id: best, refused: known.get(key)! };
}
const refusals = new WeakMap<YardMap, Map<string, NodeHere['refused']>>();

/** Why an entrance of this building may not use the node, by the kernel's rules applied to the map with the entrance: the
 *  node must stay the building's alone, and the building must still move as before (the node's one outside road becomes
 *  the entrance's connector, which the kernel stretches only when it is straight). */
function reuseRefusal(map: YardMap, facilityId: string, nodeId: string): NodeHere['refused'] {
  const probe: YardMap = { ...map, accessPoints: { ...map.accessPoints, ['\u0000entrance-probe']: { name: '', facilityId, nodeId, provenance: { category: 'drawing' } } } };
  const node = `「${map.nodes[nodeId]!.name || nodeId}」`, facility = `「${map.facilities[facilityId]!.name}」`;
  if (privateTo(probe, nodeId) === facilityId) {
    const move = translateCommand({ nodes: [], roads: [], facilities: [facilityId] }, [0.001, 0, 0]);
    if (!commandSupport(map, move).allowed) return null;
    const after = commandSupport(probe, move);
    if (after.allowed) return null;
    const issue = after.issues.find(issue => issue.severity === 'error');
    const road = issue?.code === 'STATIC_CONNECTOR_SHAPE_UNSUPPORTED' && issue.entityId ? map.roads[issue.entityId] : undefined;
    return { label: `用此节点后${facility}将不能移动`,
      message: `入口若用节点${node}，${road ? `道路「${road.name}」就成了入口的接入段；它有折点或独立几何，建筑移动时内核不能伸缩它，` : `内核会拒绝${facility}的整体移动（${issue?.message ?? '原因未说明'}），`}${facility}将不能移动。请在旁边的外边界上点选（离它 6 px 内都算这里，放大后可以点得更近），另建独立的入口节点，再画一段直路接过来。` };
  }
  const owners = nodeOwners(map, nodeId);
  const others = [...owners.owners].filter(owner => owner !== facilityId).map(owner => `「${map.facilities[owner]?.name ?? map.zones[owner]?.name ?? owner}」`);
  if (others.length || owners.unownedPoint) {
    const whose = [...others, ...owners.unownedPoint ? ['未声明归属的作业点'] : []].join('、');
    return { label: `此处节点已属于${whose}，不能共用`,
      message: `节点${node}已属于${whose}，入口不能与之共用：共用节点的入口不能移动，相关建筑的移动也可能因此被拒。请在旁边的外边界上点选（离它 6 px 内都算这里，放大后可以点得更近），另建独立的入口节点。` };
  }
  return { label: '此处是公共道路节点，不能作入口',
    message: `节点${node}是公共道路的节点（${roadsAt(map, nodeId)} 条道路在此相接），入口不能用它：公共节点保持固定，入口放在这里就不能移动，建筑的移动也可能因此被拒。请在旁边的外边界上点选（离它 6 px 内都算这里，放大后可以点得更近），再从新入口画一段路接到这里。` };
}

/** How many roads end at the node. */
export function roadsAt(map: YardMap, nodeId: string): number {
  return Object.values(map.roads).filter(road => road.fromNodeId === nodeId || road.toNodeId === nodeId).length;
}

/** One entrance in one command (one undo step): on an existing node of the outline (`ids.existingNode`, one `nodeAt` did not
 *  refuse), or with its own new node, which is not connected to any road (drawing a road from it connects it; the road tool
 *  snaps to nodes). */
export function entranceCommand(map: YardMap, facilityId: string, point: Vec3, ids: { point: string; node: string; existingNode?: string | null }): { command: MapCommand; name: string } {
  const facility = map.facilities[facilityId];
  if (!facility) throw new RangeError('建筑已不在地图中。');
  const name = nextEntranceName(map, facilityId);
  if (ids.existingNode) {
    const accessPoint: AccessPoint = { name, facilityId, nodeId: ids.existingNode, provenance: { category: 'drawing',
      ...facility.provenance.sourceRefs?.length ? { sourceRefs: [...facility.provenance.sourceRefs] } : {}, note: '人工点选建筑外边界上已有的节点作为入口。' } };
    return { name, command: { type: 'addAccessPoint', id: ids.point, accessPoint } };
  }
  // Entrance and node rest on the same evidence: a hand-picked point on the building's outline, from the building's sources.
  const provenance = { category: 'drawing' as const, ...facility.provenance.sourceRefs?.length ? { sourceRefs: [...facility.provenance.sourceRefs] } : {},
    note: '人工点选建筑外边界上的位置；只建入口与独立节点，未接路。' };
  const node: MapNode = { name: name + '节点', position: [...point], kind: 'access', provenance: structuredClone(provenance) };
  const accessPoint: AccessPoint = { name, facilityId, nodeId: ids.node, provenance };
  return { name, command: { type: 'addAccessPoint', id: ids.point, accessPoint, newNode: { id: ids.node, node } } };
}
