import { useEffect, useRef } from 'react';
import { Circle, Layer, Line, Shape } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type Konva from 'konva';
import { backgroundFrame, resizeBackgroundCorner, rotateBackground, translateBackground, type BackgroundCorner, type BackgroundTransform } from '../../geometry/backgrounds';
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { useCurrentCallback } from '../../ui/useCurrentCallback';

export interface BackgroundVisual { id: string; image: HTMLImageElement; transform: BackgroundTransform; width: number; height: number; opacity: number }
export interface BackgroundCanvasProps {
  items: readonly BackgroundVisual[]; camera: Camera; readCamera(): Camera;
  adjustingId: string | null; keepAspect: boolean; contextKey: string;
  onCommit(id: string, transform: BackgroundTransform, contextKey: string): boolean;
  onActive(active: boolean): void;
  onError(message: string): void;
}
type Gesture = { id: string; transform: BackgroundTransform; width: number; height: number; start: Vec2; kind: 'move' | 'rotate' | BackgroundCorner; stage: Konva.Stage; contextKey: string };
/** One canvas image per asset, below vectors. Full affine composition keeps shear and Y conventions. */
export function BackgroundImages({ items, camera, preview }: { items: readonly BackgroundVisual[]; camera: Camera; preview?: { id: string; transform: BackgroundTransform } | null }) {
  return <Layer listening={false} name="background-rasters">{items.map(item => {
    const t = preview?.id === item.id ? preview.transform : item.transform;
    return <Shape key={item.id} name="background-raster" opacity={item.opacity} listening={false} sceneFunc={context => {
      context.save();
      context.transform(camera.scale * t[0], -camera.scale * t[1], camera.scale * t[2], -camera.scale * t[3], camera.offsetX + camera.scale * t[4], camera.offsetY - camera.scale * t[5]);
      context.drawImage(item.image, 0, 0, item.width, item.height); context.restore();
    }}/>;
  })}</Layer>;
}
/** Controls do not serialize Konva nodes and have no vector selection membership. */
export function BackgroundControls(props: BackgroundCanvasProps & { preview: { id: string; transform: BackgroundTransform } | null; onPreview(value: { id: string; transform: BackgroundTransform } | null): void }) {
  const gesture = useRef<Gesture | null>(null);
  const lastTransform = useRef<BackgroundTransform | null>(null); const pendingFrame = useRef<number | null>(null);
  const active = props.items.find(item => item.id === props.adjustingId);
  const latest = useRef(props); latest.current = props;
  const cancel = useCurrentCallback(() => {
    gesture.current = null; lastTransform.current = null;
    if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current); pendingFrame.current = null;
    props.onPreview(null); props.onActive(false);
  });
  const pointAt = useCurrentCallback((event: MouseEvent, stage: Konva.Stage): Vec2 => {
    const rect = stage.container().getBoundingClientRect();
    const world = screenToWorld([(event.clientX - rect.left) * stage.width() / rect.width, (event.clientY - rect.top) * stage.height() / rect.height], props.readCamera());
    return [world[0], world[1]];
  });
  const calculate = useCurrentCallback((event: MouseEvent) => {
    const g = gesture.current; if (!g || g.contextKey !== props.contextKey) return null;
    const world = pointAt(event, g.stage);
    if (g.kind === 'move') return translateBackground(g.transform, [world[0] - g.start[0], world[1] - g.start[1]]);
    if (g.kind === 'rotate') {
      const center = backgroundFrame(g.transform, g.width, g.height).center;
      return rotateBackground(g.transform, g.width, g.height, Math.atan2(world[1] - center[1], world[0] - center[0]) - Math.atan2(g.start[1] - center[1], g.start[0] - center[0]));
    }
    return resizeBackgroundCorner(g.transform, g.width, g.height, g.kind, world, props.keepAspect);
  });
  const move = useCurrentCallback((event: MouseEvent) => {
    if (!gesture.current) return;
    try {
      const transform = calculate(event); if (!transform) { cancel(); return; }
      lastTransform.current = transform;
      if (pendingFrame.current === null) pendingFrame.current = requestAnimationFrame(() => {
        pendingFrame.current = null; const g = gesture.current; const next = lastTransform.current;
        if (g && next) { props.onPreview({ id: g.id, transform: next }); }
      });
    } catch (failure) { props.onError(String(failure)); /* Invalid crossing never becomes a mirrored preview or commit. */ }
  });
  const end = useCurrentCallback((event: MouseEvent) => {
    const g = gesture.current; if (!g || event.button !== 0) return;
    try {
      const result = calculate(event); cancel();
      if (result && g.contextKey === props.contextKey) props.onCommit(g.id, result, g.contextKey);
    } catch (failure) { cancel(); props.onError(String(failure)); }
  });
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', end); window.addEventListener('blur', cancel); window.addEventListener('keydown', key);
    document.addEventListener('visibilitychange', visibility);
    return () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', end); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key); document.removeEventListener('visibilitychange', visibility); if (pendingFrame.current !== null) cancelAnimationFrame(pendingFrame.current); gesture.current = null; latest.current.onPreview(null); latest.current.onActive(false); };
  }, [move, end, cancel]);
  function start(event: KonvaEventObject<MouseEvent>, kind: Gesture['kind']) {
    if (event.evt.button !== 0 || !active) return;
    const stage = event.target.getStage(); if (!stage) return;
    event.cancelBubble = true; event.evt.preventDefault(); props.onError('');
    gesture.current = { id: active.id, transform: [...active.transform], width: active.width, height: active.height,
      start: pointAt(event.evt, stage), kind, stage, contextKey: props.contextKey };
    lastTransform.current = active.transform; props.onActive(true);
  }
  if (!active) return null;
  const frame = backgroundFrame(props.preview?.id === active.id ? props.preview.transform : active.transform, active.width, active.height);
  const corners = frame.corners.map(p => worldToScreen([p[0], p[1], 0], props.camera));
  const center = worldToScreen([frame.center[0], frame.center[1], 0], props.camera);
  const top: Vec2 = [(corners[0]![0] + corners[1]![0]) / 2, (corners[0]![1] + corners[1]![1]) / 2];
  const norm = Math.hypot(top[0] - center[0], top[1] - center[1]);
  const rotation: Vec2 = [top[0] + (top[0] - center[0]) / Math.max(norm, 1) * 32, top[1] + (top[1] - center[1]) / Math.max(norm, 1) * 32];
  return <Layer name="background-controls">
    <Line name="background-move" points={corners.flat()} closed fill="rgba(255,255,255,0.015)" stroke="#f09a35" strokeWidth={2} dash={[8, 4]} onMouseDown={event => start(event, 'move')}/>
    <Line points={[...top, ...rotation]} stroke="#f09a35" strokeWidth={2} listening={false}/>
    <Circle x={center[0]} y={center[1]} radius={4} stroke="#f09a35" listening={false}/>
    {corners.map((p, i) => <Circle name={'background-corner-' + i} key={i} x={p[0]} y={p[1]} radius={7} fill={i === 0 ? '#f09a35' : '#fff'} stroke="#b75c11" strokeWidth={2} hitStrokeWidth={10} onMouseDown={event => start(event, i as BackgroundCorner)}/>)}
    <Circle name="background-rotation" x={rotation[0]} y={rotation[1]} radius={8} fill="#fff" stroke="#b75c11" strokeWidth={2} hitStrokeWidth={10} onMouseDown={event => start(event, 'rotate')}/>
  </Layer>;
}
