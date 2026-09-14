import { describe, expect, it } from 'vitest';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import { newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../../src/domain/factory';
import type { Polygon, YardMap } from '../../src/domain/model';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { getSemanticFieldState, isInferredSemantic, previewSemanticPatch, type SemanticPatchFile, type SemanticPatchItem } from '../../src/domain/semanticPatch';
import { checkResearchInput, prepareResearchAccess, type ResearchTarget } from '../../src/domain/researchAccess';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { roadForMap, pathLength, getRoadPath } from '../../src/geometry/roadPath';
import { validateMap } from '../../src/validation/validate';

const box = (x: number, y: number, w: number, h: number): Polygon => ({ outer: [[x,y,0],[x+w,y,0],[x+w,y+h,0],[x,y+h,0],[x,y,0]], holes: [] });
const target = (id: string): ResearchTarget => ({ kind: 'facilities', id });
function fixture() {
  const map = newMap('FAST03_completion', 'F3 domain', '0.3.0');
  map.nodes.a = newNode([0,0,0]); map.nodes.b = newNode([100,0,0]);
  const road = roadForMap(map, { ...newRoad('a','b'), direction:'both', resourceIds:['shared'] });
  if (!road.geometry) throw new Error('Expected v03 path');
  map.roads.r = road;
  map.resources.shared = { name:'双向共享设计容量',kind:'road',capacityUnit:'vehicle',capacity:{state:'known',value:1},controlModel:'exclusive',appliesTo:[{entityType:'roads',entityId:'r'}],provenance:{category:'design_assumption'} };
  map.facilities.f1 = newFacility(box(20,20,10,10),'建筑001','building');
  map.facilities.f2 = newFacility(box(70,20,10,10),'建筑002','building');
  map.zones.land = { ...newZone(box(-10,-10,120,60),'声明陆域','drivable'), passability:'allowed' };
  map.zones.z = newZone(box(30,40,20,10),'区域001','unclassified');
  return map;
}
function patch(map: YardMap, items: Partial<SemanticPatchItem>[] = [{}]): SemanticPatchFile {
  return { formatVersion:'1.0',mapId:map.mapId,baseMapContentHash:contentHash(map),patches:items.map(item=>({entityType:'facilities',entityId:'f1',field:'kind',before:'building',after:'workshop',origin:'inferred',evidenceGrade:'medium',evidence:'矩形屋顶和生产区上下文，仅作用途推测。',imageRef:'crops/f1.raw.png',...item})) };
}
function run(map: YardMap, command: MapCommand): YardMap {
  const before=serializeMap(map),result=applyMapCommand(map,command);
  expect(result.ok,JSON.stringify(result)).toBe(true); if(!result.ok)throw new Error('command rejected');
  expect(serializeMap(map)).toBe(before); expect(validateMap(result.map).ok,JSON.stringify(validateMap(result.map))).toBe(true); return result.map;
}

describe('FAST03 controlled semantic completion',()=>{
  it('applies all accepted labels as one undo, keeps physical/geometry data and stores image evidence',()=>{
    const map=fixture(), before=createSession(map,true), command:MapCommand={type:'applySemanticPatch',patch:patch(map,[{}, {entityId:'f2',after:'yard'}])};
    const result=editSession(before,command); expect(result.ok,JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    const after=result.session.map;
    expect(after.facilities.f1!.kind).toBe('workshop');expect(after.facilities.f2!.kind).toBe('yard');
    expect(after.facilities.f1!.boundary).toEqual(map.facilities.f1!.boundary);expect(after.facilities.f1!.heightM).toEqual({state:'unknown'});
    expect(after.roads).toEqual(map.roads);expect(after.resources).toEqual(map.resources);expect(after.zones).toEqual(map.zones);
    expect(isInferredSemantic(after.facilities.f1!)).toBe(true);expect(getSemanticFieldState(after.facilities.f1!,'kind')).toMatchObject({origin:'inferred',locked:false,evidenceGrade:'medium',imageRef:'crops/f1.raw.png'});
    expect(undoSession(result.session).map).toEqual(before.map);expect(validateMap(after).ok).toBe(true);
  });
  it('keeps low evidence generic and isolates passability-affecting categories from labels',()=>{
    const map=fixture(), input=patch(map,[{evidenceGrade:'low'},{entityType:'zones',entityId:'z',before:'unclassified',after:'water'}]);
    const preview=previewSemanticPatch(map,input);expect(preview.ok).toBe(true);expect(preview.items.map(item=>item.status)).toEqual(['low_evidence','semantic_impact']);
    const after=run(map,{type:'applySemanticPatch',patch:input});expect(after).toEqual(map);
  });
  it('locks later manual overrides and protects preexisting explicit kinds and names',()=>{
    let map: YardMap=run(fixture(),{type:'applySemanticPatch',patch:patch(fixture())});
    map=run(map,{type:'updateFacility',id:'f1',patch:{kind:'building',name:'人工确认的区域'}});
    expect(getSemanticFieldState(map.facilities.f1!,'kind')).toMatchObject({origin:'manual',locked:true});
    const preview=previewSemanticPatch(map,patch(map,[{}, {field:'name',before:'人工确认的区域',after:'模型建议厂房'}]));expect(preview.items.map(item=>item.status)).toEqual(['protected','protected']);
    map=structuredClone(map);map.facilities.f2!.kind='quay';expect(previewSemanticPatch(map,patch(map,[{entityId:'f2',before:'quay',after:'yard'}])).items[0]!.status).toBe('protected');
  });
  it('inferred workshop labels leave identical geometry edits permitted while manual workshop remains protected',()=>{
    const map=fixture(), command:MapCommand={type:'quickTraceRoad',points:[[15,25,0],[40,25,0]],defaults:{widthM:1,connectNewCrossings:false}};
    const inferred=run(map,{type:'applySemanticPatch',patch:patch(map)});
    expect(applyMapCommand(map,command).ok).toBe(true);expect(applyMapCommand(inferred,command).ok).toBe(true);
    expect(inferred.facilities.f1!.boundary).toEqual(map.facilities.f1!.boundary);
    const manual=structuredClone(map);manual.facilities.f1!.kind='workshop';expect(applyMapCommand(manual,command).ok).toBe(false);
  });
  it('rejects stale, dangling, before mismatch, executable paths, missing evidence and physical mutation atomically',()=>{
    const map=fixture(), inputs:unknown[]=[{...patch(map),baseMapContentHash:'stale'},patch(map,[{entityId:'missing'}]),patch(map,[{before:'other'}]),patch(map,[{imageRef:'../outside.png'}]),patch(map,[{evidence:''}]),{...patch(map),patches:[{...patch(map).patches[0],field:'boundary',after:box(9,9,3,3)}]},patch(map,[{},{}])];
    for(const input of inputs){expect(previewSemanticPatch(map,input).ok).toBe(false);const result=applyMapCommand(map,{type:'applySemanticPatch',patch:input as SemanticPatchFile});expect(result.ok).toBe(false);}
    expect(map.facilities.f1!.kind).toBe('building');
  });
});

describe('FAST03 explicit research target access',()=>{
  it('connects two selected boundary proxies to one original road with one undo and retained shared resource',()=>{
    const map=fixture(), proposal=prepareResearchAccess(map,[target('f1'),target('f2')],{landZoneIds:['land']});
    expect(proposal.items.map(item=>item.status),JSON.stringify(proposal)).toEqual(['ready','ready']);
    const before=createSession(map,true),result=editSession(before,{type:'applyResearchAccess',proposal});
    expect(result.ok,JSON.stringify(result.issues)).toBe(true);expect(result.session.past).toHaveLength(1);const after=result.session.map;
    expect(Object.keys(after.servicePoints)).toHaveLength(2);expect(Object.keys(after.accessPoints)).toHaveLength(2);expect(Object.keys(after.roads)).toHaveLength(5);
    expect(after.facilities.f1!.boundary).toEqual(map.facilities.f1!.boundary);expect(after.facilities.f2!.boundary).toEqual(map.facilities.f2!.boundary);expect(after.resources.shared!.capacity).toEqual(map.resources.shared!.capacity);expect(Object.keys(after.resources)).toEqual(['shared']);
    expect(Object.values(after.roads).filter(road=>road.resourceIds.includes('shared'))).toHaveLength(3);
    for(const point of Object.values(after.servicePoints)){expect(point.arrival).toMatchObject({mode:'node_proxy',transferAssumption:'excluded_from_model'});expect(point.resourceIds).toEqual([]);expect(point.provenance.category).toBe('design_assumption');expect(after.nodes[point.nodeId]!.position[1]).toBe(20);}
    expect(undoSession(result.session).map).toEqual(before.map);expect(validateMap(after).ok,JSON.stringify(validateMap(after))).toBe(true);
    expect(prepareResearchAccess(after,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('existing');
  });
  it('leaves unknown land, forbidden targets, water crossings, other buildings and holes unresolved',()=>{
    const noLand=fixture();expect(prepareResearchAccess(noLand,[target('f1')],{landZoneIds:[]}).items[0]!.status).toBe('unresolved');
    noLand.zones.land!.passability='unknown';expect(prepareResearchAccess(noLand,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
    const elevated=fixture();for(const point of elevated.zones.land!.boundary.outer)point[2]=5;expect(prepareResearchAccess(elevated,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
    const water=fixture();water.zones.water={...newZone(box(-10,2,120,15),'水域','water'),passability:'forbidden'};expect(prepareResearchAccess(water,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
    const wall=fixture();wall.facilities.wall=newFacility(box(-10,2,120,15));expect(prepareResearchAccess(wall,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
    const holes=fixture();holes.zones.land!.boundary.holes=[box(-5,2,110,15).outer];expect(prepareResearchAccess(holes,[target('f1')],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
    const forbidden=fixture();forbidden.zones.z!.passability='forbidden';expect(prepareResearchAccess(forbidden,[{kind:'zones',id:'z'}],{landZoneIds:['land']}).items[0]!.status).toBe('unresolved');
  });
  it('binds preview to exact map and candidate, applies only accepted targets and reports routing/scheduling separately',()=>{
    const map=fixture(),proposal=prepareResearchAccess(map,[target('f1'),target('f2')],{landZoneIds:['land']});
    const tampered=structuredClone(proposal);tampered.items[0]!.candidate!.position[0]+=3;
    expect(applyMapCommand(map,{type:'applyResearchAccess',proposal:tampered}).ok).toBe(false);
    const stale=structuredClone(map);stale.facilities.f2!.name='different';expect(applyMapCommand(stale,{type:'applyResearchAccess',proposal}).ok).toBe(false);
    const after=run(map,{type:'applyResearchAccess',proposal,acceptedTargetIds:['f1']});expect(after.facilities.f2!.servicePointIds).toEqual([]);expect(Object.keys(after.servicePoints)).toHaveLength(1);
    expect(checkResearchInput(map,'spatial',[target('f1')]).ready).toBe(true);expect(checkResearchInput(map,'routing',[target('f1')],'a').ready).toBe(false);
    expect(checkResearchInput(after,'routing',[target('f1')],'a').ready).toBe(true);expect(checkResearchInput(after,'scheduling',[target('f1')],'a').issues.map(issue=>issue.code)).toContain('RESEARCH_SCENARIO_REQUIRED');
  });
  it('connects to a real cubic without changing its locus or all reverse service references',()=>{
    const map=fixture();map.facilities.f1!.boundary=box(45,90,10,10);map.zones.land!.boundary=box(-20,-20,140,150);
    map.roads.r!.geometry={kind:'path',anchors:[],spans:[{kind:'cubic',control1:[0,100,0],control2:[100,100,0]}]};
    map.servicePoints.old={...newServicePoint('a'),arrival:{mode:'explicit_internal',entryNodeId:'b',internalPath:[{roadId:'r',direction:'backward'}]}};
    const length=pathLength(getRoadPath(map,'r')).lengthM, proposal=prepareResearchAccess(map,[target('f1')],{landZoneIds:['land']});
    expect(proposal.items[0]!.status,JSON.stringify(proposal)).toBe('ready');expect(proposal.items[0]!.candidate!.connectionPoint[1]).toBeGreaterThan(70);
    const after=run(map,{type:'applyResearchAccess',proposal});const children=Object.entries(after.roads).filter(([,road])=>road.resourceIds.includes('shared'));
    expect(children).toHaveLength(2);expect(children.reduce((sum,[id])=>sum+pathLength(getRoadPath(after,id)).lengthM,0)).toBeCloseTo(length,4);
    expect(after.servicePoints.old!.arrival).toMatchObject({internalPath:expect.arrayContaining([expect.objectContaining({direction:'backward'})])});
    if(after.servicePoints.old!.arrival?.mode!=='explicit_internal')throw new Error('Expected old internal declaration');expect(after.servicePoints.old!.arrival.internalPath).toHaveLength(2);
  });
});
