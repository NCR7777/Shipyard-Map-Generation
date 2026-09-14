import { useEffect, useRef } from 'react';
import { Circle, Line } from 'react-konva';
import type Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { RoadGeometry, Vec3 } from '../../domain/model';
import { movePathAnchor, pathToRoadGeometry, pointAt, type ResolvedPath } from '../../geometry/roadPath';
import { bendPathSpan } from '../../geometry/curveEditing';
import { screenToWorld, worldToScreen, type Camera } from '../../geometry/coordinates';

type Handle = { kind: 'anchor'; index: number } | { kind: 'middle'; index: number } | { kind: 'control1' | 'control2'; index: number };
interface Props {
  roadId: string; path: ResolvedPath; allowCurves: boolean; camera: Camera; readCamera: () => Camera; changeToken: number;
  onPreview: (path: ResolvedPath | null) => void;
  onCommit: (geometry: RoadGeometry, changeToken: number) => boolean;
}
export function RoadGeometryHandles(props: Props) {
  const latest = useRef(props); latest.current = props;
  const drag = useRef<{ path: ResolvedPath; preview: ResolvedPath; handle: Handle; token: number; node: Konva.Node } | null>(null);
  function cancel() { const active = drag.current; drag.current = null; if (active) { active.node.stopDrag(); latest.current.onPreview(null); } }
  useEffect(() => { cancel(); }, [props.roadId, props.changeToken]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); }; window.addEventListener('keydown', escape); window.addEventListener('blur', cancel); return () => { window.removeEventListener('keydown', escape); window.removeEventListener('blur', cancel); }; }, []);
  function handle(point: Vec3, handle: Handle, name: string, fill: string) {
    const [x,y] = worldToScreen(point, props.camera);
    const move = (event: KonvaEventObject<DragEvent>) => {
      const active = drag.current; if (!active) return;
      const world = screenToWorld([event.target.x(),event.target.y()], latest.current.readCamera(), point[2]);
      let path: ResolvedPath;
      if (active.handle.kind === 'anchor') path = movePathAnchor(active.path,active.handle.index,world);
      else if (active.handle.kind === 'middle') path = bendPathSpan(active.path,active.handle.index,world);
      else { path = structuredClone(active.path); const span = path.spans[active.handle.index]!; if (span.kind !== 'cubic') return; span[active.handle.kind] = world; }
      active.preview = path; latest.current.onPreview(path);
    };
    return <Circle key={name + '/' + handle.index} name={name} x={x} y={y} radius={handle.kind === 'middle' ? 6 : 5} fill={fill} stroke="#93600d" strokeWidth={2} draggable
      onMouseDown={event => {event.cancelBubble=true;}} onClick={event=>{event.cancelBubble=true;}}
      onDblClick={event=>{event.cancelBubble=true;if(handle.kind==='middle' && props.path.spans[handle.index]!.kind==='cubic'){const path=structuredClone(props.path);path.spans[handle.index]={kind:'line'};props.onCommit(pathToRoadGeometry(path),props.changeToken);}}}
      onDragStart={event=>{drag.current={path:structuredClone(props.path),preview:props.path,handle,token:props.changeToken,node:event.target};}}
      onDragMove={move} onDragEnd={()=>{const active=drag.current;drag.current=null;latest.current.onPreview(null);if(active && active.token===latest.current.changeToken)latest.current.onCommit(pathToRoadGeometry(active.preview),active.token);}}/>;
  }
  return <>
    {props.path.anchors.slice(1,-1).map((point,index)=>handle(point,{kind:'anchor',index:index+1},'road-shape-handle','#fff2c4'))}
    {props.path.spans.map((span,index)=><Line key={'tangent/'+index} listening={false} points={span.kind==='cubic' ? [props.path.anchors[index]!,span.control1,span.control2,props.path.anchors[index+1]!].flatMap(p=>worldToScreen(p,props.camera)) : []} stroke="#ae8b55" strokeWidth={1} dash={[4,4]}/>)}
    {props.path.spans.flatMap((span,index)=>span.kind==='cubic' ? [handle(span.control1,{kind:'control1',index},'road-control1-handle','#d9e9ff'),handle(span.control2,{kind:'control2',index},'road-control2-handle','#d9e9ff')] : [])}
    {props.allowCurves && props.path.spans.map((_,index)=>handle(pointAt(props.path,index,0.5),{kind:'middle',index},'road-bend-handle','#ffe49a'))}
  </>;
}
