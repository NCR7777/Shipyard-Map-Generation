import { useEffect, useMemo, useRef, useState } from 'react';
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
  scene: SceneSnapshot;
  hiddenTypes?: readonly SceneKind[];
  showLabels?: boolean;
  inspectKey?: string;
  onInspect?: (item: SceneItem) => void;
  canDrag?: (kind: keyof Selection, id: string) => boolean;
  canEditBoundary?: (kind: 'facilities' | 'zones', id: string) => boolean;
  movingJunctionIds?: readonly string[];
  rigidRoadIds?: readonly string[];
  roadDisplay: Pick<DrawingConfig, 'showRoadBands' | 'showRoadCenterlines' | 'showOrdinaryNodes'>;
  roadShapePreview?: { roadId: string; shapePoints: Vec3[]; mapContentHash: string } | null;
  camera: Camera;
  onCamera: (camera: Camera) => void;
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
  onCursor: (point: Vec3 | null) => void;
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
  const pan = useRef<{ pointer: Vec2; camera: Camera } | null>(null);
  const dragStart = useRef<Vec3 | null>(null);
  const [size, setSize] = useState({ width: 800, height: 540 });
  const [previewDelta, setPreviewDelta] = useState<Vec3 | null>(null);
  const [rubberEnd, setRubberEnd] = useState<Vec3 | null>(null);
  const [pickNotice, setPickNotice] = useState('');
  const [boundaryPreview, setBoundaryPreview] = useState<BoundaryPreview | null>(null);
  const [boundaryActive, setBoundaryActive] = useState(false);
  const boundaryActiveRef = useRef(false);
  const [boundaryError, setBoundaryError] = useState('');
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
      const point = pointer(); if (point) pan.current = { pointer: point, camera: props.camera };
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
      if (props.pointPick.mode === 'new') props.onPointPick?.({ position: snapPosition(screen, props.camera, props.scene.nodes, props.snap).world });
      else setPickNotice('请选择已有节点或入口/服务点标记；背景、道路中部和附近坐标不代表已有节点。');
      return;
    }
    const { world } = snapPosition(screen, props.camera, props.scene.nodes, props.snap);
    if (isSpatialTool(props.tool)) drawing.click(world, screen);
    else if (props.tool === 'node' && !props.readonly) props.onAddNode(world);
    else if (props.tool === 'road' && !props.readonly) props.onRoadPoint(world);
    else if (props.tool === 'select') props.onClearSelection();
  }
  const start = props.draftRoad ? nodeById.get(props.draftRoad.fromNodeId)?.position : undefined;
  const draftPoints = start ? [start, ...props.draftRoad!.points, ...(rubberEnd ? [rubberEnd] : [])] : [];
  const visibleNodes = props.scene.nodes.filter(node => worldToScreen(position(node.id, node.position), props.camera).every(Number.isFinite));
  const projectedRoads = props.scene.roads.map(road => {
    const pixels = road.widthM.state === 'known' ? road.widthM.value * props.camera.scale : null;
    return { ...road, screenPoints: points(road),
      bandWidthPx: pixels !== null && Number.isFinite(pixels) && pixels > 0 ? pixels : null };
  });
  const visibleRoads = projectedRoads.filter(road => !props.hiddenTypes?.includes('roads') && road.screenPoints.every(Number.isFinite));
  const unprojectableWidths = visibleRoads.filter(road => road.widthM.state === 'known' && road.bandWidthPx === null).length;
  const unknownWidths = props.scene.roads.filter(road => road.widthM.state !== 'known').length;
  const widthRangeIssues = props.scene.missingCapabilities.filter(issue => issue.startsWith('ROAD_WIDTH_VISUAL_RANGE:'));
  const displayedNodes = visibleNodes.filter(() => !props.hiddenTypes?.includes('nodes')).filter(node => props.roadDisplay.showOrdinaryNodes || node.kind !== 'ordinary'
    || selectedNodeIds.has(node.id) || !!props.pointPick || props.tool === 'road');
  const unprojectable = props.scene.nodes.length + props.scene.roads.length - visibleNodes.length - projectedRoads.filter(road => road.screenPoints.every(Number.isFinite)).length;
  function roadClick(event: KonvaEventObject<MouseEvent>, id: string) {
    if (event.evt.button !== 0) return;
    if (props.pointPick) { event.cancelBubble = true; const screen = pointer(); if (screen) drawAt(screen); }
    else if (props.tool === 'select') { event.cancelBubble = true; props.onSelect('roads', id, event.evt.shiftKey); }
    else if (!props.readonly && (props.tool === 'node' || props.tool === 'road' || isSpatialTool(props.tool))) {
      const screen = pointer(); if (!screen) return; event.cancelBubble = true; drawAt(screen);
    }
  }
  const spatialProps: SpatialLayerProps = {
    hiddenTypes: props.hiddenTypes, showLabels: props.showLabels, canDrag: props.canDrag,
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
  return <div tabIndex={0} onMouseDownCapture={event => { if (event.target instanceof HTMLCanvasElement) wrapper.current?.focus({ preventScroll: true }); }} ref={wrapper} className={`canvas-surface tool-${props.tool}`} data-testid="map-canvas" aria-label="米制地图画布">
    <Stage ref={stage} width={size.width} height={size.height}
      onMouseDown={handleStageDown} onMouseUp={() => { pan.current = null; }} onMouseLeave={() => { pan.current = null; props.onCursor(null); }}
      onClick={handleStageClick}
      onMouseMove={() => {
        if (boundaryActiveRef.current) return;
        const point = pointer(); if (!point) return;
        if (pan.current) props.onCamera({ ...pan.current.camera, offsetX: pan.current.camera.offsetX + point[0] - pan.current.pointer[0], offsetY: pan.current.camera.offsetY + point[1] - pan.current.pointer[1] });
        const world = snapPosition(point, props.camera, props.scene.nodes, props.snap).world; props.onCursor(world); setRubberEnd(world);
      }}
      onWheel={event => {
        event.evt.preventDefault(); if (dragStart.current || boundaryActiveRef.current) return; const point = pointer(); if (!point) return;
        props.onCamera(zoomAt(props.camera, point, Math.min(100, Math.max(Number.MIN_VALUE, props.camera.scale * (event.evt.deltaY < 0 ? 1.15 : 1 / 1.15)))));
      }}>
      <Layer listening={false}>
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Line key={'grid-' + index} points={tick.axis === 'x' ? [tick.pixel, 0, tick.pixel, size.height] : [0, tick.pixel, size.width, tick.pixel]} stroke={Math.abs(tick.value) < 1e-9 ? '#8ba6b4' : '#e5edf1'} strokeWidth={Math.abs(tick.value) < 1e-9 ? 1.5 : 1} />)}
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Text key={'label-' + index} x={tick.axis === 'x' ? tick.pixel + 4 : 5} y={tick.axis === 'x' ? 6 : tick.pixel + 4} text={roundTick(tick.value)} fill="#7b8f9d" fontSize={10} />)}
      </Layer>
      <Layer listening={!boundaryActive}>
        <DeclaredLayer backdrop items={props.scene.items} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} showLabels={props.showLabels !== false} selectedKey={props.inspectKey} onSelect={item => props.onInspect?.(item)} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        <SpatialLayer {...spatialProps} />
        {/* All bands precede all auxiliary lines, then nodes/associated points and edit handles.
            Round caps/joins form a width-derived approximation, never a surveyed junction disk. */}
        {props.roadDisplay.showRoadBands && visibleRoads.map(road => road.bandWidthPx !== null &&
          <Line key={road.id} name="road-band" points={road.screenPoints}
            stroke={props.selection.roads.includes(road.id) ? '#efbb82' : '#b7d0db'}
            strokeWidth={road.bandWidthPx} hitStrokeWidth={Math.max(14, road.bandWidthPx)} lineCap="round" lineJoin="round"
            onClick={event => roadClick(event, road.id)} />)}
        {visibleRoads.map(road => {
          // Unknown/unrestricted/not-applicable (or unprojectable) never become a fabricated band.
          const auxiliary = road.bandWidthPx === null;
          if (!props.roadDisplay.showRoadCenterlines && !(props.roadDisplay.showRoadBands && auxiliary)) return null;
          return <Line key={road.id} name="road-centerline" points={road.screenPoints}
            stroke={props.selection.roads.includes(road.id) ? '#ad5f17' : auxiliary ? '#a76c24' : '#216b88'}
            strokeWidth={2} hitStrokeWidth={14} dash={auxiliary ? [7, 5] : undefined} lineCap="round" lineJoin="round"
            onClick={event => roadClick(event, road.id)} />;
        })}
        <DeclaredLayer items={props.scene.items} camera={props.camera} hiddenTypes={props.hiddenTypes ?? []} showLabels={props.showLabels !== false} selectedKey={props.inspectKey} onSelect={item => props.onInspect?.(item)} selection={props.selection} previewDelta={previewDelta} movingJunctionIds={props.movingJunctionIds ?? []}/>
        {displayedNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          const selected = selectedNodeIds.has(node.id) || props.pointPick?.nodeId === node.id;
          return <Circle _useStrictMode key={node.id} x={x} y={y} radius={selected ? 6.5 : 5} fill={selected ? '#e08128' : '#ffffff'} stroke={selected ? '#9a4c0d' : '#216b88'} strokeWidth={2} hitStrokeWidth={12}
            draggable={!boundaryActive && !props.hasUnappliedInput && !props.pointPick && props.tool === 'select' && !props.readonly && (props.canDrag?.('nodes', node.id) ?? true)}
            onMouseDown={event => {
              if (event.evt.button === 0 && !props.pointPick && props.tool === 'select' && (!selected || event.evt.shiftKey)) props.onSelect('nodes', node.id, event.evt.shiftKey);
            }}
            onClick={event => {
              if (event.evt.button !== 0) return;
              if (props.pointPick) { event.cancelBubble = true; pickNode(node.id); }
              else if (props.tool === 'road' && !props.readonly) { event.cancelBubble = true; props.onRoadNode(node.id); }
              else if (props.tool === 'select') { event.cancelBubble = true; if (!event.evt.shiftKey) props.onSelect('nodes', node.id, false); }
              else if (isSpatialTool(props.tool)) { const screen = pointer(); if (screen) { event.cancelBubble = true; drawAt(screen); } }
            }}
            onDragStart={() => { dragStart.current = [...node.position]; }}
            onDragMove={event => {
              if (!dragStart.current) return;
              const value = snapPosition([event.target.x(), event.target.y()], props.camera, props.scene.nodes, props.snap, selectedNodeIds, node.position[2]).world;
              setPreviewDelta([value[0] - dragStart.current[0], value[1] - dragStart.current[1], 0]);
            }}
            onDragEnd={event => {
              const origin = dragStart.current; dragStart.current = null; setPreviewDelta(null);
              if (!origin) return;
              const value = snapPosition([event.target.x(), event.target.y()], props.camera, props.scene.nodes, props.snap, selectedNodeIds, node.position[2]).world;
              props.onTranslate([value[0] - origin[0], value[1] - origin[1], 0]);
            }} />;
        })}
        <AssociatedPointLayer {...spatialProps} />
      </Layer>
      <Layer listening={false}>
        {props.showLabels !== false && displayedNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          return <Text key={node.id} x={x + 11} y={y - 16} text={node.name || node.id} fontSize={11} fill="#355266" />;
        })}
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
    <output className="sr-only" data-testid="camera-state" data-offset-x={props.camera.offsetX} data-offset-y={props.camera.offsetY} data-scale={props.camera.scale}>{JSON.stringify(props.camera)}</output>
  </div>;
}