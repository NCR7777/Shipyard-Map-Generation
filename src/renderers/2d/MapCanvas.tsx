import { selectionCandidates, cycleSelection, type SelectionCycle } from '../../geometry/selectionHits';
import { useCrossingPreview } from './useCrossingPreview';
import { useMeasurement, MeasurementOverlay } from './MeasurementOverlay';
import { roadWidthHandle, widthFromRoadHandle } from './roadWidthHandles';
import { BackgroundImages, BackgroundControls, type BackgroundCanvasProps } from './BackgroundCanvas';
import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { useFrameCamera } from '../../ui/useFrameCamera';
import { useCurrentCallback } from '../../ui/useCurrentCallback';
import { createDisplayIndex, selectDisplay, layoutLabels, createTextMeasurer, type ScreenRect, type DisplayGeometry } from './display';
import { Stage, Layer, Circle, Line, Text, Arrow, Path, Group } from 'react-konva';
import Konva from 'konva';

// Middle button belongs exclusively to viewport panning in this editor.
Konva.dragButtons = [0];
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import type { SceneSnapshot, SceneItem, SceneKind } from '../../adapters/contracts';
import type { Polygon, Vec3, RoadGeometry } from '../../domain/model';
import type { DrawingConfig } from '../../editor/projectController';
import { SpatialLayer, AssociatedPointLayer, DeclaredLayer, type SpatialLayerProps } from './SpatialLayer';
import { useSpatialDrawing, isSpatialTool, isRectangleTool, isOrientedRectangleTool, orientedRectangleVertices, snapPosition, type SnapOptions } from './useSpatialDrawing';
import { SELECTION_KINDS, type Selection } from '../../domain/commands';
import { pointAt, tangentAt, projectToPath, flattenPath, immutablePathCopy, type ResolvedPath } from '../../geometry/roadPath';
import { previewDraftPath, lastDraftJoin, type DraftRoad, type TraceConnection } from '../../editor/roadDrawing';
export type { DraftRoad, TraceConnection } from '../../editor/roadDrawing';
import { RoadGeometryHandles } from './RoadGeometryHandles';
import { rectangleFrame } from '../../geometry/rectangles';
import { BoundaryHandles, type BoundaryTarget, type BoundaryPreview } from './BoundaryHandles';
import { screenToWorld, worldToScreen, zoomAt, type Camera, type Vec2 } from '../../geometry/coordinates';

export type Tool = 'select' | 'node' | 'road' | 'curve' | 'measure' | 'pan' | 'facilityRect' | 'facilityPolygon' | 'zoneRect' | 'zonePolygon' | 'facilityOrientedRect' | 'zoneOrientedRect';
export const isRoadTool = (tool: Tool) => tool === 'road' || tool === 'curve';
export type PointPickResult = { nodeId: string } | { position: Vec3 } | { roadId: string; distanceM: number; position: Vec3 };
export interface PointPick { mode: 'existing' | 'new' | 'road' | 'path' | 'relocate'; nodeId?: string; position?: Vec3; selectedRoadIds?: string[]; eligibleRoadIds?: string[] }
export type TopologyTarget = { kind: 'nodes'; id: string; position: Vec3 } | { kind: 'roads'; id: string; position: Vec3; distanceM: number };
interface Props {
  onPointIdentities?: SpatialLayerProps['onPointIdentities'];
  canEditRoad?: (id: string) => boolean;
  onRoadWidthCommit?: (id: string, widthM: number, baseChangeToken: number) => boolean;
  onRoadFinish?: () => void;
  onRoadGeometryCommit?: (id: string, geometry: RoadGeometry, baseChangeToken: number) => boolean;
  runtime?: { mapContentHash: string; runId: string; timeS: number; vehicles: { vehicleId: string; state: string; position: Vec3; yawRad: number; route: ResolvedPath | null }[] } | null;
  accessPreview?: Vec3[][];
  repairPreview?: { kind: 'facilities' | 'zones'; id: string; boundary: Polygon; points: Vec3[] } | null;
  backgrounds?: Omit<BackgroundCanvasProps, 'camera' | 'readCamera'>; comparisonMode?: boolean;
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
  fillOpacity?: Pick<DrawingConfig, 'roadFillOpacity' | 'facilityFillOpacity' | 'zoneFillOpacity'>;
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
  onRoadPoint: (point: Vec3, connection?: TraceConnection, finish?: boolean, disconnect?: boolean) => void;
  onTranslate: (delta: Vec3, baseChangeToken: number) => void;
  onDuplicate?: (delta: Vec3, baseChangeToken: number) => void;
  topologySnap?: boolean;
  lockedTypes?: readonly SceneKind[];
  onTopologyDrop?: (nodeId: string, target: TopologyTarget, baseChangeToken: number) => void;
  splitPickRoadId?: string;
  onSplitPick?: (distanceM: number) => void;
  onDragRejected?: (kind: keyof Selection, id: string) => void;
  draftRoad: DraftRoad | null;
  traceCrossingsEnabled?: boolean;
  traceCrossings?: (points: Vec3[], geometry?: RoadGeometry) => Vec3[];
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
function pathData(path: ResolvedPath, camera: Camera): string {
  const start = worldToScreen(path.anchors[0]!, camera);
  return `M ${start[0]} ${start[1]} ` + path.spans.map((span, index) => { const end = worldToScreen(path.anchors[index + 1]!, camera); if (span.kind === 'line') return `L ${end[0]} ${end[1]}`; const a = worldToScreen(span.control1, camera), b = worldToScreen(span.control2, camera); return `C ${a[0]} ${a[1]} ${b[0]} ${b[1]} ${end[0]} ${end[1]}`; }).join(' ');
}
function projectRoad(road: SceneSnapshot['roads'][number], point: Vec3) { const projected = projectToPath(road.path, point); return { ...projected, position: projected.point, distanceM: projected.sM }; }
function tickStep(scale: number): number {
  const raw = 70 / scale; const magnitude = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= raw)!;
}
function roundTick(value: number): string { return Number(value.toPrecision(8)).toString(); }

export function MapCanvas(props: Props) {
  const [backgroundPreview, setBackgroundPreview] = useState<{ id: string; transform: import('../../geometry/backgrounds').BackgroundTransform } | null>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const stage = useRef<KonvaStage>(null);
  const pan = useRef<{ pointer: Vec2 } | null>(null);
  const dragStart = useRef<Vec3 | null>(null);
  const pressed = useRef(false);
  const altPressed = useRef(false);
  const shiftPressed = useRef(false);
  const rectangleStart = useRef<Vec2 | null>(null);
  const rectangleDragged = useRef(false);
  const dragToken = useRef(0);
  const [topologyTarget, setTopologyTarget] = useState<TopologyTarget | null>(null);
  const selectionCycle=useRef<SelectionCycle|null>(null),[cycleNotice,setCycleNotice]=useState('');
  useEffect(()=>{selectionCycle.current=null;setCycleNotice('');},[props.scene.mapContentHash,props.tool]);
  const inputCamera = useRef<Camera | null>(null);
  const cursorOutput = useRef<HTMLOutputElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [snapKey, setSnapKey] = useState<string | null>(null);
  const latest = useRef(props); latest.current = props;
  const preparedRoads=useMemo(()=>props.scene.roads.map(road=>({...road,path:immutablePathCopy(road.path)})),[props.scene.roads]);
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
    altPressed.current = 'altKey' in event && event.altKey;
    shiftPressed.current = 'shiftKey' in event && event.shiftKey;
    if (event.target instanceof HTMLCanvasElement) wrapper.current?.focus({ preventScroll: true });
    const button = 'button' in event ? event.button : 0;
    if (button === 0 && props.tool !== 'pan') pressed.current = true;
    hover(null);
  }
  function captureEnd() { consumeCamera(); pressed.current = false; }

  const [size, setSize] = useState({ width: 800, height: 540 });
  const measurement = useMeasurement(props.tool==='measure', props.scene.mapId);
  useEffect(()=>{const key=(event:KeyboardEvent)=>{if(event.defaultPrevented||(event.target as HTMLElement).closest('input,textarea,select,[contenteditable="true"]'))return;if(measurement.handleKey(event.key))event.preventDefault();};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);},[measurement.handleKey]);
  const [pathPreview, setPathPreview] = useState<{ roadId: string; path: ResolvedPath; mapContentHash: string } | null>(null);
  const widthDragging = useRef(false);
  const [widthPreview, setWidthPreview] = useState<{ roadId: string; widthM: number } | null>(null);
  const [traceDisconnected, setTraceDisconnected] = useState(false);
  const [traceTarget, setTraceTarget] = useState<TopologyTarget | null>(null);
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
      pan.current = null; pressed.current = false; dragStart.current = null; setTopologyTarget(null); setTraceTarget(null); setWidthPreview(null); widthDragging.current = false;
      if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
      hoverTimer.current = null; setHoverKey(null); setPreviewDelta(null); setPathPreview(null);
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
    setPathPreview(null); dragStart.current = null; setPreviewDelta(null); setTopologyTarget(null); setTraceTarget(null); setWidthPreview(null); widthDragging.current = false;
    stage.current?.find((node: Konva.Node) => node.isDragging()).forEach(node => node.stopDrag());
  }, [props.draftResetToken, props.scene.mapContentHash, props.boundaryChangeToken, props.selection, props.readonly, props.tool]);
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
    for (const road of preparedRoads) if (props.selection.roads.includes(road.id)) {
      ids.add(road.fromNodeId); ids.add(road.toNodeId);
    }
    return ids;
  }, [props.selection, preparedRoads, props.movingNodeIds]);
  function position(id: string, original: Vec3): Vec3 {
    if (!previewDelta || !selectedNodeIds.has(id)) return original;
    return [original[0] + previewDelta[0], original[1] + previewDelta[1], original[2] + previewDelta[2]];
  }
  const nodeById = useMemo(() => new Map(props.scene.nodes.map(n => [n.id, n])), [props.scene.nodes]);
  const activeShapePreview = props.roadShapePreview;
  const shapePreview = activeShapePreview?.mapContentHash === props.scene.mapContentHash
    && props.selection.roads.includes(activeShapePreview.roadId) ? activeShapePreview : null;
  function resolvedPath(road: SceneSnapshot['roads'][number]): ResolvedPath {
    let path = pathPreview?.roadId === road.id && pathPreview.mapContentHash === props.scene.mapContentHash ? pathPreview.path : road.path;
    if (shapePreview?.roadId === road.id && path.spans.every(span => span.kind === 'line')) path = { anchors: [path.anchors[0]!, ...shapePreview.shapePoints, path.anchors.at(-1)!], spans: Array.from({length:shapePreview.shapePoints.length+1},()=>({kind:'line' as const})) };
    if (!previewDelta) return path;
    const delta=previewDelta, rigid=props.rigidRoadIds?.includes(road.id) || props.selection.roads.includes(road.id);
    const move=(p:Vec3):Vec3=>[p[0]+delta[0],p[1]+delta[1],p[2]+delta[2]];
    return {anchors:path.anchors.map((p,i)=>i===0?position(road.fromNodeId,p):i===path.anchors.length-1?position(road.toNodeId,p):rigid?move(p):p),spans:path.spans.map((span,i)=>span.kind==='line'?span:{kind:'cubic',control1:rigid||i===0&&selectedNodeIds.has(road.fromNodeId)?move(span.control1):span.control1,control2:rigid||i===path.spans.length-1&&selectedNodeIds.has(road.toNodeId)?move(span.control2):span.control2})};
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
    if (!props.readonly && !props.pointPick && !props.backgrounds?.adjustingId && isRectangleTool(props.tool) && !isOrientedRectangleTool(props.tool) && !drawing.vertices.length && event.evt.button === 0) rectangleStart.current = pointer();
    if ((!props.pointPick && props.tool === 'pan') || event.evt.button === 1) {
      const point = pointer(); if (point) pan.current = { pointer: point };
      event.evt.preventDefault();
    }
  }
  function handleStageUp() {
    pan.current = null;
    const start = rectangleStart.current, end = pointer(); rectangleStart.current = null;
    if (start && end && Math.hypot(end[0] - start[0], end[1] - start[1]) > 5) {
      const view = props.frameCamera.read();
      drawing.dragRectangle(snapPosition(start, view, props.scene.nodes, props.snap).world, snapPosition(end, view, props.scene.nodes, props.snap).world);
      rectangleDragged.current = true;
    }
  }
  function cycleAtPointer(advance=false,reverse=false): boolean {
    const screen=advance?selectionCycle.current?.screen:pointer();if(!screen||props.tool!=='select'||props.pointPick||props.splitPickRoadId)return false;
    const hits=selectionCandidates({...props.scene,roads:preparedRoads},screen,props.frameCamera.read(),{visibleKeys:display.keys,hiddenTypes:props.hiddenTypes,showRoadBands:props.roadDisplay.showRoadBands,showRoadCenterlines:props.roadDisplay.showRoadCenterlines});
    const result=cycleSelection(hits,screen,props.scene.mapContentHash,selectionCycle.current,{advance,reverse});selectionCycle.current=result.cycle;
    setCycleNotice(hits.length>1?'叠放对象 '+((result.cycle?.index??0)+1)+' / '+hits.length+' · 再点同处或 Tab 切换，Shift+Tab 返回':'');
    if(!result.hit)return false;props.onSelect(result.hit.kind,result.hit.id,false);return true;
  }
  function selectCanvasObject(kind:keyof Selection,id:string,additive:boolean){
    if(additive){selectionCycle.current=null;setCycleNotice('');props.onSelect(kind,id,true);return;}
    if(!cycleAtPointer())props.onSelect(kind,id,false);
  }
  function inspectCanvasObject(item:SceneItem){if(!shiftPressed.current&&cycleAtPointer())return;props.onInspect?.(item);}
  function handleStageClick(event: KonvaEventObject<MouseEvent>) {
    if (props.backgrounds?.adjustingId || boundaryActiveRef.current || event.target !== event.target.getStage() || event.evt.button !== 0) return;
    const screen = pointer(); if (!screen) return;
    if (props.tool==='measure'){measurement.addPoint(screenToWorld(screen,props.frameCamera.read()));return;}
    if (props.splitPickRoadId) { pickSplit(screen); return; }
    drawAt(screen, event.evt.altKey, event.evt.detail > 1, event.evt.shiftKey);
  }
  function pickNode(id: string) {
    if (!props.pointPick || props.readonly) return;
    if (props.pointPick.mode === 'relocate') { const screen = pointer(); if (screen) props.onPointPick?.({ position: snapPosition(screen, props.frameCamera.read(), props.scene.nodes, { gridM: props.snap?.gridM ?? null, nodes: false }).world }); return; }
    if (props.pointPick.mode === 'existing' || props.pointPick.mode === 'road') props.onPointPick?.({ nodeId: id });
    else {
      const node = nodeById.get(id);
      if (node && props.pointPick.mode === 'new') props.onPointPick?.({ position: [...node.position] });
    }
  }
  function drawAt(screen: Vec2, altKey = altPressed.current, finish = false, shift = shiftPressed.current) {
    if (rectangleDragged.current) { rectangleDragged.current = false; return; }
    if (props.backgrounds?.adjustingId || boundaryActiveRef.current) return;
    if (props.pointPick) {
      if (props.readonly) return;
      if (props.pointPick.mode === 'new' || props.pointPick.mode === 'relocate') props.onPointPick?.({ position: snapPosition(screen, props.frameCamera.read(), props.scene.nodes, props.pointPick.mode === 'relocate' ? { gridM: props.snap?.gridM ?? null, nodes: false } : props.snap).world });
      else setPickNotice('请选择已有节点或入口/服务点标记；背景、道路中部和附近坐标不代表已有节点。');
      return;
    }
    if (props.tool === 'select') {if(!cycleAtPointer())props.onClearSelection();return;}
    const { world } = snapPosition(screen, props.frameCamera.read(), props.scene.nodes, props.snap);
    if (isSpatialTool(props.tool)) drawing.click(world, screen, finish, shift);
    else if (props.tool === 'node' && !props.readonly) props.onAddNode(world);
    else if (isRoadTool(props.tool) && !props.readonly) {
      const target = traceCandidate(screen, altKey);
      props.onRoadPoint(target?.position ?? (altKey ? screenToWorld(screen, props.frameCamera.read()) : world), target ? target.kind === 'nodes' ? { kind: 'node', nodeId: target.id } : { kind: 'road', roadId: target.id, distanceM: target.distanceM } : undefined, finish, altKey);
    }
  }
  const draftPath = useMemo(()=>props.draftRoad ? previewDraftPath(props.draftRoad, props.tool==='curve'?'curve':'road', rubberEnd) : null,[props.draftRoad,props.tool,rubberEnd]);
  const draftJoin = draftPath ? lastDraftJoin(draftPath) : null;
  const crossingPreview = useCrossingPreview(draftPath,props.scene.mapContentHash,props.traceCrossingsEnabled!==false&&!!props.draftRoad&&!props.draftRoad.disconnect&&!traceDisconnected,props.traceCrossings);
  const keepKeys = useMemo(() => {
    const keys = new Set(SELECTION_KINDS.flatMap(kind => (props.selection[kind] ?? []).map(id => kind + '/' + id)));
    for (const id of selectedNodeIds) keys.add('nodes/' + id);
    if (props.inspectKey) keys.add(props.inspectKey);
    if (snapKey) keys.add(snapKey);
    if (props.draftRoad?.fromNodeId) keys.add('nodes/' + props.draftRoad.fromNodeId);
    return keys;
  }, [props.selection, selectedNodeIds, props.inspectKey, snapKey, props.draftRoad]);
  const overrides = new Map<string, DisplayGeometry>(), offsets = new Map<string, Vec3>();
  if (props.repairPreview) overrides.set(props.repairPreview.kind + '/' + props.repairPreview.id, { polygons: [props.repairPreview.boundary] });
  if (boundaryPreview) overrides.set(boundaryPreview.kind + '/' + boundaryPreview.id, { polygons: [boundaryPreview.boundary] });
  if (shapePreview || pathPreview || previewDelta) for (const road of preparedRoads) {
    if (shapePreview?.roadId !== road.id && pathPreview?.roadId !== road.id && !(previewDelta && (selectedNodeIds.has(road.fromNodeId) || selectedNodeIds.has(road.toNodeId)))) continue;
    overrides.set('roads/' + road.id, { lines: [flattenPath(resolvedPath(road), 0.05).samples.map(sample => sample.position)] });
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
    editingNodes: !!props.pointPick || isRoadTool(props.tool), offsets, geometryOverrides: overrides });
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
  const projectedRoads = preparedRoads.filter(road => display.keys.has('roads/' + road.id)).map(road => {
    const widthM = widthPreview?.roadId === road.id ? { state: 'known' as const, value: widthPreview.widthM } : road.widthM;
    const pixels = widthM.state === 'known' ? widthM.value * props.camera.scale : null;
    const path = resolvedPath(road);
    return { ...road, path, screenPoints: path.anchors.flatMap(p => worldToScreen(p, props.camera)), pathData: pathData(path, props.camera), bandWidthPx: pixels !== null && Number.isFinite(pixels) && pixels > 0 ? pixels : null };
  });
  const visibleRoads = projectedRoads.filter(road => road.screenPoints.every(Number.isFinite));
  const unprojectableWidths = visibleRoads.filter(road => road.widthM.state === 'known' && road.bandWidthPx === null).length;
  const widthControls = !props.readonly && !props.hasUnappliedInput && !props.pointPick && !props.draftRoad && !props.splitPickRoadId && !props.lockedTypes?.includes('roads') && props.tool === 'select' && props.selection.roads.length === 1
    ? visibleRoads.filter(road => props.selection.roads.includes(road.id) && (props.canEditRoad?.(road.id) ?? true)).flatMap(road => {
      if (road.widthM.state !== 'known') return [];
      const widthM = road.widthM.value;
      const middle = Math.floor(road.path.spans.length / 2), center = pointAt(road.path, middle, 0.5), tangent = tangentAt(road.path, middle, 0.5);
      if (Math.hypot(tangent[0], tangent[1]) <= 1e-9) return [];
      return ([-1, 1] as const).map(sign => ({ roadId: road.id, ...roadWidthHandle(center, tangent, widthM, sign, props.camera, widthPreview?.roadId === road.id ? widthPreview.widthM : undefined) }));
    }) : [];
  const unknownWidths = useMemo(() => preparedRoads.filter(road => road.widthM.state !== 'known').length, [preparedRoads]);
  const widthRangeIssues = useMemo(() => props.scene.missingCapabilities.filter(issue => issue.startsWith('ROAD_WIDTH_VISUAL_RANGE:')), [props.scene.missingCapabilities]);
  const unprojectable = display.unprojectableCount;
  function pickSplit(screen: Vec2) {
    const road = preparedRoads.find(value => value.id === props.splitPickRoadId);
    if (!road || props.hiddenTypes?.includes('roads') || props.lockedTypes?.includes('roads') || (!props.roadDisplay.showRoadBands && !props.roadDisplay.showRoadCenterlines)) return;
    const projected = projectRoad(road, screenToWorld(screen, props.frameCamera.read()));
    if (!projected || projected.ambiguous || projected.offsetM * props.frameCamera.read().scale > 12) { setPickNotice('请在所选道路中心线 12 CSS 像素内点击。'); return; }
    if (projected.distanceM <= 1e-6 || projected.distanceM >= road.lengthM - 1e-6) { setPickNotice('切分点必须位于道路内部；端点请使用节点合并。'); return; }
    setPickNotice(''); props.onSplitPick?.(projected.distanceM);
  }
  function traceCandidate(screen: Vec2, altKey: boolean): TopologyTarget | null {
    if (altKey || !props.snap?.nodes || props.tool==='curve'&&props.draftRoad?.curveEnd) return null;
    const camera = props.frameCamera.read(), z = props.draftRoad?.points[0]?.[2] ?? 0;
    const world = screenToWorld(screen, camera, z);
    let best: TopologyTarget | null = null, distance = 12;
    if (!props.hiddenTypes?.includes('nodes') && !props.lockedTypes?.includes('nodes')) for (const node of props.scene.nodes) {
      if (Math.abs(node.position[2] - z) > 1e-6 || props.draftRoad?.points.length === 1 && props.draftRoad.startConnection?.kind === 'node' && node.id === props.draftRoad.startConnection.nodeId) continue;
      const p = worldToScreen(node.position, camera), delta = Math.hypot(p[0] - screen[0], p[1] - screen[1]);
      if (delta <= distance) { best = { kind: 'nodes', id: node.id, position: node.position }; distance = delta; }
    }
    if (best) return best;
    if (!props.hiddenTypes?.includes('roads') && !props.lockedTypes?.includes('roads')) for (const road of preparedRoads) {
      if (!(props.canEditRoad?.(road.id) ?? true)) continue;
      const projected = projectRoad(road, world);
      if (!projected || projected.ambiguous || Math.abs(projected.position[2] - z) > 1e-6 || projected.distanceM <= 1e-6 || projected.distanceM >= road.lengthM - 1e-6) continue;
      const delta = projected.offsetM * camera.scale;
      if (delta < distance) { best = { kind: 'roads', id: road.id, position: projected.position, distanceM: projected.distanceM }; distance = delta; }
    }
    return best;
  }
  function topologyCandidate(screen: Vec2, nodeId: string, z: number): TopologyTarget | null {
    if (!props.topologySnap || props.selection.nodes.length !== 1 || props.selection.nodes[0] !== nodeId
      || SELECTION_KINDS.some(kind => kind !== 'nodes' && props.selection[kind]?.length)) return null;
    const camera = props.frameCamera.read(); const world = screenToWorld(screen, camera, z);
    let best: TopologyTarget | null = null; let distance = 12;
    if (!props.hiddenTypes?.includes('nodes') && !props.lockedTypes?.includes('nodes')) for (const node of props.scene.nodes) {
      if (node.id === nodeId || !display.keys.has('nodes/' + node.id) || Math.abs(node.position[2] - z) > 1e-6) continue;
      const [x, y] = worldToScreen(node.position, camera); const delta = Math.hypot(x - screen[0], y - screen[1]);
      if (delta <= distance) { distance = delta; best = { kind: 'nodes', id: node.id, position: node.position }; }
    }
    if (!props.hiddenTypes?.includes('roads') && !props.lockedTypes?.includes('roads')
      && (props.roadDisplay.showRoadBands || props.roadDisplay.showRoadCenterlines)) for (const road of preparedRoads) {
      if (!display.keys.has('roads/' + road.id) || road.fromNodeId === nodeId || road.toNodeId === nodeId) continue;
      const projected = projectRoad(road, world);
      if (!projected || projected.ambiguous || Math.abs(projected.position[2] - z) > 1e-6 || projected.distanceM <= 1e-6 || projected.distanceM >= road.lengthM - 1e-6) continue;
      const delta = projected.offsetM * camera.scale;
      if (delta < distance) { distance = delta; best = { kind: 'roads', id: road.id, position: projected.position, distanceM: projected.distanceM }; }
    }
    return best;
  }
  function roadClick(event: KonvaEventObject<MouseEvent>, id: string) {
    if (event.evt.button !== 0) return;
    if (props.splitPickRoadId) { event.cancelBubble = true; const screen = pointer(); if (screen) pickSplit(screen); }
    else if (props.pointPick) {
      event.cancelBubble = true; const screen = pointer();
      if (screen && !props.readonly && (props.pointPick.mode === 'road' || props.pointPick.mode === 'path')) {
        if (props.lockedTypes?.includes('roads')) { setPickNotice('道路已锁定，请先解除该类型锁定。'); return; }
        const road = preparedRoads.find(road => road.id === id);
        const projected = road && projectRoad(road, screenToWorld(screen, props.frameCamera.read()));
        if (projected && !projected.ambiguous) props.onPointPick?.({ roadId: id, distanceM: projected.distanceM, position: projected.position });
      } else if (screen) drawAt(screen);
    }
    else if (props.tool === 'select') { event.cancelBubble = true; selectCanvasObject('roads', id, event.evt.shiftKey); }
    else if (!props.readonly && (props.tool === 'node' || isRoadTool(props.tool) || isSpatialTool(props.tool))) {
      const screen = pointer(); if (!screen) return; event.cancelBubble = true; drawAt(screen, event.evt.altKey, event.evt.detail > 1, event.evt.shiftKey);
    }
  }
  // Shared handlers keep Konva subscriptions stable; each dispatch sees current guards.
  const onRoadClick = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => roadClick(event, event.currentTarget.getAttr('roadId') as string));
  const onRoadEnter = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => hover('roads/' + event.currentTarget.getAttr('roadId')));
  const onShapeLeave = useCurrentCallback(() => hover(null));
  const onNodeEnter = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => hover('nodes/' + event.currentTarget.getAttr('nodeId')));
  const onNodeDown = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => {
    const id = event.currentTarget.getAttr('nodeId') as string;
    const selected = props.selection.nodes.includes(id) || props.pointPick?.nodeId === id;
    if (event.evt.button === 0 && !props.pointPick && !props.splitPickRoadId && props.tool === 'select') {
      if (!selected || event.evt.shiftKey) props.onSelect('nodes', id, event.evt.shiftKey);
      else if (props.canDrag && !props.canDrag('nodes', id)) props.onDragRejected?.('nodes', id);
    }
  });
  const onNodeClick = useCurrentCallback((event: KonvaEventObject<MouseEvent>) => {
    if (event.evt.button !== 0) return;
    const id = event.currentTarget.getAttr('nodeId') as string;
    if (props.splitPickRoadId) { event.cancelBubble = true; const screen = pointer(); if (screen) pickSplit(screen); }
    else if (props.pointPick) { event.cancelBubble = true; pickNode(id); }
    else if (isRoadTool(props.tool) && !props.readonly) { event.cancelBubble = true; const screen = pointer(); if (screen) drawAt(screen, event.evt.altKey, event.evt.detail > 1, event.evt.shiftKey); }
    else if (props.tool === 'select') { event.cancelBubble = true; if (!event.evt.shiftKey) selectCanvasObject('nodes', id, false); }
    else if (isSpatialTool(props.tool)) { const screen = pointer(); if (screen) { event.cancelBubble = true; drawAt(screen, event.evt.altKey, event.evt.detail > 1, event.evt.shiftKey); } }
  });
  const onNodeDragStart = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    const node = nodeById.get(event.currentTarget.getAttr('nodeId') as string);
    if (node) { dragStart.current = [...node.position]; dragToken.current = props.boundaryChangeToken; }
  });
  const onNodeDragMove = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    if (!dragStart.current) return;
    const screen: Vec2 = [event.target.x(), event.target.y()];
    const target = topologyCandidate(screen, event.currentTarget.getAttr('nodeId') as string, dragStart.current[2]);
    setTopologyTarget(target);
    const value = target?.position ?? snapPosition(screen, props.frameCamera.read(), props.scene.nodes, props.snap, selectedNodeIds, dragStart.current[2]).world;
    setPreviewDelta([value[0] - dragStart.current[0], value[1] - dragStart.current[1], 0]);
  });
  const onNodeDragEnd = useCurrentCallback((event: KonvaEventObject<DragEvent>) => {
    const origin = dragStart.current; dragStart.current = null; setPreviewDelta(null); setTopologyTarget(null); setTraceTarget(null); setWidthPreview(null); widthDragging.current = false;
    if (!origin || dragToken.current !== props.boundaryChangeToken) return;
    const nodeId = event.currentTarget.getAttr('nodeId') as string;
    const target = topologyCandidate([event.target.x(), event.target.y()], nodeId, origin[2]);
    if (target && !altPressed.current) { props.onTopologyDrop?.(nodeId, target, dragToken.current); return; }
    const value = snapPosition([event.target.x(), event.target.y()], props.frameCamera.read(), props.scene.nodes, props.snap, selectedNodeIds, origin[2]).world;
    (altPressed.current ? props.onDuplicate : props.onTranslate)?.([value[0] - origin[0], value[1] - origin[1], 0], dragToken.current);
  });
  const spatialProps: SpatialLayerProps = {
    onPointIdentities: props.onPointIdentities, comparisonMode: props.comparisonMode, fillOpacity: props.fillOpacity, hiddenTypes: props.hiddenTypes, visibleKeys: display.keys, onHover: hover, canDrag: props.canDrag,
    scene: props.scene, camera: props.camera, selection: props.selection, previewDelta, boundaryPreview,
    snap: props.snap, readonly: props.readonly, selecting: !props.pointPick && props.tool === 'select', drawingRoad: !props.pointPick && isRoadTool(props.tool), movingNodeIds: selectedNodeIds,
    disableDrag: !!props.splitPickRoadId || props.hasUnappliedInput || boundaryActive, pickingPoint: !!props.pointPick, onPickNode: pickNode,
    onSelect: props.onSelect, onClickSelect:selectCanvasObject, onRoadNode: () => { const p = pointer(); if (p) drawAt(p); }, onDrawClick: () => { const p = pointer(); if (p) drawAt(p); },
    onDragStart: origin => { dragStart.current = origin; dragToken.current = props.boundaryChangeToken; }, onPreview: setPreviewDelta,
    onDragEnd: delta => { const active = dragStart.current; dragStart.current = null; if (active && dragToken.current === props.boundaryChangeToken) (altPressed.current ? props.onDuplicate : props.onTranslate)?.(delta, dragToken.current); },
  };
  const firstVertex = drawing.vertices[0];
  const spatialPreview = isOrientedRectangleTool(props.tool) && drawing.vertices.length === 2 && rubberEnd
    ? (() => { try { const vertices = orientedRectangleVertices(drawing.vertices[0]!, drawing.vertices[1]!, rubberEnd); return [...vertices, vertices[0]!]; } catch { return drawing.vertices; } })()
    : isRectangleTool(props.tool) && !isOrientedRectangleTool(props.tool) && firstVertex && rubberEnd
    ? [firstVertex, [rubberEnd[0], firstVertex[1], 0] as Vec3, rubberEnd, [firstVertex[0], rubberEnd[1], 0] as Vec3, firstVertex]
    : [...drawing.vertices, ...(rubberEnd && drawing.vertices.length ? [rubberEnd] : [])];
  return <div tabIndex={0} onKeyDown={event=>{if(event.key==='Tab'&&event.target===wrapper.current&&(selectionCycle.current?.keys.length??0)>1&&cycleAtPointer(true,event.shiftKey))event.preventDefault();}} onPointerDownCapture={captureStart} onMouseDownCapture={captureStart} onTouchStartCapture={captureStart} onPointerUpCapture={captureEnd} onMouseUpCapture={captureEnd} onTouchEndCapture={captureEnd} ref={wrapper} className={`canvas-surface tool-${props.tool}`} data-testid="map-canvas" aria-label="米制地图画布">
    <Stage ref={stage} width={size.width} height={size.height}
      onMouseDown={handleStageDown} onMouseUp={handleStageUp} onMouseLeave={() => { pan.current = null; hover(null); measurement.movePointer(null); if (cursorOutput.current) cursorOutput.current.textContent = '本地 XY · 米制'; }}
      onClick={handleStageClick}
      onMouseMove={event => {
        if (boundaryActiveRef.current) return;
        const point = pointer(); if (!point) return;
        if (pan.current) {
          const previous = pan.current.pointer;
          props.frameCamera.queue(current => ({ ...current, offsetX: current.offsetX + point[0] - previous[0], offsetY: current.offsetY + point[1] - previous[1] }));
          pan.current.pointer = point;
          return;
        }
        if(props.tool==='measure'){measurement.movePointer(screenToWorld(point,props.frameCamera.read()));return;}
        const drawingPointer = !!props.pointPick || props.tool === 'node' || isRoadTool(props.tool) || isSpatialTool(props.tool);
        const snapped = drawingPointer ? snapPosition(point, props.frameCamera.read(), props.scene.nodes, props.pointPick?.mode === 'relocate' ? { gridM: props.snap?.gridM ?? null, nodes: false } : props.snap) : null;
        const world = snapped?.world ?? screenToWorld(point, props.frameCamera.read());
        if (cursorOutput.current) cursorOutput.current.textContent = `X ${world[0].toFixed(3)} m · Y ${world[1].toFixed(3)} m`;
        if (drawingPointer) { setTraceDisconnected(event.evt.altKey); const target = isRoadTool(props.tool) ? traceCandidate(point, event.evt.altKey) : null; setTraceTarget(target); setRubberEnd(isSpatialTool(props.tool) ? drawing.project(world, event.evt.shiftKey) : target?.position ?? world); setSnapKey(target ? target.kind + '/' + target.id : snapped?.nodeId ? 'nodes/' + snapped.nodeId : null); }
      }}
      onWheel={event => {
        event.evt.preventDefault();
        if (pressed.current || dragStart.current || boundaryActiveRef.current || event.evt.deltaY === 0) return;
        const point = pointer(); if (!point) return;
        props.frameCamera.queue(current => zoomAt(current, point, Math.min(100, Math.max(Number.MIN_VALUE, current.scale * (event.evt.deltaY < 0 ? 1.15 : 1 / 1.15)))));
      }}>
      {props.backgrounds && <BackgroundImages items={props.backgrounds.items} camera={props.camera} preview={backgroundPreview}/>}
      <Layer listening={false} opacity={props.backgrounds?.items.length ? 0.3 : 1}>
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Line key={'grid-' + index} points={tick.axis === 'x' ? [tick.pixel, 0, tick.pixel, size.height] : [0, tick.pixel, size.width, tick.pixel]} stroke={Math.abs(tick.value) < 1e-9 ? '#8ba6b4' : '#e5edf1'} strokeWidth={Math.abs(tick.value) < 1e-9 ? 1.5 : 1} />)}
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Text key={'label-' + index} x={tick.axis === 'x' ? tick.pixel + 4 : 5} y={tick.axis === 'x' ? 6 : tick.pixel + 4} text={roundTick(tick.value)} fill="#7b8f9d" fontSize={10} />)}
      </Layer>
      <Layer listening={props.tool!=='measure' && !boundaryActive && !props.backgrounds?.adjustingId}>
        <DeclaredLayer listening={props.tool === 'select' && !props.pointPick} backdrop items={props.scene.items} visibleKeys={display.keys} onHover={hover} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} selectedKey={focusKey} onSelect={inspectCanvasObject} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        <SpatialLayer {...spatialProps} />
        {/* All bands precede all auxiliary lines, then nodes/associated points and edit handles.
            Round caps/joins form a width-derived approximation, never a surveyed junction disk. */}
        {props.roadDisplay.showRoadBands && visibleRoads.map(road => road.bandWidthPx !== null &&
          <Path key={road.id} roadId={road.id} name="road-band" data={road.pathData}
            stroke={props.selection.roads.includes(road.id) ? '#efbb82' : '#b7d0db'}
            opacity={(props.fillOpacity?.roadFillOpacity ?? 1) * (props.comparisonMode ? 0.25 : 1)} strokeWidth={road.bandWidthPx} hitStrokeWidth={Math.max(14, road.bandWidthPx)} lineCap="round" lineJoin="round"
            onMouseEnter={onRoadEnter} onMouseLeave={onShapeLeave} onClick={onRoadClick} />)}
        {visibleRoads.map(road => {
          // Unknown/unrestricted/not-applicable (or unprojectable) never become a fabricated band.
          const auxiliary = road.bandWidthPx === null, selected = props.selection.roads.includes(road.id);
          // Keep the selection cue visible when the displayed road band is transparent.
          if (!props.roadDisplay.showRoadCenterlines && !(props.roadDisplay.showRoadBands && (auxiliary || selected))) return null;
          return <Path key={road.id} roadId={road.id} name="road-centerline" data={road.pathData}
            stroke={props.pointPick?.selectedRoadIds?.includes(road.id) ? '#16834b' : props.pointPick?.eligibleRoadIds?.includes(road.id) ? '#078ca0' : selected ? '#ad5f17' : auxiliary ? '#a76c24' : '#216b88'}
            strokeWidth={2} hitStrokeWidth={14} dash={auxiliary ? [7, 5] : undefined} lineCap="round" lineJoin="round"
            onMouseEnter={onRoadEnter} onMouseLeave={onShapeLeave} onClick={onRoadClick} />;
        })}
        {props.roadDisplay.showRoadCenterlines && visibleRoads.filter(road => road.direction === 'forward' || road.direction === 'backward').map(road => {
          const spanIndex = Math.floor(road.path.spans.length / 2), center = pointAt(road.path, spanIndex, 0.5), tangent = tangentAt(road.path, spanIndex, 0.5);
          const [x,y] = worldToScreen(center, props.camera), dx = tangent[0], dy = -tangent[1], length = Math.hypot(dx,dy);
          if (length < 1e-9) return null; const sign = road.direction === 'forward' ? 1 : -1;
          return <Arrow key={'arrow/' + road.id} name="road-direction-arrow" points={[x - sign * dx / length * 8, y - sign * dy / length * 8, x + sign * dx / length * 8, y + sign * dy / length * 8]} pointerLength={6} pointerWidth={6} stroke="#216b88" fill="#216b88" listening={false}/>;
        })}
        <DeclaredLayer listening={props.tool === 'select' && !props.pointPick} items={props.scene.items} visibleKeys={display.keys} onHover={hover} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} selectedKey={focusKey} onSelect={inspectCanvasObject} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        {displayedNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          const selected = selectedNodeIds.has(node.id) || props.pointPick?.nodeId === node.id;
          return <Circle _useStrictMode nodeId={node.id} onMouseEnter={onNodeEnter} onMouseLeave={onShapeLeave} key={node.id} x={x} y={y} radius={selected ? 6.5 : 5} fill={selected ? '#e08128' : '#ffffff'} stroke={selected ? '#9a4c0d' : '#216b88'} strokeWidth={2} hitStrokeWidth={12}
            draggable={!props.splitPickRoadId && !boundaryActive && !props.hasUnappliedInput && !props.pointPick && props.tool === 'select' && !props.readonly && (props.canDrag?.('nodes', node.id) ?? true)}
            onMouseDown={onNodeDown} onClick={onNodeClick} onDragStart={onNodeDragStart} onDragMove={onNodeDragMove} onDragEnd={onNodeDragEnd} />;
        })}
        <AssociatedPointLayer {...spatialProps} />
        {widthControls.map(handle => {
          const move = (event: KonvaEventObject<DragEvent>) => { const world = screenToWorld([event.target.x(), event.target.y()], props.frameCamera.read(), handle.center[2]); const widthM = widthFromRoadHandle(handle, world); setWidthPreview({ roadId: handle.roadId, widthM }); return widthM; };
          return <Group key={handle.roadId + '/width/' + handle.sign}>
            <Line listening={false} points={[...handle.edgeScreen, ...handle.screen]} stroke="#087c54" strokeWidth={2}/>
            <Circle name="road-width-handle" x={handle.screen[0]} y={handle.screen[1]} radius={7} fill="#d5f1e5" stroke="#087c54" strokeWidth={2} draggable
              onMouseDown={event => { event.cancelBubble = true; }} onClick={event => { event.cancelBubble = true; }}
              onDragStart={() => { widthDragging.current = true; dragToken.current = props.boundaryChangeToken; }} onDragMove={move}
              onDragEnd={event => { if (widthDragging.current) props.onRoadWidthCommit?.(handle.roadId, move(event), dragToken.current); widthDragging.current = false; setWidthPreview(null); }}/>
          </Group>;
        })}

        {!props.readonly && !props.hasUnappliedInput && !props.pointPick && !props.draftRoad && !props.splitPickRoadId && !props.lockedTypes?.includes('roads') && (props.tool === 'select' || props.tool === 'curve') && props.selection.roads.length === 1 && visibleRoads.filter(road => props.selection.roads.includes(road.id) && (props.canEditRoad?.(road.id) ?? true)).map(road =>
          <RoadGeometryHandles key={road.id} allowCurves={props.scene.schemaVersion === '0.3.0'} roadId={road.id} path={road.path} camera={props.camera} readCamera={props.frameCamera.read} changeToken={props.boundaryChangeToken}
            onPreview={path=>setPathPreview(path?{roadId:road.id,path,mapContentHash:props.scene.mapContentHash}:null)}
            onCommit={(geometry,token)=>props.onRoadGeometryCommit?.(road.id,geometry,token)??false}/>) }

      </Layer>
      <Layer listening={false}>
        {props.tool==='measure'&&<MeasurementOverlay state={measurement.state} camera={props.camera}/>}
        {props.runtime?.mapContentHash === props.scene.mapContentHash && props.runtime.vehicles.map(vehicle => {
          const [x,y]=worldToScreen(vehicle.position,props.camera), color=vehicle.state==='gap'?'#9d7353':vehicle.state==='travel'?'#075cbb':'#ba780e';
          return <Group key={'vehicle/'+vehicle.vehicleId}>
            {vehicle.route&&<Path data={pathData(vehicle.route,props.camera)} stroke={color} strokeWidth={5} opacity={0.45}/>}
            <Group x={x} y={y} rotation={-vehicle.yawRad*180/Math.PI}><Arrow points={[-8,0,8,0]} pointerLength={9} pointerWidth={10} stroke={color} fill={color} strokeWidth={4}/></Group>
            <Text x={x+11} y={y-17} text={vehicle.vehicleId} fontSize={13} fill={color}/>
          </Group>;
        })}
        {props.routePreview?.mapContentHash === props.scene.mapContentHash && (() => {
          const points = props.routePreview.points.flatMap(point => worldToScreen(point, props.camera));
          return points.every(Number.isFinite) && points.length >= 4 ? <Line points={points} stroke={props.routePreview.confirmed ? '#1876ad' : '#c47e19'} strokeWidth={5} opacity={0.85} dash={props.routePreview.confirmed ? undefined : [10,6]}/> : null;
        })()}
        {crossingPreview.map((point, index) => { const [x, y] = worldToScreen(point, props.camera); return <Group key={'crossing/' + index}><Circle x={x} y={y} radius={9} fill="#c6ead940" stroke="#087c54" strokeWidth={2} dash={[3,2]}/><Text x={x-4} y={y-7} text="+" fontSize={14} fill="#087c54"/><Text x={x+12} y={y-6} text="连通" fontSize={11} fill="#087c54"/></Group>; })}
        {traceTarget && isRoadTool(props.tool) && (() => { const [x, y] = worldToScreen(traceTarget.position, props.camera); return <Circle x={x} y={y} radius={11} stroke="#0b975b" strokeWidth={3} dash={[3, 2]}/>; })()}
        {topologyTarget && (() => { const [x, y] = worldToScreen(topologyTarget.position, props.camera); return <Circle x={x} y={y} radius={12} stroke="#bd4a1c" strokeWidth={3} dash={[4, 3]}/>; })()}
        {props.diagnosticPosition && (() => { const point = worldToScreen(props.diagnosticPosition, props.camera); return point.every(Number.isFinite) ? <Circle x={point[0]} y={point[1]} radius={14} stroke="#c05f22" strokeWidth={3} dash={[5,3]}/> : null; })()}
        {props.accessPreview?.map((line,index)=><Line key={'access-preview/'+index} points={line.flatMap(point=>worldToScreen(point,props.camera))} stroke="#c88312" strokeWidth={3} dash={[7,4]}/>)}
        {props.repairPreview?.points.map((point, i) => { const [x,y] = worldToScreen(point, props.camera); return <Circle key={'repair/' + i} x={x} y={y} radius={9} stroke="#b25616" strokeWidth={2} dash={[4,3]}/>; })}
        {labels.labels.map(({ key, ...label }) => <Text key={key} name="display-label" {...label} listening={false}/>)}
        {draftPath && draftPath.spans.length>0 && <Path data={pathData(draftPath,props.camera)} stroke="#e08128" strokeWidth={2} dash={[7,5]}/>}
        {spatialPreview.length > 1 && <Line points={spatialPreview.flatMap(point => worldToScreen(point, props.camera))} stroke="#bd741d" strokeWidth={2} dash={[7, 5]} />}
        {drawing.vertices.map((point, index) => { const p = worldToScreen(point, props.camera); return <Circle key={index} x={p[0]} y={p[1]} radius={4} fill="#bd741d" />; })}
      </Layer>
      {props.backgrounds && <BackgroundControls key={props.backgrounds.contextKey + '/' + props.backgrounds.adjustingId} {...props.backgrounds} camera={props.camera} readCamera={props.frameCamera.read} preview={backgroundPreview} onPreview={setBackgroundPreview}/>}
      <BoundaryHandles target={boundaryTarget} mode={props.boundaryEditMode} preview={boundaryPreview} camera={props.camera}
        mapHash={props.scene.mapContentHash} changeToken={props.boundaryChangeToken} contextKey={boundaryContextKey}
        onPreview={setBoundaryPreview} onActive={boundaryInteraction} onError={setBoundaryError} onCommit={props.onBoundaryCommit} />
    </Stage>
    <output className="sr-only" data-testid="background-render-state" data-adjusting={props.backgrounds?.adjustingId ?? ''} data-loaded={props.backgrounds?.items.length ?? 0} data-preview={backgroundPreview ? JSON.stringify(backgroundPreview.transform) : ''} />
    {boundaryPreview && <output data-testid="boundary-edit-preview" data-width-m={boundaryPreview.widthM} data-height-m={boundaryPreview.heightM} data-clamped={boundaryPreview.clamped ?? false}
      style={{ position: 'absolute', top: 34, left: 14, padding: 8, background: '#fff', border: '1px solid #c9d6d8', borderRadius: 6, pointerEvents: 'none' }}>
      {boundaryPreview.widthM === undefined ? '顶点预览' : '局部宽 ' + roundTick(boundaryPreview.widthM) + ' m × 高 ' + roundTick(boundaryPreview.heightM!) + ' m'}
      {boundaryPreview.clamped ? ' · 最小边长 0.01 m' : ''} · 松开应用，Esc 取消；仅修改边界
    </output>}
    {boundaryError && <div role="alert" style={{ position: 'absolute', bottom: 38, left: 14, right: 14, background: '#fff4ed', padding: 8 }}>{boundaryError}</div>}
    <output className="sr-only" data-testid="boundary-handles" data-count={boundaryHandleCount} data-mode={boundaryMode}>{boundaryHandleCount} 个边界控制柄</output>
    {drawing.vertices.length > 0 && <div style={{ position: 'absolute', top: 34, left: 14, padding: 8, background: '#fff', border: '1px solid #c9d6d8', borderRadius: 6, zIndex: 2 }}>
      <span>{isOrientedRectangleTool(props.tool) ? drawing.vertices.length === 1 ? '点击基边另一端，再点击侧边；Esc 取消' : '点击确定垂直宽度；Esc 取消' : isRectangleTool(props.tool) ? '再点击对角点；Esc 取消' : `${drawing.vertices.length} 个顶点 · Enter 完成`}</span>
      {!isRectangleTool(props.tool) && <button onClick={drawing.finish} disabled={drawing.vertices.length < 3 || props.readonly}>完成多边形</button>}
      <button onClick={drawing.cancel}>取消绘制</button>{drawing.error && <p role="alert">{drawing.error}</p>}
    </div>}
    {props.draftRoad && <div className="point-pick-instruction" data-testid="road-draft-instruction"><span>{props.draftRoad.spans.length} 段草稿 · {props.tool === 'curve' ? props.draftRoad.curveEnd ? '点击曲线经过位置' : '点击下一段终点，再点弯曲位置' : '点击下一点；Enter / 双击完成'}；R / C 接续直线或曲线。{draftJoin&&<strong> 当前接续：{draftJoin==='smooth'?'平滑':'折角'}。</strong>}绿圈接路，Alt 不连接</span><button onClick={props.onRoadFinish} disabled={props.draftRoad.points.length < 2 || !!props.draftRoad.curveEnd}>完成道路</button></div>}
    {widthPreview && <output className="point-pick-instruction" data-testid="road-width-preview">人工影像估计宽度 {widthPreview.widthM.toFixed(2)} m · 松开应用</output>}
    {props.pointPick && <div className="point-pick-instruction" role="status">{pickNotice || (props.pointPick.mode === 'path' ? '绿色为已选内部路径；青色为从末端沿已声明方向可继续选择的本对象道路。' : props.pointPick.mode === 'road' ? '点选接入道路或路口；仅生成候选，确认后才显式接路。' : props.pointPick.mode === 'existing' ? '点选已有节点或关联点以绑定；不会新增节点。' : '点选专用节点位置；确认创建前仅是草稿，不自动拆路或连接。')}</div>}
    <div className="canvas-label">LOCAL XY · 米制 · Z ↑</div>
    <output ref={cursorOutput} className="canvas-cursor" data-testid="cursor-position">本地 XY · 米制</output>
    {details && cardRect && props.labelMode !== 'off' && !props.frameCamera.navigating && !pressed.current && <div className="focus-details" style={{ left: cardRect.x, top: cardRect.y, right: 'auto' }} role="tooltip" data-testid="focus-details"><strong>{details.name || details.id}</strong><code>{details.id}</code><span>{details.source}</span></div>}
    <output className="sr-only" data-testid="display-state" data-navigating={props.frameCamera.navigating} data-visible={display.keys.size} data-culled={display.culledCount} data-lod={display.lodCount} data-labels={labels.labels.length} data-candidates={labels.candidateCount} data-measurements={labels.measurementCount} data-cache-size={measurer.size}/>

    {topologyTarget && <div className="projection-warning" data-testid="topology-candidate">候选 {topologyTarget.kind}/{topologyTarget.id} · 释放后需明确确认{topologyTarget.kind === 'nodes' ? '合并' : '连接'}；取消不移动。</div>}
    {props.splitPickRoadId && <div className="projection-warning" data-testid="split-pick-notice">点击所选道路中心线拾取切分位置；Esc 取消。{pickNotice}</div>}
    {(unprojectable > 0 || unprojectableWidths > 0 || widthRangeIssues.length > 0) && <div className="projection-warning" data-testid="projection-warning" role="status">
      {unprojectable > 0 && <div>{unprojectable} 个对象超出屏幕数值范围，JSON 完整保留；请数值调整坐标。</div>}
      {unprojectableWidths > 0 && <div>{unprojectableWidths} 条声明宽度超出屏幕数值范围，仅显示辅助线；JSON 数值完整保留。</div>}
      {widthRangeIssues.map(issue => <div key={issue}>{issue}</div>)}
    </div>}
    <div className="scale-label" data-testid="road-display-legend">{roundTick(step)} m 网格 · 道路带 = 声明宽度 × 比例<br/>
      圆端 / 圆连接近似带；不代表实测路口或车辆扫掠<br/>
      {unknownWidths > 0 && <span data-testid="unknown-road-widths">{unknownWidths} 条道路宽度未知 / 不适用 / 无限制：显示时用辅助虚线<br/></span>}
      道路带重叠不自动连通；绿圈确认接路，Alt 保留独立端点<br/>叠放处再点或 Tab 切换对象，Shift+Tab 返回，Shift 多选
      {shapePreview && <span data-testid="road-shape-preview"><br/>折点预览 · 应用属性后写入地图</span>}
    </div>
    {props.tool==='measure'&&<output className="point-pick-instruction" data-testid="measurement-readout" data-length-m={measurement.lengths.totalM} data-count={measurement.state.points.length}>量距：{measurement.lengths.totalM.toFixed(2)} m · 点击连续量距，Enter 完成，Esc 清空；不写入地图。</output>}
    {cycleNotice&&<output className="point-pick-instruction" data-testid="selection-cycle">{cycleNotice}</output>}
    <output className="sr-only" data-testid="road-width-handles" data-handles={JSON.stringify(widthControls.map(handle=>({roadId:handle.roadId,sign:handle.sign,position:handle.position,screen:handle.screen,edgeScreen:handle.edgeScreen})))}/>
    <output className="sr-only" data-testid="runtime-overlay" data-run-id={props.runtime?.runId??''} data-time-s={props.runtime?.timeS??''} data-vehicles={JSON.stringify(props.runtime?.vehicles.map(({route:_,...vehicle})=>vehicle)??[])}/>
    <output className="sr-only" data-testid="path-overlay" data-map-hash={props.routePreview?.mapContentHash ?? ''} data-points={props.routePreview?.points.length ?? 0}/>
    <output className="sr-only" data-testid="diagnostic-marker" data-position={JSON.stringify(props.diagnosticPosition ?? null)}/>
    <output className="sr-only" data-testid="camera-state" data-offset-x={props.camera.offsetX} data-offset-y={props.camera.offsetY} data-scale={props.camera.scale}>{JSON.stringify(props.camera)}</output>
  </div>;
}