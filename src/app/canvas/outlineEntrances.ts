import type { SceneSnapshot } from '../../adapters/contracts';
import type { MapNode, MapRoad, Polygon, Vec3, YardMap } from '../../domain/model';
import { boundaryEntranceAdjustments, OwnerEditError } from '../../domain/ownerEditing';
import { moveNodeWithHandles } from '../../domain/topologyEditing';
import { getRoadPath } from '../../geometry/roadPath';
import { entranceMovable, onOutline } from './entrances';

/** A building's entrances on its outline go with an edited outline (the kernel moves them in the same transaction, through
 *  `updateFacility.entranceAdjustments`; their connector roads stretch). Each keeps its edge and its fraction along it, so a
 *  corner entrance stays on its corner and one mid-wall stays mid-wall. Entrances off the outline stay where they are, as
 *  the kernel keeps them; ones on a public or shared node cannot move, and the kernel refuses an edit that leaves them off. */

type Ring = readonly Vec3[];
const ON_EDGE_M = 1e-6, SAME_M = 1e-9;
const lerp = (a: Vec3, b: Vec3, t: number, z: number): Vec3 => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), z];
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const same = (a: Vec3, b: Vec3) => distance(a, b) <= SAME_M;

/** The edge of a closed ring a point lies on, and its fraction along that edge. A corner lies on two edges: either maps it
 *  onto the same vertex of the edited ring (the end of one edge is the start of the next in every case below). */
function edgeOf(ring: Ring, point: Vec3): { edge: number; t: number } | null {
  let best: { edge: number; t: number; d: number } | null = null;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    if (!(length2 > 0)) continue;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2));
    const d = Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
    if (d <= ON_EDGE_M && (!best || d < best.d)) best = { edge: i, t, d };
  }
  return best && { edge: best.edge, t: best.t };
}
/** The point at fraction `t` of the length of a polyline. */
function alongPolyline(points: readonly Vec3[], t: number, z: number): Vec3 {
  const lengths = points.slice(1).map((point, i) => distance(points[i]!, point)), total = lengths.reduce((sum, value) => sum + value, 0);
  let left = t * total;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]! || i === lengths.length - 1) return lengths[i]! > 0 ? lerp(points[i]!, points[i + 1]!, Math.min(1, left / lengths[i]!), z) : [...points[i]!.slice(0, 2), z] as Vec3;
    left -= lengths[i]!;
  }
  return [...points[0]!.slice(0, 2), z] as Vec3;
}
/** Fraction `t` of the edge (a, b) as a fraction of the polyline a → b → c (for an edge that gains or loses a vertex). */
const fractionOf = (a: Vec3, b: Vec3, c: Vec3, t: number, first: boolean) => {
  const one = distance(a, b), two = distance(b, c), total = one + two;
  return total > 0 ? (first ? t * one : one + t * two) / total : 0;
};

/** Where points on the edges of `before` go on `after` (both closed, counter-clockwise as the kernel requires of an outer
 *  ring): the same vertices moved (renumbered, even: a rectangle is rebuilt from its frame), one vertex inserted into an
 *  edge, or one removed. Null for any other change. */
export function carryAlongRing(before: Ring, after: Ring, points: readonly Vec3[]): (Vec3 | null)[] | null {
  const a = before.slice(0, -1), b = after.slice(0, -1), n = a.length, m = b.length;
  const params = points.map(point => edgeOf(before, point));
  if (m === n) {
    // The renumbering that keeps the vertices closest (a moved vertex or two do not change it).
    let best = { shift: 0, cost: Infinity };
    for (let shift = 0; shift < n; shift++) {
      let cost = 0;
      for (let i = 0; i < n; i++) cost += distance(a[i]!, b[(i + shift) % n]!);
      if (cost < best.cost - SAME_M) best = { shift, cost };
    }
    const at = (i: number) => b[(i + best.shift) % n]!;
    return points.map((point, index) => { const p = params[index]; return p ? lerp(at(p.edge), at(p.edge + 1), p.t, point[2]) : null; });
  }
  if (m === n + 1) {
    // b is a with one vertex inserted at k (1 ≤ k ≤ n, after a[k − 1]); the others unchanged.
    for (let k = 1; k <= n; k++) {
      if (!a.every((vertex, i) => same(vertex, b[i < k ? i : i + 1]!))) continue;
      return points.map((point, index) => {
        const p = params[index]; if (!p) return null;
        if (p.edge < k - 1) return lerp(b[p.edge]!, b[p.edge + 1]!, p.t, point[2]);
        if (p.edge > k - 1) return lerp(b[p.edge + 1]!, b[(p.edge + 2) % m]!, p.t, point[2]);
        return alongPolyline([b[k - 1]!, b[k]!, b[(k + 1) % m]!], p.t, point[2]);
      });
    }
    return null;
  }
  if (m === n - 1) {
    // b is a without vertex r; the two edges around it become one.
    for (let r = 0; r < n; r++) {
      const kept = a.filter((_, i) => i !== r);
      if (!kept.every((vertex, i) => same(vertex, b[i]!))) continue;
      const previous = (r - 1 + n) % n, joined = [a[previous]!, a[r]!, a[(r + 1) % n]!];
      const newIndex = (i: number) => (i > r ? i - 1 : i);
      return points.map((point, index) => {
        const p = params[index]; if (!p) return null;
        if (p.edge === previous || p.edge === r) {
          const t = fractionOf(joined[0]!, joined[1]!, joined[2]!, p.t, p.edge === previous);
          return lerp(b[newIndex(previous)]!, b[newIndex((r + 1) % n)]!, t, point[2]);
        }
        return lerp(b[newIndex(p.edge)]!, b[newIndex((p.edge + 1) % n)]!, p.t, point[2]);
      });
    }
    return null;
  }
  return null;
}

/** The entrances of the building that go with the edited outline, and where. Entrances that stay where they are (off the
 *  outline, fixed on a public node, or not moved by this edit) are left out. */
export function entranceAdjustments(map: YardMap, facilityId: string, boundary: Polygon): { id: string; position: Vec3 }[] {
  const facility = map.facilities[facilityId]; if (!facility) return [];
  const carried: { id: string; position: Vec3 }[] = [], seen = new Set<string>();
  for (const [id, entrance] of Object.entries(map.accessPoints)) {
    if (entrance.facilityId !== facilityId || seen.has(entrance.nodeId) || !onOutline(map, id) || !entranceMovable(map, id)) continue;
    seen.add(entrance.nodeId);
    carried.push({ id, position: map.nodes[entrance.nodeId]!.position });
  }
  if (!carried.length) return [];
  const moved = carryAlongRing(facility.boundary.outer, boundary.outer, carried.map(entry => entry.position));
  let result: { id: string; position: Vec3 }[];
  if (moved && moved.every(Boolean)) result = carried.map((entry, index) => ({ id: entry.id, position: moved[index]! }));
  else {
    // Any other change (or an entrance on a hole): the kernel's nearest point, when it has a unique one.
    try { result = boundaryEntranceAdjustments(map, facilityId, boundary).filter(entry => carried.some(item => item.id === entry.id)); }
    catch (error) { if (error instanceof OwnerEditError) return []; throw error; }
  }
  return result.filter(entry => !same(entry.position, map.nodes[map.accessPoints[entry.id]!.nodeId]!.position));
}

/** The preview of entrances going with an outline: their markers, nodes and connecting roads where the edit puts them. */
export function entranceOverlay(map: YardMap, scene: SceneSnapshot, adjustments: readonly { id: string; position: Vec3 }[]) {
  const moves = new Map(adjustments.map(entry => [map.accessPoints[entry.id]!.nodeId, entry.position]));
  const roads = Object.entries(map.roads).filter(([, road]) => moves.has(road.fromNodeId) || moves.has(road.toNodeId)).map(([id]) => id);
  const local = { nodes: {} as Record<string, MapNode>, roads: {} as Record<string, MapRoad> };
  for (const id of moves.keys()) local.nodes[id] = { ...map.nodes[id]!, position: [...map.nodes[id]!.position] };
  for (const id of roads) local.roads[id] = structuredClone(map.roads[id]!);
  for (const [id, position] of moves) moveNodeWithHandles(local as unknown as YardMap, id, position);
  const position = (id: string) => local.nodes[id]?.position ?? map.nodes[id]!.position;
  const path = (id: string) => {
    const road = local.roads[id]!;
    return getRoadPath({ roads: { [id]: road }, nodes: { [road.fromNodeId]: { ...map.nodes[road.fromNodeId]!, position: position(road.fromNodeId) }, [road.toNodeId]: { ...map.nodes[road.toNodeId]!, position: position(road.toNodeId) } } } as unknown as YardMap, id);
  };
  const wanted = new Set(roads);
  const overlay = {
    nodes: scene.nodes.filter(node => moves.has(node.id)).map(node => ({ ...node, position: position(node.id) })),
    roads: scene.roads.filter(road => wanted.has(road.id)).map(road => ({ ...road, path: path(road.id), points: [] })),
    accessPoints: scene.accessPoints.filter(point => moves.has(point.nodeId)).map(point => ({ ...point, position: position(point.nodeId) })),
    servicePoints: scene.servicePoints.filter(point => moves.has(point.nodeId)).map(point => ({ ...point, position: position(point.nodeId) })),
  };
  const hidden = [...overlay.nodes.map(node => 'nodes/' + node.id), ...overlay.roads.map(road => 'roads/' + road.id),
    ...overlay.accessPoints.map(point => 'accessPoints/' + point.id), ...overlay.servicePoints.map(point => 'servicePoints/' + point.id)];
  return { overlay, hidden };
}
