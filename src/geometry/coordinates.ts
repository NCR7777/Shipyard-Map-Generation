import type { Vec3 } from '../domain/model';

export type Vec2 = [number, number];
export interface Camera { offsetX: number; offsetY: number; scale: number }

function checkCamera(camera: Camera): void {
  if (!Number.isFinite(camera.scale) || camera.scale <= 0
    || !Number.isFinite(camera.offsetX) || !Number.isFinite(camera.offsetY)) {
    throw new RangeError('Camera must have finite offsets and positive finite pixels-per-metre scale');
  }
}

export function worldToScreen(point: Vec3, camera: Camera): Vec2 {
  checkCamera(camera);
  return [camera.offsetX + point[0] * camera.scale, camera.offsetY - point[1] * camera.scale];
}

export function screenToWorld(point: Vec2, camera: Camera, z = 0): Vec3 {
  checkCamera(camera);
  return [(point[0] - camera.offsetX) / camera.scale, (camera.offsetY - point[1]) / camera.scale, z];
}

/** Keep the world point under the cursor fixed when zooming. */
export function zoomAt(camera: Camera, screen: Vec2, scale: number): Camera {
  checkCamera(camera);
  const ratio = scale / camera.scale;
  // A valid tiny scale can put the cursor beyond finite world coordinates; stay in screen space.
  const next = { scale, offsetX: screen[0] - (screen[0] - camera.offsetX) * ratio, offsetY: screen[1] - (screen[1] - camera.offsetY) * ratio };
  checkCamera(next);
  return next;
}

/** Existing fit calculation shared by whole-map and object navigation; unrepresentable cameras are refused. */
export function fitCamera(bounds: { min: Vec3; max: Vec3 }, width: number, height: number): Camera | null {
  const halfWidth = Math.max(5, bounds.max[0] / 2 - bounds.min[0] / 2);
  const halfHeight = Math.max(5, bounds.max[1] / 2 - bounds.min[1] / 2);
  const scale = Math.min(10, Math.max(1, width - 100) / 2 / halfWidth, Math.max(1, height - 100) / 2 / halfHeight);
  const next = { scale, offsetX: width / 2 - (bounds.min[0] / 2 + bounds.max[0] / 2) * scale, offsetY: height / 2 + (bounds.min[1] / 2 + bounds.max[1] / 2) * scale };
  return scale > 0 && Object.values(next).every(Number.isFinite) ? next : null;
}
