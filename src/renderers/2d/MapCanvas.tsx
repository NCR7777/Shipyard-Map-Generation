import { useEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Circle, Line, Text } from 'react-konva';
import Konva from 'konva';

// Middle button belongs exclusively to viewport panning in this editor.
Konva.dragButtons = [0];
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Stage as KonvaStage } from 'konva/lib/Stage';
import type { SceneSnapshot } from '../../adapters/contracts';
import type { Polygon, Vec3 } from '../../domain/model';
import { SpatialLayer, AssociatedPointLayer, type SpatialLayerProps } from './SpatialLayer';
import { useSpatialDrawing, isSpatialTool, isRectangleTool, snapPosition, type SnapOptions } from './useSpatialDrawing';
import type { Selection } from '../../domain/commands';
import { screenToWorld, worldToScreen, zoomAt, type Camera, type Vec2 } from '../../geometry/coordinates';

export type Tool = 'select' | 'node' | 'road' | 'pan' | 'facilityRect' | 'facilityPolygon' | 'zoneRect' | 'zonePolygon';
export interface DraftRoad { fromNodeId: string; points: Vec3[] }
interface Props {
  scene: SceneSnapshot;
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
  movingNodeIds?: string[];
  facilityMovePolicy?: 'boundaryOnly' | 'withAssociatedNodes';
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
  const drawing = useSpatialDrawing(props.tool, props.readonly, props.camera, props.onPolygonCreate);
  const drawingDirty = drawing.vertices.length > 0;
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
  function points(road: SceneSnapshot['roads'][number]): number[] {
    return road.points.flatMap((point, index) => {
      let world = point;
      if (index === 0) world = position(road.fromNodeId, point);
      else if (index === road.points.length - 1) world = position(road.toNodeId, point);
      else if (previewDelta && props.selection.roads.includes(road.id)) world = [point[0] + previewDelta[0], point[1] + previewDelta[1], point[2] + previewDelta[2]];
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
    if (props.tool === 'pan' || event.evt.button === 1) {
      const point = pointer(); if (point) pan.current = { pointer: point, camera: props.camera };
      event.evt.preventDefault();
    }
  }
  function handleStageClick(event: KonvaEventObject<MouseEvent>) {
    if (event.target !== event.target.getStage() || event.evt.button !== 0) return;
    const screen = pointer(); if (!screen) return;
    drawAt(screen);
  }
  function drawAt(screen: Vec2) {
    const { world } = snapPosition(screen, props.camera, props.scene.nodes, props.snap);
    if (isSpatialTool(props.tool)) drawing.click(world, screen);
    else if (props.tool === 'node' && !props.readonly) props.onAddNode(world);
    else if (props.tool === 'road' && !props.readonly) props.onRoadPoint(world);
    else if (props.tool === 'select') props.onClearSelection();
  }
  const start = props.draftRoad ? nodeById.get(props.draftRoad.fromNodeId)?.position : undefined;
  const draftPoints = start ? [start, ...props.draftRoad!.points, ...(rubberEnd ? [rubberEnd] : [])] : [];
  const visibleNodes = props.scene.nodes.filter(node => worldToScreen(position(node.id, node.position), props.camera).every(Number.isFinite));
  const visibleRoads = props.scene.roads.filter(road => points(road).every(Number.isFinite));
  const unprojectable = props.scene.nodes.length + props.scene.roads.length - visibleNodes.length - visibleRoads.length;
  const spatialProps: SpatialLayerProps = {
    scene: props.scene, camera: props.camera, selection: props.selection, previewDelta,
    snap: props.snap, readonly: props.readonly, selecting: props.tool === 'select', drawingRoad: props.tool === 'road', movingNodeIds: selectedNodeIds,
    onSelect: props.onSelect, onRoadNode: props.onRoadNode, onDrawClick: () => { const p = pointer(); if (p) drawAt(p); },
    onDragStart: origin => { dragStart.current = origin; }, onPreview: setPreviewDelta,
    onDragEnd: delta => { dragStart.current = null; props.onTranslate(delta); },
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
        const point = pointer(); if (!point) return;
        if (pan.current) props.onCamera({ ...pan.current.camera, offsetX: pan.current.camera.offsetX + point[0] - pan.current.pointer[0], offsetY: pan.current.camera.offsetY + point[1] - pan.current.pointer[1] });
        const world = snapPosition(point, props.camera, props.scene.nodes, props.snap).world; props.onCursor(world); setRubberEnd(world);
      }}
      onWheel={event => {
        event.evt.preventDefault(); if (dragStart.current) return; const point = pointer(); if (!point) return;
        props.onCamera(zoomAt(props.camera, point, Math.min(100, Math.max(0.02, props.camera.scale * (event.evt.deltaY < 0 ? 1.15 : 1 / 1.15)))));
      }}>
      <Layer listening={false}>
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Line key={'grid-' + index} points={tick.axis === 'x' ? [tick.pixel, 0, tick.pixel, size.height] : [0, tick.pixel, size.width, tick.pixel]} stroke={Math.abs(tick.value) < 1e-9 ? '#8ba6b4' : '#e5edf1'} strokeWidth={Math.abs(tick.value) < 1e-9 ? 1.5 : 1} />)}
        {grid.filter(tick => Number.isFinite(tick.pixel)).map((tick, index) => <Text key={'label-' + index} x={tick.axis === 'x' ? tick.pixel + 4 : 5} y={tick.axis === 'x' ? 6 : tick.pixel + 4} text={roundTick(tick.value)} fill="#7b8f9d" fontSize={10} />)}
      </Layer>
      <Layer>
        <SpatialLayer {...spatialProps} />
        {visibleRoads.map(road => <Line key={road.id} name="road" points={points(road)} stroke={props.selection.roads.includes(road.id) ? '#e08128' : '#216b88'} strokeWidth={props.selection.roads.includes(road.id) ? 5 : 3} hitStrokeWidth={14} lineCap="round" lineJoin="round"
          onClick={event => {
            if (props.tool === 'select') { event.cancelBubble = true; props.onSelect('roads', road.id, event.evt.shiftKey); }
            else if (!props.readonly && (props.tool === 'node' || props.tool === 'road' || isSpatialTool(props.tool))) {
              const screen = pointer(); if (!screen) return; event.cancelBubble = true;
              drawAt(screen);
            }
          }} />)}
        {visibleNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          const selected = selectedNodeIds.has(node.id);
          return <Circle _useStrictMode key={node.id} x={x} y={y} radius={selected ? 6.5 : 5} fill={selected ? '#e08128' : '#ffffff'} stroke={selected ? '#9a4c0d' : '#216b88'} strokeWidth={2} hitStrokeWidth={12}
            draggable={props.tool === 'select' && !props.readonly}
            onMouseDown={event => {
              if (props.tool === 'select' && (!selected || event.evt.shiftKey)) props.onSelect('nodes', node.id, event.evt.shiftKey);
            }}
            onClick={event => {
              if (props.tool === 'road' && !props.readonly) { event.cancelBubble = true; props.onRoadNode(node.id); }
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
        {visibleNodes.map(node => {
          const [x, y] = worldToScreen(position(node.id, node.position), props.camera);
          return <Text key={node.id} x={x + 11} y={y - 16} text={node.name || node.id} fontSize={11} fill="#355266" />;
        })}
        {draftPoints.length > 1 && <Line points={draftPoints.flatMap(point => worldToScreen(point, props.camera))} stroke="#e08128" strokeWidth={2} dash={[7, 5]} />}
        {spatialPreview.length > 1 && <Line points={spatialPreview.flatMap(point => worldToScreen(point, props.camera))} stroke="#bd741d" strokeWidth={2} dash={[7, 5]} />}
        {drawing.vertices.map((point, index) => { const p = worldToScreen(point, props.camera); return <Circle key={index} x={p[0]} y={p[1]} radius={4} fill="#bd741d" />; })}
      </Layer>
    </Stage>
    {drawing.vertices.length > 0 && <div style={{ position: 'absolute', top: 34, left: 14, padding: 8, background: '#fff', border: '1px solid #c9d6d8', borderRadius: 6, zIndex: 2 }}>
      <span>{isRectangleTool(props.tool) ? '再点击对角点；Esc 取消' : `${drawing.vertices.length} 个顶点 · Enter 完成`}</span>
      {!isRectangleTool(props.tool) && <button onClick={drawing.finish} disabled={drawing.vertices.length < 3 || props.readonly}>完成多边形</button>}
      <button onClick={drawing.cancel}>取消绘制</button>{drawing.error && <p role="alert">{drawing.error}</p>}
    </div>}
    <div className="canvas-label">LOCAL XY · 米制 · Z ↑</div>
    {unprojectable > 0 && <div className="projection-warning" aria-live="polite">{unprojectable} 个对象超出屏幕数值范围，JSON 完整保留；请数值调整坐标。</div>}
    <div className="scale-label">{roundTick(step)} m 网格 · 道路线宽仅表示外观</div>
    <output className="sr-only" data-testid="camera-state" data-offset-x={props.camera.offsetX} data-offset-y={props.camera.offsetY} data-scale={props.camera.scale}>{JSON.stringify(props.camera)}</output>
  </div>;
}