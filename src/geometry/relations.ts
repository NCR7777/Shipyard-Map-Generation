import type { Polygon, Vec3 } from '../domain/model';
import { GEOMETRY_TOLERANCE_M as EPS, pointInRing, segmentsIntersect } from './polygons';

type Edge = readonly [Vec3, Vec3];
type Interval = readonly [number, number];
export type GeometryWork = (amount?: number) => void;
const edges = (polygon: Polygon): Edge[] => [polygon.outer, ...polygon.holes].flatMap(ring => ring.slice(1).map((point, i) => [ring[i]!, point] as const));
const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;
export function pointInPolygon(point: Vec3, polygon: Polygon): 'inside' | 'outside' | 'boundary' {
  const outer = pointInRing(point, polygon.outer);
  if (outer !== 'inside') return outer;
  for (const hole of polygon.holes) {
    const result = pointInRing(point, hole);
    if (result === 'boundary') return 'boundary';
    if (result === 'inside') return 'outside';
  }
  return 'inside';
}
function crossing(a: Edge, b: Edge): { x: number; t: number } | null {
  const dx = a[1][0] - a[0][0], dy = a[1][1] - a[0][1];
  const ex = b[1][0] - b[0][0], ey = b[1][1] - b[0][1];
  const denominator = cross(dx, dy, ex, ey);
  if (denominator === 0) return null; // Collinear endpoints already partition the scan.
  const qx = b[0][0] - a[0][0], qy = b[0][1] - a[0][1];
  const t = cross(qx, qy, ex, ey) / denominator;
  const u = cross(qx, qy, dx, dy) / denominator;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a[0][0] + t * dx, t } : null;
}
function intervalsAt(all: Edge[], x: number, work: GeometryWork): Interval[] {
  const crossings: number[] = [];
  for (const [a, b] of all) {
    work();
    if ((a[0] <= x && x < b[0]) || (b[0] <= x && x < a[0])) crossings.push(a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1]));
  }
  crossings.sort((a, b) => a - b);
  const result: Interval[] = [];
  for (let i = 0; i + 1 < crossings.length; i += 2) result.push([crossings[i]!, crossings[i + 1]!]);
  return result;
}
/** Exact linear-edge vertical decomposition, up to the shared metre tolerance.
 * Vertices AND cross-polygon edge intersections delimit slabs; between events
 * interval ordering cannot change. Holes contribute via even/odd interiors.
 * No polygon union, replacement geometry, raster or bbox-only final decision.
 */
export function polygonHasArea(a: Polygon, b: Polygon, relation: 'intersection' | 'outside', work: GeometryWork): boolean {
  const ae = edges(a), be = edges(b);
  const events = [...ae, ...be].flatMap(edge => [edge[0][0]]);
  for (const left of ae) for (const right of be) {
    work(); const hit = crossing(left, right); if (hit) events.push(hit.x);
  }
  events.sort((x, y) => x - y);
  for (let i = 1; i < events.length; i++) {
    work();
    const lo = events[i - 1]!, hi = events[i]!;
    if (hi - lo <= EPS) continue;
    const x = lo + (hi - lo) / 2;
    const aIntervals = intervalsAt(ae, x, work), bIntervals = intervalsAt(be, x, work);
    for (const [start, end] of aIntervals) {
      let covered = start;
      for (const [bs, be] of bIntervals) {
        work();
        if (relation === 'intersection' && Math.min(end, be) - Math.max(start, bs) > EPS) return true;
        if (relation === 'outside') {
          if (be <= covered) continue;
          if (bs - covered > EPS) break;
          covered = Math.max(covered, be);
          if (covered >= end) break;
        }
      }
      if (relation === 'outside' && end - covered > EPS) return true;
    }
  }
  return false;
}
/** Includes complete segments, not just their vertices; boundary contact is allowed. */
export function polylineWithinPolygon(points: readonly Vec3[], polygon: Polygon, work: GeometryWork): boolean {
  const boundary = edges(polygon);
  work(points.length * boundary.length);
  if (points.some(point => pointInPolygon(point, polygon) === 'outside')) return false;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, cuts = [0, 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
    for (const edge of boundary) {
      work(); const hit = crossing([a, b], edge); if (hit) cuts.push(hit.t);
      // Covers collinear overlap endpoints as well as isolated crossings.
      if (lengthSquared) for (const vertex of edge) {
        const t = ((vertex[0] - a[0]) * dx + (vertex[1] - a[1]) * dy) / lengthSquared;
        if (t > 0 && t < 1) cuts.push(t);
      }
    }
    cuts.sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      work(boundary.length); const t = (cuts[j - 1]! + cuts[j]!) / 2;
      if (pointInPolygon([a[0] + t * dx, a[1] + t * dy, a[2]], polygon) === 'outside') return false;
    }
  }
  return true;
}
function pointSegmentDistance(point: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}
/** Union of segment capsules = constant-width polyline with round caps/joins.
 * A strict distance test excludes mere boundary contact. No tessellation error.
 */
export function roundRoadIntersectsPolygon(points: readonly Vec3[], radius: number, polygon: Polygon, work: GeometryWork): boolean {
  const boundary = edges(polygon);
  work(points.length * boundary.length);
  if (points.some(point => pointInPolygon(point, polygon) !== 'outside')) return true;
  for (let i = 1; i < points.length; i++) for (const [c, d] of boundary) {
    work(); const a = points[i - 1]!, b = points[i]!;
    if (segmentsIntersect(a, b, c, d)) return true;
    const distance = Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
    if (radius - distance > EPS) return true;
  }
  return false;
}
