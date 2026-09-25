import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SceneSnapshot } from '../../adapters/contracts';
import type { Vec3, YardMap } from '../../domain/model';
import { backgroundPoint, type BackgroundTransform } from '../../geometry/backgrounds';
import { fitCamera, screenToWorld, worldToScreen, zoomAt, type Camera, type Vec2 } from '../../geometry/coordinates';
import { cycleSelection, selectionCandidates, type SelectionCycle } from '../../geometry/selectionHits';
import { bridge, isEditableTarget, operation, runOperation } from '../ops/registry';
import type { Selection } from '../../domain/commands';
import { backgroundBounds, drawableBackgrounds } from '../state/backgrounds';
import { adjusted, adjustedLayer, measurePoint, setTransform, transformFields, type AdjustedLayer } from '../state/backgroundEdit';
import { DRAWING_TOOLS, draftStore, dropStaleDraft, setTool } from '../state/draft';
import { apply as applyEdit, editBlock, lockedMessage } from '../state/edit';
import { duplicate, selectionOf, translate } from '../state/editOps';
import { displayIndexOf, itemOf, notify, sceneOf, select, store, useApp } from '../state/store';
import { adjustFrame, adjustPartAt, dragTransform, pixelAt, type AdjustFrame, type AdjustPart } from './backgroundAdjust';
import { entranceSlide } from './entrances';
import { polygonTouchesBox, polylineTouchesBox, type Box } from './boxSelect';
import { click as drawClick, dragsRectangle, finish as drawFinish, preview as drawPreview, removeLast, type DrawingContext, type PointerInput } from './drawingTools';
import { dragHandle, editCommand, handleAt, handlePoint, handlesOf, insertVertex, removeVertex, selectedTarget, straighten, type Edit, type Handle, type Target } from './handles';
import { planMove, type MovePlan } from './movePreview';
import { entranceAdjustments, entranceOverlay } from './outlineEntrances';
import { endKey, pressTarget } from './pressTarget';
import { MapRenderer, type ScreenBox } from './renderer';

const SELECTABLE = new Set(['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints']);
/** Pressing one of these drags it at once; an unselected node or road is only selected first, so the network is not bent by accident. */
const DIRECT_DRAG = new Set(['nodes', 'facilities', 'zones', 'accessPoints', 'servicePoints']);
const DRAG_PX = 4;
const DOUBLE_CLICK_MS = 500;
const SETTLE_MS = 150;
const MIN_SCALE = 0.005, MAX_SCALE = 200;

/** World XY under the pointer, kept out of the main store so pointer moves re-render only the readout. */
let cursor: Vec3 | null = null;
const cursorListeners = new Set<() => void>();
function setCursor(next: Vec3 | null) { cursor = next; cursorListeners.forEach(listener => listener()); }
export function useCursor(): Vec3 | null {
  return useSyncExternalStore(listener => { cursorListeners.add(listener); return () => { cursorListeners.delete(listener); }; }, () => cursor);
}

type Gesture =
  | { kind: 'pan'; start: Vec2; camera: Camera; pointerId: number }
  | { kind: 'press'; start: Vec2; pointerId: number; shift: boolean; alt: boolean; drag?: string;
      /** Dragging `drag` leaves the selection as it is (a selected road's end node). */
      keep?: boolean }
  | { kind: 'box'; start: Vec2; end: Vec2; pointerId: number; shift: boolean }
  | { kind: 'move'; start: Vec3; pointerId: number; plan: MovePlan; selection: Selection; delta: Vec3;
      /** A lone entrance slides along its building's outline: the delta for a pointer position. */
      slide?: ((world: Vec3) => Vec3) | undefined }
  | { kind: 'draw'; start: Vec2; pointerId: number; alt: boolean; shift: boolean; dragged: boolean }
  | { kind: 'handle'; start: Vec2; pointerId: number; alt: boolean; target: Target; handle: Handle; edit: Edit | null;
      /** A point marker at the press, as close as the handle: a click (no drag) selects it. */
      marker: string | null;
      /** The press in world metres and the camera then: zooming mid-drag must not reinterpret the grab offset. */
      world: Vec3; camera: Camera }
  /** Dragging the background image being adjusted: `next` is where it is shown (null until the pointer moves). */
  | { kind: 'background'; start: Vec2; pointerId: number; layer: AdjustedLayer; part: AdjustPart; from: Vec3; next: BackgroundTransform | null };
const ZERO: Vec3 = [0, 0, 0];

const fixed = (value: number, digits: number) => String(Number(value.toFixed(digits)));
/** What a drag of this part shows beside the pointer. */
function adjustLabel(part: AdjustPart, layer: AdjustedLayer, t: BackgroundTransform): string[] {
  const fields = transformFields(t, layer.width, layer.height);
  if (part.kind === 'move') return [`左上角 X ${fixed(fields.x, 3)} · Y ${fixed(fields.y, 3)} m`];
  if (part.kind === 'corner') return [`宽 ${fixed(fields.width, 2)} × 高 ${fixed(fields.height, 2)} m`, `${fixed(fields.resolution, 4)} m/像素`];
  return [`角度 ${fixed(fields.angle, 2)}°`];
}
/** Resize cursors follow the corner's diagonal as it is shown. */
function adjustCursor(part: AdjustPart | null, frame: AdjustFrame): string | null {
  if (!part) return null;
  if (part.kind === 'move') return 'move';
  if (part.kind === 'rotate') return 'grab';
  const [x, y] = frame.corners[part.corner];
  return (x - frame.centre[0]) * (y - frame.centre[1]) > 0 ? 'nwse-resize' : 'nesw-resize';
}

/** Keys whose geometry shares a point with the world box. Containment uses bounds (exact for boxes); crossing tests the shapes. */
function keysInBox(scene: SceneSnapshot, visible: ReadonlySet<string>, box: Box, crossing: boolean, bandWidths: boolean): string[] {
  const roads = new Map(scene.roads.map(road => [road.id, road]));
  return displayIndexOf(scene).entries.filter(entry => SELECTABLE.has(entry.kind) && visible.has(entry.key) && entry.bounds).filter(entry => {
    const { min, max } = entry.bounds!;
    if (!crossing) return min[0] >= box.minX && max[0] <= box.maxX && min[1] >= box.minY && max[1] <= box.maxY;
    if (min[0] > box.maxX || max[0] < box.minX || min[1] > box.maxY || max[1] < box.minY) return false;
    const road = entry.kind === 'roads' ? roads.get(entry.id) : undefined;
    if (road) return polylineTouchesBox(road.points, box, bandWidths && road.widthM.state === 'known' ? road.widthM.value / 2 : 0);
    const item = itemOf(scene, entry.key); if (!item) return false;
    return item.polygons.some(polygon => polygonTouchesBox(polygon, box)) || item.lines.some(line => polylineTouchesBox(line, box))
      || item.points.some(point => polylineTouchesBox([point], box));
  }).map(entry => entry.key);
}

export function CanvasView() {
  const host = useRef<HTMLDivElement>(null);
  const stageHost = useRef<HTMLDivElement>(null);
  const renderer = useRef<MapRenderer | null>(null);
  const camera = useRef<Camera>({ offsetX: 0, offsetY: 0, scale: 1 });
  const gesture = useRef<Gesture | null>(null);
  const cycle = useRef<SelectionCycle | null>(null);
  const settle = useRef(0);
  const space = useRef(false);
  const [hover, setHover] = useState<string | null>(null);
  /** Over a handle a press reshapes instead of moving: the cursor says so. */
  const [overHandle, setOverHandle] = useState(false);
  const [panning, setPanning] = useState(false);
  const map = useApp(state => state.session?.map ?? null);
  const drawing = useApp(state => state.drawing);
  const selection = useApp(state => state.selection);
  const tool = useApp(state => state.tool), entranceFor = useApp(state => state.entranceFor);
  const frameRequest = useApp(state => state.frameRequest);
  const rasters = useApp(state => state.rasters);
  const backgroundView = useApp(state => state.backgroundView);
  const adjusting = useApp(state => state.adjusting);
  /** Over the adjusted image: the cursor for what a press there takes hold of. */
  const [overAdjust, setOverAdjust] = useState<string | null>(null);
  const scene = map ? sceneOf(map) : null;
  const token = useApp(state => state.session?.changeToken ?? 0), mapEpoch = useApp(state => state.mapEpoch);
  const drawingTool = DRAWING_TOOLS.includes(tool);
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  const lastInput = useRef<PointerInput | null>(null);
  /** The previous drawing click, to recognise the second click of a double-click. */
  const lastClick = useRef<{ at: number; screen: Vec2 } | null>(null);
  /** Everything a drawing tool needs, read fresh at each event. */
  function drawingContext(): DrawingContext | null {
    const state = store.get(), current = state.session?.map; if (!current) return null;
    return { map: current, scene: sceneOf(current), camera: camera.current, drawing: state.drawing, tool: state.tool, token: state.session!.changeToken, shapes: state.shapes, entranceFor: state.entranceFor };
  }
  function pointerInput(event: { clientX: number; clientY: number; altKey: boolean; shiftKey: boolean }): PointerInput {
    const at = point(event);
    return { screen: at, world: screenToWorld(at, camera.current), alt: event.altKey, shift: event.shiftKey };
  }
  function refreshDraft(input = lastInput.current) {
    const context = drawingContext();
    renderer.current?.setDraft(context && DRAWING_TOOLS.includes(context.tool) ? drawPreview(context, input) : null);
  }
  const moveFrame = useRef(0);
  const backgrounds = useMemo(() => map ? drawableBackgrounds(map, rasters, backgroundView, drawing.hiddenTypes) : [], [map, rasters, backgroundView, drawing.hiddenTypes]);
  const boundaryMode = useApp(state => state.boundaryMode);
  const target = useMemo(() => map && scene ? selectedTarget(map, scene, { tool, selection, boundaryMode, drawing }, !!editBlock()) : null,
    [map, scene, tool, selection, boundaryMode, drawing]);
  /** The handles being drawn: the selection's, or a drag preview's. */
  const shownHandles = useRef<Target | null>(null);
  function showHandles(next: Target | null) {
    shownHandles.current = next;
    renderer.current?.setHandles(next ? camera => handlesOf(next, camera) : null);
    countHandles();
  }
  // Like the camera, the number of handles drawn is readable from the element (tests, and whoever embeds the canvas).
  function countHandles() { if (host.current) host.current.dataset.handles = String(shownHandles.current ? handlesOf(shownHandles.current, camera.current).length : 0); }
  useEffect(() => { showHandles(target); }, [target]);

  /** The adjusted image's frame and handles (or, while measuring, the picked points), at `preview` during a drag. */
  function showAdjust(preview?: { transform: BackgroundTransform; part: AdjustPart }) {
    const current = renderer.current; if (!current) return;
    const state = store.get(), layer = adjusted(state);
    if (!layer) { current.setAdjust(null); return; }
    const t = preview?.transform ?? layer.transform, measure = state.adjusting?.measure ?? null;
    current.setAdjust(view => {
      let frame: AdjustFrame | null = null;
      try { frame = adjustFrame(t, layer.width, layer.height, view); } catch { /* an unusable transform shows no frame */ }
      const points = (measure ?? []).map(pixel => backgroundPoint(t, pixel)), onScreen = points.map(point => worldToScreen([point[0], point[1], 0], view));
      const label = preview && frame ? { at: frame.rotate, lines: adjustLabel(preview.part, layer, t) }
        : points.length === 2 ? { at: onScreen[1]!, lines: [`图上距离 ${fixed(Math.hypot(points[1]![0] - points[0]![0], points[1]![1] - points[0]![1]), 3)} m`] } : null;
      return { frame: measure ? null : frame, measure: onScreen, label };
    });
  }
  useEffect(() => { showAdjust(); }, [map, adjusting]);

  function apply(next: Camera, navigating: boolean) {
    if (!Object.values(next).every(Number.isFinite) || next.scale <= 0) return;
    camera.current = next;
    renderer.current?.setCamera(next, navigating);
    window.clearTimeout(settle.current);
    if (navigating) { settle.current = window.setTimeout(() => apply(camera.current, false), SETTLE_MS); return; }
    // The settled camera is readable from the DOM (tests, diagnostics) without re-rendering React.
    const element = host.current; if (element) Object.assign(element.dataset, { scale: String(next.scale), offsetX: String(next.offsetX), offsetY: String(next.offsetY) });
    countHandles();
    // The settled camera is also saved with the project's view (debounced there).
    if (store.get().scale !== next.scale) store.set({ scale: next.scale, camera: next }); else store.set({ camera: next });
  }
  /** The handle a press there takes, if any, and the point marker a click there means instead. Entrances and service points
   *  often sit on a building's corner or in the middle of an edge. A drag always works the selected object's handle (to move
   *  such an entrance, select it first: then the building shows no handles); a click (no drag) selects the marker when it is at
   *  least as close as the handle. An edge midpoint yields a click to a node on the same terms. */
  function handleFor(at: Vec2): { handle: Handle; marker: string | null } | null {
    if (!target || !scene) return null;
    const handle = handleAt(handlesOf(target, camera.current), at, camera.current); if (!handle) return null;
    const top = hits(at)[0]?.key; if (!top) return { handle, marker: null };
    const kind = top.slice(0, top.indexOf('/')), id = top.slice(top.indexOf('/') + 1);
    const position = kind === 'accessPoints' ? scene.accessPoints.find(point => point.id === id)?.position
      : kind === 'servicePoints' ? scene.servicePoints.find(point => point.id === id)?.position
        : kind === 'nodes' && handle.kind === 'insert' ? scene.nodes.find(node => node.id === id)?.position : undefined;
    if (!position) return { handle, marker: null };
    const distance = (point: Vec3) => { const [x, y] = worldToScreen(point, camera.current); return Math.hypot(x - at[0], y - at[1]); };
    return { handle, marker: distance(position) <= distance(handle.at) ? top : null };
  }
  /** What a press or click takes hold of (a road's end node within reach on a road, see `pressTarget`). */
  function pressed(at: Vec2): string | undefined {
    const map = store.get().session?.map;
    return map ? pressTarget(map, hits(at).map(hit => hit.key), at, camera.current) : undefined;
  }
  function point(event: { clientX: number; clientY: number }): Vec2 {
    const rect = host.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  function hits(at: Vec2) {
    const current = renderer.current; if (!scene || !current) return [];
    return selectionCandidates(scene, at, camera.current, { visibleKeys: current.visibleKeys, hiddenTypes: drawing.hiddenTypes,
      showRoadBands: drawing.showRoadBands, showRoadCenterlines: drawing.showRoadCenterlines });
  }
  /** Ends a gesture without committing anything: a pan keeps where it got to, a press or box selects nothing. */
  // Window listeners are registered once; they call the latest render's cancelGesture, which knows the current handles.
  const cancelLatest = useRef(() => {});
  useLayoutEffect(() => { cancelLatest.current = cancelGesture; });
  function cancelGesture() {
    const current = gesture.current; if (!current) return;
    gesture.current = null;
    renderer.current?.setBox(null);
    if (current.kind === 'move') { cancelAnimationFrame(moveFrame.current); moveFrame.current = 0; renderer.current?.setOverlay(null); }
    if (current.kind === 'handle') endHandlePreview();
    if (current.kind === 'background') { renderer.current?.setBackgroundPreview(null); showAdjust(); }
    if (current.kind === 'pan') apply(camera.current, false);
    if (host.current?.hasPointerCapture(current.pointerId)) host.current.releasePointerCapture(current.pointerId);
  }

  useLayoutEffect(() => {
    // The renderer owns this inner element; React never renders children into it.
    const element = stageHost.current!;
    const instance = new MapRenderer(element, element.clientWidth || 800, element.clientHeight || 600);
    renderer.current = instance;
    const observer = new ResizeObserver(() => instance.resize(element.clientWidth, element.clientHeight));
    observer.observe(element);
    bridge.draw = {
      finish: () => { const context = drawingContext(); if (context) drawFinish(context); },
      undoPoint: () => removeLast(), cancel: () => draftStore.set(null),
    };
    bridge.zoomBy = factor => {
      const { width, height } = instance.size;
      apply(zoomAt(camera.current, [width / 2, height / 2], Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.current.scale * factor))), false);
    };
    return () => { observer.disconnect(); window.clearTimeout(settle.current); instance.destroy(); renderer.current = null; bridge.zoomBy = () => {}; };
  }, []);

  // A draft belongs to the map revision it started on; the preview follows the draft and the tool.
  useEffect(() => { dropStaleDraft(token); }, [token]);
  // Another map: no draft, measurement or click history carries over (its change token starts again at 0).
  useEffect(() => { draftStore.set(null); lastClick.current = null; }, [mapEpoch]);
  useEffect(() => draftStore.subscribe(() => refreshDraft()), []);
  useEffect(() => { refreshDraft(); }, [tool, drawing, entranceFor]);
  // A double-click is two clicks of one tool with nothing in between.
  useEffect(() => { lastClick.current = null; }, [tool]);

  useEffect(() => {
    if (!scene) return;
    renderer.current?.setState({ scene, index: displayIndexOf(scene), drawing, selection: selectionSet, hover, backgrounds, comparison: backgroundView.comparison });
    // A dropped image is drawn from its preview until here, where the committed transform arrives: no frame shows it back at its old place.
    if (gesture.current?.kind !== 'background') renderer.current?.setBackgroundPreview(null);
  }, [scene, drawing, selectionSet, hover, backgrounds, backgroundView.comparison]);

  useEffect(() => {
    const current = renderer.current; if (!frameRequest || !scene || !current) return;
    const { width, height } = current.size, scale = camera.current.scale;
    const centre = (x: number, y: number, at: number) => apply({ scale: at, offsetX: width / 2 - x * at, offsetY: height / 2 + y * at }, false);
    // A restored project shows exactly the view it was saved with.
    if ('camera' in frameRequest) { apply(frameRequest.camera, false); return; }
    if ('point' in frameRequest) { centre(frameRequest.point[0], frameRequest.point[1], scale); return; }
    if ('bounds' in frameRequest) { const fitted = fitCamera(frameRequest.bounds, width, height); if (fitted) apply(fitted, false); return; }
    const wanted = new Set(frameRequest.keys), entries = displayIndexOf(scene).entries.filter(entry => wanted.has(entry.key) && entry.bounds);
    // A map traced from nothing yet has only its background to show.
    const bounds = !frameRequest.keys.length ? scene.bounds ?? (map ? backgroundBounds(map) : null) : entries.length ? {
      min: [Math.min(...entries.map(e => e.bounds!.min[0])), Math.min(...entries.map(e => e.bounds!.min[1])), 0] as Vec3,
      max: [Math.max(...entries.map(e => e.bounds!.max[0])), Math.max(...entries.map(e => e.bounds!.max[1])), 0] as Vec3 } : null;
    // An empty new map: the origin in the middle, 100 m about 400 px across, where drawing starts.
    if (!bounds) { if (!frameRequest.keys.length) centre(0, 0, 4); return; }
    if (!frameRequest.keys.length) { const fitted = fitCamera(bounds, width, height); if (fitted) apply(fitted, false); return; }
    // Locating keeps the user's zoom and only zooms out when the objects would not fit.
    const needed = Math.min((width - 100) / (bounds.max[0] - bounds.min[0]), (height - 100) / (bounds.max[1] - bounds.min[1]));
    centre((bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, Math.min(scale, needed > 0 ? needed : Infinity));
  }, [frameRequest]);

  useEffect(() => {
    // Capture phase: Escape during a gesture cancels it and never reaches the workspace shortcut that clears the selection.
    const down = (event: KeyboardEvent) => {
      lastClick.current = null;
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); cancelLatest.current(); return; }
      // Drawing keys: Enter finishes, Backspace takes back a point, Escape drops the draft and then leaves the tool.
      if (DRAWING_TOOLS.includes(store.get().tool) && !isEditableTarget(event.target) && !store.get().overlay) {
        const context = drawingContext(), draft = draftStore.get();
        const handled = event.key === 'Enter' && store.get().tool === 'entrance' ? (setTool('select'), true)
          : event.key === 'Enter' && draft ? (context && drawFinish(context), true)
          // Delete also takes back a point while drawing: it must not open the delete dialog for the road just drawn.
          : (event.key === 'Backspace' || event.key === 'Delete') && draft ? (removeLast(), true)
          : event.key === 'Escape' ? (draft ? draftStore.set(null) : setTool('select'), true) : false;
        if (handled) { event.preventDefault(); event.stopPropagation(); return; }
      }
      // While a drag runs, shortcuts (undo, nudge, delete, …) wait: they would change the map under the preview.
      if (gesture.current && gesture.current.kind !== 'press' && !['Shift', 'Alt', 'Control', 'Meta'].includes(event.key) && event.code !== 'Space') {
        event.preventDefault(); event.stopPropagation(); return;
      }
      if (event.code === 'Space' && !isEditableTarget(event.target) && !event.repeat) { space.current = true; setPanning(true); }
    };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { space.current = false; setPanning(false); } };
    const blur = () => { space.current = false; setPanning(false); cancelLatest.current(); };
    window.addEventListener('keydown', down, true); window.addEventListener('keyup', up); window.addEventListener('blur', blur);
    return () => { window.removeEventListener('keydown', down, true); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); };
  }, []);

  useEffect(() => {
    const element = host.current!;
    const wheel = (event: WheelEvent) => {
      if (!scene) return;
      event.preventDefault();
      const at = point(event), factor = Math.exp(-Math.max(-600, Math.min(600, event.deltaY)) * (event.deltaMode === 1 ? 0.05 : 0.0015));
      const next = zoomAt(camera.current, at, Math.min(MAX_SCALE, Math.max(MIN_SCALE, camera.current.scale * factor)));
      // Zooming mid-pan re-bases the pan so the next move continues from the zoomed view.
      const current = gesture.current;
      if (current?.kind === 'pan') gesture.current = { ...current, camera: next, start: at };
      apply(next, true);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [scene]);

  function onPointerDown(event: React.PointerEvent) {
    if (!scene || gesture.current) return;
    const at = point(event);
    if (event.button === 1 || (event.button === 0 && (tool === 'pan' || space.current))) {
      event.preventDefault();
      gesture.current = { kind: 'pan', start: at, camera: camera.current, pointerId: event.pointerId };
    } else if (event.button === 0 && store.get().adjusting) {
      // Adjusting: presses belong to the image alone. Measuring picks image points; otherwise a handle or the image is dragged.
      const state = store.get(), layer = adjusted(state); if (!layer) return;
      if (state.adjusting!.measure) { measurePoint(pixelAt(layer.transform, screenToWorld(at, camera.current))); return; }
      let part: AdjustPart | null;
      try { part = adjustPartAt(adjustFrame(layer.transform, layer.width, layer.height, camera.current), at); } catch { return; }
      if (!part) return;
      gesture.current = { kind: 'background', start: at, pointerId: event.pointerId, layer, part, from: screenToWorld(at, camera.current), next: null };
    } else if (event.button === 0 && !event.shiftKey && target && handleFor(at)) {
      // Handles take the press before the objects under them (Shift+click still adds to the selection).
      const { handle, marker } = handleFor(at)!;
      // A road's end moves its node (the point on it, if one: an entrance then slides along its outline); the road stays selected.
      if (handle.kind === 'end') gesture.current = { kind: 'press', start: at, pointerId: event.pointerId, shift: false, alt: event.altKey, drag: endKey(store.get().session!.map, handle.nodeId), keep: true };
      else gesture.current = { kind: 'handle', start: at, pointerId: event.pointerId, alt: event.altKey, target, handle, marker, edit: null,
        world: screenToWorld(at, camera.current), camera: camera.current };
    } else if (event.button === 0 && drawingTool) {
      gesture.current = { kind: 'draw', start: at, pointerId: event.pointerId, alt: event.altKey, shift: event.shiftKey, dragged: false };
    } else if (event.button === 0) {
      const top = pressed(at), kind = top?.slice(0, top.indexOf('/'));
      const drag = top && (selectionSet.has(top) || DIRECT_DRAG.has(kind!)) ? top : undefined;
      gesture.current = { kind: 'press', start: at, pointerId: event.pointerId, shift: event.shiftKey, alt: event.altKey, ...(drag ? { drag } : {}) };
    } else return;
    host.current!.setPointerCapture(event.pointerId);
    host.current!.focus({ preventScroll: true });
  }
  const hoverFrame = useRef(0);
  function onPointerMove(event: React.PointerEvent) {
    const at = point(event), current = gesture.current;
    setCursor(screenToWorld(at, camera.current));
    if (drawingTool && current?.kind !== 'pan') {
      const input = pointerInput(event); lastInput.current = input;
      if (current?.kind === 'draw' && !current.dragged && Math.hypot(at[0] - current.start[0], at[1] - current.start[1]) > DRAG_PX) {
        current.dragged = true;
        // A dragged two-point rectangle: the press becomes its first corner, so the rectangle follows the pointer.
        const context = drawingContext();
        if (context && dragsRectangle(context)) drawClick(context, { screen: current.start, world: screenToWorld(current.start, camera.current), alt: current.alt, shift: current.shift });
      }
      cancelAnimationFrame(hoverFrame.current);
      hoverFrame.current = requestAnimationFrame(() => refreshDraft(input));
      return;
    }
    if (current?.kind === 'pan') {
      apply({ ...current.camera, offsetX: current.camera.offsetX + at[0] - current.start[0], offsetY: current.camera.offsetY + at[1] - current.start[1] }, true);
      return;
    }
    if (current?.kind === 'background') {
      if (!current.next && Math.hypot(at[0] - current.start[0], at[1] - current.start[1]) <= DRAG_PX) return;
      // Shift: corners the other way round from the aspect setting, the rotation in 15° steps.
      const keepAspect = (store.get().adjusting?.keepAspect ?? true) !== event.shiftKey, { layer } = current;
      try { current.next = dragTransform(current.part, layer.transform, layer.width, layer.height, current.from, screenToWorld(at, camera.current), { keepAspect, snapAngle: event.shiftKey }); }
      catch { return; }
      renderer.current?.setBackgroundPreview({ id: layer.id, transform: current.next });
      showAdjust({ transform: current.next, part: current.part });
      return;
    }
    if (current?.kind === 'handle') {
      if (!current.edit && Math.hypot(at[0] - current.start[0], at[1] - current.start[1]) <= DRAG_PX) return;
      const world = handlePoint(current.handle, current.world, screenToWorld(at, camera.current), event.altKey ? 0 : store.get().drawing.snapGrid);
      try { current.edit = dragHandle(current.target, current.handle, world, current.camera); }
      catch { return; }
      showHandlePreview(current.target, current.edit, world);
      return;
    }
    if (current?.kind === 'move') {
      // Millimetre steps keep committed coordinates readable; the preview shows the same rounded delta.
      const world = screenToWorld(at, camera.current), [x, y] = world, delta: Vec3 = [Math.round((x - current.start[0]) * 1000) / 1000, Math.round((y - current.start[1]) * 1000) / 1000, 0];
      // Shift keeps the move horizontal or vertical.
      if (event.shiftKey) delta[Math.abs(delta[0]) < Math.abs(delta[1]) ? 0 : 1] = 0;
      // An entrance lands exactly on its building's outline (not rounded: that would take it off the outline).
      current.delta = current.slide ? current.slide(world) : delta;
      if (!moveFrame.current) moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = 0;
        const live = gesture.current; if (live?.kind === 'move') renderer.current?.setOverlay(live.plan.hidden, live.plan.overlay(live.delta));
      });
      return;
    }
    if (current?.kind === 'press' && Math.hypot(at[0] - current.start[0], at[1] - current.start[1]) > DRAG_PX) {
      if (current.drag) { startMove(current); return; }
      gesture.current = { kind: 'box', start: current.start, end: at, pointerId: current.pointerId, shift: current.shift };
    }
    const box = gesture.current;
    if (box?.kind === 'box') { box.end = at; renderer.current?.setBox({ x0: box.start[0], y0: box.start[1], x1: at[0], y1: at[1] }); return; }
    if (current) return;
    cancelAnimationFrame(hoverFrame.current);
    // Adjusting: nothing else is picked, so nothing else lights up; the cursor tells what a press would take hold of.
    const state = store.get(), layer = state.adjusting && !state.adjusting.measure ? adjusted(state) : null;
    if (state.adjusting) {
      hoverFrame.current = requestAnimationFrame(() => {
        if (!layer) { setOverAdjust(null); return; }
        try { const frame = adjustFrame(layer.transform, layer.width, layer.height, camera.current); setOverAdjust(adjustCursor(adjustPartAt(frame, at), frame)); }
        catch { setOverAdjust(null); }
      });
      return;
    }
    hoverFrame.current = requestAnimationFrame(() => {
      setHover(pressed(at) ?? null);
      setOverHandle(!!handleFor(at));
    });
  }
  function onPointerUp(event: React.PointerEvent) {
    const current = gesture.current; if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (host.current!.hasPointerCapture(event.pointerId)) host.current!.releasePointerCapture(event.pointerId);
    if (current.kind === 'pan') { apply(camera.current, false); return; }
    if (current.kind === 'move') { finishMove(current); return; }
    if (current.kind === 'handle') { finishHandle(current, point(event)); return; }
    if (current.kind === 'background') { finishBackground(current); return; }
    if (current.kind === 'draw') {
      const context = drawingContext(); if (!context) return;
      const input = pointerInput(event), previous = lastClick.current, now = performance.now();
      // The second click of a double-click only finishes: it never places a point, a node, or a new draft.
      if (context.tool !== 'entrance' && previous && now - previous.at < DOUBLE_CLICK_MS && Math.hypot(input.screen[0] - previous.screen[0], input.screen[1] - previous.screen[1]) <= DRAG_PX * 2) {
        lastClick.current = null; drawFinish(context); return;
      }
      lastClick.current = { at: now, screen: input.screen };
      // The release is the click (a slight slip while clicking still places the point); a dragged rectangle ends here.
      drawClick(context, input);
      return;
    }
    if (current.kind === 'box') { renderer.current?.setBox(null); boxSelect({ x0: current.start[0], y0: current.start[1], x1: current.end[0], y1: current.end[1] }, current.shift); return; }
    clickSelect(point(event), current.shift, current.alt);
  }
  /** A click selects what is under it; Shift adds or removes, Alt cycles through overlapping objects. */
  function clickSelect(at: Vec2, shift: boolean, alt: boolean) {
    const candidates = hits(at);
    if (alt && scene) {
      const cycled = cycleSelection(candidates, at, scene.mapContentHash, cycle.current, { advance: true });
      cycle.current = cycled.cycle;
      if (cycled.hit) select([cycled.hit.key], shift ? 'toggle' : 'replace');
      return;
    }
    cycle.current = null;
    // As a press would take it (a road's end node near the end of a road), so a click selects what hovering showed.
    const map = store.get().session?.map, key = map ? pressTarget(map, candidates.map(hit => hit.key), at, camera.current) : candidates[0]?.key;
    if (key) select([key], shift ? 'toggle' : 'replace');
    else if (!shift) select([]);
  }
  /** A handle drag redraws the one object from its edited geometry; the committed scene replaces it after the edit. */
  function showHandlePreview(target: Target, edit: Edit, world: Vec3) {
    const map = store.get().session!.map, scene = sceneOf(map), key = target.kind + '/' + target.id;
    const road = target.kind === 'roads' ? scene.roads.find(entry => entry.id === target.id) : undefined;
    // A building's entrances on its outline go with it: their markers and connecting roads move in the preview too.
    const carried = target.kind === 'facilities' && 'boundary' in edit ? entranceOverlay(map, scene, entranceAdjustments(map, target.id, edit.boundary)) : null;
    const overlay = {
      nodes: carried?.overlay.nodes ?? [], accessPoints: carried?.overlay.accessPoints ?? [], servicePoints: carried?.overlay.servicePoints ?? [], items: [],
      roads: road ? [{ ...road, points: [], ...'path' in edit ? { path: edit.path } : {}, ...'widthM' in edit ? { widthM: { state: 'known' as const, value: edit.widthM } } : {} }] : carried?.overlay.roads ?? [],
      facilities: target.kind === 'facilities' && 'boundary' in edit ? scene.facilities.filter(area => area.id === target.id).map(area => ({ ...area, boundary: edit.boundary })) : [],
      zones: target.kind === 'zones' && 'boundary' in edit ? scene.zones.filter(area => area.id === target.id).map(area => ({ ...area, boundary: edit.boundary })) : [],
    };
    renderer.current?.setOverlay(new Set([key, ...carried?.hidden ?? []]), overlay);
    const previewTarget: Target = target.kind === 'roads'
      ? { ...target, ...'path' in edit ? { path: edit.path } : {}, ...'widthM' in edit ? { widthM: edit.widthM } : {} }
      : { ...target, ...'boundary' in edit ? { boundary: edit.boundary } : {} };
    showHandles(previewTarget);
    renderer.current?.setDraft({ vertices: [], label: { at: world, lines: [edit.label] } });
  }
  function endHandlePreview() {
    renderer.current?.setOverlay(null); renderer.current?.setDraft(null);
    showHandles(target);
  }
  /** One transaction per handle drag; an unchanged outline, path or width makes none. Alt+click on a vertex removes it;
   *  on any other handle it is the usual Alt+click, cycling through the objects there. */
  function finishHandle(gestureState: Extract<Gesture, { kind: 'handle' }>, at: Vec2) {
    const map = store.get().session?.map; if (!map) return;
    const { target, handle } = gestureState;
    if (!gestureState.edit) {
      if (!gestureState.alt && gestureState.marker) { select([gestureState.marker]); return; }
      if (gestureState.alt && handle.kind === 'vertex' && target.kind !== 'roads') {
        try { commitEdit(map, target, { boundary: removeVertex(target, handle), label: '删除顶点' }); }
        catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
      } else if (!gestureState.alt && handle.kind === 'insert' && target.kind !== 'roads') {
        const label = target.mode === 'rect' ? '插入顶点（矩形改为多边形）' : '插入顶点';
        try { if (commitEdit(map, target, { boundary: insertVertex(target, handle), label }, label)) notify(`已在边的中点插入顶点${target.mode === 'rect' ? '，矩形改为自由多边形' : ''}，可以拖动它。`); }
        catch (error) { notify(error instanceof Error ? error.message : String(error), 'error'); }
      } else if (gestureState.alt) clickSelect(at, false, true);
      return;
    }
    const inserted = handle.kind === 'insert' ? (target.kind !== 'roads' && target.mode === 'rect' ? '插入顶点（矩形改为多边形）' : '插入顶点') : undefined;
    if (!commitEdit(map, target, gestureState.edit, inserted)) endHandlePreview();
    else { renderer.current?.setDraft(null); }
  }
  function commitEdit(map: YardMap, target: Target, edit: Edit, label?: string): boolean {
    const change = editCommand(map, target, edit);
    return !!change && applyEdit(change.command, label ?? change.label);
  }

  /** One transaction per drag of the adjusted image; a click without a drag, or a refused change, puts it back. */
  function finishBackground(drag: Extract<Gesture, { kind: 'background' }>) {
    const map = store.get().session?.map, before = map && adjustedLayer(map, drag.layer.id)?.transform;
    const changed = !!drag.next && !!before && !drag.next.every((value, index) => value === before[index]);
    const label = drag.part.kind === 'move' ? '移动底图' : drag.part.kind === 'corner' ? '缩放底图' : '旋转底图';
    if (!changed || !setTransform(drag.layer.id, drag.next!, label)) renderer.current?.setBackgroundPreview(null);
    showAdjust();
  }
  /** Turns a press on a draggable object into a move (Alt: a copy), refusing at once what the commit would refuse. */
  function startMove(press: Extract<Gesture, { kind: 'press' }>) {
    const map = store.get().session?.map; if (!map || !scene) return;
    const refuse = (reason: string) => { gesture.current = null; notify(reason, 'error'); };
    const blocked = editBlock(); if (blocked) { refuse(blocked); return; }
    let keys = store.get().selection;
    if (!keys.includes(press.drag!)) { keys = [press.drag!]; if (!press.keep) select(keys); }
    const selection = selectionOf(keys); if (typeof selection === 'string') { refuse(selection); return; }
    let plan: MovePlan;
    try { plan = planMove(map, scene, selection, press.alt ? 'copy' : 'move'); }
    catch (error) { refuse(`不能${press.alt ? '复制' : '移动'}：${error instanceof Error ? error.message : String(error)}`); return; }
    // Indirect effects count too: a zone drag stretches roads, so locked roads refuse it here, not after the drop.
    const locked = lockedMessage(plan.affectedRefs); if (locked) { refuse(locked); return; }
    const start = screenToWorld(press.start, camera.current);
    // Dropped off its building's outline an entrance would be refused: a lone one slides along the outline instead.
    gesture.current = { kind: 'move', start, pointerId: press.pointerId, plan, selection, delta: ZERO, slide: press.alt ? undefined : entranceSlide(map, selection, start) };
    renderer.current?.setOverlay(plan.hidden, plan.overlay(ZERO));
  }
  /** One transaction for the whole drag; releasing where it started changes nothing. */
  function finishMove(move: Extract<Gesture, { kind: 'move' }>) {
    cancelAnimationFrame(moveFrame.current); moveFrame.current = 0;
    const map = store.get().session?.map;
    if (!map || move.delta.every(value => Math.abs(value) < 1e-9)) { renderer.current?.setOverlay(null); return; }
    const done = move.plan.mode === 'copy' ? duplicate(map, move.selection, move.delta) : translate(move.selection, move.delta);
    // On success the committed scene replaces the preview; a refusal puts everything back.
    if (!done) renderer.current?.setOverlay(null);
  }
  function boxSelect(screen: ScreenBox, add: boolean) {
    const current = renderer.current; if (!scene || !current) return;
    const a = screenToWorld([screen.x0, screen.y0], camera.current), b = screenToWorld([screen.x1, screen.y1], camera.current);
    const box = { minX: Math.min(a[0], b[0]), minY: Math.min(a[1], b[1]), maxX: Math.max(a[0], b[0]), maxY: Math.max(a[1], b[1]) };
    select(keysInBox(scene, current.visibleKeys, box, screen.x1 < screen.x0, drawing.showRoadBands), add ? 'add' : 'replace');
  }

  const draggable = hover && (selectionSet.has(hover) || DIRECT_DRAG.has(hover.slice(0, hover.indexOf('/'))));
  const cursorStyle = panning || tool === 'pan' ? (gesture.current?.kind === 'pan' ? 'grabbing' : 'grab')
    : adjusting ? (adjusting.measure ? 'crosshair' : gesture.current?.kind === 'background' && gesture.current.part.kind === 'rotate' ? 'grabbing' : overAdjust ?? 'default')
      : drawingTool || (overHandle && target) ? 'crosshair' : draggable ? 'move' : hover ? 'pointer' : 'default';
  return <div className="canvas-host" ref={host} tabIndex={0} aria-label="地图画布" data-testid="map-canvas" style={{ cursor: cursorStyle }}
    onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    onPointerCancel={cancelGesture} onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) cancelGesture(); }}
    onDoubleClick={event => {
      // Double-clicking a bend handle straightens that span.
      const map = store.get().session?.map, at = point(event);
      const handle = target?.kind === 'roads' ? handleAt(handlesOf(target, camera.current), at, camera.current) : null;
      if (map && target?.kind === 'roads' && handle?.kind === 'bend' && target.path.spans[handle.span]?.kind === 'cubic') commitEdit(map, target, { path: straighten(target, handle.span), label: '拉直' });
    }}
    onPointerLeave={() => { setCursor(null); if (!gesture.current) setHover(null); if (drawingTool) { lastInput.current = null; refreshDraft(null); } }}
    onAuxClick={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>
    <div className="stage-host" ref={stageHost} />
    {!scene && <EmptyState />}
    {scene && !scene.bounds && map && !Object.keys(map.backgroundLayers).length && <BlankMapHint />}
  </div>;
}

/** A map with nothing on it yet: tracing starts from an image, or drawing starts at once. */
function BlankMapHint() {
  return <div className="canvas-hint" role="note" onPointerDown={event => event.stopPropagation()}>
    <span>空白地图：可以先加一张影像或图纸作底图，定好比例再描图；也可以直接用工具栏绘制。</span>
    <button className="button primary" onClick={() => runOperation(operation('file.addBackground'))}>添加底图…</button>
  </div>;
}

function EmptyState() {
  const starting = useApp(state => state.project.phase === 'starting');
  if (starting) return <div className="canvas-empty"><div className="canvas-empty-card"><h2>正在恢复上次的浏览器工程…</h2></div></div>;
  return <div className="canvas-empty">
    <div className="canvas-empty-card">
      <h2>打开一张船厂地图</h2>
      <p>支持 schema 0.1.0 / 0.2.0 / 0.3.0 的地图 JSON 或 zip 包，可以连同底图图片一起选择；也可以把文件直接拖到窗口里。打开或新建的地图保存在本浏览器中，修改后自动保存。</p>
      <div className="dialog-actions">
        <button className="button" onClick={() => runOperation(operation('file.projects'))}>浏览器工程…</button>
        <button className="button" onClick={() => runOperation(operation('file.new'))}>新建地图…</button>
        <button className="button primary" onClick={() => runOperation(operation('file.open'))}>打开地图…<kbd>Ctrl+O</kbd></button>
      </div>
    </div>
  </div>;
}
