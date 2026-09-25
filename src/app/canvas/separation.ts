import type { MapCommand } from '../../domain/commands';
import type { Vec3, YardMap } from '../../domain/model';
import { inspectAccessSeparation } from '../../domain/accessSeparation';
import { flattenPath, getRoadPath } from '../../geometry/roadPath';
import { uid } from './movePreview';

/** Splitting an entrance off a node it shares (a public junction on its building's wall): the entrance moves a few metres
 *  along the wall onto a node of its own (the kernel's `separateAccessPoint`, one transaction). The old node, its roads, turns
 *  and service points stay as they are, and no road is built: the entrance is off the road network until one is drawn to it. */

/** How far along the wall the entrance goes (it can be dragged further along the outline afterwards). */
export const SEPARATION_M = 4;
/** Room kept to the corner at the end of the edge. */
const CORNER_ROOM_M = 0.5;
/** Clearance from the new node to every road's centreline and every node: off the roads, clear of the junction it leaves,
 *  and never onto another entrance or node (two entrances split off the same wall would otherwise land on one spot). */
const CLEAR_M = 1;

const distanceToSegment = (p: readonly number[], a: readonly number[], b: readonly number[]) => {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / length2)) : 0;
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy);
};

/** The spot on the building's outline along the edge from the old node, on the side with more room that is at least 1 m
 *  from every road's centreline and every node; or why there is none. */
export function separationSpot(map: YardMap, entranceId: string, preferredM = SEPARATION_M): { position: Vec3; distanceM: number } | { reason: string } {
  const entrance = map.accessPoints[entranceId], node = entrance && map.nodes[entrance.nodeId], facility = entrance && map.facilities[entrance.facilityId];
  if (!entrance || !node || !facility) return { reason: '入口或所属建筑已不在地图中。' };
  const ring = facility.boundary.outer, p = node.position, n = ring.length - 1;
  // Each way the wall goes from the node: along an edge from the node's place on it.
  const ways: { from: Vec3; to: Vec3; roomM: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i]!, b = ring[i + 1]!, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (!(length > 0)) continue;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (length * length);
    if (t < -1e-9 || t > 1 + 1e-9 || Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy) > 1e-6) continue;
    const at: Vec3 = [a[0] + t * dx, a[1] + t * dy, p[2]];
    ways.push({ from: at, to: b, roomM: (1 - t) * length }, { from: at, to: a, roomM: t * length });
  }
  if (!ways.length) return { reason: '入口节点不在所属建筑的外边界上，拆出后的位置无法自动确定。' };
  const roads = Object.keys(map.roads).map(id => flattenPath(getRoadPath(map, id)).samples.map(sample => sample.position));
  const nodes = Object.values(map.nodes).map(other => other.position);
  let byRoad = false, byNode = false;
  for (const way of ways.sort((x, y) => y.roomM - x.roomM)) {
    const distanceM = Math.min(preferredM, way.roomM - CORNER_ROOM_M);
    if (!(distanceM >= CORNER_ROOM_M)) continue;
    const f = distanceM / way.roomM;
    const position: Vec3 = [way.from[0] + f * (way.to[0] - way.from[0]), way.from[1] + f * (way.to[1] - way.from[1]), p[2]];
    if (roads.some(points => points.slice(1).some((point, i) => distanceToSegment(position, points[i]!, point) < CLEAR_M))) { byRoad = true; continue; }
    if (nodes.some(other => Math.hypot(position[0] - other[0], position[1] - other[1]) < CLEAR_M)) { byNode = true; continue; }
    return { position, distanceM };
  }
  if (!byRoad && !byNode) return { reason: '入口所在的边太短，拆出后的位置无法自动确定。' };
  const why = [...byRoad ? ['在道路上或离道路不到 1 m'] : [], ...byNode ? ['离已有节点不到 1 m'] : []].join('，或');
  return { reason: `入口两侧沿外边界移开后都${why}，不能自动拆出。` };
}

/** The command (one transaction), or why the entrance cannot be split off. */
export function separationCommand(map: YardMap, entranceId: string): { command: MapCommand; nodeId: string; distanceM: number } | { reason: string } {
  const info = inspectAccessSeparation(map, entranceId);
  if (!info.supported) return { reason: info.issues[0]?.message ?? '这个入口不能拆出。' };
  const spot = separationSpot(map, entranceId);
  if ('reason' in spot) return spot;
  const nodeId = uid('node');
  return { nodeId, distanceM: spot.distanceM, command: { type: 'separateAccessPoint', id: entranceId, nodeId, position: spot.position } };
}
