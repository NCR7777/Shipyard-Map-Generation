import type { Vec3 } from '../../domain/model';
import { worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';

/** Keep the width control clear of a centreline bend control without altering the metric road band. */
export function roadWidthHandle(center: Vec3, tangent: Vec3, widthM: number, sign: -1 | 1, camera: Camera, previewWidthM = widthM) {
  const normal: Vec2 = [-tangent[1], tangent[0]];
  const outsetM = Math.max(0, 16 / camera.scale - widthM / 2);
  const edge: Vec3 = [center[0] + normal[0] * previewWidthM / 2 * sign, center[1] + normal[1] * previewWidthM / 2 * sign, center[2]];
  const position: Vec3 = [edge[0] + normal[0] * outsetM * sign, edge[1] + normal[1] * outsetM * sign, center[2]];
  return { center, normal, sign, outsetM, position, screen: worldToScreen(position, camera), edgeScreen: worldToScreen(edge, camera) };
}
export function widthFromRoadHandle(handle: ReturnType<typeof roadWidthHandle>, world: Vec3): number {
  const halfWidth = handle.sign * ((world[0] - handle.center[0]) * handle.normal[0] + (world[1] - handle.center[1]) * handle.normal[1]) - handle.outsetM;
  return Math.min(1000, Math.max(0.1, 2 * halfWidth));
}
