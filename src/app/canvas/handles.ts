import type { SceneSnapshot } from '../../adapters/contracts';
import { canEditBoundary, type MapCommand } from '../../domain/commands';
import type { Polygon, Vec3, YardMap } from '../../domain/model';
import { sameValue } from '../../domain/value';
import { worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { bendPathSpan } from '../../geometry/curveEditing';
import { insertPolygonVertex, movePolygonVertex, rectangleFrame, removePolygonVertex, resizeRectangleCorner, type RectangleCorner } from '../../geometry/rectangles';
import { movePathAnchor, pathLength, pathToRoadGeometry, pointAt, poseAtDistance, type ResolvedPath } from '../../geometry/roadPath';
import type { AppState } from '../state/store';
import { snapToGrid } from './drafting';
import { uid } from './movePreview';
import { entranceAdjustments } from './outlineEntrances';

/** Keep the width control clear of a centreline bend control without altering the metric road band (ported from ../map). */
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

export type Handle =
  | { kind: 'corner'; corner: RectangleCorner; at: Vec3 }
  | { kind: 'vertex'; ring: number; index: number; at: Vec3 }
  | { kind: 'insert'; ring: number; edge: number; at: Vec3 }
  | { kind: 'anchor'; index: number; at: Vec3 }
  /** A road's end: a press drags its node (or the point on it), the road staying selected. */
  | { kind: 'end'; nodeId: string; at: Vec3 }
  | { kind: 'control'; span: number; which: 1 | 2; at: Vec3; anchor: Vec3 }
  | { kind: 'bend'; span: number; at: Vec3 }
  | { kind: 'width'; sign: -1 | 1; at: Vec3; edge: Vec3; widthM: number };
/** The object the handles belong to, with its current geometry. */
export type Target =
  | { kind: 'facilities' | 'zones'; id: string; boundary: Polygon; mode: 'rect' | 'free' }
  | { kind: 'roads'; id: string; path: ResolvedPath; widthM: number | null; curves: boolean; ends: readonly [string, string] };

/** Handles are offered for one selected building, zone or road the map lets the user change. */
export function handleTarget(map: YardMap, scene: SceneSnapshot, key: string, boundaryMode: 'rect' | 'free'): Target | null {
  const at = key.indexOf('/'), kind = key.slice(0, at), id = key.slice(at + 1);
  if (kind === 'facilities' || kind === 'zones') {
    const area = (kind === 'facilities' ? scene.facilities : scene.zones).find(entry => entry.id === id);
    if (!area || !canEditBoundary(map, kind, id)) return null;
    // Rectangle handles only while the outline still is a rectangle; anything else is edited vertex by vertex.
    return { kind, id, boundary: area.boundary, mode: boundaryMode === 'rect' && rectangleFrame(area.boundary) ? 'rect' : 'free' };
  }
  if (kind === 'roads') {
    const road = scene.roads.find(entry => entry.id === id); if (!road) return null;
    const { fromNodeId, toNodeId } = map.roads[id]!;
    return { kind, id, path: road.path, widthM: road.widthM.state === 'known' ? road.widthM.value : null, curves: map.schemaVersion === '0.3.0', ends: [fromNodeId, toNodeId] };
  }
  return null;
}

/** Handles belong to one selected building, zone or road in the select tool, on an editable map (`blocked` false), in an unlocked layer. */
export function selectedTarget(map: YardMap, scene: SceneSnapshot, state: Pick<AppState, 'tool' | 'selection' | 'boundaryMode' | 'drawing'>, blocked: boolean): Target | null {
  const key = state.selection.length === 1 ? state.selection[0]! : null;
  if (state.tool !== 'select' || !key || blocked || state.drawing.lockedTypes.includes(key.slice(0, key.indexOf('/')) as never)) return null;
  return handleTarget(map, scene, key, state.boundaryMode);
}

const midpoint = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
/** Below this size on screen an object shows no handles: they would pile up and take every press around it. */
export const MIN_HANDLE_OBJECT_PX = 24;
/** A press within this distance (screen px) of a handle takes it. */
export const HANDLE_HIT_PX = 8;
/** An edge midpoint needs this much room (screen px) to the polygon's other edges to be offered: more than twice the hit
 *  radius, so a press midway between two edges (the middle of a thin shape) is out of reach of a midpoint on either, and a
 *  midpoint and a vertex never both reach one press. */
export const INSERT_CLEARANCE_PX = 2 * HANDLE_HIT_PX + 1;
function segmentDistance(point: Vec3, a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2)) : 0;
  return Math.hypot(point[0] - a[0] - t * dx, point[1] - a[1] - t * dy);
}
const clearances = new WeakMap<Polygon, number[][]>();
/** For each edge of each ring, the distance (m) from its midpoint to the nearest other edge of any ring. Computed once per
 *  outline (handles are drawn every frame). */
function midpointClearance(boundary: Polygon): number[][] {
  let result = clearances.get(boundary);
  if (!result) {
    const rings = [boundary.outer, ...boundary.holes];
    const edges = rings.flatMap((ring, index) => ring.slice(0, -1).map((a, edge) => ({ ring: index, edge, a, b: ring[edge + 1]! })));
    result = rings.map((ring, index) => ring.slice(0, -1).map((a, edge) => {
      const middle = midpoint(a, ring[edge + 1]!);
      let nearest = Infinity;
      for (const other of edges) if (other.ring !== index || other.edge !== edge) nearest = Math.min(nearest, segmentDistance(middle, other.a, other.b));
      return nearest;
    }));
    clearances.set(boundary, result);
  }
  return result;
}
function screenExtent(points: readonly Vec3[], camera: Camera): number {
  const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * camera.scale;
}
/** Every handle of the target in world metres. */
export function handlesOf(target: Target, camera: Camera): Handle[] {
  const extentPoints = target.kind === 'roads'
    ? [...target.path.anchors, ...target.path.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : [])]
    : target.boundary.outer;
  if (screenExtent(extentPoints, camera) < MIN_HANDLE_OBJECT_PX) return [];
  if (target.kind === 'roads') {
    const { path } = target, out: Handle[] = [];
    out.push({ kind: 'end', nodeId: target.ends[0], at: path.anchors[0]! }, { kind: 'end', nodeId: target.ends[1], at: path.anchors.at(-1)! });
    path.anchors.slice(1, -1).forEach((at, index) => out.push({ kind: 'anchor', index: index + 1, at }));
    path.spans.forEach((span, index) => {
      if (span.kind === 'cubic' && target.curves) {
        out.push({ kind: 'control', span: index, which: 1, at: span.control1, anchor: path.anchors[index]! }, { kind: 'control', span: index, which: 2, at: span.control2, anchor: path.anchors[index + 1]! });
      }
      if (target.curves) out.push({ kind: 'bend', span: index, at: pointAt(path, index, 0.5) });
    });
    if (target.widthM !== null) {
      const pose = poseAtDistance(path, 'forward', pathLength(path).lengthM / 2), tangent: Vec3 = [Math.cos(pose.yawRad), Math.sin(pose.yawRad), 0];
      for (const sign of [-1, 1] as const) {
        const handle = roadWidthHandle(pose.position, tangent, target.widthM, sign, camera);
        out.push({ kind: 'width', sign, at: handle.position, edge: [pose.position[0] + handle.normal[0] * target.widthM / 2 * sign, pose.position[1] + handle.normal[1] * target.widthM / 2 * sign, 0], widthM: target.widthM });
      }
    }
    return out;
  }
  const rings = [target.boundary.outer, ...target.boundary.holes], clearance = midpointClearance(target.boundary);
  // An edge midpoint closer than 17 px to another edge is not offered: in a thin shape a press in the middle must still move it,
  // and on a short edge the midpoint would crowd the corners.
  const inserts = rings.flatMap((ring, index) => ring.slice(0, -1).flatMap((at, edge) => clearance[index]![edge]! * camera.scale >= INSERT_CLEARANCE_PX
    ? [{ kind: 'insert' as const, ring: index, edge, at: midpoint(at, ring[edge + 1]!) }] : []));
  // A rectangle keeps its corner handles, and offers the edge midpoints too: inserting a vertex there makes it a free
  // polygon (otherwise a rectangular building could take no new vertex without first switching modes in the inspector).
  // A drag preview may already have made it a polygon (an inserted vertex): then it shows as one.
  const frame = target.mode === 'rect' ? rectangleFrame(target.boundary) : null;
  if (frame) return [...frame.corners.map((at, corner) => ({ kind: 'corner' as const, corner: corner as RectangleCorner, at })), ...inserts];
  return [...rings.flatMap((ring, index) => ring.slice(0, -1).map((at, vertex) => ({ kind: 'vertex' as const, ring: index, index: vertex, at }))), ...inserts];
}
/** The handle under a screen point (8 px), preferring real vertices over insert points. */
export function handleAt(handles: readonly Handle[], screen: Vec2, camera: Camera): Handle | null {
  let best: Handle | null = null, distance = HANDLE_HIT_PX;
  for (const handle of handles) {
    const [x, y] = worldToScreen(handle.at, camera), delta = Math.hypot(x - screen[0], y - screen[1]) + (handle.kind === 'insert' ? 1 : 0);
    if (delta <= distance) { best = handle; distance = delta; }
  }
  return best;
}

/** Where a dragged handle goes: it keeps the offset at which it was grabbed, so a press beside it does not make it jump.
 *  Points of the outline or centreline (not tangents, bends or widths) land on the grid when it is on; Alt ignores it. */
export function handlePoint(handle: Handle, pressWorld: Vec3, world: Vec3, grid: number): Vec3 {
  const point: Vec3 = [world[0] + handle.at[0] - pressWorld[0], world[1] + handle.at[1] - pressWorld[1], handle.at[2]];
  return handle.kind === 'corner' || handle.kind === 'vertex' || handle.kind === 'insert' || handle.kind === 'anchor' ? snapToGrid(point, grid) : point;
}

/** The dragged result: the new outline, road path or width, and a readout. */
export type Edit = { boundary: Polygon; label: string } | { path: ResolvedPath; label: string } | { widthM: number; label: string };
export function dragHandle(target: Target, handle: Handle, world: Vec3, camera: Camera): Edit {
  if (target.kind === 'roads') {
    const path = structuredClone(target.path);
    if (handle.kind === 'anchor') return { path: movePathAnchor(target.path, handle.index, world), label: '移动折点' };
    if (handle.kind === 'bend') return { path: bendPathSpan(target.path, handle.span, world), label: '弯曲' };
    if (handle.kind === 'control') {
      const span = path.spans[handle.span]!;
      if (span.kind === 'cubic') { if (handle.which === 1) span.control1 = [...world]; else span.control2 = [...world]; }
      return { path, label: '调整切向' };
    }
    if (handle.kind === 'width') {
      const pose = poseAtDistance(target.path, 'forward', pathLength(target.path).lengthM / 2), tangent: Vec3 = [Math.cos(pose.yawRad), Math.sin(pose.yawRad), 0];
      const widthM = widthFromRoadHandle(roadWidthHandle(pose.position, tangent, target.widthM!, handle.sign, camera), world);
      return { widthM, label: `人工影像估计宽度 ${widthM.toFixed(2)} m` };
    }
  } else {
    if (handle.kind === 'corner') {
      const resized = resizeRectangleCorner(rectangleFrame(target.boundary)!, handle.corner, world);
      return { boundary: resized.boundary, label: `${resized.widthM.toFixed(2)} × ${resized.heightM.toFixed(2)} m${resized.clamped ? '（已到最小尺寸）' : ''}` };
    }
    if (handle.kind === 'vertex') return { boundary: movePolygonVertex(target.boundary, handle.ring, handle.index, world), label: '移动顶点' };
    if (handle.kind === 'insert') return { boundary: movePolygonVertex(insertPolygonVertex(target.boundary, handle.ring, handle.edge), handle.ring, handle.edge + 1, world), label: target.mode === 'rect' ? '插入顶点（矩形改为自由多边形）' : '插入顶点' };
  }
  throw new RangeError('handle does not belong to this object');
}
/** A click on an edge midpoint inserts a vertex there without moving anything. The outline stays the same, so the checks a
 *  moved edge can fail (road-band overlap, an entrance left off the outline) do not arise; the kernel still refuses it when the
 *  object already has a problem it re-checks on every outline change (a service point outside its owner, say), and says so. */
export function insertVertex(target: Extract<Target, { kind: 'facilities' | 'zones' }>, handle: Extract<Handle, { kind: 'insert' }>): Polygon {
  return insertPolygonVertex(target.boundary, handle.ring, handle.edge);
}
/** Alt+click on a vertex removes it; double-click on a bend handle straightens that span. */
export function removeVertex(target: Extract<Target, { kind: 'facilities' | 'zones' }>, handle: Extract<Handle, { kind: 'vertex' }>): Polygon {
  return removePolygonVertex(target.boundary, handle.ring, handle.index);
}
export function straighten(target: Extract<Target, { kind: 'roads' }>, span: number): ResolvedPath {
  const path = structuredClone(target.path); path.spans[span] = { kind: 'line' }; return path;
}

/** The command committing an edit, or null when nothing changed. */
export function editCommand(map: YardMap, target: Target, edit: Edit): { command: MapCommand; label: string } | null {
  if (target.kind === 'roads') {
    if ('widthM' in edit) {
      if (target.widthM !== null && Math.abs(edit.widthM - target.widthM) < 1e-6) return null;
      return { label: '修改道路宽度', command: { type: 'updateRoadBatch', ids: [target.id], patch: { widthM: { state: 'known', value: Math.round(edit.widthM * 1000) / 1000 } },
        designAssumption: { id: uid('source'), origin: 'manual_image_estimate', description: '人工影像估计：对照底图拖动宽度侧柄。' } } };
    }
    if (!('path' in edit) || sameValue(edit.path, target.path)) return null;
    const patch = map.schemaVersion === '0.3.0' ? { geometry: pathToRoadGeometry(edit.path) } : { shapePoints: edit.path.anchors.slice(1, -1) };
    return { label: '修改道路形状', command: { type: 'updateRoad', id: target.id, patch } };
  }
  // By value: the kernel's rectangle helpers build { outer, holes } while the scene has { holes, outer }.
  if (!('boundary' in edit) || sameValue(edit.boundary, target.boundary)) return null;
  const label = target.kind === 'facilities' ? '修改建筑轮廓' : '修改区域轮廓';
  if (target.kind === 'zones') return { label, command: { type: 'updateZone', id: target.id, patch: { boundary: edit.boundary } } };
  // The building's entrances on its outline go with it, in the same transaction.
  const adjustments = entranceAdjustments(map, target.id, edit.boundary);
  return { label, command: { type: 'updateFacility', id: target.id, patch: { boundary: edit.boundary }, ...adjustments.length ? { entranceAdjustments: adjustments } : {} } };
}
