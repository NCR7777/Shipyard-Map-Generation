import type { PhysicalValue, Vec3, YardMap } from '../domain/model';

export function roadPoints(map: YardMap, roadId: string): Vec3[] {
  if (!Object.hasOwn(map.roads, roadId)) throw new Error(`Unknown road: ${roadId}`);
  const road = map.roads[roadId]!;
  if (!Object.hasOwn(map.nodes, road.fromNodeId) || !Object.hasOwn(map.nodes, road.toNodeId))
    throw new Error(`Dangling endpoint: ${roadId}`);
  return [map.nodes[road.fromNodeId]!.position, ...road.shapePoints, map.nodes[road.toNodeId]!.position].map(p => [...p]);
}

export function polylineLength2D(points: readonly Vec3[]): number {
  let result = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!;
    const b = points[index]!;
    result += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return result;
}

export function roadLength(map: YardMap, roadId: string): number {
  return polylineLength2D(roadPoints(map, roadId));
}

export function geometryBounds(points: readonly Vec3[]): { min: Vec3; max: Vec3 } | null {
  if (points.length === 0) return null;
  const min: Vec3 = [...points[0]!];
  const max: Vec3 = [...points[0]!];
  for (const p of points) {
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], p[axis]);
      max[axis] = Math.max(max[axis], p[axis]);
    }
  }
  return { min, max };
}
/** View-only envelope for a round-cap, round-join XY stroke, not a road boundary. */
export function roadWidthBounds(points: readonly Vec3[], widthM: PhysicalValue): {
  bounds: ReturnType<typeof geometryBounds>; limited: boolean;
} {
  const bounds = geometryBounds(points);
  if (!bounds || widthM.state !== 'known' || widthM.value <= 0) return { bounds, limited: false };
  if (!Number.isFinite(widthM.value)) return { bounds, limited: true };
  const radius = widthM.value / 2;
  let limited = radius === 0;
  for (const axis of [0, 1] as const) {
    const low = bounds.min[axis] - radius;
    const high = bounds.max[axis] + radius;
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(high - low)) limited = true;
    // Keep every entity and finite bounds, but report that this extent cannot be fully displayed.
    bounds.min[axis] = Math.max(-Number.MAX_VALUE, low);
    bounds.max[axis] = Math.min(Number.MAX_VALUE, high);
  }
  return { bounds, limited };
}

/** Closest XY centerline point and horizontal chainage; no connectivity is inferred. */
export function projectPolyline(point: Vec3, points: readonly Vec3[]): { position: Vec3; distanceM: number; offsetM: number } | null {
  let best: { position: Vec3; distanceM: number; offsetM: number } | null = null;
  let chainage = 0;
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!; const b = points[index]!;
    const dx = b[0] - a[0]; const dy = b[1] - a[1]; const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length) || length === 0) continue;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * (dx / length) + (point[1] - a[1]) * (dy / length)) / length));
    const position: Vec3 = [a[0] + t * dx, a[1] + t * dy, a[2] + t * (b[2] - a[2])];
    const offsetM = Math.hypot(point[0] - position[0], point[1] - position[1]);
    if (Number.isFinite(offsetM) && (!best || offsetM < best.offsetM)) best = { position, distanceM: chainage + t * length, offsetM };
    chainage += length;
  }
  return best;
}
