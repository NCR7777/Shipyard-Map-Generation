import type { RoadGeometry, RoadSpan, Vec3 } from '../domain/model';
import { tangentAt, type ResolvedPath } from '../geometry/roadPath';
import { curveThroughMidpoint } from '../geometry/curveEditing';

export type TraceConnection = { kind: 'node'; nodeId: string } | { kind: 'road'; roadId: string; distanceM: number };
export interface DraftRoad {
  points: Vec3[]; spans: RoadSpan[]; continuity: 'smooth' | 'corner';
  fromNodeId?: string; startConnection?: TraceConnection; endConnection?: TraceConnection; disconnect?: boolean;
  curveEnd?: { point: Vec3; connection?: TraceConnection }; standaloneCurve?: boolean;
}
const apart = (a: Vec3, b: Vec3) => Math.hypot(...a.map((value,index)=>value-b[index]!)) > 1e-7;
export function draftRoadGeometry(draft: Pick<DraftRoad,'points'|'spans'>): RoadGeometry { if(!draft.spans.length)throw new RangeError('A committed road needs at least one span');return {kind:'path',anchors:draft.points.slice(1,-1),spans:[draft.spans[0]!,...draft.spans.slice(1)]}; }
export function appendDraftLine(draft: DraftRoad, point: Vec3): DraftRoad {
  const end=draft.points.at(-1)!;if(!apart(end,point))return draft;
  const spans=structuredClone(draft.spans),previous=spans.at(-1);
  if(draft.continuity==='smooth'&&previous?.kind==='cubic'){
    const direction=tangentAt({anchors:[end,point],spans:[{kind:'line'}]},0,0),distance=Math.hypot(previous.control2[0]-end[0],previous.control2[1]-end[1]);
    previous.control2=[end[0]-direction[0]*distance,end[1]-direction[1]*distance,previous.control2[2]];
  }
  return {...draft,points:[...draft.points,point],spans:[...spans,{kind:'line'}],curveEnd:undefined};
}
export function appendDraftCurve(draft: DraftRoad, end: Vec3, middle: Vec3): DraftRoad {
  const start=draft.points.at(-1)!;if(!apart(start,end))return draft;
  const span=curveThroughMidpoint(start,end,middle);
  if(draft.continuity==='smooth'&&draft.spans.length){
    const direction=tangentAt({anchors:draft.points,spans:draft.spans},draft.spans.length-1,1),distance=Math.hypot(span.control1[0]-start[0],span.control1[1]-start[1]);
    span.control1=[start[0]+direction[0]*distance,start[1]+direction[1]*distance,span.control1[2]];
    // Preserve the chosen through-point while imposing only this draft's incoming tangent.
    span.control2=middle.map((value,axis)=>(8*value-start[axis]!-end[axis]!-3*span.control1[axis]!)/3) as Vec3;
  }
  return {...draft,points:[...draft.points,end],spans:[...draft.spans,span],curveEnd:undefined};
}
export function previewDraftPath(draft: DraftRoad, tool: 'road'|'curve', cursor: Vec3|null): ResolvedPath {
  const preview=cursor?(tool==='curve'&&draft.curveEnd?appendDraftCurve(draft,draft.curveEnd.point,cursor):appendDraftLine(draft,cursor)):draft;
  return {anchors:preview.points,spans:preview.spans};
}
export function lastDraftJoin(path: ResolvedPath): 'smooth'|'corner'|null {
  if(path.spans.length<2)return null;
  const index=path.spans.length-1,a=tangentAt(path,index-1,1),b=tangentAt(path,index,0);
  return a[0]*b[0]+a[1]*b[1]>1-1e-6?'smooth':'corner';
}
