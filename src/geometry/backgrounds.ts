import type { BackgroundLayer, Vec2 } from '../domain/model';

export type BackgroundTransform = BackgroundLayer['imageToWorld'];
export type BackgroundCorner = 0 | 1 | 2 | 3;

export function backgroundDeterminant(t: BackgroundTransform): number { return t[0] * t[3] - t[1] * t[2]; }
export function validBackgroundTransform(t: unknown): t is BackgroundTransform {
  if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite)) return false;
  const det = backgroundDeterminant(t as BackgroundTransform);
  return Number.isFinite(det) && det !== 0;
}
function assertTransform(t: BackgroundTransform): void {
  if (!validBackgroundTransform(t)) throw new RangeError('底图需要有限且非奇异的仿射变换。');
}
function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) throw new RangeError('像素尺寸必须为正整数。');
}
export function backgroundPoint(t: BackgroundTransform, pixel: Vec2): Vec2 {
  return [t[0] * pixel[0] + t[2] * pixel[1] + t[4], t[1] * pixel[0] + t[3] * pixel[1] + t[5]];
}
function pixels(width: number, height: number): [Vec2, Vec2, Vec2, Vec2] { return [[0, 0], [width, 0], [width, height], [0, height]]; }
export function backgroundFrame(t: BackgroundTransform, width: number, height: number) {
  assertTransform(t); assertDimensions(width, height);
  const corners = pixels(width, height).map(pixel => backgroundPoint(t, pixel)) as [Vec2, Vec2, Vec2, Vec2];
  const scaleXMPerPx = Math.hypot(t[0], t[1]), scaleYMPerPx = Math.hypot(t[2], t[3]);
  const center = backgroundPoint(t, [width / 2, height / 2]);
  const widthM = width * scaleXMPerPx, heightM = height * scaleYMPerPx;
  if (![...corners.flat(), ...center, widthM, heightM].every(Number.isFinite)) throw new RangeError('底图范围超出有限数值。');
  return { corners, center, widthM, heightM, rotationRad: Math.atan2(t[1], t[0]), scaleXMPerPx, scaleYMPerPx };
}
export function translateBackground(t: BackgroundTransform, delta: Vec2): BackgroundTransform {
  assertTransform(t);
  const result: BackgroundTransform = [t[0], t[1], t[2], t[3], t[4] + delta[0], t[5] + delta[1]];
  assertTransform(result);
  if (Math.sign(backgroundDeterminant(result)) !== Math.sign(backgroundDeterminant(t))) throw new RangeError('数值运算不能反转底图朝向。');
  return result;
}
export function rotateBackground(t: BackgroundTransform, width: number, height: number, angleRad: number, pivot: Vec2 = backgroundFrame(t, width, height).center): BackgroundTransform {
  assertTransform(t); assertDimensions(width, height);
  if (!Number.isFinite(angleRad)) throw new RangeError('旋转角度必须有限。');
  if (angleRad === 0) return [...t];
  const c = Math.cos(angleRad), s = Math.sin(angleRad), dx = t[4] - pivot[0], dy = t[5] - pivot[1];
  const result: BackgroundTransform = [c * t[0] - s * t[1], s * t[0] + c * t[1], c * t[2] - s * t[3], s * t[2] + c * t[3], pivot[0] + c * dx - s * dy, pivot[1] + s * dx + c * dy];
  assertTransform(result);
  if (Math.sign(backgroundDeterminant(result)) !== Math.sign(backgroundDeterminant(t))) throw new RangeError('数值运算不能反转底图朝向。');
  return result;
}
/** Scale the existing pixel basis, preserving shear and the chosen fixed corner. */
export function scaleBackground(t: BackgroundTransform, width: number, height: number, factorX: number, factorY: number, fixedCorner: BackgroundCorner): BackgroundTransform {
  assertTransform(t); assertDimensions(width, height);
  if (![factorX, factorY].every(n => Number.isFinite(n) && n > 0)) throw new RangeError('缩放必须为正数，不能穿过固定角或翻转底图。');
  const pixel = pixels(width, height)[fixedCorner];
  if (!pixel) throw new RangeError('无效底图角点。');
  if (factorX === 1 && factorY === 1) return [...t];
  const fixed = backgroundPoint(t, pixel);
  const result: BackgroundTransform = [t[0] * factorX, t[1] * factorX, t[2] * factorY, t[3] * factorY, 0, 0];
  result[4] = fixed[0] - result[0] * pixel[0] - result[2] * pixel[1];
  result[5] = fixed[1] - result[1] * pixel[0] - result[3] * pixel[1];
  assertTransform(result);
  if (Math.sign(backgroundDeterminant(result)) !== Math.sign(backgroundDeterminant(t))) throw new RangeError('数值运算不能反转底图朝向。');
  return result;
}
export function resizeBackgroundCorner(t: BackgroundTransform, width: number, height: number, corner: BackgroundCorner, world: Vec2, keepAspect = false): BackgroundTransform {
  assertTransform(t); assertDimensions(width, height);
  const fixedCorner = ((corner + 2) % 4) as BackgroundCorner;
  const coordinates = pixels(width, height), moving = coordinates[corner], fixed = coordinates[fixedCorner];
  if (!moving || !fixed) throw new RangeError('无效底图角点。');
  const origin = backgroundPoint(t, fixed), dx = world[0] - origin[0], dy = world[1] - origin[1];
  const du = moving[0] - fixed[0], dv = moving[1] - fixed[1], det = backgroundDeterminant(t);
  let sx = (t[3] * dx - t[2] * dy) / det / du, sy = (-t[1] * dx + t[0] * dy) / det / dv;
  if (keepAspect) {
    const vx = t[0] * du + t[2] * dv, vy = t[1] * du + t[3] * dv;
    sx = sy = (dx * vx + dy * vy) / (vx * vx + vy * vy);
  }
  return scaleBackground(t, width, height, sx, sy, fixedCorner);
}
