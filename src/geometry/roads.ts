import type { Vec3, YardMap } from '../domain/model';

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