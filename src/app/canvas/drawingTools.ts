import type { SceneSnapshot } from '../../adapters/contracts';
import { getQuickTraceCrossings } from '../../domain/drawingDefaults';
import { newNode } from '../../domain/factory';
import type { Vec3, YardMap } from '../../domain/model';
import type { DrawingConfig } from '../../editor/projectController';
import { appendDraftCurve, appendDraftLine, draftRoadGeometry, previewDraftPath, type DraftRoad } from '../../editor/roadDrawing';
import { worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { pathLength } from '../../geometry/roadPath';
import { apply } from '../state/edit';
import { draftStore, type Draft } from '../state/draft';
import { notify, select, store, type ShapeKind, type Tool } from '../state/store';
import { entranceAt, entranceCommand, entranceSpot, nextEntranceName, nodeAt, roadsAt, SAME_PLACE_PX } from './entrances';
import { constrainAxis, formatReadout, roadCommand, segmentReadout, selfIntersects, shapeBoundary, shapeCommand, SHAPE_CLICKS, snapTarget, snapToGrid, SNAP_PX, type SnapTarget } from './drafting';
import { uid } from './movePreview';
import type { DraftVisual } from './renderer';

export interface DrawingContext { map: YardMap; scene: SceneSnapshot; camera: Camera; drawing: DrawingConfig; tool: Tool; token: number; shapes: Record<'building' | 'zone', ShapeKind>; entranceFor: string | null }
export interface PointerInput { screen: Vec2; world: Vec3; alt: boolean; shift: boolean }

const lastPoint = (draft: Draft | null): Vec3 | undefined => !draft ? undefined : draft.kind === 'road' ? draft.road.curveEnd?.point ?? draft.road.points.at(-1) : draft.points.at(-1);
const isRoadTool = (tool: Tool) => tool === 'road' || tool === 'curve';
const target = (tool: Tool): 'building' | 'zone' => tool === 'building' ? 'building' : 'zone';

/** Where a click lands: a connection target for roads (node, or a road interior point to split at), a node's coordinates for
 *  areas and measurements; otherwise the grid, and Shift keeps the segment horizontal or vertical. Alt turns all snapping off. */
export function resolvePoint(context: DrawingContext, input: PointerInput): { point: Vec3; snap: SnapTarget | null } {
  const { scene, camera, drawing, tool } = context, draft = draftStore.get();
  const usable = (kind: 'nodes' | 'roads') => !drawing.hiddenTypes.includes(kind) && !drawing.lockedTypes.includes(kind);
  const excludeNodeId = draft?.kind === 'road' && draft.road.points.length === 1 && draft.road.startConnection?.kind === 'node' ? draft.road.startConnection.nodeId : undefined;
  const curveThrough = draft?.kind === 'road' && tool === 'curve' && !!draft.road.curveEnd;
  const snap = input.alt || !drawing.snapNodes || curveThrough ? null
    : snapTarget(scene, input.screen, camera, { z: 0, nodes: usable('nodes'), roads: isRoadTool(tool) && usable('roads'), excludeNodeId });
  if (snap) return { point: [...snap.position], snap: isRoadTool(tool) ? snap : null };
  let point = snapToGrid(input.world, input.alt ? 0 : drawing.snapGrid);
  const last = lastPoint(draft);
  if (input.shift && last) point = constrainAxis(last, point);
  return { point, snap: null };
}

function commitRoad(context: DrawingContext, road: DraftRoad): void {
  if (road.points.length < 2 || road.curveEnd) { notify(road.curveEnd ? '再点一下曲线经过的位置；草稿还没有提交。' : '道路至少需要两个不同的点。'); return; }
  const before = new Set(Object.keys(context.map.roads));
  // Joining one road twice (start in its middle and cross it again) or closing a loop is refused by the kernel; say how to draw it anyway.
  if (!apply(roadCommand(road, context.drawing), '绘制道路', undefined, '如需不接路，可按住 Alt 画，或在选项里关闭「与已有道路交叉处连通」。')) return;
  draftStore.set(null);
  const created = Object.keys(store.get().session!.map.roads).filter(id => !before.has(id));
  select(created.slice(-1).map(id => 'roads/' + id));
}
function commitShape(context: DrawingContext, draft: Extract<Draft, { kind: 'shape' }>): void {
  const boundary = shapeBoundary(draft.shape, draft.points);
  if (!boundary) {
    notify(draft.shape === 'polygon' && selfIntersects(draft.points) ? '轮廓自相交，最后一点已撤回；请换个位置继续。' : '形状太小或点在一条直线上，最后一点已撤回。', 'error');
    draftStore.set({ ...draft, points: draft.points.slice(0, -1) }); return;
  }
  if (!apply(shapeCommand(context.map, draft.target, boundary, context.drawing), draft.target === 'building' ? '绘制建筑' : '绘制区域')) return;
  draftStore.set(null);
  select([]);
}

/** The building the entrance tool is limited to (started from its inspector), while it still exists. */
const entranceOnly = (context: DrawingContext) => context.entranceFor && Object.hasOwn(context.map.facilities, context.entranceFor) ? context.entranceFor : null;
/** Each click on a building's outer outline adds one entrance there (one undo step); the tool stays for the next. */
function placeEntrance(context: DrawingContext, input: PointerInput): void {
  const hidden = (['facilities', 'accessPoints'] as const).find(kind => context.drawing.hiddenTypes.includes(kind));
  if (hidden) { notify(`${hidden === 'facilities' ? '建筑' : '入口'}图层已隐藏，显示后才能放入口。`, 'error'); return; }
  // The building it was limited to is gone (its creation undone, say): say so rather than quietly placing on any building.
  if (context.entranceFor && !entranceOnly(context)) {
    store.set({ entranceFor: null });
    notify('限定的建筑已不在地图中，入口工具改为可在任意建筑上添加；请重新点选。', 'error');
    return;
  }
  const { map } = context, only = entranceOnly(context), spot = entranceSpot(map, input.world, context.camera, only);
  if (!spot) {
    notify(only ? `请靠近「${map.facilities[only]!.name}」的外边界点选（出现绿色圆点时）。` : '请靠近建筑外边界点选（出现绿色圆点时）；建筑内部和孔洞边界不能放入口。', 'error');
    return;
  }
  const tolerance = SAME_PLACE_PX / context.camera.scale, existing = entranceAt(map, spot.facilityId, spot.point, tolerance);
  if (existing) { notify(`此处已有本建筑的入口「${map.accessPoints[existing]!.name}」。`, 'error'); return; }
  const here = nodeAt(map, spot.facilityId, spot.point, tolerance);
  if (here?.refused) { notify(here.refused.message, 'error'); return; }
  const node = here?.id ?? null;
  const { command, name } = entranceCommand(map, spot.facilityId, node ? map.nodes[node]!.position : spot.point, { point: uid('access'), node: uid('node'), existingNode: node });
  if (!apply(command, '添加入口')) return;
  const facility = map.facilities[spot.facilityId]!.name, roads = node ? roadsAt(map, node) : 0;
  notify(node ? `已添加${name}（${facility}），用的是此处已有的节点「${map.nodes[node]!.name}」${roads ? `，与其 ${roads} 条道路相连` : '（该节点没有接路，从它画路即可接入路网）'}。继续点选可再加，Esc 或 Enter 结束。`
    : `已添加${name}（${facility}）。继续点选外边界可再加，Esc 或 Enter 结束；从入口节点画路即可接入路网。`);
}
/** The building under the pointer with its outline dashed, and a green ring where the entrance would go. */
function entrancePreview(context: DrawingContext, input: PointerInput | null): DraftVisual | null {
  if (context.drawing.hiddenTypes.includes('facilities') || context.drawing.hiddenTypes.includes('accessPoints')) return null;
  const { map } = context, only = entranceOnly(context), spot = input ? entranceSpot(map, input.world, context.camera, only) : null;
  const facilityId = spot?.facilityId ?? only; if (!facilityId) return null;
  const facility = map.facilities[facilityId]!;
  const visual: DraftVisual = { vertices: [], area: { polygon: null, outline: facility.boundary.outer } };
  if (spot) {
    const here = nodeAt(map, facilityId, spot.point, SAME_PLACE_PX / context.camera.scale), node = here?.id, at = node ? map.nodes[node]!.position : spot.point;
    // Where a click would be refused there is no green ring, only the reason.
    if (here?.refused) { visual.label = { at, lines: [here.refused.label, facility.name] }; return visual; }
    visual.snap = { position: at, kind: 'node' };
    visual.label = { at, lines: [nextEntranceName(map, facilityId) + (node ? `（用已有节点「${map.nodes[node]!.name}」）` : spot.corner ? '（角点）' : ''), facility.name] };
  }
  return visual;
}

/** One click of the active drawing tool. */
export function click(context: DrawingContext, input: PointerInput): void {
  if (context.tool === 'entrance') { placeEntrance(context, input); return; }
  const { tool, token } = context, draft = draftStore.get(), { point, snap } = resolvePoint(context, input);
  if (tool === 'node') {
    apply({ type: 'addNode', id: uid('node'), node: newNode(point, `节点 ${Object.keys(context.map.nodes).length + 1}`) }, '添加节点');
    return;
  }
  if (tool === 'measure') {
    const points = draft?.kind === 'measure' && !draft.finished ? draft.points : [];
    draftStore.set({ kind: 'measure', points: [...points, point], finished: false });
    return;
  }
  if (isRoadTool(tool)) {
    if (draft?.kind !== 'road') {
      draftStore.set({ kind: 'road', token, road: {
        points: [point], spans: [], continuity: 'corner', standaloneCurve: tool === 'curve', disconnect: input.alt,
        ...snap ? { startConnection: snap.connection } : {}, ...snap?.connection.kind === 'node' ? { fromNodeId: snap.connection.nodeId } : {},
      } });
      return;
    }
    const road: DraftRoad = { ...draft.road, disconnect: input.alt || !!draft.road.disconnect };
    if (tool === 'curve') {
      // A curve takes its end, then a point it passes through; a lone curve or one ending on a target commits at once.
      if (!road.curveEnd) { draftStore.set({ ...draft, road: { ...road, curveEnd: { point, ...snap ? { connection: snap.connection } : {} } } }); return; }
      const next: DraftRoad = { ...appendDraftCurve(road, road.curveEnd.point, point), ...road.curveEnd.connection ? { endConnection: road.curveEnd.connection } : {} };
      if (next.points.length === road.points.length) { notify('曲线的终点与起点重合，请换一个终点。', 'error'); return; }
      if (road.standaloneCurve || next.endConnection) commitRoad(context, next); else draftStore.set({ ...draft, road: next });
      return;
    }
    const next: DraftRoad = { ...appendDraftLine(road, point), ...snap ? { endConnection: snap.connection } : {} };
    if (next.points.length === road.points.length) return;
    // Reaching a node or road ends the road there.
    if (snap) commitRoad(context, next); else draftStore.set({ ...draft, road: next });
    return;
  }
  if (tool === 'building' || tool === 'zone') {
    const shape = context.shapes[target(tool)];
    const current: Extract<Draft, { kind: 'shape' }> = draft?.kind === 'shape' && draft.target === target(tool) && draft.shape === shape ? draft : { kind: 'shape', target: target(tool), shape, points: [], token };
    // Clicking the first vertex again closes a polygon.
    const first = current.points[0];
    if (shape === 'polygon' && current.points.length >= 3 && first) {
      const [x, y] = worldToScreen(first, context.camera);
      if (Math.hypot(x - input.screen[0], y - input.screen[1]) <= SNAP_PX) { commitShape(context, current); return; }
    }
    const last = current.points.at(-1);
    if (last && Math.hypot(last[0] - point[0], last[1] - point[1]) < 1e-6) return;
    const next = { ...current, points: [...current.points, point] };
    if (next.points.length >= SHAPE_CLICKS[shape]) commitShape(context, next); else draftStore.set(next);
  }
}
/** A two-point rectangle can be dragged out in one press: the press is its first corner, the release its second. */
export const dragsRectangle = (context: DrawingContext) => (context.tool === 'building' || context.tool === 'zone') && context.shapes[target(context.tool)] === 'rect2' && !draftStore.get();
/** Enter or double-click. */
export function finish(context: DrawingContext): void {
  const draft = draftStore.get(); if (!draft) return;
  if (draft.kind === 'road') commitRoad(context, draft.road);
  else if (draft.kind === 'shape') {
    if (draft.shape !== 'polygon') notify(draft.shape === 'rect2' ? '再点一下对角即可完成矩形。' : '三点斜矩形需要依次点基边两端和宽度。');
    else if (draft.points.length >= 3) commitShape(context, draft); else notify('多边形至少需要三个点。');
  }
  else draftStore.set({ ...draft, finished: true });
}
/** Backspace takes back the last point of the draft. */
export function removeLast(): void {
  const draft = draftStore.get(); if (!draft) return;
  if (draft.kind === 'road') {
    const road: DraftRoad = { ...draft.road };
    if (road.curveEnd) { delete road.curveEnd; draftStore.set({ ...draft, road }); return; }
    if (road.points.length <= 1) { draftStore.set(null); return; }
    delete road.endConnection;
    draftStore.set({ ...draft, road: { ...road, points: road.points.slice(0, -1), spans: road.spans.slice(0, -1) } });
    return;
  }
  if (draft.points.length <= 1) { draftStore.set(null); return; }
  draftStore.set({ ...draft, points: draft.points.slice(0, -1) } as Draft);
}

let crossings: { at: number; key: string; points: Vec3[] } = { at: 0, key: '', points: [] };
/** The preview for the pointer at `input`: nothing is committed. */
export function preview(context: DrawingContext, input: PointerInput | null): DraftVisual | null {
  if (context.tool === 'entrance') return entrancePreview(context, input);
  const draft = draftStore.get(), { tool, drawing } = context;
  const resolved = input ? resolvePoint(context, input) : null, cursor = resolved?.point ?? null;
  const visual: DraftVisual = { vertices: [], snap: resolved?.snap ? { position: resolved.snap.position, kind: resolved.snap.connection.kind === 'node' ? 'node' : 'road' } : null };
  if (draft?.kind === 'road') {
    const path = previewDraftPath(draft.road, tool === 'curve' ? 'curve' : 'road', cursor);
    visual.road = { path, widthM: drawing.roadWidthM };
    visual.vertices = draft.road.curveEnd ? [...draft.road.points, draft.road.curveEnd.point] : draft.road.points;
    const last = lastPoint(draft), total = path.anchors.length > 1 ? pathLength(path).lengthM : 0;
    if (cursor && last) visual.label = { at: cursor, lines: [formatReadout(last, cursor), `全长 ${total.toFixed(2)} m`] };
    if (drawing.connectNewCrossings && path.anchors.length > 1 && !draft.road.disconnect) {
      // Crossing search walks every road: refresh at most every 120 ms.
      const key = JSON.stringify(path.anchors.at(-1)), now = performance.now();
      if (now - crossings.at > 120 && key !== crossings.key) {
        try { crossings = { at: now, key, points: getQuickTraceCrossings(context.map, path.anchors, draftRoadGeometry({ points: path.anchors, spans: path.spans })).map(crossing => crossing.point) }; }
        catch { crossings = { at: now, key, points: [] }; }
      }
      visual.crossings = crossings.points;
    }
  } else if (draft?.kind === 'shape') {
    const points = cursor ? [...draft.points, cursor] : draft.points;
    visual.area = { polygon: shapeBoundary(draft.shape, points), outline: points };
    visual.vertices = draft.points;
    const last = draft.points.at(-1);
    if (cursor && last) {
      const lines = draft.shape === 'rect2' ? [`${Math.abs(cursor[0] - last[0]).toFixed(2)} × ${Math.abs(cursor[1] - last[1]).toFixed(2)} m`] : [formatReadout(last, cursor)];
      if (draft.shape === 'rect3' && draft.points.length === 2) lines.push(`宽 ${Math.abs(signedWidth(draft.points[0]!, draft.points[1]!, cursor)).toFixed(2)} m`);
      visual.label = { at: cursor, lines };
    }
  } else if (draft?.kind === 'measure') {
    const points = cursor && !draft.finished ? [...draft.points, cursor] : draft.points;
    visual.line = points; visual.vertices = draft.points;
    const total = points.slice(1).reduce((sum, point, index) => sum + segmentReadout(points[index]!, point).lengthM, 0);
    const at = cursor ?? draft.points.at(-1);
    if (at && points.length > 1) visual.label = { at, lines: [...cursor && !draft.finished && draft.points.length ? [`本段 ${formatReadout(draft.points.at(-1)!, cursor)}`] : [], `合计 ${total.toFixed(2)} m`] };
  }
  return visual.snap || visual.road || visual.area || visual.line || visual.vertices.length ? visual : null;
}
function signedWidth(a: Vec3, b: Vec3, side: Vec3): number {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]); if (!length) return 0;
  return ((side[0] - a[0]) * -(b[1] - a[1]) + (side[1] - a[1]) * (b[0] - a[0])) / length;
}
