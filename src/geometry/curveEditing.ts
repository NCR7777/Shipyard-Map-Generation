import type { RoadSpan, Vec3 } from '../domain/model';
import { pointAt, type ResolvedPath } from './roadPath';

/** A quadratic through the chosen midpoint, represented as a cubic. Endpoints stay authoritative. */
export function curveThroughMidpoint(a: Vec3, b: Vec3, middle: Vec3): Extract<RoadSpan, {kind:'cubic'}> {
  const q = middle.map((value, axis) => 2 * value - (a[axis]! + b[axis]!) / 2) as Vec3;
  return { kind:'cubic', control1:a.map((value,axis)=>value+2/3*(q[axis]!-value)) as Vec3, control2:b.map((value,axis)=>value+2/3*(q[axis]!-value)) as Vec3 };
}
/** Moving the midpoint translates both existing handles equally; it never adds network nodes. */
export function bendPathSpan(path: ResolvedPath, index: number, middle: Vec3): ResolvedPath {
  const next=structuredClone(path), span=next.spans[index]!;
  if(span.kind==='line') next.spans[index]=curveThroughMidpoint(next.anchors[index]!,next.anchors[index+1]!,middle);
  else { const previous=pointAt(path,index,0.5),delta=middle.map((v,axis)=>(v-previous[axis]!)*4/3);span.control1=span.control1.map((v,axis)=>v+delta[axis]!) as Vec3;span.control2=span.control2.map((v,axis)=>v+delta[axis]!) as Vec3; }
  return next;
}
