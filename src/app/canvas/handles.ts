import type { SceneSnapshot } from '../../adapters/contracts';
import { applyMapCommand, canEditBoundary, commandSupport, type MapCommand } from '../../domain/commands';
import { nodeOwners } from '../../domain/ownerEditing';
import type { Polygon, Vec3, YardMap } from '../../domain/model';
import { sameValue } from '../../domain/value';
import { worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { bendPathSpan } from '../../geometry/curveEditing';
import { insertPolygonVertex, movePolygonVertex, rectangleFrame, removePolygonVertex, resizeRectangleCorner, type RectangleCorner } from '../../geometry/rectangles';
import { movePathAnchor, pathLength, pathToRoadGeometry, pointAt, poseAtDistance, projectToPath, splitPath, type ResolvedPath } from '../../geometry/roadPath';
import type { AppState } from '../state/store';
import { snapToGrid } from './drafting';
import { translateCommand, uid } from './movePreview';
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
/** A double click on the selected road's line inserts a bend there: the span splits at the nearest point of the centreline,
 *  a curve into two curves along the same shape, so the road keeps its shape. Null when the point is farther than `reachM`
 *  from the line, or at a bend or end already there. */
export function insertAnchor(target: Extract<Target, { kind: 'roads' }>, at: Vec3, reachM: number): ResolvedPath | null {
  const projection = projectToPath(target.path, at);
  if (!(projection.offsetM <= reachM) || projection.t <= 1e-6 || projection.t >= 1 - 1e-6) return null;
  const [before, after] = splitPath(target.path, projection.spanIndex, projection.t);
  const path: ResolvedPath = { anchors: [...before.anchors, ...after.anchors.slice(1)], spans: [...before.spans, ...after.spans] };
  // A road on one level keeps it exactly: the split's arithmetic may leave the new points a rounding off it, which the kernel
  // refuses as a change of height.
  const z = target.path.anchors[0]![2], points = (p: ResolvedPath) => [...p.anchors, ...p.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : [])];
  if (points(target.path).every(point => point[2] === z)) for (const point of points(path)) point[2] = z;
  return path;
}
/** Why the bend would stop a building or zone moving that could before, or null. An entrance's connector (the one road out of
 *  a building's own entrance node) must stay straight to stretch when its building moves; a bend in it pins the building. */
export function bendStopsMoving(map: YardMap, roadId: string, path: ResolvedPath, target: Extract<Target, { kind: 'roads' }>): string | null {
  const change = editCommand(map, target, { path, label: '' }); if (!change) return null;
  const road = map.roads[roadId]; if (!road) return null;
  const owners = new Set([road.fromNodeId, road.toNodeId].flatMap(node => [...nodeOwners(map, node).owners]));
  let after: YardMap | undefined;
  for (const owner of owners) {
    const kind = map.facilities[owner] ? 'facilities' as const : map.zones[owner] ? 'zones' as const : null; if (!kind) continue;
    const move = translateCommand({ nodes: [], roads: [], [kind]: [owner] }, [0.001, 0, 0]);
    if (!commandSupport(map, move).allowed) continue;
    if (!after) { const result = applyMapCommand(map, change.command); if (!result.ok) return null; after = result.map; }
    if (commandSupport(after, move).allowed) continue;
    const name = map[kind][owner]!.name;
    return `这条路是「${name}」入口的接入段。接入段要保持直线，「${name}」整体移动时它才能随着伸缩；插入折点后「${name}」将不能移动，所以没有插入。`;
  }
  return null;
}
/** Alt+click on a bend removes it: its two spans join into one, straight when both were. Otherwise one curve keeps the outer
 *  end tangents (a straight side counts as the curve with controls at its thirds). A curve split at parameter t has its two
 *  inner controls in line with the split point at distances t : 1 − t, so t is read from them; when splitting the joined
 *  curve there gives the two spans back, the bend came from one split and that curve is the original, at any t. Two curves
 *  not from one split join approximately (t bounded, see below); a side of zero length leaves the other span as it is. */
export function removeAnchor(target: Extract<Target, { kind: 'roads' }>, handle: Extract<Handle, { kind: 'anchor' }>): ResolvedPath {
  const path = structuredClone(target.path), index = handle.index, before = path.spans[index - 1]!, after = path.spans[index]!;
  const a = path.anchors[index - 1]!, m = path.anchors[index]!, b = path.anchors[index + 1]!;
  let joined: ResolvedPath['spans'][number] = { kind: 'line' };
  if (before.kind === 'cubic' || after.kind === 'cubic') {
    const along = (from: Vec3, to: Vec3, f: number): Vec3 => [from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, from[2] + (to[2] - from[2]) * f];
    const first = before.kind === 'cubic' ? before.control1 : along(a, m, 1 / 3), last = after.kind === 'cubic' ? after.control2 : along(b, m, 1 / 3);
    const innerLeft = before.kind === 'cubic' ? before.control2 : along(m, a, 1 / 3), innerRight = after.kind === 'cubic' ? after.control1 : along(m, b, 1 / 3);
    const dl = Math.hypot(m[0] - innerLeft[0], m[1] - innerLeft[1]), dr = Math.hypot(innerRight[0] - m[0], innerRight[1] - m[1]);
    const left = pathLength({ anchors: [a, m], spans: [before] }).lengthM, right = pathLength({ anchors: [m, b], spans: [after] }).lengthM;
    const curve = (t: number): ResolvedPath['spans'][number] => ({ kind: 'cubic', control1: along(a, first, 1 / t), control2: along(b, last, 1 / (1 - t)) });
    const byControls = dl / (dl + dr);
    // A bend made by splitting one curve: splitting the joined curve at the parameter the inner controls give returns the two
    // spans, whatever the parameter; then that curve is the original.
    const exact = byControls > 0 && byControls < 1 && (() => {
      const [l, r] = splitPath({ anchors: [a, b], spans: [curve(byControls)] }, 0, byControls);
      const points = (span: ResolvedPath['spans'][number], from: Vec3, to: Vec3) => span.kind === 'cubic' ? [span.control1, span.control2] : [along(from, to, 1 / 3), along(from, to, 2 / 3)];
      const got = [...points(l.spans[0]!, a, m), l.anchors[1]!, ...points(r.spans[0]!, m, b)], want = [...points(before, a, m), m, ...points(after, m, b)];
      const tolerance = 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]));
      return got.every((point, k) => Math.hypot(point[0] - want[k]![0], point[1] - want[k]![1]) <= tolerance);
    })();
    if (exact) joined = curve(byControls);
    // A side of zero length adds nothing: the other span, as it is.
    else if (!(left > 0)) joined = after;
    else if (!(right > 0)) joined = before;
    // ponytail: two curves not from one split join approximately: t from the inner controls when they give a sensible one (on the
    // Hanwha map's bends beside curves this strays less than the lengths' ratio), else from the lengths, kept within 0.1–0.9 so
    // the controls are never flung far out (t near 0 or 1 multiplies them tenfold and more).
    else joined = curve(Math.min(0.9, Math.max(0.1, byControls >= 0.1 && byControls <= 0.9 ? byControls : left / (left + right))));
  }
  path.anchors.splice(index, 1);
  path.spans.splice(index - 1, 2, joined);
  return path;
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
