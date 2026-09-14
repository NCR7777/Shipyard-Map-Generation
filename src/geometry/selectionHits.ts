import type { SceneKind, SceneSnapshot } from '../adapters/contracts';
import type { Vec3 } from '../domain/model';
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from './coordinates';
import { boundsOfPath, projectToPath } from './roadPath';
import { geometryBounds } from './roads';
import { pointInPolygon, polylineBoundaryDistance } from './relations';

export type SelectionHitKind = 'nodes' | 'roads' | 'facilities' | 'zones' | 'accessPoints' | 'servicePoints';
export interface SelectionHit { key: string; kind: SelectionHitKind; id: string; distancePx: number }
export interface SelectionHitOptions {
  visibleKeys: ReadonlySet<string>; hiddenTypes?: readonly SceneKind[]; lockedTypes?: readonly SceneKind[];
  showRoadBands: boolean; showRoadCenterlines: boolean; pixelTolerance?: number;
}
const priority: Record<SelectionHitKind, number> = { servicePoints: 0, accessPoints: 1, nodes: 2, roads: 3, facilities: 4, zones: 5 };
const noWork = () => {};
function nearBounds(point: Vec3, bounds: { min: Vec3; max: Vec3 } | null, margin: number): boolean {
  return !!bounds && point[0] >= bounds.min[0] - margin && point[0] <= bounds.max[0] + margin && point[1] >= bounds.min[1] - margin && point[1] <= bounds.max[1] + margin;
}
/** Click-only exact hit candidates. View flags are inputs; this never changes map or selection. */
export function selectionCandidates(scene: SceneSnapshot, screen: Vec2, camera: Camera, options: SelectionHitOptions): SelectionHit[] {
  const world = screenToWorld(screen, camera);
  if (!world.every(Number.isFinite)) return [];
  const pixelTolerance = options.pixelTolerance ?? 12, toleranceM = pixelTolerance / camera.scale;
  const hidden = new Set(options.hiddenTypes), hits: SelectionHit[] = [];
  // Locks restrict editing, not the existing ability to select and inspect visible objects.
  const enabled = (kind: SelectionHitKind): boolean => !hidden.has(kind);
  const visible = (kind: SelectionHitKind, id: string): boolean => enabled(kind) && options.visibleKeys.has(kind + '/' + id);
  const add = (kind: SelectionHitKind, id: string, distancePx: number) => hits.push({ kind, id, key: kind + '/' + id, distancePx });
  for (const node of scene.nodes) if (visible('nodes', node.id)) {
    const p = worldToScreen(node.position, camera), distancePx = Math.hypot(p[0] - screen[0], p[1] - screen[1]);
    if (distancePx <= pixelTolerance) add('nodes', node.id, distancePx);
  }
  // Existing combined markers show all same-node business identities behind one representative.
  const associated = [...scene.accessPoints.map(point => ({ ...point, kind: 'accessPoints' as const })), ...scene.servicePoints.map(point => ({ ...point, kind: 'servicePoints' as const }))];
  const representedNodes = new Set(associated.filter(point => !hidden.has(point.kind) && options.visibleKeys.has(point.kind + '/' + point.id)).map(point => point.nodeId));
  for (const point of associated) if (enabled(point.kind) && representedNodes.has(point.nodeId)) {
    const p = worldToScreen(point.position, camera), distancePx = Math.hypot(p[0] - screen[0], p[1] - screen[1]);
    if (distancePx <= Math.max(14, pixelTolerance)) add(point.kind, point.id, distancePx);
  }
  if (options.showRoadBands || options.showRoadCenterlines) for (const road of scene.roads) if (visible('roads', road.id)) {
    const bandPixels = options.showRoadBands && road.widthM.state === 'known' ? road.widthM.value * camera.scale : 0;
    const radiusPx = Math.max(pixelTolerance, Number.isFinite(bandPixels) ? bandPixels / 2 : 0), radiusM = radiusPx / camera.scale;
    if (!nearBounds(world, boundsOfPath(road.path), radiusM)) continue;
    const projection = projectToPath(road.path, world);
    // Multiple positions on this same road still identify one selectable entity.
    if (projection.converged && projection.offsetM * camera.scale <= radiusPx) add('roads', road.id, projection.offsetM * camera.scale);
  }
  for (const kind of ['facilities', 'zones'] as const) for (const item of scene[kind]) if (visible(kind, item.id)) {
    if (!nearBounds(world, geometryBounds(item.boundary.outer), toleranceM)) continue;
    const distanceM = pointInPolygon(world, item.boundary) !== 'outside' ? 0 : polylineBoundaryDistance([world], item.boundary, noWork);
    if (distanceM <= toleranceM) add(kind, item.id, distanceM * camera.scale);
  }
  return hits.sort((a, b) => priority[a.kind] - priority[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export interface SelectionCycle { screen: Vec2; mapHash: string; keys: string[]; index: number }
/** The host bypasses this helper for Shift multi-selection and editing handles. */
export function cycleSelection(candidates: readonly SelectionHit[], screen: Vec2, mapHash: string, previous: SelectionCycle | null, options: { advance?: boolean; reverse?: boolean; tolerancePx?: number } = {}): { hit: SelectionHit | null; cycle: SelectionCycle | null } {
  if (!candidates.length) return { hit: null, cycle: null };
  const keys = candidates.map(hit => hit.key), sameSet = previous && previous.mapHash === mapHash && previous.keys.length === keys.length && keys.every((key, index) => key === previous.keys[index]);
  const samePoint = previous && Math.hypot(screen[0] - previous.screen[0], screen[1] - previous.screen[1]) <= (options.tolerancePx ?? 6);
  const step = options.reverse ? -1 : 1;
  const index = sameSet && (samePoint || options.advance) ? (previous.index + step + keys.length) % keys.length : options.reverse ? keys.length - 1 : 0;
  return { hit: candidates[index]!, cycle: { screen: [...screen], mapHash, keys, index } };
}
