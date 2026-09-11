import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { useFrameCamera } from '../../ui/useFrameCamera';
import { useCurrentCallback } from '../../ui/useCurrentCallback';
import { createDisplayIndex, selectDisplay, layoutLabels, createTextMeasurer, type ScreenRect, type DisplayGeometry } from './display';
import { Stage, Layer, Circle, Line, Text } from 'react-konva';
import Konva from 'konva';

// Middle button belongs exclusively to viewport panning in this editor.
Konva.dragButtons = [0];
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import type { SceneSnapshot, SceneItem, SceneKind } from '../../adapters/contracts';
import type { Polygon, Vec3 } from '../../domain/model';
import type { DrawingConfig } from '../../editor/projectController';
import { SpatialLayer, AssociatedPointLayer, DeclaredLayer, type SpatialLayerProps } from './SpatialLayer';
import { useSpatialDrawing, isSpatialTool, isRectangleTool, snapPosition, type SnapOptions } from './useSpatialDrawing';
import { SELECTION_KINDS, type Selection } from '../../domain/commands';
import { rectangleFrame } from '../../geometry/rectangles';
import { BoundaryHandles, type BoundaryTarget, type BoundaryPreview } from './BoundaryHandles';
import { screenToWorld, worldToScreen, zoomAt, type Camera, type Vec2 } from '../../geometry/coordinates';

export type Tool = 'select' | 'node' | 'road' | 'pan' | 'facilityRect' | 'facilityPolygon' | 'zoneRect' | 'zonePolygon';
export type PointPickResult = { nodeId: string } | { position: Vec3 };
export interface PointPick { mode: 'existing' | 'new'; nodeId?: string; position?: Vec3 }
export interface DraftRoad { fromNodeId: string; points: Vec3[] }
interface Props {
  routePreview?: { mapContentHash: string; points: Vec3[]; confirmed: boolean } | null;
  diagnosticPosition?: Vec3 | null;
  scene: SceneSnapshot;
  hiddenTypes?: readonly SceneKind[];
  labelMode: DrawingConfig['labelMode'];
  focusKey?: string;
  describeItem: (key: string) => { id: string; name: string; source: string } | null;
  inspectKey?: string;
  onInspect?: (item: SceneItem) => void;
  canDrag?: (kind: keyof Selection, id: string) => boolean;
  canEditBoundary?: (kind: 'facilities' | 'zones', id: string) => boolean;
  movingJunctionIds?: readonly string[];
  rigidRoadIds?: readonly string[];
  roadDisplay: Pick<DrawingConfig, 'showRoadBands' | 'showRoadCenterlines' | 'showOrdinaryNodes'>;
  roadShapePreview?: { roadId: string; shapePoints: Vec3[]; mapContentHash: string } | null;
  camera: Camera;
  frameCamera: ReturnType<typeof useFrameCamera>;
  onSize: (size: { width: number; height: number }) => void;
  tool: Tool;
  readonly: boolean;
  selection: Selection;
  onSelect: (kind: keyof Selection, id: string, additive: boolean) => void;
  onClearSelection: () => void;
  onAddNode: (point: Vec3) => void;
  onRoadNode: (id: string) => void;
  onRoadPoint: (point: Vec3) => void;
  onTranslate: (delta: Vec3) => void;
  draftRoad: DraftRoad | null;
  onPolygonCreate?: (kind: 'facilities' | 'zones', boundary: Polygon) => boolean;
  onDraftChange?: (dirty: boolean) => void;
  hasUnappliedInput?: boolean;
  draftResetToken?: number;
  pointPick?: PointPick;
  onPointPick?: (result: PointPickResult) => void;
  movingNodeIds?: string[];
  boundaryEditMode: 'auto' | 'polygon';
  boundaryChangeToken: number;
  onBoundaryCommit: (kind: 'facilities' | 'zones', id: string, boundary: Polygon, baseMapHash: string, baseChangeToken: number) => boolean;
  onBoundaryInteractionChange: (active: boolean) => void;
  snap?: SnapOptions;
}
function tickStep(scale: number): number {
  const raw = 70 / scale; const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= raw)!;
}
function roundTick(value: number): string { return Number(value.toPrecision(8)).toString(); }

export function MapCanvas(props: Props) {
  const wrapper = useRef<HTMLDivElement>(null);
  const stage = useRef<KonvaStage>(null);
  const pan = useRef<{ pointer: Vec2 } | null>(null);
  const dragStart = useRef<Vec3 | null>(null);
  const pressed = useRef(false);
  const inputCamera = useRef<Camera | null>(null);
  const cursorOutput = useRef<HTMLOutputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [snapKey, setSnapKey] = useState<string | null>(null);
  const latest = useRef(props); latest.current = props;
  const displayIndex = useMemo(() => createDisplayIndex(props.scene), [props.scene]);
  const measurer = useMemo(() => createTextMeasurer(), [props.scene]);
  useEffect(() => {
    const clear = () => measurer.clear();
    document.fonts?.addEventListener('loadingdone', clear);
    return () => { document.fonts?.removeEventListener('loadingdone', clear); clear(); };
  }, [measurer]);
  function hover(key: string | null) {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
    if (!key || props.frameCamera.navigating || pressed.current || props.labelMode === 'off') { setHoverKey(null); return; }
    const epoch = props.frameCamera.epoch;
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null;
      if (latest.current.frameCamera.epoch === epoch && !latest.current.frameCamera.navigating && !pressed.current) setHoverKey(key);
    }, 200);
  }
  function consumeCamera() {
    // Native capture precedes Konva's hit lookup. A published prop alone does not refresh the hit canvas.
    const next = props.frameCamera.read();
    const previous = inputCamera.current;
    if (props.frameCamera.hasPending() || !previous || next.scale !== previous.scale || next.offsetX !== previous.offsetX || next.offsetY !== previous.offsetY) {
      flushSync(() => props.frameCamera.flush());
      stage.current?.draw();
      inputCamera.current = next;
    }
  }
  function captureStart(event: React.PointerEvent | React.MouseEvent | React.TouchEvent) {
    consumeCamera();
    if (event.target instanceof HTMLCanvasElement) wrapper.current?.focus({ preventScroll: true });
    const button = 'button' in event ? event.button : 0;
    if (button === 0 && props.tool !== 'pan') pressed.current = true;
    hover(null);
  }
  function captureEnd() { consumeCamera(); pressed.current = false; }

  const [size, setSize] = useState({ width: 800, height: 540 });
  const [previewDelta, setPreviewDelta] = useState<Vec3 | null>(null);
  const [rubberEnd, setRubberEnd] = useState<Vec3 | null>(null);
  const [pickNotice, setPickNotice] = useState('');
  const [boundaryPreview, setBoundaryPreview] = useState<BoundaryPreview | null>(null);
  const [boundaryActive, setBoundaryActive] = useState(false);
  const boundaryActiveRef = useRef(false);
  const [boundaryError, setBoundaryError] = useState('');
  useEffect(() => {
    pan.current = null; pressed.current = false;
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
    hoverTimer.current = null; setHoverKey(null);
  }, [props.frameCamera.epoch, props.scene]);
  useEffect(() => {
    if (props.frameCamera.navigating || props.labelMode === 'off') hover(null);
  }, [props.frameCamera.navigating, props.labelMode]);
  useEffect(() => {
    function cancel() {
      pan.current = null; pressed.current = false; dragStart.current = null;
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      hoverTimer.current = null; setHoverKey(null); setPreviewDelta(null);
      stage.current?.find((node: Konva.Node) => node.isDragging()).forEach(node => node.stopDrag());
      latest.current.frameCamera.cancel();
    }
    function up() { pan.current = null; pressed.current = false; }
    function escape(event: KeyboardEvent) { if (event.key === 'Escape') cancel(); }
    function visibility() { if (document.hidden) cancel(); }
    window.addEventListener('mouseup', up); window.addEventListener('pointerup', up); window.addEventListener('touchend', up);
    window.addEventListener('blur', cancel); window.addEventListener('pointercancel', cancel); window.addEventListener('touchcancel', cancel);
    window.addEventListener('keydown', escape); document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('mouseup', up); window.removeEventListener('pointerup', up); window.removeEventListener('touchend', up);
      window.removeEventListener('blur', cancel); window.removeEventListener('pointercancel', cancel); window.removeEventListener('touchcancel', cancel);
      window.removeEventListener('keydown', escape); document.removeEventListener('visibilitychange', visibility);
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      pan.current = null; pressed.current = false;
    };
  }, []);

  useEffect(() => {
    dragStart.current = null; setPreviewDelta(null);
    stage.current?.find((node: Konva.Node) => node.isDragging()).forEach(node => node.stopDrag());
  }, [props.draftResetToken]);
  useEffect(() => { setPickNotice(''); }, [props.pointPick?.mode]);
  const drawing = useSpatialDrawing(props.tool, props.readonly || !!props.pointPick, props.camera, props.onPolygonCreate, props.draftResetToken);
  const drawingDirty = drawing.vertices.length > 0;
  const boundaryTarget = useMemo<BoundaryTarget | null>(() => {
    if (props.readonly || props.hasUnappliedInput || props.pointPick || props.draftRoad || drawingDirty || previewDelta || props.tool !== 'select'
      || SELECTION_KINDS.reduce((count, kind) => count + (props.selection[kind]?.length ?? 0), 0) !== 1) return null;
    for (const kind of ['facilities', 'zones'] as const) {
      const id = props.selection[kind]?.[0];
      const item = props.scene[kind].find(value => value.id === id);
      if (item && !props.hiddenTypes?.includes(kind) && (props.canEditBoundary?.(kind, item.id) ?? true)) return { kind, id: item.id, boundary: item.boundary };
    }
    return null;
  }, [props.readonly, props.hasUnappliedInput, props.pointPick, props.draftRoad, drawingDirty, previewDelta, props.tool, props.selection, props.scene, props.hiddenTypes, props.canEditBoundary]);
  const boundaryFrame = useMemo(() => boundaryTarget && props.boundaryEditMode === 'auto' ? rectangleFrame(boundaryTarget.boundary) : null, [boundaryTarget, props.boundaryEditMode]);
  const boundaryMode = boundaryTarget ? boundaryFrame ? 'rectangle' : 'polygon' : 'none';
  const boundaryHandleCount = boundaryTarget ? [boundaryTarget.boundary.outer, ...boundaryTarget.boundary.holes].reduce((count, ring) => count + ring.length - 1, 0) : 0;
  const boundaryContextKey = JSON.stringify([props.scene.mapContentHash, props.boundaryChangeToken, props.boundaryEditMode,
    SELECTION_KINDS.map(kind => props.selection[kind] ?? []), props.tool, props.readonly, props.hasUnappliedInput,
    !!props.pointPick, !!props.draftRoad, drawingDirty, props.draftResetToken, props.camera, size]);
  function boundaryInteraction(active: boolean) {
    boundaryActiveRef.current = active; setBoundaryActive(active); pan.current = null;
    props.onBoundaryInteractionChange(active);
  }
  useEffect(() => { props.onDraftChange?.(drawingDirty); return () => props.onDraftChange?.(false); }, [drawingDirty, props.onDraftChange]);
  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]; if (!entry) return;
      const next = { width: Math.max(100, Math.floor(entry.contentRect.width)), height: Math.max(100, Math.floor(entry.contentRect.height)) };
      setSize(next); props.onSize(next);
    });
    if (wrapper.current) observer.observe(wrapper.current);
    return () => observer.disconnect();
  }, [props.onSize]);
  const selectedNodeIds = useMemo(() => {
    if (props.movingNodeIds) return new Set(props.movingNodeIds);
    const ids = new Set(props.selection.nodes);
    for (const road of props.scene.roads) if (props.selection.roads.includes(road.id)) {
      ids.add(road.fromNodeId); ids.add(road.toNodeId);
    }
    return ids;
  }, [props.selection, props.scene.roads, props.movingNodeIds]);
  function position(id: string, original: Vec3): Vec3 {
    if (!previewDelta || !selectedNodeIds.has(id)) return original;
    return [original[0] + previewDelta[0], original[1] + previewDelta[1], original[2] + previewDelta[2]];
  }
  const nodeById = useMemo(() => new Map(props.scene.nodes.map(n => [n.id, n])), [props.scene.nodes]);
  const shapePreview = props.roadShapePreview?.mapContentHash === props.scene.mapContentHash
    && props.selection.roads.includes(props.roadShapePreview.roadId) ? props.roadShapePreview : null;
  function points(road: SceneSnapshot['roads'][number]): number[] {
    const route = shapePreview?.roadId === road.id
      ? [road.points[0]!, ...shapePreview.shapePoints, road.points.at(-1)!] : road.points;
    return route.flatMap((point, index) => {
      let world = point;
      if (index === 0) world = position(road.fromNodeId, point);
      else if (index === route.length - 1) world = position(road.toNodeId, point);
      else if (previewDelta && (props.rigidRoadIds?.includes(road.id) || props.selection.roads.includes(road.id))) world = [point[0] + previewDelta[0], point[1] + previewDelta[1], point[2] + previewDelta[2]];
      return worldToScreen(world, props.camera);
    });
  }
  function pointer(): Vec2 | null {
    const value = stage.current?.getPointerPosition(); return value ? [value.x, value.y] : null;
  }
  const step = tickStep(props.camera.scale);
  const [left, top] = screenToWorld([0, 0], props.camera);
  const [right, bottom] = screenToWorld([size.width, size.height], props.camera);
  const grid: { value: number; pixel: number; axis: 'x' | 'y' }[] = [];
  for (let x = Math.ceil(left / step) * step; x <= right && grid.length < 150; x += step) grid.push({ value: x, pixel: worldToScreen([x, 0, 0], props.camera)[0], axis: 'x' });
  for (let y = Math.ceil(bottom / step) * step; y <= top && grid.length < 300; y += step) grid.push({ value: y, pixel: worldToScreen([0, y, 0], props.camera)[1], axis: 'y' });
  function handleStageDown(event: KonvaEventObject<MouseEvent>) {
    if (boundaryActiveRef.current) return;
    if ((!props.pointPick && props.tool === 'pan') || event.evt.button === 1) {
      const point = pointer(); if (point) pan.current = { pointer: point };
      event.evt.preventDefault();
    }
  }
  function handleStageClick(event: KonvaEventObject<MouseEvent>) {
    if (boundaryActiveRef.current || event.target !== event.target.getStage() || event.evt.button !== 0) return;
    const screen = pointer(); if (!screen) return;
    drawAt(screen);
  }
  function pickNode(id: string) {
    if (!props.pointPick || props.readonly) return;
    if (props.pointPick.mode === 'existing') props.onPointPick?.({ nodeId: id });
    else {
      const node = nodeById.get(id);
      if (node) props.onPointPick?.({ position: [...node.position] });
    }
  }
  function drawAt(screen: Vec2) {
    if (boundaryActiveRef.current) return;
    if (props.pointPick) {
      if (props.readonly) return;
      if (props.pointPick.mode === 'new') props.onPointPick?.({ position: snapPosition(screen, props.frameCamera.read(), props.scene.nodes, props.snap).world });
      else setPickNotice('请选择已有节点或入口/服务点标记；背景、道路中部和附近坐标不代表已有节点。');
      return;
    }
    if (props.tool === 'select') { props.onClearSelection(); return; }
    const { world } = snapPosition(screen, props.frameCamera.read(), props.scene.nodes, props.snap);
    if (isSpatialTool(props.tool)) drawing.click(world, screen);
    else if (props.tool === 'node' && !props.readonly) props.onAddNode(world);
    else if (props.tool === 'road' && !props.readonly) props.onRoadPoint(world);
  }
  const start = props.draftRoad ? nodeById.get(props.draftRoad.fromNodeId)?.position : undefined;
  const draftPoints = start ? [start, ...props.draftRoad!.points, ...(rubberEnd ? [rubberEnd] : [])] : [];
  const keepKeys = useMemo(() => {
    const keys = new Set(SELECTION_KINDS.flatMap(kind => (props.selection[kind] ?? []).map(id => kind + '/' + id)));
    for (const id of selectedNodeIds) keys.add('nodes/' + id);
    if (props.inspectKey) keys.add(props.inspectKey);
    if (snapKey) keys.add(snapKey);
    if (props.draftRoad) keys.add('nodes/' + props.draftRoad.fromNodeId);
    return keys;
  }, [props.selection, selectedNodeIds, props.inspectKey, snapKey, props.draftRoad]);
  const overrides = new Map<string, DisplayGeometry>(), offsets = new Map<string, Vec3>();
  if (boundaryPreview) overrides.set(boundaryPreview.kind + '/' + boundaryPreview.id, { polygons: [boundaryPreview.boundary] });
  if (shapePreview || previewDelta) for (const road of props.scene.roads) {
    if (shapePreview?.roadId !== road.id && !(previewDelta && (selectedNodeIds.has(road.fromNodeId) || selectedNodeIds.has(road.toNodeId)))) continue;
    const route = shapePreview?.roadId === road.id ? [road.points[0]!, ...shapePreview.shapePoints, road.points.at(-1)!] : road.points;
    overrides.set('roads/' + road.id, { lines: [route.map((point, index) => index === 0 ? position(road.fromNodeId, point)
      : index === route.length - 1 ? position(road.toNodeId, point)
        : previewDelta && (props.rigidRoadIds?.includes(road.id) || props.selection.roads.includes(road.id))
          ? [point[0] + previewDelta[0], point[1] + previewDelta[1], point[2] + previewDelta[2]] as Vec3 : point)] });
  }
  if (previewDelta) {
    for (const id of selectedNodeIds) offsets.set('nodes/' + id, previewDelta);
    for (const kind of ['facilities', 'zones'] as const) for (const id of props.selection[kind] ?? []) offsets.set(kind + '/' + id, previewDelta);
    for (const kind of ['accessPoints', 'servicePoints'] as const) for (const point of props.scene[kind]) if (selectedNodeIds.has(point.nodeId)) offsets.set(kind + '/' + point.id, previewDelta);
    for (const item of props.scene.items) if (item.owner && props.selection[item.owner.kind]?.includes(item.owner.id)
      || item.kind === 'junctions' && props.movingJunctionIds?.includes(item.id)) offsets.set(item.key, previewDelta);
  }
  const focusKey = props.focusKey ?? hoverKey ?? undefined;
  const display = selectDisplay(displayIndex, { camera: props.camera, ...size, hiddenTypes: props.hiddenTypes, focusKey,
    keepKeys, showDetails: props.labelMode === 'debug_all', navigating: props.frameCamera.navigating, showOrdinaryNodes: props.roadDisplay.showOrdinaryNodes,
    editingNodes: !!props.pointPick || props.tool === 'road', offsets, geometryOverrides: overrides });
  const details = focusKey && display.keys.has(focusKey) ? props.describeItem(focusKey) : null;
  const reserved: ScreenRect[] = [{ x: 0, y: 0, width: size.width, height: 30 }, { x: 0, y: size.height - 105, width: size.width, height: 105 }];
  if (boundaryTarget) for (const ring of [boundaryPreview?.boundary.outer ?? boundaryTarget.boundary.outer, ...(boundaryPreview?.boundary.holes ?? boundaryTarget.boundary.holes)]) {
    for (const point of ring) { const [x, y] = worldToScreen(point, props.camera); reserved.push({ x: x - 14, y: y - 14, width: 28, height: 28 }); }
  }
  const cardRect = details ? [
    { x: size.width - 270, y: 34, width: 260, height: 125 }, { x: 10, y: 34, width: 260, height: 125 },
    { x: size.width - 270, y: size.height - 234, width: 260, height: 125 }, { x: 10, y: size.height - 234, width: 260, height: 125 },
  ].find(card => card.x >= 4 && card.y >= 4 && card.x + card.width <= size.width - 4 && !reserved.some(box =>
    card.x < box.x + box.width + 4 && card.x + card.width + 4 > box.x && card.y < box.y + box.height + 4 && card.y + card.height + 4 > box.y)) : undefined;
  if (cardRect) reserved.push(cardRect);
  const labels = layoutLabels(display, { camera: props.camera, ...size, mode: props.labelMode, focusKey, navigating: props.frameCamera.navigating, reserved }, measurer);
  const displayedNodes = props.scene.nodes.filter(node => display.keys.has('nodes/' + node.id) && worldToScreen(position(node.id, node.position), props.camera).every(Number.isFinite));
  const projectedRoads = props.scene.roads.filter(road => display.keys.has('roads/' + road.id)).map(road => {
    const pixels = road.widthM.state === 'known' ? road.widthM.value * props.camera.scale : null;
    return { ...road, screenPoints: points(road), bandWidthPx: pixels !== null && Number.isFinite(pixels) && pixels > 0 ? pixels : null };
  });
  const visibleRoads = projectedRoads.filter(road => road.screenPoints.every(Number.isFinite));
  const unprojectableWidths = visibleRoads.filter(road => road.widthM.state === 'known' && road.bandWidthPx === null).length;
  const unknownWidths = useMemo(() => props.scene.roads.filter(road => road.widthM.state !== 'known').length, [props.scene.roads]);
  const widthRangeIssues = useMemo(() => props.scene.missingCapabilities.filter(issue => issue.startsWith('ROAD_WIDTH_VISUAL_RANGE:')), [props.scene.missingCapabilities]);
  const unprojectable = display.unprojectableCount;
  function roadClick(event: KonvaEventObject<MouseEvent>, id: string) {
    if (event.evt.button !== 0) return;
    if (props.pointPick) { event.cancelBubble = true; const screen = pointer(); if (screen) drawAt(screen); }
    else if (props.tool === 'select') { event.cancelBubble = true; props.onSelect('roads', id, event.evt.shiftKey); }
    else if (!props.readonly && (props.tool === 'node' || props.tool === 'road' || isSpatialTool(props.tool))) {
      const screen = pointer(); if (!screen) return; event.cancelBubble = true; drawAt(screen);
    }
  }
  // Shared handlers keep Konva subscriptions stable; each dispatch sees current guards.
  const onRoadClick = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => roadClick(event, event.currentTarget.getAttr('roadId') as string));
  const onRoadEnter = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => hover('roads/' + event.currentTarget.getAttr('roadId')));
  const onShapeLeave = useCurrentCallback(() => hover(null));
  const onNodeEnter = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => hover('nodes/' + event.currentTarget.getAttr('nodeId')));
  const onNodeDown = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => {
    const id = event.currentTarget.getAttr('nodeId') as string;
    const selected = selectedNodeIds.has(id) || props.pointPick?.nodeId === id;
    if (event.evt.button === 0 && !props.pointPick && props.tool === 'select' && (!selected || event.evt.shiftKey)) props.onSelect('nodes', id, event.evt.shiftKey);
  });
  const onNodeClick = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => {
    if (event.evt.button !== 0) return;
    const id = event.currentTarget.getAttr('nodeId') as string;
    if (props.pointPick) { event.cancelBubble = true; pickNode(id); }
    else if (props.tool === 'road' && !props.readonly) { event.cancelBubble = true; props.onRoadNode(id); }
    else if (props.tool === 'select') { event.cancelBubble = true; if (!event.evt.shiftKey) props.onSelect('nodes', id, false); }
    else if (isSpatialTool(props.tool)) { const screen = pointer(); if (screen) { event.cancelBubble = true; drawAt(screen); } }
  });
  const onNodeDragStart = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    const node = nodeById.get(event.currentTarget.getAttr('nodeId') as string);
    if (node) dragStart.current = [...node.position];
  });
  const onNodeDragMove = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    if (!dragStart.current) return;
    const value = snapPosition([event.target.x(), event.target.y()], props.camera, props.scene.nodes, props.snap, selectedNodeIds, dragStart.current[2]).world;
    setPreviewDelta([value[0] - dragStart.current[0], value[1] - dragStart.current[1], 0]);
  });
  const onNodeDragEnd = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    const origin = dragStart.current; dragStart.current = null; setPreviewDelta(null);
    if (!origin) return;
    const value = snapPosition([event.target.x(), event.target.y()], props.camera, props.scene.nodes, props.snap, selectedNodeIds, origin[2]).world;
    props.onTranslate([value[0] - origin[0], value[1] - origin[1], 0]);
  });
  const spatialProps: SpatialLayerProps = {
    hiddenTypes: props.hiddenTypes, visibleKeys: display.keys, onHover: hover, canDrag: props.canDrag,
    scene: props.scene, camera: props.camera, selection: props.selection, previewDelta, boundaryPreview,
    snap: props.snap, readonly: props.readonly, selecting: !props.pointPick && props.tool === 'select', drawingRoad: !props.pointPick && props.tool === 'road', movingNodeIds: selectedNodeIds,
    disableDrag: props.hasUnappliedInput || boundaryActive, pickingPoint: !!props.pointPick, onPickNode: pickNode,
    onSelect: props.onSelect, onRoadNode: props.onRoadNode, onDrawClick: () => { const p = pointer(); if (p) drawAt(p); },
    onDragStart: origin => { dragStart.current = origin; }, onPreview: setPreviewDelta,
    onDragEnd: delta => { const active = dragStart.current; dragStart.current = null; if (active) props.onTranslate(delta); },
  };
  const firstVertex = drawing.vertices[0];
  const spatialPreview = isRectangleTool(props.tool) && firstVertex && rubberEnd
    ? [firstVertex, [rubberEnd[0], firstVertex[1], 0] as Vec3, rubberEnd, [firstVertex[0], rubberEnd[1], 0] as Vec3, firstVertex]
    : [...drawing.vertices, ...(rubberEnd && drawing.vertices.length ? [rubberEnd] : [])];
  return <div tabIndex={0} onPointerDownCapture={captureStart} onMouseDownCapture={captureStart} onTouchStartCapture={captureStart} onPointerUpCapture={captureEnd} onMouseUpCapture={captureEnd} onTouchEndCapture={captureEnd} ref={wrapper} className={`canvas-surface tool-${props.tool}`} data-testid="map-canvas" aria-label="米制地图画布">
    <Stage ref={stage} width={size.width} height={size.height}
      onMouseDown={handleStageDown} onMouseUp={() => { pan.current = null; }} onMouseLeave={() => { pan.current = null; hover(null); if (cursorOutput.current) cursorOutput.current.textContent = '本地 XY · 米制'; }}
      onClick={handleStageClick}
      onMouseMove={() => {
        if (boundaryActiveRef.current) return;
        const point = pointer(); if (!point) return;
        if (pan.current) {
          const previous = pan.current.pointer;
          props.frameCamera.queue(current => ({ ...current, offsetX: current.offsetX + point[0] - previous[0], offsetY: current.offsetY + point[1] - previous[1] }));
          pan.current.pointer = point;
          return;
        }
        const drawingPointer = !!props.pointPick || props.tool === 'node' || props.tool === 'road' || isSpatialTool(props.tool);
        const snapped = drawingPointer ? snapPosition(point, props.frameCamera.read(), props.scene.nodes, props.snap) : null;
        const world = snapped?.world ?? screenToWorld(point, props.frameCamera.read());
        if (cursorOutput.current) cursorOutput.current.textContent = `X ${world[0].toFixed(3)} m · Y ${world[1].toFixed(3)} m`;
        if (drawingPointer) { setRubberEnd(world); setSnapKey(snapped?.nodeId ? 'nodes/' + snapped.nodeId : null); }
      }}
      onWheel={event => {
        event.evt.preventDefault();
        if (pressed.current || dragStart.current || boundaryActiveRef.current || event.evt.deltaY === 0) return;
        const point = pointer(); if (!point) return;
        props.frameCamera.queue(current => zoomAt(current, point, Math.min(100, Math.max(Number.MIN_VALUE, current.scale * (event.evt.deltaY < 0 ? 1.15 : 1 / 1.15)))));
      }}>
      <Layer listening={false}>
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Line key={'grid-' + index} points={tick.axis === 'x' ? [tick.pixel, 0, tick.pixel, size.height] : [0, tick.pixel, size.width, tick.pixel]} stroke={Math.abs(tick.value) < 1e-9 ? '#8ba6b4' : '#e5edf1'} strokeWidth={Math.abs(tick.value) < 1e-9 ? 1.5 : 1} />)}
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Text key={'label-' + index} x={tick.axis === 'x' ? tick.pixel + 4 : 5} y={tick.axis === 'x' ? 6 : tick.pixel + 4} text={roundTick(tick.value)} fill="#7b8f9d" fontSize={10} />)}
      </Layer>
      <Layer listening={!boundaryActive}>
        <DeclaredLayer backdrop items={props.scene.items} visibleKeys={display.keys} onHover={hover} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} selectedKey={focusKey} onSelect={item => props.onInspect?.(item)} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        <SpatialLayer {...spatialProps} />
        {/* All bands precede all auxiliary lines, then nodes/associated points and edit handles.
            Round caps/joins form a width-derived approximation, never a surveyed junction disk. */}
        {props.roadDisplay.showRoadBands && visibleRoads.map(road => road.bandWidthPx !== null &&
          <Line key={road.id} roadId={road.id} name="road-band" points={road.screenPoints}
            stroke={props.selection.roads.includes(road.id) ? '#efbb82' : '#b7d0db'}
            strokeWidth={road.bandWidthPx} hitStrokeWidth={Math.max(14, road.bandWidthPx)} lineCap="round" lineJoin="round"
            onMouseEnter={onRoadEnter} onMouseLeave={onShapeLeave} onClick={onRoadClick} />)}
        {visibleRoads.map(road => {
          // Unknown/unrestricted/not-applicable (or unprojectable) never become a fabricated band.
          const auxiliary = road.bandWidthPx === null;
          if (!props.roadDisplay.showRoadCenterlines && !(props.roadDisplay.showRoadBands && auxiliary)) return null;
          return <Line key={road.id} roadId={road.id} name="road-centerline" points={road.screenPoints}
            stroke={props.selection.roads.includes(road.id) ? '#ad5f17' : auxiliary ? '#a76c24' : '#216b88'}
            strokeWidth={2} hitStrokeWidth={14} dash={auxiliary ? [7, 5] : undefined} lineCap="round" lineJoin="round"
            onMouseEnter={onRoadEnter} onMouseLeave={onShapeLeave} onClick={onRoadClick} />;
        })}
        <DeclaredLayer items={props.scene.items} visibleKeys={display.keys} onHover={hover} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} selectedKey={focusKey} onSelect={item => props.onInspect?.(item)} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        {displayedNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          const selected = selectedNodeIds.has(node.id) || props.pointPick?.nodeId === node.id;
          return <Circle _useStrictMode nodeId={node.id} onMouseEnter={onNodeEnter} onMouseLeave={onShapeLeave} key={node.id} x={x} y={y} radius={selected ? 6.5 : 5} fill={selected ? '#e08128' : '#ffffff'} stroke={selected ? '#9a4c0d' : '#216b88'} strokeWidth={2} hitStrokeWidth={12}
            draggable={!boundaryActive && !props.hasUnappliedInput && !props.pointPick && props.tool === 'select' && !props.readonly && (props.canDrag?.('nodes', node.id) ?? true)}
            onMouseDown={onNodeDown} onClick={onNodeClick} onDragStart={onNodeDragStart} onDragMove={onNodeDragMove} onDragEnd={onNodeDragEnd} />;
        })}
        <AssociatedPointLayer {...spatialProps} />
      </Layer>
      <Layer listening={false}>
        {props.routePreview?.mapContentHash === props.scene.mapContentHash && (() => {
          const points = props.routePreview.points.flatMap(point => worldToScreen(point, props.camera));
          return points.every(Number.isFinite) && points.length >= 4 ? <Line points={points} stroke={props.routePreview.confirmed ? '#1876ad' : '#c47e19'} strokeWidth={5} opacity={0.85} dash={props.routePreview.confirmed ? undefined : [10,6]}/> : null;
        })()}
        {props.diagnosticPosition && (() => { const point = worldToScreen(props.diagnosticPosition, props.camera); return point.every(Number.isFinite) ? <Circle x={point[0]} y={point[1]} radius={14} stroke="#c05f22" strokeWidth={3} dash={[5,3]}/> : null; })()}
        {labels.labels.map(({ key, ...label }) => <Text key={key} name="display-label" {...label} listening={false}/>)}
        {draftPoints.length > 1 && <Line points={draftPoints.flatMap(point => worldToScreen(point, props.camera))} stroke="#e08128" strokeWidth={2} dash={[7, 5]} />}
        {spatialPreview.length > 1 && <Line points={spatialPreview.flatMap(point => worldToScreen(point, props.camera))} stroke="#bd741d" strokeWidth={2} dash={[7, 5]} />}
        {drawing.vertices.map((point, index) => { const p = worldToScreen(point, props.camera); return <Circle key={index} x={p[0]} y={p[1]} radius={4} fill="#bd741d" />; })}
      </Layer>
      <BoundaryHandles target={boundaryTarget} mode={props.boundaryEditMode} preview={boundaryPreview} camera={props.camera}
        mapHash={props.scene.mapContentHash} changeToken={props.boundaryChangeToken} contextKey={boundaryContextKey}
        onPreview={setBoundaryPreview} onActive={boundaryInteraction} onError={setBoundaryError} onCommit={props.onBoundaryCommit} />
    </Stage>
    {boundaryPreview && <output data-testid="boundary-edit-preview" data-width-m={boundaryPreview.widthM} data-height-m={boundaryPreview.heightM} data-clamped={boundaryPreview.clamped ?? false}
      style={{ position: 'absolute', top: 34, left: 14, padding: 8, background: '#fff', border: '1px solid #c9d6d8', borderRadius: 6, pointerEvents: 'none' }}>
      {boundaryPreview.widthM === undefined ? '顶点预览' : '局部宽 ' + roundTick(boundaryPreview.widthM) + ' m × 高 ' + roundTick(boundaryPreview.heightM!) + ' m'}
      {boundaryPreview.clamped ? ' · 最小边长 0.01 m' : ''} · 松开应用，Esc 取消；仅修改边界
    </output>}
    {boundaryError && <div role="alert" style={{ position: 'absolute', bottom: 38, left: 14, right: 14, background: '#fff4ed', padding: 8 }}>{boundaryError}</div>}
    <output className="sr-only" data-testid="boundary-handles" data-count={boundaryHandleCount} data-mode={boundaryMode}>{boundaryHandleCount} 个边界控制柄</output>
    {drawing.vertices.length > 0 && <div style={{ position: 'absolute', top: 34, left: 14, padding: 8, background: '#fff', border: '1px solid #c9d6d8', borderRadius: 6, zIndex: 2 }}>
      <span>{isRectangleTool(props.tool) ? '再点击对角点；Esc 取消' : `${drawing.vertices.length} 个顶点 · Enter 完成`}</span>
      {!isRectangleTool(props.tool) && <button onClick={drawing.finish} disabled={drawing.vertices.length < 3 || props.readonly}>完成多边形</button>}
      <button onClick={drawing.cancel}>取消绘制</button>{drawing.error && <p role="alert">{drawing.error}</p>}
    </div>}
    {props.pointPick && <div className="point-pick-instruction" role="status">{pickNotice || (props.pointPick.mode === 'existing' ? '点选已有节点或关联点以绑定；不会新增节点。' : '点选专用节点位置；确认创建前仅是草稿，不自动拆路或连接。')}</div>}
    <div className="canvas-label">LOCAL XY · 米制 · Z ↑</div>
    <output ref={cursorOutput} className="canvas-cursor" data-testid="cursor-position">本地 XY · 米制</output>
    {details && cardRect && props.labelMode !== 'off' && !props.frameCamera.navigating && !pressed.current && <div className="focus-details" style={{ left: cardRect.x, top: cardRect.y, right: 'auto' }} role="tooltip" data-testid="focus-details"><strong>{details.name || details.id}</strong><code>{details.id}</code><span>{details.source}</span></div>}
    <output className="sr-only" data-testid="display-state" data-navigating={props.frameCamera.navigating} data-visible={display.keys.size} data-culled={display.culledCount} data-lod={display.lodCount} data-labels={labels.labels.length} data-candidates={labels.candidateCount} data-measurements={labels.measurementCount} data-cache-size={measurer.size}/>

    {(unprojectable > 0 || unprojectableWidths > 0 || widthRangeIssues.length > 0) && <div className="projection-warning" data-testid="projection-warning" role="status">
      {unprojectable > 0 && <div>{unprojectable} 个对象超出屏幕数值范围，JSON 完整保留；请数值调整坐标。</div>}
      {unprojectableWidths > 0 && <div>{unprojectableWidths} 条声明宽度超出屏幕数值范围，仅显示辅助线；JSON 数值完整保留。</div>}
      {widthRangeIssues.map(issue => <div key={issue}>{issue}</div>)}
    </div>}
    <div className="scale-label" data-testid="road-display-legend">{roundTick(step)} m 网格 · 道路带 = 声明宽度 × 比例<br/>
      圆端 / 圆连接近似带；不代表实测路口或车辆扫掠<br/>
      {unknownWidths > 0 && <span data-testid="unknown-road-widths">{unknownWidths} 条道路宽度未知 / 不适用 / 无限制：显示时用辅助虚线<br/></span>}
      道路带重叠不自动连通；点边缘仅取坐标，不接入中部
      {shapePreview && <span data-testid="road-shape-preview"><br/>折点预览 · 应用属性后写入地图</span>}
    </div>
    <output className="sr-only" data-testid="path-overlay" data-map-hash={props.routePreview?.mapContentHash ?? ''} data-points={props.routePreview?.points.length ?? 0}/>
    <output className="sr-only" data-testid="diagnostic-marker" data-position={JSON.stringify(props.diagnosticPosition ?? null)}/>
    <output className="sr-only" data-testid="camera-state" data-offset-x={props.camera.offsetX} data-offset-y={props.camera.offsetY} data-scale={props.camera.scale}>{JSON.stringify(props.camera)}</output>
  </div>;
}