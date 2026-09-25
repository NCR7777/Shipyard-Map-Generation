import type { SceneSnapshot } from '../../adapters/contracts';
import type { MapCommand } from '../../domain/commands';
import { newFacility, newZone } from '../../domain/factory';
import type { Polygon, Vec3, YardMap } from '../../domain/model';
import { spatialClassificationEditable } from '../../domain/spatialClassification';
import type { DrawingConfig } from '../../editor/projectController';
import { draftRoadGeometry, type DraftRoad, type TraceConnection } from '../../editor/roadDrawing';
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { orientedRectangleVertices } from '../../geometry/rectangles';
import { boundsOfPath, projectToPath } from '../../geometry/roadPath';
import { nearBounds } from '../../geometry/selectionHits';
import { uid } from './movePreview';

/** Screen distance within which a click connects to a node or road centreline, as in ../map. */
export const SNAP_PX = 12;
import type { ShapeKind } from '../state/store';
export type { ShapeKind };
export interface SnapTarget { connection: TraceConnection; position: Vec3 }

/** The node or road centreline a road click would connect to: nodes first, then the nearest road interior point.
 *  Hidden or locked layers never connect; ends of a road are its nodes, never a mid-road split. */
export function snapTarget(scene: SceneSnapshot, screen: Vec2, camera: Camera, options: {
  z: number; nodes: boolean; roads: boolean; excludeNodeId?: string | undefined;
}): SnapTarget | null {
  let best: SnapTarget | null = null, distance = SNAP_PX;
  if (options.nodes) for (const node of scene.nodes) {
    if (Math.abs(node.position[2] - options.z) > 1e-6 || node.id === options.excludeNodeId) continue;
    const p = worldToScreen(node.position, camera), delta = Math.hypot(p[0] - screen[0], p[1] - screen[1]);
    if (delta <= distance) { best = { connection: { kind: 'node', nodeId: node.id }, position: node.position }; distance = delta; }
  }
  if (best || !options.roads) return best;
  const world = screenToWorld(screen, camera, options.z);
  for (const road of scene.roads) {
    if (!nearBounds(world, boundsOfPath(road.path), distance / camera.scale)) continue;
    const projected = projectToPath(road.path, world);
    if (projected.ambiguous || Math.abs(projected.point[2] - options.z) > 1e-6 || projected.sM <= 1e-6 || projected.sM >= road.lengthM - 1e-6) continue;
    const delta = projected.offsetM * camera.scale;
    if (delta < distance) { best = { connection: { kind: 'road', roadId: road.id, distanceM: projected.sM }, position: projected.point }; distance = delta; }
  }
  return best;
}

/** Coordinate snapping only: never creates topology. */
export function snapToGrid(point: Vec3, step: number): Vec3 {
  return step > 0 ? [Math.round(point[0] / step) * step, Math.round(point[1] / step) * step, point[2]] : point;
}
/** Shift keeps the new segment horizontal or vertical. */
export function constrainAxis(from: Vec3, to: Vec3): Vec3 {
  return Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]) ? [to[0], from[1], to[2]] : [from[0], to[1], to[2]];
}
/** Length and bearing (clockwise from north, i.e. +Y) of a segment, for the readout next to the cursor. */
export function segmentReadout(from: Vec3, to: Vec3): { lengthM: number; bearingDeg: number } {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  return { lengthM: Math.hypot(dx, dy), bearingDeg: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
}
export const formatReadout = (from: Vec3, to: Vec3) => { const { lengthM, bearingDeg } = segmentReadout(from, to); return `${lengthM.toFixed(2)} m · ${bearingDeg.toFixed(1)}°`; };

const ring = (points: readonly Vec3[]): Polygon => ({ outer: [...points.map(point => [...point] as Vec3), [...points[0]!] as Vec3] as unknown as Polygon['outer'], holes: [] });
/** Shoelace area; positive for counter-clockwise points. */
const signedArea = (points: readonly Vec3[]) => points.reduce((sum, point, index) => { const next = points[(index + 1) % points.length]!; return sum + point[0] * next[1] - next[0] * point[1]; }, 0) / 2;
/** Reverses clockwise input but keeps the first vertex where the user put it. */
const counterClockwise = (points: readonly Vec3[]) => ring(signedArea(points) < 0 ? [points[0]!, ...points.slice(1).reverse()] : points);
const cross = (o: Vec3, a: Vec3, b: Vec3) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
/** Whether two non-adjacent edges of the closed outline cross (a figure eight, a bow tie). */
export function selfIntersects(points: readonly Vec3[]): boolean {
  const n = points.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    const a = points[i]!, b = points[(i + 1) % n]!, c = points[j]!, d = points[(j + 1) % n]!;
    if (Math.sign(cross(a, b, c)) * Math.sign(cross(a, b, d)) < 0 && Math.sign(cross(c, d, a)) * Math.sign(cross(c, d, b)) < 0) return true;
  }
  return false;
}
/** The boundary a shape draft describes with the cursor as its last point, or null while it is still incomplete or degenerate. */
export function shapeBoundary(shape: ShapeKind, points: readonly Vec3[]): Polygon | null {
  try {
    if (shape === 'rect2' && points.length >= 2) {
      const [a, b] = points as [Vec3, Vec3];
      if (Math.abs(b[0] - a[0]) < 0.01 || Math.abs(b[1] - a[1]) < 0.01) return null;
      return ring([[Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], [Math.max(a[0], b[0]), Math.min(a[1], b[1]), a[2]], [Math.max(a[0], b[0]), Math.max(a[1], b[1]), a[2]], [Math.min(a[0], b[0]), Math.max(a[1], b[1]), a[2]]]);
    }
    if (shape === 'rect3' && points.length >= 3) {
      // Counter-clockwise, whichever side the width was drawn to.
      return counterClockwise(orientedRectangleVertices(points[0]!, points[1]!, points[2]!));
    }
    if (shape === 'polygon' && points.length >= 3) return Math.abs(signedArea(points)) < 1e-4 || selfIntersects(points) ? null : counterClockwise(points);
  } catch { return null; }
  return null;
}
/** Clicks a shape needs before it can be committed. */
export const SHAPE_CLICKS: Record<ShapeKind, number> = { rect2: 2, rect3: 3, polygon: Infinity };

/** The command for a finished road draft, with the drawing defaults of this session. */
export function roadCommand(draft: DraftRoad, drawing: DrawingConfig): MapCommand {
  return {
    type: 'quickTraceRoad', points: draft.points, geometry: draftRoadGeometry(draft), disconnect: draft.disconnect ?? false,
    defaults: { widthM: drawing.roadWidthM, direction: drawing.roadDirection, connectNewCrossings: drawing.connectNewCrossings },
    ...draft.startConnection ? { startConnection: draft.startConnection } : {}, ...draft.endConnection ? { endConnection: draft.endConnection } : {},
  };
}
/** Generic kinds use the quick-trace defaults (numbered names, drawing source); a chosen specific kind is added directly, as in ../map. */
export function shapeCommand(map: YardMap, target: 'building' | 'zone', boundary: Polygon, drawing: DrawingConfig): MapCommand {
  const facilities = target === 'building', generic = facilities ? drawing.facilityKind === 'building' : drawing.zoneKind === 'unclassified';
  const classification = spatialClassificationEditable(map) ? { classId: facilities ? drawing.facilityClassificationId : drawing.zoneClassificationId } : undefined;
  if (generic) return { type: 'quickTraceBoundary', kind: facilities ? 'building' : 'area', boundary, ...classification ? { classification } : {} };
  const count = Object.keys(facilities ? map.facilities : map.zones).length + 1, number = String(count).padStart(3, '0');
  return facilities
    ? { type: 'addFacility', id: uid('facility'), facility: newFacility(boundary, '建筑' + number, drawing.facilityKind), ...classification ? { classification } : {} }
    : { type: 'addZone', id: uid('zone'), zone: newZone(boundary, '区域' + number, drawing.zoneKind), ...classification ? { classification } : {} };
}
