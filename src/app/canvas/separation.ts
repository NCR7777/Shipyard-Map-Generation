import type { MapCommand } from '../../domain/commands';
import type { Vec3, YardMap } from '../../domain/model';
import { inspectAccessSeparation } from '../../domain/accessSeparation';
import { flattenPath, getRoadPath } from '../../geometry/roadPath';
import { uid } from './movePreview';

/** Splitting an entrance off a node it shares (a public junction on its building's wall): the entrance moves a few metres
 *  along the wall onto a node of its own, joined back to the old node by a short straight connector (the kernel's
 *  `separateAccessPoint`, one transaction). The old node, its roads and turns stay as they are. */

/** How far along the wall the entrance goes (it can be dragged further along the outline afterwards). */
export const SEPARATION_M = 4;
/** Room kept to the corner at the end of the edge: past it the straight connector would cut the building. */
const CORNER_ROOM_M = 0.5;
/** A road leaving the old node within this angle of the wall runs along it: the connector would lie on that road. */
const ALONG_DEG = 20;
/** Clearance from the connector to every other road's centreline. */
const CLEAR_M = 1;

const distanceToSegment = (p: readonly number[], a: readonly number[], b: readonly number[]) => {
  const dx = b[0]! - a[0]!, dy = b[1]! - a[1]!, length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0]! - a[0]!) * dx + (p[1]! - a[1]!) * dy) / length2)) : 0;
  return Math.hypot(p[0]! - a[0]! - t * dx, p[1]! - a[1]! - t * dy);
};
/** The least distance between two segments (they do not cross in the cases that matter here: crossing gives 0 anyway). */
function segmentGap(a: readonly number[], b: readonly number[], c: readonly number[], d: readonly number[]): number {
  const cross = (o: readonly number[], p: readonly number[], q: readonly number[]) => (p[0]! - o[0]!) * (q[1]! - o[1]!) - (p[1]! - o[1]!) * (q[0]! - o[0]!);
  const d1 = cross(a, b, c), d2 = cross(a, b, d), d3 = cross(c, d, a), d4 = cross(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

/** The spot on the building's outline along the edge from the old node, on the side with more room that no road at the old
 *  node runs along and that keeps the connector clear of other roads; or why there is none. */
export function separationSpot(map: YardMap, entranceId: string, preferredM = SEPARATION_M): { position: Vec3; distanceM: number } | { reason: string } {
  const entrance = map.accessPoints[entranceId], node = entrance && map.nodes[entrance.nodeId], facility = entrance && map.facilities[entrance.facilityId];
  if (!entrance || !node || !facility) return { reason: '入口或所属建筑已不在地图中。' };
  const ring = facility.boundary.outer, p = node.position, n = ring.length - 1, old = entrance.nodeId;
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
  // The roads as polylines, and for those at the old node the direction each leaves it in.
  const roads = Object.entries(map.roads).map(([id, road]) => {
    const points = flattenPath(getRoadPath(map, id)).samples.map(sample => sample.position);
    const leaving = road.fromNodeId === old ? points.find(point => Math.hypot(point[0] - p[0], point[1] - p[1]) > 1e-6)
      : road.toNodeId === old ? [...points].reverse().find(point => Math.hypot(point[0] - p[0], point[1] - p[1]) > 1e-6) : undefined;
    return { points, leaving, atOld: road.fromNodeId === old || road.toNodeId === old };
  });
  let blocked = false;
  for (const way of ways.sort((x, y) => y.roomM - x.roomM)) {
    const distanceM = Math.min(preferredM, way.roomM - CORNER_ROOM_M);
    if (!(distanceM >= CORNER_ROOM_M)) continue;
    const ux = (way.to[0] - way.from[0]) / way.roomM, uy = (way.to[1] - way.from[1]) / way.roomM;
    const along = roads.some(road => {
      if (!road.leaving) return false;
      const vx = road.leaving[0] - p[0], vy = road.leaving[1] - p[1];
      return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / Math.hypot(vx, vy)))) * 180 / Math.PI < ALONG_DEG;
    });
    const position: Vec3 = [way.from[0] + ux * distanceM, way.from[1] + uy * distanceM, p[2]];
    // Clear of the roads: the new node off every road at the old node (those meet the connector at the old node, as they
    // must, and the angle rule keeps them off it), the whole connector off every other road.
    const crowded = roads.some(road => road.points.slice(1).some((point, i) =>
      (road.atOld ? distanceToSegment(position, road.points[i]!, point) : segmentGap(position, p, road.points[i]!, point)) < CLEAR_M));
    if (along || crowded) { blocked = true; continue; }
    return { position, distanceM };
  }
  return { reason: blocked ? '入口两侧沿外边界都有道路经过或贴近，拆出后的接驳路会压在道路上，不能自动拆出。' : '入口所在的边太短，拆出后的位置无法自动确定。' };
}

/** The command (one transaction), or why the entrance cannot be split off. The connector is as wide as the narrowest road
 *  already at the node, and never wider than new roads are drawn (`widthM`): a door does not widen the road. */
export function separationCommand(map: YardMap, entranceId: string, widthM: number): { command: MapCommand; nodeId: string; distanceM: number } | { reason: string } {
  const info = inspectAccessSeparation(map, entranceId);
  if (!info.supported) return { reason: info.issues[0]?.message ?? '这个入口不能拆出。' };
  const spot = separationSpot(map, entranceId);
  if ('reason' in spot) return spot;
  const old = info.oldNodeId, nodeId = uid('node');
  const widths = Object.values(map.roads).filter(road => road.fromNodeId === old || road.toNodeId === old)
    .flatMap(road => road.widthM.state === 'known' ? [road.widthM.value] : []);
  return { nodeId, distanceM: spot.distanceM,
    command: { type: 'separateAccessPoint', id: entranceId, nodeId, position: spot.position, connectorWidthM: Math.min(widthM, ...widths) } };
}
