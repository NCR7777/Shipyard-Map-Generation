import { useEffect, useRef } from 'react';
import { Circle, Layer } from 'react-konva';
import type { Node, KonvaEventObject } from 'konva/lib/Node';
import type { Polygon, Vec3 } from '../../domain/model';
import { screenToWorld, worldToScreen, type Camera } from '../../geometry/coordinates';
import { rectangleFrame, resizeRectangleCorner, movePolygonVertex, type RectangleFrame, type RectangleCorner } from '../../geometry/rectangles';

export interface BoundaryTarget { kind: 'facilities' | 'zones'; id: string; boundary: Polygon }
export interface BoundaryPreview extends BoundaryTarget { widthM?: number; heightM?: number; clamped?: boolean }
interface Props {
  target: BoundaryTarget | null;
  mode: 'auto' | 'polygon';
  preview: BoundaryPreview | null;
  camera: Camera;
  mapHash: string;
  changeToken: number;
  contextKey: string;
  onPreview: (preview: BoundaryPreview | null) => void;
  onActive: (active: boolean) => void;
  onError: (message: string) => void;
  onCommit: (kind: BoundaryTarget['kind'], id: string, boundary: Polygon, baseMapHash: string, baseChangeToken: number) => boolean;
}
interface Drag {
  target: BoundaryTarget; frame: RectangleFrame | null; ringIndex: number; vertexIndex: number;
  node: Node; original: Vec3; contextKey: string; mapHash: string; changeToken: number;
  camera: Camera; focus: Element | null; preview: BoundaryPreview; pointerStart: { clientX: number; clientY: number }; pointerId: number | null;
}

/** Screen-sized controls; only drag end can request a domain transaction. */
export function BoundaryHandles(props: Props) {
  const current = useRef(props); current.current = props;
  const drag = useRef<Drag | null>(null);
  const pointerDown = useRef<PointerEvent | null>(null);
  const latestPointer = useRef<PointerEvent | null>(null);
  function cancel() {
    const active = drag.current;
    if (!active) return;
    // Clear first: stopDrag emits dragend synchronously.
    drag.current = null;
    const [x, y] = worldToScreen(active.original, active.camera);
    active.node.position({ x, y });
    active.node.stopDrag();
    current.current.onPreview(null);
    current.current.onActive(false);
  }
  useEffect(() => {
    if (drag.current?.contextKey !== props.contextKey) cancel();
  }, [props.contextKey]);
  useEffect(() => {
    function rememberPointer(event: PointerEvent) {
      if (!event.isPrimary) return;
      if (event.type === 'pointerdown') pointerDown.current = event;
      latestPointer.current = event;
    }
    function escape(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !drag.current) return;
      event.preventDefault(); event.stopImmediatePropagation(); cancel();
    }
    function visibility() { if (document.hidden) cancel(); }
    function focus(event: FocusEvent) { if (drag.current && event.target !== drag.current.focus) cancel(); }
    window.addEventListener('pointerdown', rememberPointer, true);
    window.addEventListener('pointermove', rememberPointer, true);
    window.addEventListener('pointerup', rememberPointer, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('pointercancel', cancel);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('focusin', focus);
    return () => {
      window.removeEventListener('pointerdown', rememberPointer, true);
      window.removeEventListener('pointermove', rememberPointer, true);
      window.removeEventListener('pointerup', rememberPointer, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('pointercancel', cancel);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('focusin', focus);
      cancel();
    };
  }, []);
  function update(event: KonvaEventObject<DragEvent>): BoundaryPreview | null {
    const active = drag.current;
    if (!active) return null;
    if (active.contextKey !== current.current.contextKey) { cancel(); return null; }
    try {
      // Konva's mouse drag positions contain integer MouseEvent coordinates and a rendered grab offset.
      // Native pointer displacement preserves the exact original vertex and does not reread preview geometry.
      const input = active.pointerId !== null && latestPointer.current?.pointerId === active.pointerId ? latestPointer.current : event.evt;
      const content = active.node.getStage()!.getContent(); const bounds = content.getBoundingClientRect();
      const delta = screenToWorld([
        (input.clientX - active.pointerStart.clientX) * content.clientWidth / bounds.width,
        (input.clientY - active.pointerStart.clientY) * content.clientHeight / bounds.height,
      ], { offsetX: 0, offsetY: 0, scale: active.camera.scale });
      const world: Vec3 = [active.original[0] + delta[0], active.original[1] + delta[1], active.original[2]];
      const result = active.frame
        ? resizeRectangleCorner(active.frame, active.vertexIndex as RectangleCorner, world)
        : { boundary: movePolygonVertex(active.target.boundary, active.ringIndex, active.vertexIndex, world) };
      active.preview = { ...active.target, ...result };
      current.current.onPreview(active.preview);
      return active.preview;
    } catch (error) {
      current.current.onError(error instanceof Error ? error.message : '控制柄坐标无法计算。');
      cancel(); return null;
    }
  }
  if (!props.target) return null;
  const target = props.target;
  const frame = props.mode === 'auto' ? rectangleFrame(target.boundary) : null;
  const boundary = props.preview?.kind === target.kind && props.preview.id === target.id ? props.preview.boundary : target.boundary;
  return <Layer>{[boundary.outer, ...boundary.holes].flatMap((ring, ringIndex) => ring.slice(0, -1).map((point, vertexIndex) => {
    const [x, y] = worldToScreen(point, props.camera);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return <Circle _useStrictMode key={ringIndex + ':' + vertexIndex} name="boundary-handle"
      x={x} y={y} radius={5} hitStrokeWidth={12} fill={ringIndex ? '#e9dcff' : '#fff'}
      stroke={frame ? '#9a4c0d' : '#66518e'} strokeWidth={2} draggable
      onMouseDown={event => { event.cancelBubble = true; }}
      onClick={event => { event.cancelBubble = true; }}
      onDragStart={event => {
        event.cancelBubble = true;
        const latest = current.current;
        if (!latest.target || latest.target.id !== target.id || latest.target.kind !== target.kind) { event.target.stopDrag(); return; }
        drag.current = {
          target, frame, ringIndex, vertexIndex, node: event.target, original: [...point],
          contextKey: latest.contextKey, mapHash: latest.mapHash, changeToken: latest.changeToken,
          camera: { ...latest.camera }, focus: document.activeElement,
          pointerStart: pointerDown.current ?? event.evt, pointerId: pointerDown.current?.pointerId ?? null,
          preview: { ...target, ...(frame ? { widthM: frame.widthM, heightM: frame.heightM, clamped: false } : {}) },
        };
        latest.onError(''); latest.onPreview(drag.current.preview); latest.onActive(true);
      }}
      onDragMove={event => { event.cancelBubble = true; update(event); }}
      onDragEnd={event => {
        event.cancelBubble = true;
        const active = drag.current;
        if (!active) return;
        if (active.contextKey !== current.current.contextKey) { cancel(); return; }
        // Strict rendering may reposition a clamped handle. Commit the last input-derived preview, never reproject its rendered position.
        const result = active.preview;
        drag.current = null;
        current.current.onPreview(null); current.current.onActive(false);
        if (JSON.stringify(result.boundary) === JSON.stringify(active.target.boundary)) return;
        if (!current.current.onCommit(active.target.kind, active.target.id, result.boundary, active.mapHash, active.changeToken))
          current.current.onError('边界修改未通过校验或地图已变化，已恢复原边界；请查看检查器。');
      }} />;
  }))}</Layer>;
}