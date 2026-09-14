import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { roadForMap, pointAt, getRoadPath } from '../../src/geometry/roadPath';
import { inspectSpatial } from '../../src/validation/spatialDiagnostics';
import { validateMap } from '../../src/validation/validate';

describe('FAST01 independent integration review',()=>{
  it('does not certify artificial corridor containment from chords when a cubic leaves between samples',()=>{
    const map=newMap('FAST01_CORRIDOR_AUDIT','合成数值审查，不是现场数据','0.3.0');
    map.nodes.a=newNode([-1,0,0]);map.nodes.b=newNode([1,0,0]);
    const road=roadForMap(map,newRoad('a','b'));
    if(!road.geometry)throw new Error('Expected v03 path');
    road.geometry={kind:'path',anchors:[],spans:[{kind:'cubic',control1:[-0.3,0.02,0],control2:[0.3,0.02,0]}]};
    road.corridorPolygon={outer:[[-2,-0.005,0],[2,-0.005,0],[2,0.005,0],[-2,0.005,0],[-2,-0.005,0]],holes:[]};
    map.roads.r=road;
    expect(validateMap(map).ok).toBe(true);
    expect(pointAt(getRoadPath(map,'r'),0,0.5)[1]).toBe(0.015);
    const report=inspectSpatial(map);
    expect(report.issues.some(issue=>issue.code==='SPATIAL_CORRIDOR_CENTERLINE_OUTSIDE'||issue.code==='SPATIAL_CORRIDOR_NEEDS_REFINEMENT'),JSON.stringify(report)).toBe(true);
  });
});
