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
