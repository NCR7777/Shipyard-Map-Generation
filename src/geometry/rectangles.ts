import type { Polygon, Vec3 } from '../domain/model';
import type { Vec2 } from './coordinates';
import { GEOMETRY_TOLERANCE_M, validatePolygon } from './polygons';

export const MIN_RECTANGLE_SIZE_M = 0.01;
export type RectangleCorner = 0 | 1 | 2 | 3;
export interface RectangleFrame {
  corners: [Vec3, Vec3, Vec3, Vec3];
  axisX: Vec2;
  axisY: Vec2;
  widthM: number;
  heightM: number;
  angleRad: number;
}
export interface RectangleResize { boundary: Polygon; widthM: number; heightM: number; clamped: boolean }
const cornerAxes: readonly Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const finitePoint = (point: Vec3): boolean => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite);
const dot = (vector: Vec2, axis: Vec2): number => vector[0] * axis[0] + vector[1] * axis[1];
const originalBoundary = (frame: RectangleFrame): Polygon => {
  const [a, b, c, d] = frame.corners;
  return { outer: [[...a], [...b], [...c], [...d], [...a]], holes: [] };
};

/** Derive only: unreliable, nonrectangular and holed boundaries retain their original geometry. */
export function rectangleFrame(boundary: Polygon): RectangleFrame | null {
  if (boundary.holes.length || boundary.outer.length !== 5 || !boundary.outer.every(finitePoint) || validatePolygon(boundary).length) return null;
  const corners = boundary.outer.slice(0, 4).map(point => [...point] as Vec3) as RectangleFrame['corners'];
  const [a, b, c, d] = corners;
  const widthM = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const axisX: Vec2 = [(b[0] - a[0]) / widthM, (b[1] - a[1]) / widthM];
  const axisY: Vec2 = [-axisX[1], axisX[0]];
  const heightM = dot([d[0] - a[0], d[1] - a[1]], axisY);
  if (widthM <= GEOMETRY_TOLERANCE_M || heightM <= GEOMETRY_TOLERANCE_M) return null;
  const expectedD: Vec2 = [a[0] + axisY[0] * heightM, a[1] + axisY[1] * heightM];
  if (Math.hypot(d[0] - expectedD[0], d[1] - expectedD[1]) > GEOMETRY_TOLERANCE_M
    || Math.hypot(c[0] - b[0] - axisY[0] * heightM, c[1] - b[1] - axisY[1] * heightM) > GEOMETRY_TOLERANCE_M) return null;
  return { corners, axisX, axisY, widthM, heightM, angleRad: Math.atan2(axisX[1], axisX[0]) };
}

function checkCorner(corner: RectangleCorner): void {
  if (!Number.isInteger(corner) || corner < 0 || corner > 3) throw new RangeError('矩形控制角必须为 0 至 3。');
}
function unchanged(frame: RectangleFrame, widthM: number, heightM: number): boolean {
  return Math.abs(widthM - frame.widthM) <= GEOMETRY_TOLERANCE_M && Math.abs(heightM - frame.heightM) <= GEOMETRY_TOLERANCE_M;
}

/** Positive local dimensions, with the opposite of corner fixed. No persisted transform is introduced. */
export function resizeRectangleDimensions(frame: RectangleFrame, widthM: number, heightM: number, corner: RectangleCorner = 2): Polygon {
  checkCorner(corner);
  if (!Number.isFinite(widthM) || !Number.isFinite(heightM)) throw new RangeError('矩形宽高必须为有限米制数值。');
  if (unchanged(frame, widthM, heightM)) return originalBoundary(frame);
  if (widthM < MIN_RECTANGLE_SIZE_M || heightM < MIN_RECTANGLE_SIZE_M) throw new RangeError(`调整后的矩形宽高必须至少为 ${MIN_RECTANGLE_SIZE_M} m。`);
  const fixedIndex = (corner + 2) % 4;
  const fixed = frame.corners[fixedIndex]!;
  const fixedAxes = cornerAxes[fixedIndex]!;
  const corners = cornerAxes.map(([x, y], index): Vec3 => index === fixedIndex ? [...fixed] : [
    fixed[0] + (x - fixedAxes[0]) * widthM * frame.axisX[0] + (y - fixedAxes[1]) * heightM * frame.axisY[0],
    fixed[1] + (x - fixedAxes[0]) * widthM * frame.axisX[1] + (y - fixedAxes[1]) * heightM * frame.axisY[1],
    fixed[2],
  ]) as RectangleFrame['corners'];
  return { outer: [...corners, [...corners[0]]], holes: [] };
}

/** Freeze frame at drag start; project each pointer independently and clamp crossing without flipping. */
export function resizeRectangleCorner(frame: RectangleFrame, corner: RectangleCorner, pointerWorld: Vec3): RectangleResize {
  checkCorner(corner);
  if (!finitePoint(pointerWorld)) throw new RangeError('控制柄坐标必须为三个有限米制数值。');
  const fixedIndex = (corner + 2) % 4;
  const fixed = frame.corners[fixedIndex]!;
  const vector: Vec2 = [pointerWorld[0] - fixed[0], pointerWorld[1] - fixed[1]];
  const movingAxes = cornerAxes[corner]!;
  const fixedAxes = cornerAxes[fixedIndex]!;
  const requestedWidth = (movingAxes[0] - fixedAxes[0]) * dot(vector, frame.axisX);
  const requestedHeight = (movingAxes[1] - fixedAxes[1]) * dot(vector, frame.axisY);
  if (unchanged(frame, requestedWidth, requestedHeight)) return { boundary: originalBoundary(frame), widthM: frame.widthM, heightM: frame.heightM, clamped: false };
  const widthM = Math.max(MIN_RECTANGLE_SIZE_M, requestedWidth);
  const heightM = Math.max(MIN_RECTANGLE_SIZE_M, requestedHeight);
  return { boundary: resizeRectangleDimensions(frame, widthM, heightM, corner), widthM, heightM, clamped: widthM !== requestedWidth || heightM !== requestedHeight };
}

/** Ring 0 is the outer ring; subsequent indices are holes. Final validity remains the domain command's job. */
export function movePolygonVertex(boundary: Polygon, ringIndex: number, vertexIndex: number, position: Vec3): Polygon {
  const ring = [boundary.outer, ...boundary.holes][ringIndex];
  if (!Number.isInteger(ringIndex) || !ring || !Number.isInteger(vertexIndex) || vertexIndex < 0 || vertexIndex >= ring.length - 1 || !finitePoint(position))
    throw new RangeError('必须选择有效的非闭合顶点，并输入三个有限米制坐标。');
  const result = structuredClone(boundary);
  const target = ringIndex === 0 ? result.outer : result.holes[ringIndex - 1]!;
  target[vertexIndex] = [...position];
  if (vertexIndex === 0) target[target.length - 1] = [...position];
  return result;
}
