import { Group, Shape, Text, Rect, Line, Circle } from 'react-konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { SceneSnapshot, SceneItem, SceneKind } from '../../adapters/contracts';
import type { Selection } from '../../domain/commands';
import type { Vec3 } from '../../domain/model';
import { worldToScreen, type Camera } from '../../geometry/coordinates';
import { snapPosition, type SnapOptions } from './useSpatialDrawing';
import type { BoundaryPreview } from './BoundaryHandles';

export interface SpatialLayerProps {
  showLabels?: boolean; hiddenTypes?: readonly SceneKind[]; canDrag?: (kind: keyof Selection, id: string) => boolean;
  scene: SceneSnapshot; camera: Camera; selection: Selection; previewDelta: Vec3 | null; boundaryPreview?: BoundaryPreview | null;
  snap?: SnapOptions; readonly: boolean; selecting: boolean; drawingRoad: boolean; movingNodeIds: Set<string>;
  disableDrag?: boolean; pickingPoint?: boolean; onPickNode?: (id: string) => void;
  onSelect: (kind: keyof Selection, id: string, additive: boolean) => void;
  onDrawClick: () => void; onRoadNode: (id: string) => void;
  onDragStart: (origin: Vec3) => void; onPreview: (delta: Vec3 | null) => void; onDragEnd: (delta: Vec3) => void;
}
function move(point: Vec3, delta: Vec3 | null): Vec3 { return delta ? [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]] : point; }
function dragDelta(event: KonvaEventObject<DragEvent>, origin: Vec3, props: SpatialLayerProps): Vec3 {
  const value = snapPosition([event.target.x(), event.target.y()], props.camera, props.scene.nodes, props.snap, props.movingNodeIds, origin[2]).world;
  return [value[0] - origin[0], value[1] - origin[1], 0];
}
/** Only scene projection: transient drag offsets never become a second map. */
export function SpatialLayer(props: SpatialLayerProps) {
  const polygons = [...props.scene.zones.map(item => ({ ...item, entityType: 'zones' as const })), ...props.scene.facilities.map(item => ({ ...item, entityType: 'facilities' as const }))];
  return <>{polygons.filter(item => !props.hiddenTypes?.includes(item.entityType)).map(item => {
    const selected = !!props.selection[item.entityType]?.includes(item.id);
    const origin = item.boundary.outer[0]; const offset = selected ? props.previewDelta : null;
    const boundary = props.boundaryPreview?.kind === item.entityType && props.boundaryPreview.id === item.id ? props.boundaryPreview.boundary : item.boundary;
    const anchor = worldToScreen(move(origin, offset), props.camera);
    const rings = [boundary.outer, ...boundary.holes].map(ring => ring.map(point => {
      const p = worldToScreen(move(point, offset), props.camera); return [p[0] - anchor[0], p[1] - anchor[1]];
    }));
    if (!anchor.every(Number.isFinite) || rings.some(ring => ring.some(point => !point.every(Number.isFinite)))) return null;
    const fill = item.entityType === 'facilities' ? '#c7e3df' : item.kind === 'water' ? '#bad8ef' : item.kind === 'obstacle' || item.kind === 'forbidden' ? '#ead0cc' : '#e8e3c6';
    return <Group _useStrictMode key={item.entityType + item.id} x={anchor[0]} y={anchor[1]} draggable={!props.disableDrag && props.selecting && !props.readonly && (props.canDrag?.(item.entityType, item.id) ?? true)}
      onMouseDown={event => { if (event.evt.button === 0 && props.selecting && (!selected || event.evt.shiftKey)) props.onSelect(item.entityType, item.id, event.evt.shiftKey); }}
      onClick={event => { if (event.evt.button !== 0) return; event.cancelBubble = true; if (props.selecting) { if (!event.evt.shiftKey) props.onSelect(item.entityType, item.id, false); } else if (!props.readonly) props.onDrawClick(); }}
      onDragStart={() => props.onDragStart([...origin])} onDragMove={event => props.onPreview(dragDelta(event, origin, props))}
      onDragEnd={event => { props.onPreview(null); props.onDragEnd(dragDelta(event, origin, props)); }}>
      <Shape fill={fill} stroke={selected ? '#d57921' : item.entityType === 'facilities' ? '#497e75' : '#929174'} strokeWidth={selected ? 3 : 1.5} fillRule="evenodd"
        sceneFunc={(context, shape) => { context.beginPath(); for (const ring of rings) { ring.forEach((point, index) => { if (!index) context.moveTo(point[0]!, point[1]!); else context.lineTo(point[0]!, point[1]!); }); context.closePath(); } context.fillStrokeShape(shape); }} />
      {props.showLabels !== false && <Text x={8} y={-20} text={item.name || item.id} fontSize={12} fill="#355266" listening={false} />}
    </Group>;
  })}</>;
}
export function AssociatedPointLayer(props: SpatialLayerProps) {
  return <>{[...props.scene.accessPoints.map(point => ({ ...point, entityType: 'accessPoints' as const })), ...props.scene.servicePoints.map(point => ({ ...point, entityType: 'servicePoints' as const }))].filter(point => !props.hiddenTypes?.includes(point.entityType)).map(point => {
    const origin = point.position; const offset = props.movingNodeIds.has(point.nodeId) ? props.previewDelta : null;
    const pos = worldToScreen(move(origin, offset), props.camera); if (!pos.every(Number.isFinite)) return null;
    const selected = !!props.selection[point.entityType]?.includes(point.id);
    return <Group _useStrictMode key={point.entityType + point.id} x={pos[0]} y={pos[1]} draggable={!props.disableDrag && props.selecting && !props.readonly && (props.canDrag?.(point.entityType, point.id) ?? true)}
      onMouseDown={event => { if (event.evt.button === 0 && props.selecting && (!selected || event.evt.shiftKey)) props.onSelect(point.entityType, point.id, event.evt.shiftKey); }}
      onClick={event => { if (event.evt.button !== 0) return; event.cancelBubble = true; if (props.pickingPoint && !props.readonly) props.onPickNode?.(point.nodeId); else if (props.drawingRoad && !props.readonly) props.onRoadNode(point.nodeId); else if (props.selecting) { if (!event.evt.shiftKey) props.onSelect(point.entityType, point.id, false); } else if (!props.readonly) props.onDrawClick(); }}
      onDragStart={() => props.onDragStart([...origin])} onDragMove={event => props.onPreview(dragDelta(event, origin, props))}
      onDragEnd={event => { props.onPreview(null); props.onDragEnd(dragDelta(event, origin, props)); }}>
      <Rect x={-9} y={-9} width={18} height={18} cornerRadius={point.entityType === 'accessPoints' ? 2 : 8} fill={selected ? '#e08128' : point.entityType === 'accessPoints' ? '#5e9086' : '#816db1'} stroke="#fff" strokeWidth={2} />
      <Text x={-4} y={-5} text={point.entityType === 'accessPoints' ? '入' : '服'} fontSize={10} fill="#fff" listening={false} />
      {props.showLabels !== false && <Text x={12} y={4} text={point.name || point.id} fontSize={11} fill="#355266" listening={false} />}
    </Group>;
  })}</>;
}

/** Existing polygons/points/lines only; selected logical resources highlight their references. */
export function DeclaredLayer({ items, camera, hiddenTypes, showLabels, selectedKey, onSelect, selection, previewDelta, movingJunctionIds, backdrop = false }: {
  items: SceneItem[]; camera: Camera; hiddenTypes: readonly SceneKind[]; showLabels: boolean;
  selectedKey?: string; onSelect: (item: SceneItem) => void; selection: Selection; previewDelta: Vec3 | null;
  movingJunctionIds: readonly string[]; backdrop?: boolean;
}) {
  return <>{items.filter(item => !hiddenTypes.includes(item.kind) && (backdrop ? item.kind === 'siteBoundary'
    : item.kind === 'junctions' || item.kind === 'slots' || ((item.kind === 'resources' || item.kind === 'movements') && item.key === selectedKey))).map(item => {
    const delta = item.owner && selection[item.owner.kind]?.includes(item.owner.id) || item.kind === 'junctions' && movingJunctionIds.includes(item.id) ? previewDelta : null;
    const selected = item.key === selectedKey;
    const stroke = selected ? '#d57921' : item.kind === 'siteBoundary' ? '#54656f' : item.kind === 'junctions' ? '#af78a5' : item.kind === 'slots' ? '#6a897d' : '#b78627';
    const pick = (event: KonvaEventObject<MouseEvent>) => { if (event.evt.button === 0) { event.cancelBubble = true; onSelect(item); } };
    return <Group key={item.key} name={'declared-' + item.kind}>
      {item.polygons.map((polygon, index) => {
        const rings = [polygon.outer, ...polygon.holes].map(ring => ring.map(point => worldToScreen(move(point, delta), camera)));
        if (rings.some(ring => ring.some(p => !p.every(Number.isFinite)))) return null;
        return <Shape key={'polygon-' + index} stroke={stroke} strokeWidth={selected ? 3 : 1.2}
          dash={item.kind === 'siteBoundary' || item.kind === 'junctions' ? [7, 4] : undefined}
          fill={item.kind === 'slots' ? '#e1eee56b' : undefined} fillRule="evenodd" onClick={pick}
          sceneFunc={(context, shape) => { context.beginPath(); for (const ring of rings) { ring.forEach((p, i) => { if (i === 0) context.moveTo(p[0], p[1]); else context.lineTo(p[0], p[1]); }); context.closePath(); } context.fillStrokeShape(shape); }} />;
      })}
      {item.lines.map((line, index) => { const points = line.flatMap(point => worldToScreen(move(point, delta), camera)); return points.every(Number.isFinite) ? <Line key={'line-' + index} points={points} stroke={stroke} strokeWidth={3} onClick={pick}/> : null; })}
      {(selected || !item.polygons.length) && item.points.map((point, index) => { const p = worldToScreen(move(point, delta), camera); if (!p.every(Number.isFinite)) return null; return <Circle key={'point-' + index} x={p[0]} y={p[1]} radius={selected ? 9 : 7} stroke={stroke} strokeWidth={1} onClick={pick}/>; })}
      {showLabels && item.polygons[0] && (() => { const p = worldToScreen(move(item.polygons[0].outer[0], delta), camera); if (!p.every(Number.isFinite)) return null; return <Text x={p[0] + 3} y={p[1] + 3} text={item.name} fontSize={10} fill={stroke} listening={false}/>; })()}
    </Group>;
  })}</>;
}
