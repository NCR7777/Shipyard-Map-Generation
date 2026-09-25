import type { Vec2, Vec3 } from '../../domain/model';
import { worldToScreen, type Camera } from '../../geometry/coordinates';
import {
  backgroundFrame, backgroundPoint, resizeBackgroundCorner, rotateBackground, scaleBackground, translateBackground, validBackgroundTransform,
  type BackgroundCorner, type BackgroundTransform,
} from '../../geometry/backgrounds';

/** Placing, dragging and typing a background image's transform. The kernel checks every result again when it is committed. */

/** Screen distance of the rotation handle beyond the middle of the image's top edge. */
export const ROTATE_OFFSET_PX = 28;
const HIT_PX = 10;
/** Shift while rotating: the image's angle goes in these steps. */
export const ANGLE_STEP = Math.PI / 12;

export type AdjustPart = { kind: 'move' } | { kind: 'corner'; corner: BackgroundCorner } | { kind: 'rotate' };
/** The adjusted image on screen: its four corners (pixel corners 0,0 · w,0 · w,h · 0,h), centre, and rotation handle. */
export interface AdjustFrame { corners: [Vec2, Vec2, Vec2, Vec2]; centre: Vec2; topMiddle: Vec2; rotate: Vec2 }

const screen = (point: Vec2, camera: Camera): Vec2 => worldToScreen([point[0], point[1], 0], camera);
export function adjustFrame(t: BackgroundTransform, width: number, height: number, camera: Camera): AdjustFrame {
  const frame = backgroundFrame(t, width, height);
  const corners = frame.corners.map(corner => screen(corner, camera)) as AdjustFrame['corners'], centre = screen(frame.center, camera);
  const topMiddle: Vec2 = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
  // Outward from the centre through the top edge: above the image as it is shown, however it is turned.
  let dx = topMiddle[0] - centre[0], dy = topMiddle[1] - centre[1], length = Math.hypot(dx, dy);
  if (!(length > 1e-9)) { dx = 0; dy = -1; length = 1; }
  return { corners, centre, topMiddle, rotate: [topMiddle[0] + dx / length * ROTATE_OFFSET_PX, topMiddle[1] + dy / length * ROTATE_OFFSET_PX] };
}

function inside(point: Vec2, polygon: readonly Vec2[]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!, [xj, yj] = polygon[j]!;
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) result = !result;
  }
  return result;
}
/** What a press at `at` takes hold of: the rotation handle, then the nearest corner, then the image itself. */
export function adjustPartAt(frame: AdjustFrame, at: Vec2): AdjustPart | null {
  const distance = (point: Vec2) => Math.hypot(point[0] - at[0], point[1] - at[1]);
  if (distance(frame.rotate) <= HIT_PX) return { kind: 'rotate' };
  let nearest: BackgroundCorner | null = null, best = HIT_PX;
  frame.corners.forEach((corner, index) => { const d = distance(corner); if (d <= best) { best = d; nearest = index as BackgroundCorner; } });
  if (nearest !== null) return { kind: 'corner', corner: nearest };
  return inside(at, frame.corners) ? { kind: 'move' } : null;
}

const PIXEL_CORNERS = (width: number, height: number): Vec2[] => [[0, 0], [width, 0], [width, height], [0, height]];
const millimetres = (value: number) => Math.round(value * 1000) / 1000;
/** The transform while a part is dragged from world point `from` to `to`. A corner keeps where it was grabbed, so a press
 *  beside it does not jump; `keepAspect` scales both axes alike; `snapAngle` turns the image to whole steps of 15°. */
export function dragTransform(part: AdjustPart, start: BackgroundTransform, width: number, height: number, from: Vec2 | Vec3, to: Vec2 | Vec3,
  options: { keepAspect: boolean; snapAngle: boolean }): BackgroundTransform {
  if (part.kind === 'move') return translateBackground(start, [millimetres(to[0] - from[0]), millimetres(to[1] - from[1])]);
  if (part.kind === 'corner') {
    const corner = backgroundPoint(start, PIXEL_CORNERS(width, height)[part.corner]!);
    return resizeBackgroundCorner(start, width, height, part.corner, [corner[0] + to[0] - from[0], corner[1] + to[1] - from[1]], options.keepAspect);
  }
  const frame = backgroundFrame(start, width, height), centre = frame.center;
  let delta = Math.atan2(to[1] - centre[1], to[0] - centre[0]) - Math.atan2(from[1] - centre[1], from[0] - centre[0]);
  if (options.snapAngle) delta = Math.round((frame.rotationRad + delta) / ANGLE_STEP) * ANGLE_STEP - frame.rotationRad;
  return rotateBackground(start, width, height, delta);
}

/** Uniform scale by `factor` about a world point that stays where it is. */
export function scaleAbout(t: BackgroundTransform, factor: number, pivot: Vec2): BackgroundTransform {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError('比例必须是大于 0 的有限数。');
  const result: BackgroundTransform = [t[0] * factor, t[1] * factor, t[2] * factor, t[3] * factor, pivot[0] + factor * (t[4] - pivot[0]), pivot[1] + factor * (t[5] - pivot[1])];
  if (!validBackgroundTransform(result)) throw new RangeError('缩放后的底图超出有限数值。');
  return result;
}

/** Scale from two image points and the real distance between them: the first point stays where it is. */
export function measuredScale(t: BackgroundTransform, a: Vec2, b: Vec2, metres: number): BackgroundTransform {
  if (!Number.isFinite(metres) || metres <= 0) throw new RangeError('实际长度必须是大于 0 的有限数。');
  const pa = backgroundPoint(t, a), pb = backgroundPoint(t, b), current = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  if (!(current > 0)) throw new RangeError('两点重合，无法定比例。');
  return scaleAbout(t, metres / current, pa);
}
/** Image pixel under a world point (the inverse of imageToWorld). */
export function pixelAt(t: BackgroundTransform, world: Vec2 | Vec3): Vec2 {
  const det = t[0] * t[3] - t[1] * t[2], x = world[0] - t[4], y = world[1] - t[5];
  return [(t[3] * x - t[2] * y) / det, (-t[1] * x + t[0] * y) / det];
}

/** The numeric fields: top-left corner, size, angle (degrees, anticlockwise) and metres per pixel. */
export type NumericField = 'x' | 'y' | 'width' | 'height' | 'angle' | 'resolution';
/** The transform after one field is set; only that property changes. Size and resolution keep the top-left corner in place,
 *  the angle turns about the centre. */
export function withField(t: BackgroundTransform, width: number, height: number, field: NumericField, value: number, keepAspect: boolean): BackgroundTransform {
  if (!Number.isFinite(value)) throw new RangeError('必须是有限数。');
  const frame = backgroundFrame(t, width, height);
  // The corner is set, not moved by a difference: the typed number is stored exactly.
  if (field === 'x' || field === 'y') { const result: BackgroundTransform = [...t]; result[field === 'x' ? 4 : 5] = value; return result; }
  if (field === 'angle') return rotateBackground(t, width, height, value * Math.PI / 180 - frame.rotationRad);
  if (value <= 0) throw new RangeError('必须大于 0。');
  if (field === 'width') { const factor = value / frame.widthM; return scaleBackground(t, width, height, factor, keepAspect ? factor : 1, 0); }
  if (field === 'height') { const factor = value / frame.heightM; return scaleBackground(t, width, height, keepAspect ? factor : 1, factor, 0); }
  const factor = value / frame.scaleXMPerPx;
  return scaleBackground(t, width, height, factor, factor, 0);
}

/** Where a new image goes without calibration: over the map's content (vectors, or other images), centred on it; on an
 *  empty map 1 m per pixel with its lower-left corner at the origin. Either is a starting guess until it is calibrated. */
export function initialPlacement(width: number, height: number, bounds: { min: Vec3; max: Vec3 } | null): BackgroundTransform {
  const spanX = bounds ? bounds.max[0] - bounds.min[0] : 0, spanY = bounds ? bounds.max[1] - bounds.min[1] : 0;
  if (!bounds || !(Math.max(spanX, spanY) >= 10)) {
    const cx = bounds ? (bounds.min[0] + bounds.max[0]) / 2 : width / 2, cy = bounds ? (bounds.min[1] + bounds.max[1]) / 2 : height / 2;
    return [1, 0, 0, -1, cx - width / 2, cy + height / 2];
  }
  const s = Math.max(spanX / width, spanY / height), cx = (bounds.min[0] + bounds.max[0]) / 2, cy = (bounds.min[1] + bounds.max[1]) / 2;
  return [s, 0, 0, -s, cx - s * width / 2, cy + s * height / 2];
}

/** A replacement image covers the old one's ground: same top-left corner and width; the same height too when the aspect
 *  ratios agree within 1 %, otherwise the old pixel shape (the new image is not stretched) and `sameGround` is false. */
export function replacementTransform(t: BackgroundTransform, oldSize: { width: number; height: number }, newSize: { width: number; height: number }): { transform: BackgroundTransform; sameGround: boolean } {
  const fx = oldSize.width / newSize.width, exact = oldSize.height / newSize.height, sameGround = Math.abs(exact - fx) <= 0.01 * fx, fy = sameGround ? exact : fx;
  return { transform: [t[0] * fx, t[1] * fx, t[2] * fy, t[3] * fy, t[4], t[5]], sameGround };
}
