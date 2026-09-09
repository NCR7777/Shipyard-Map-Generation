import type { Polygon, Vec3 } from '../domain/model';

export const GEOMETRY_TOLERANCE_M = 1e-7;
export const MAX_POLYGON_VERTICES = 512;
export const MAX_POLYGON_HOLES = 16;
export const MAX_MAP_POLYGON_VERTICES = 8192;
export interface PolygonProblem { code: string; path: string; message: string }

export function ringArea2D(ring: readonly Vec3[]): number {
  const origin = ring[0]; if (!origin) return 0;
  let area = 0;
  for (let i = 1; i + 1 < ring.length; i++) {
    const a = ring[i]!; const b = ring[i + 1]!;
    area += (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0]);
  }
  return area / 2;
}
export function polygonArea2D(polygon: Polygon): number { return Math.abs(ringArea2D(polygon.outer)) - polygon.holes.reduce((sum, ring) => sum + Math.abs(ringArea2D(ring)), 0); }
function distance(a: Vec3, b: Vec3): number { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
function cross(a: Vec3, b: Vec3, c: Vec3): number { return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]); }
function orientation(a: Vec3, b: Vec3, c: Vec3): number {
  const value = cross(a, b, c);
  const tolerance = GEOMETRY_TOLERANCE_M * Math.max(1, distance(a, b), distance(a, c));
  return Math.abs(value) <= tolerance ? 0 : Math.sign(value);
}
export function pointOnSegment(point: Vec3, a: Vec3, b: Vec3): boolean {
  return orientation(a, b, point) === 0 && point[0] >= Math.min(a[0], b[0]) - GEOMETRY_TOLERANCE_M
    && point[0] <= Math.max(a[0], b[0]) + GEOMETRY_TOLERANCE_M && point[1] >= Math.min(a[1], b[1]) - GEOMETRY_TOLERANCE_M
    && point[1] <= Math.max(a[1], b[1]) + GEOMETRY_TOLERANCE_M;
}
export function segmentsIntersect(a: Vec3, b: Vec3, c: Vec3, d: Vec3): boolean {
  const ac = orientation(a, b, c); const ad = orientation(a, b, d);
  const ca = orientation(c, d, a); const cb = orientation(c, d, b);
  if (ac * ad < 0 && ca * cb < 0) return true;
  return (ac === 0 && pointOnSegment(c, a, b)) || (ad === 0 && pointOnSegment(d, a, b))
    || (ca === 0 && pointOnSegment(a, c, d)) || (cb === 0 && pointOnSegment(b, c, d));
}
export function pointInRing(point: Vec3, ring: readonly Vec3[]): 'inside' | 'outside' | 'boundary' {
  let inside = false;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i]!; const b = ring[i + 1]!;
    if (pointOnSegment(point, a, b)) return 'boundary';
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}
function ringIntersection(a: readonly Vec3[], b: readonly Vec3[]): boolean {
  for (let i = 0; i + 1 < a.length; i++) for (let j = 0; j + 1 < b.length; j++) if (segmentsIntersect(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!)) return true;
  return false;
}

/** Bounded planar checks. Rings remain authoritative: validation does not repair or reorder them. */
export function validatePolygon(polygon: Polygon): PolygonProblem[] {
  const problems: PolygonProblem[] = [];
  const add = (code: string, path: string, message: string) => { if (problems.length < 200) problems.push({ code, path, message }); };
  const rings = [polygon.outer, ...polygon.holes];
  if (rings.reduce((sum, ring) => sum + ring.length, 0) > MAX_POLYGON_VERTICES || polygon.holes.length > MAX_POLYGON_HOLES) {
    return [{ code: 'POLYGON_COMPLEXITY_LIMIT', path: '', message: `单多边形仅支持最多 ${MAX_POLYGON_VERTICES} 个含闭合点顶点及 ${MAX_POLYGON_HOLES} 个孔洞，未执行复杂几何校验。` }];
  }
  const planeZ = polygon.outer[0][2];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r]!; const path = r === 0 ? '/outer' : '/holes/' + (r - 1);
    const first = ring[0]!; const last = ring.at(-1)!;
    if (first.some((value, index) => value !== last[index])) add('POLYGON_NOT_CLOSED', path, '环必须显式以完全相同 XYZ 坐标闭合。');
    if (ring.some(point => Math.abs(point[2] - planeZ) > GEOMETRY_TOLERANCE_M)) add('POLYGON_NONPLANAR', path, 'M2A 仅支持与 XY 地面平行的平面多边形。');
    if (ring.some(point => Math.abs(point[0]) > 1e9 || Math.abs(point[1]) > 1e9)) {
      add('POLYGON_COORDINATE_LIMIT', path, '多边形 XY 绝对坐标超过 1e9 m，超出本轮数值检查范围。'); continue;
    }
    const count = ring.length - 1;
    for (let i = 0; i < count; i++) {
      if (distance(ring[i]!, ring[i + 1]!) <= GEOMETRY_TOLERANCE_M) add('POLYGON_ZERO_EDGE', path + '/' + i, '环包含零长或低于 1e-7 m 容差的边。');
      for (let j = i + 1; j < count; j++) if (distance(ring[i]!, ring[j]!) <= GEOMETRY_TOLERANCE_M) add('POLYGON_DUPLICATE_VERTEX', path + '/' + j, '除闭合点外，不允许重复或容差内重合顶点。');
      const before = ring[(i + count - 1) % count]!; const at = ring[i]!; const after = ring[(i + 1) % count]!;
      if (orientation(before, at, after) === 0 && (before[0] - at[0]) * (after[0] - at[0]) + (before[1] - at[1]) * (after[1] - at[1]) > GEOMETRY_TOLERANCE_M ** 2)
        add('POLYGON_ADJACENT_OVERLAP', path + '/' + i, '相邻边折返重叠。');
      for (let j = i + 1; j < count; j++) {
        if (j === i + 1 || (i === 0 && j === count - 1)) continue;
        if (segmentsIntersect(ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!)) add('POLYGON_SELF_INTERSECTION', path + '/' + j, '环内非相邻边相交、接触或重叠。');
      }
    }
    const area = ringArea2D(ring);
    if (!Number.isFinite(area) || Math.abs(area) <= GEOMETRY_TOLERANCE_M ** 2) add('POLYGON_ZERO_AREA', path, '环面积为零或数值不可用。');
    else if ((r === 0 && area < 0) || (r > 0 && area > 0)) add('POLYGON_WINDING', path, '外环必须逆时针，孔洞必须顺时针；导入不会静默反转数组。');
  }
  for (let h = 0; h < polygon.holes.length; h++) {
    const hole = polygon.holes[h]!;
    if (ringIntersection(polygon.outer, hole) || hole.slice(0, -1).some(point => pointInRing(point, polygon.outer) !== 'inside'))
      add('POLYGON_HOLE_OUTSIDE', '/holes/' + h, '孔洞必须严格位于外环内，不能接触或穿过外环。');
    for (let j = 0; j < h; j++) {
      const other = polygon.holes[j]!;
      if (ringIntersection(hole, other) || pointInRing(hole[0], other) !== 'outside' || pointInRing(other[0], hole) !== 'outside')
        add('POLYGON_HOLE_OVERLAP', '/holes/' + h, '孔洞之间不能相交、接触或嵌套。');
    }
  }
  return problems;
}

/** Explicit drawing helper: accepts open vertices, closes and orients the new outer ring. */
export function polygonFromVertices(vertices: readonly Vec3[]): Polygon {
  if (vertices.length < 3) throw new Error('多边形至少需要三个顶点。');
  const points = vertices.map(point => [...point] as Vec3);
  const first = points[0]!; const last = points.at(-1)!;
  if (first.every((value, index) => value === last[index])) points.pop();
  if (points.length < 3) throw new Error('多边形至少需要三个不同顶点。');
  points.push([...points[0]!] as Vec3);
  if (ringArea2D(points) < 0) points.reverse();
  return { outer: points as Polygon['outer'], holes: [] };
}
export function rectanglePolygon(origin: Vec3, widthM: number, heightM: number): Polygon {
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM) || widthM <= 0 || heightM <= 0) throw new Error('矩形宽高必须是正的有限米制数值。');
  const [x, y, z] = origin;
  return polygonFromVertices([[x, y, z], [x + widthM, y, z], [x + widthM, y + heightM, z], [x, y + heightM, z]]);
}
export function transformPolygon(polygon: Polygon, transform: (point: Vec3) => Vec3): Polygon {
  return { outer: polygon.outer.map(transform) as Polygon['outer'], holes: polygon.holes.map(ring => ring.map(transform) as Polygon['outer']) };
}
