import type { Polygon, Vec3 } from '../../domain/model';
import { pointInPolygon } from '../../geometry/relations';

/** Axis-aligned world-space selection rectangle. */
export interface Box { minX: number; minY: number; maxX: number; maxY: number }

const inside = (p: Vec3, box: Box) => p[0] >= box.minX && p[0] <= box.maxX && p[1] >= box.minY && p[1] <= box.maxY;

/** Liang–Barsky clipping: true when segment ab has any point inside the box. */
export function segmentTouchesBox(a: Vec3, b: Vec3, box: Box): boolean {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0] - box.minX], [dx, box.maxX - a[0]], [-dy, a[1] - box.minY], [dy, box.maxY - a[1]]] as const) {
    if (p === 0) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return true;
}

/** A polyline with the given half width (m) touches the box; the width widens the box, a slight overestimate at its corners. */
export function polylineTouchesBox(points: readonly Vec3[], box: Box, halfWidth = 0): boolean {
  const wide = { minX: box.minX - halfWidth, minY: box.minY - halfWidth, maxX: box.maxX + halfWidth, maxY: box.maxY + halfWidth };
  if (points.length === 1) return inside(points[0]!, wide);
  for (let i = 0; i + 1 < points.length; i++) if (segmentTouchesBox(points[i]!, points[i + 1]!, wide)) return true;
  return false;
}

/** The polygon's area or outline shares at least one point with the box. */
export function polygonTouchesBox(polygon: Polygon, box: Box): boolean {
  for (const ring of [polygon.outer, ...polygon.holes]) if (polylineTouchesBox(ring, box)) return true;
  const z = polygon.outer[0]?.[2] ?? 0;
  // No edge touches the box, so the box lies wholly inside or outside the area: one corner decides.
  return pointInPolygon([box.minX, box.minY, z], polygon) !== 'outside';
}
