import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newNode } from '../../src/domain/factory';
import { compileMap, GEOMETRY_TOLERANCE_VERSION } from '../../src/compiler/routing';
import { getRoadPath, pointAt } from '../../src/geometry/roadPath';
import { inspectRoadBand } from '../../src/geometry/roadBand';
import { inspectSpatial } from '../../src/validation/spatialDiagnostics';
import { validateMap } from '../../src/validation/validate';
import type { Polygon, YardMapV03 } from '../../src/domain/model';
import { contentHash, parseMap, serializeMap } from '../../src/domain/serialization';

function curve(): YardMapV03 {
  const map=newMap('FAST01_COMPILE_SYNTHETIC','显式合成曲线协议测试','0.3.0');
  map.nodes.a=newNode([0,0,0]);map.nodes.b=newNode([100,0,0]);
  map.roads.r={name:'曲线',fromNodeId:'a',toNodeId:'b',geometry:{kind:'path',anchors:[],spans:[{kind:'cubic',control1:[0,100,0],control2:[100,100,0]}]},direction:'both',widthM:{state:'known',value:12,sourceRef:'assumption'},heightLimitM:{state:'unknown'},massLimitKg:{state:'unknown'},speedLimitMps:{state:'unknown'},resourceIds:[],provenance:{category:'synthetic'}};
  map.sources.assumption={name:'测试宽度',category:'design_assumption',description:'软件测试，不是现场测量'};
  return map;
}
const square=(x:number,y:number,d=1):Polygon=>({outer:[[x,y,0],[x+d,y,0],[x+d,y+d,0],[x,y+d,0],[x,y,0]],holes:[]});
describe('FAST01 compiler and conservative road bands',()=>{
  it('exports directed logical arcs with real lengths, parameter tables and unchanged unknown limits',()=>{
    const map=curve(), before=structuredClone(map), compiled=compileMap(map);
    expect(compiled.mapContentHash).toBe(contentHash(map));expect(compiled.geometryToleranceVersion).toBe(GEOMETRY_TOLERANCE_VERSION);
    expect(Object.keys(compiled.nodes)).toEqual(['a','b']);expect(Object.keys(compiled.arcs)).toHaveLength(2);
    const forward=compiled.arcs['r:forward']!,backward=compiled.arcs['r:backward']!;
    expect(Math.abs(forward.lengthM-200)).toBeLessThanOrEqual(forward.lengthErrorM+1e-9);
    expect(forward.samples.length).toBeGreaterThan(10);expect(forward.samples.at(-1)!.sM).toBeCloseTo(forward.lengthM,9);
    expect(backward.path.anchors).toEqual([[100,0,0],[0,0,0]]);expect(backward.path.spans).toEqual([{kind:'cubic',control1:[100,100,0],control2:[0,100,0]}]);
    expect(backward.speedLimitMps).toEqual({state:'unknown'});expect(compiled.warnings).toContain('r: massLimitKg unknown');
    expect(map).toEqual(before); expect(compileMap(map)).toEqual(compiled);
    const loaded=parseMap(serializeMap(map));expect(loaded.ok).toBe(true);if(loaded.ok)expect(compileMap(loaded.map)).toEqual(compiled);
  });
  it('does not claim an allowed arc when direction is unknown and rejects invented compiler profiles',()=>{
    const map=curve();map.roads.r!.direction='unknown';expect(compileMap(map).arcs['r:forward']!.allowed).toBeNull();
    expect(()=>compileMap(map,'capacity-certified')).toThrow('UNSUPPORTED_COMPILE_PROFILE');
  });
  it('checks the curved sweep rather than chord or bounding rectangle and preserves critical uncertainty',()=>{
    const path=getRoadPath(curve(),'r');
    expect(inspectRoadBand(path,6,square(49,73)).status).toBe('intersects');
    expect(inspectRoadBand(path,6,square(49,20)).status).toBe('clear');
    expect(inspectRoadBand(path,6,square(49,82)).status).toBe('clear');
    const critical=inspectRoadBand(path,6,square(49.99999,80.999999,0.000001));
    expect(critical.status).not.toBe('clear');
    expect(pointAt(path,0,0.5)).toEqual([50,75,0]);
  });
  it('reports a generic building overlap as a warning without changing geometry or passability',()=>{
    const map=curve();map.facilities.f=newFacility(square(49,73),'未分类建筑','building'); const before=serializeMap(map);
    const issues=inspectSpatial(map).issues;expect(issues.find(i=>i.code==='SPATIAL_ROAD_BUILDING_OVERLAP')?.severity).toBe('warning');
    expect(serializeMap(map)).toBe(before);
  });
  it('rejects collapsed spans without flattening away their invalidity',()=>{
    const map=curve();map.roads.r!.geometry.anchors=[[0,0,0]];map.roads.r!.geometry.spans.unshift({kind:'line'});
    expect(validateMap(map).issues.map(i=>i.code)).toContain('ZERO_LENGTH_SPAN');
  });
});
