import { describe, expect, it, vi } from 'vitest';
import { applyMapCommand, commandSupport, LINEAGE_NAMESPACE, type MapCommand } from '../../src/domain/commands';
import { enumerateConnectionTurns, enumerateMergeTurns, splitPosition } from '../../src/domain/topologyEditing';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import { roadPoints, polylineLength2D } from '../../src/geometry/roads';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import * as spatial from '../../src/validation/spatialDiagnostics';
import type { YardMap } from '../../src/domain/model';

function fixture(): YardMap {
  const map=newMap('TE01','synthetic topology contract');
  map.nodes.a=newNode([0,0,0]);map.nodes.b=newNode([10,0,0]);map.nodes.c=newNode([20,0,0]);
  map.roads.r={...newRoad('a','b',[[4,1,0]]),direction:'both',widthM:{state:'known',value:1}};
  map.roads.s={...newRoad('b','c'),direction:'both',widthM:{state:'known',value:1}};
  map.junctions.j={name:'end junction',nodeIds:['b'],model:'explicit_movements',resourceIds:['res'],provenance:{category:'synthetic'}};
  map.movements.m={name:'forward',junctionId:'j',incomingArc:{roadId:'r',direction:'forward'},outgoingArc:{roadId:'s',direction:'forward'},allowed:true,resourceIds:['res'],provenance:{category:'synthetic'}};
  map.movements.f={...structuredClone(map.movements.m),name:'forbidden reverse',incomingArc:{roadId:'s',direction:'backward'},outgoingArc:{roadId:'r',direction:'backward'},allowed:false};
  map.resources.res={name:'fixed capacity',kind:'junction_conflict',capacityUnit:'vehicle',capacity:{state:'known',value:1},controlModel:'exclusive',appliesTo:[{entityType:'junctions',entityId:'j'}],provenance:{category:'synthetic'}};
  return map;
}
const split: MapCommand={type:'splitRoad',id:'r',distanceM:5,nodeId:'n',newRoadIds:['r1','r2']};
function run(map:YardMap,command:MapCommand){const before=structuredClone(map),result=applyMapCommand(map,command);expect(result.ok,JSON.stringify(result)).toBe(true);if(!result.ok)throw Error('expected success');expect(map).toEqual(before);expect(result.map.coordinateFrame).toEqual(map.coordinateFrame);expect(validateMap(result.map).ok).toBe(true);return result;}
function reject(map:YardMap,command:MapCommand,code:string){const before=structuredClone(map),session=createSession(map,true),result=editSession(session,command);expect(result.ok).toBe(false);expect(result.issues.map(i=>i.code)).toContain(code);expect(result.session).toBe(session);expect(map).toEqual(before);}

describe('TE01 atomic topology editing',()=>{
  it('splits geometry, remaps endpoint turns and resource scope, and preserves physical fields and metadata',()=>{
    const map=fixture();map.extensionNamespaces['test.meta']={version:'1',category:'metadata'};map.roads.r!.extensions={'test.meta':{corridorClass:'declared'}};
    map.resources.res!.appliesTo.push({entityType:'roads',entityId:'r'});const oldLength=polylineLength2D(roadPoints(map,'r'));
    const result=run(map,split),after=result.map;
    expect(after.movements.m!.incomingArc.roadId).toBe('r2');expect(after.movements.f!.outgoingArc.roadId).toBe('r2');expect(after.movements.f!.allowed).toBe(false);
    expect(after.resources.res!.capacity).toEqual(map.resources.res!.capacity);expect(after.resources.res!.appliesTo).toEqual(expect.arrayContaining([{entityType:'roads',entityId:'r1'},{entityType:'roads',entityId:'r2'}]));
    for(const id of ['r1','r2'])for(const field of ['widthM','heightLimitM','speedLimitMps','massLimitKg','extensions'] as const)expect(after.roads[id]![field]).toEqual(map.roads.r![field]);
    expect(polylineLength2D(roadPoints(after,'r1'))+polylineLength2D(roadPoints(after,'r2'))).toBeCloseTo(oldLength,10);
    expect(Object.values(after.movements).filter(m=>m.name==='原道路细分直行')).toHaveLength(2);
    expect(result.transaction!.affectedRefs).toEqual(expect.arrayContaining([{kind:'movements',id:'m'},{kind:'resources',id:'res'},{kind:'sources',id:'source_editor_topology'}]));
  });
  it('expands forward and backward internal service paths in exact traversal order',()=>{
    const map=fixture();map.movements.f!.allowed=true;
    map.servicePoints.p={...newServicePoint('c'),arrival:{mode:'explicit_internal',entryNodeId:'a',internalPath:[{roadId:'r',direction:'forward'},{roadId:'s',direction:'forward'}]}};
    map.servicePoints.q={...newServicePoint('a'),arrival:{mode:'explicit_internal',entryNodeId:'c',internalPath:[{roadId:'s',direction:'backward'},{roadId:'r',direction:'backward'}]}};
    const result=run(map,split).map;
    expect(result.servicePoints.p!.arrival).toMatchObject({internalPath:[{roadId:'r1',direction:'forward'},{roadId:'r2',direction:'forward'},{roadId:'s',direction:'forward'}]});
    expect(result.servicePoints.q!.arrival).toMatchObject({internalPath:[{roadId:'s',direction:'backward'},{roadId:'r2',direction:'backward'},{roadId:'r1',direction:'backward'}]});
  });
  it('rejects independent road geometry, opaque identifier references and unknown lineage without mutation',()=>{
    const map=fixture();map.roads.r!.observedLengthM={state:'unknown'};reject(map,split,'TOPOLOGY_INDEPENDENT_GEOMETRY');delete map.roads.r!.observedLengthM;
    map.extensionNamespaces['test.meta']={version:'1',category:'metadata'};map.metadata.extensions={'test.meta':{roadId:'r'}};reject(map,split,'TOPOLOGY_OPAQUE_REFERENCE');delete map.metadata.extensions;
    map.extensionNamespaces[LINEAGE_NAMESPACE]={version:'1.0.0',category:'metadata'};map.extensions[LINEAGE_NAMESPACE]={version:'1.0.0',roadSplits:[],unknown:true};reject(map,split,'LINEAGE_CONFLICT');
  });
  it('escapes slash and tilde metadata keys in exact opaque-reference pointers',()=>{
    const map=fixture();map.extensionNamespaces['test.meta']={version:'1',category:'metadata'};map.metadata.extensions={'test.meta':{'a/b':{'~key':['r']}}};
    const result=applyMapCommand(map,split);expect(result.ok).toBe(false);
    if(!result.ok)expect(result.issues[0]).toMatchObject({code:'TOPOLOGY_OPAQUE_REFERENCE',jsonPath:'/metadata/extensions/test.meta/a~1b/~0key/0'});
  });
  it('requires explicit cascade and removes only selected road and dependent turns while preserving junction/resources',()=>{
    const map=fixture(),command:MapCommand={type:'deleteSelection',selection:{nodes:[],roads:['r']}};reject(map,command,'TOPOLOGY_DELETE_DEPENDENCIES');
    const result=run(map,{...command,topologyPolicy:'cascade'});expect(result.map.roads.r).toBeUndefined();expect(result.map.roads.s).toEqual(map.roads.s);expect(result.map.movements).toEqual({});expect(result.map.junctions).toEqual(map.junctions);expect(result.map.resources).toEqual(map.resources);
    expect(result.map.extensions[LINEAGE_NAMESPACE]).toMatchObject({topologyEdits:[{operation:'deleteSelection',removedRoads:['r'],removedMovements:['m','f'],removedNodes:[]}]});
  });
  it('retains empty resource entities after cascade and never deletes a referenced service/slot owner to pass',()=>{
    const map=fixture();map.resources.res!.appliesTo=[{entityType:'roads',entityId:'r'},{entityType:'movements',entityId:'m'}];
    const after=run(map,{type:'deleteSelection',selection:{nodes:[],roads:['r']},topologyPolicy:'cascade'}).map;expect(after.resources.res!.appliesTo).toEqual([]);expect(after.resources.res!.capacity).toEqual(map.resources.res!.capacity);
    map.servicePoints.p={...newServicePoint('c'),arrival:{mode:'explicit_internal',entryNodeId:'a',internalPath:[{roadId:'r',direction:'forward'},{roadId:'s',direction:'forward'}]}};
    reject(map,{type:'deleteSelection',selection:{nodes:[],roads:['r']},topologyPolicy:'cascade'},'TOPOLOGY_SERVICE_PATH_DEPENDENCY');
    reject(map,{type:'deleteSelection',selection:{nodes:['a'],roads:[]},topologyPolicy:'cascade'},'TOPOLOGY_SERVICE_PATH_DEPENDENCY');
  });
  it('cascades a plain junction node and incident roads while retaining unbound resource entities and other nodes',()=>{
    const map=fixture();const result=run(map,{type:'deleteSelection',selection:{nodes:['b'],roads:[]},topologyPolicy:'cascade'}).map;
    expect(result.nodes.b).toBeUndefined();expect(result.roads).toEqual({});expect(result.movements).toEqual({});expect(result.junctions).toEqual({});
    expect(result.nodes.a).toEqual(map.nodes.a);expect(result.nodes.c).toEqual(map.nodes.c);expect(result.resources.res!.capacity).toEqual(map.resources.res!.capacity);expect(result.resources.res!.appliesTo).toEqual([]);
  });
  it('redirects pure-node and single-junction references to the retained node and junction without deleting resources',()=>{
    const map=fixture();map.nodes.d=newNode([0,5,0]);map.nodes.e=newNode([10,5,0]);map.roads.t={...newRoad('d','e'),direction:'both'};
    map.junctions.source={name:'source',nodeIds:['a'],model:'explicit_movements',resourceIds:['res'],provenance:{category:'synthetic'}};
    map.junctions.target={...structuredClone(map.junctions.source),name:'target',nodeIds:['d'],resourceIds:['res2']};
    map.resources.res2={...structuredClone(map.resources.res!),appliesTo:[{entityType:'junctions',entityId:'target'}]};map.resources.res!.appliesTo.push({entityType:'junctions',entityId:'source'});
    map.movements.blocked={name:'existing forbidden Uturn',junctionId:'source',incomingArc:{roadId:'r',direction:'backward'},outgoingArc:{roadId:'r',direction:'forward'},allowed:false,resourceIds:['res'],provenance:{category:'synthetic'}};
    map.servicePoints.p={...newServicePoint('a'),arrival:{mode:'node_proxy',transferAssumption:'excluded_from_model',note:'test'}};
    const proposed=enumerateMergeTurns(map,{sourceNodeId:'a',targetNodeId:'d'});expect(proposed.length).toBe(2);
    const after=run(map,{type:'mergeNodes',sourceNodeId:'a',targetNodeId:'d',approvedMovements:[{...proposed[0]!,id:'approved'}]}).map;
    expect(after.nodes.a).toBeUndefined();expect(after.nodes.d).toEqual(map.nodes.d);expect(after.servicePoints.p!.nodeId).toBe('d');expect(after.movements.blocked).toMatchObject({allowed:false,junctionId:'target'});expect(after.junctions.source).toBeUndefined();expect(after.junctions.target!.resourceIds).toEqual(['res2','res']);
    expect(after.resources.res!.capacity).toEqual(map.resources.res!.capacity);expect(after.resources.res2!.capacity).toEqual(map.resources.res2!.capacity);expect(after.movements.approved!.provenance.category).toBe('design_assumption');
  });
  it('rejects merge self loops, duplicate edges, conflicting nodes, and independent junction boundaries',()=>{
    const map=fixture();reject(map,{type:'mergeNodes',sourceNodeId:'a',targetNodeId:'b'},'TOPOLOGY_SELF_LOOP');
    map.nodes.d=newNode([0,2,0]);map.roads.t=newRoad('d','b');reject(map,{type:'mergeNodes',sourceNodeId:'a',targetNodeId:'d'},'TOPOLOGY_DUPLICATE_EDGE');delete map.roads.t;
    map.nodes.d!.kind='junction';reject(map,{type:'mergeNodes',sourceNodeId:'a',targetNodeId:'d'},'TOPOLOGY_NODE_CONFLICT');
  });
  it('connects one shared node atomically, approving only selected branch turns and preserving forbidden turns',()=>{
    const map=fixture();map.nodes.x=newNode([5,3,0]);map.nodes.y=newNode([5,8,0]);map.roads.t={...newRoad('x','y'),direction:'both',widthM:{state:'known',value:1}};
    map.junctions.xj={name:'branch',nodeIds:['x'],model:'explicit_movements',resourceIds:[],provenance:{category:'synthetic'}};
    map.movements.no={name:'no Uturn',junctionId:'xj',incomingArc:{roadId:'t',direction:'backward'},outgoingArc:{roadId:'t',direction:'forward'},allowed:false,resourceIds:[],provenance:{category:'synthetic'}};
    const base={nodeId:'x',roadId:'r',distanceM:5,newRoadIds:['r1','r2'] as [string,string],junctionId:'xj'},turns=enumerateConnectionTurns(map,base);expect(turns).toHaveLength(4);
    const command:MapCommand={type:'connectNodeToRoad',...base,approvedMovements:[{id:'approved',...turns[0]!}]};
    const support=commandSupport(map,command);expect(support.allowed).toBe(true);expect(support.geometryPreservedRoadIds).toEqual(['r1','r2']);expect(support.geometryPreservedRoadIds).not.toContain('t');
    const after=run(map,command).map;expect(after.roads.r1!.toNodeId).toBe('x');expect(after.roads.r2!.fromNodeId).toBe('x');expect(after.roads.t!.fromNodeId).toBe('x');expect(after.movements.no).toEqual(map.movements.no);expect(after.nodes.x!.position).not.toEqual(map.nodes.x!.position);
    expect(Object.values(after.movements).filter(m=>m.junctionId==='xj'&&m.allowed)).toHaveLength(3);
    reject(map,{...command,approvedMovements:[{id:'bad',incomingArc:map.movements.no!.incomingArc,outgoingArc:map.movements.no!.outgoingArc}]},'TOPOLOGY_TURN_NOT_PROPOSED');
  });
  it('suppress degree two restores exact polyline traversal and rewrites reverse/forward paths',()=>{
    const map=fixture();map.movements.f!.allowed=true;map.servicePoints.p={...newServicePoint('c'),arrival:{mode:'explicit_internal',entryNodeId:'a',internalPath:[{roadId:'r',direction:'forward'},{roadId:'s',direction:'forward'}]}};
    const afterSplit=run(map,split).map,result=run(afterSplit,{type:'suppressDegree2Node',nodeId:'n',retainedRoadId:'r1'});
    expect(result.map.nodes.n).toBeUndefined();expect(result.map.roads.r2).toBeUndefined();expect(result.map.servicePoints.p!.arrival).toMatchObject({internalPath:[{roadId:'r1',direction:'forward'},{roadId:'s',direction:'forward'}]});
    expect(polylineLength2D(roadPoints(result.map,'r1'))).toBeCloseTo(polylineLength2D(roadPoints(map,'r')),10);expect(result.map.movements.m!.incomingArc.roadId).toBe('r1');
    const missing=structuredClone(afterSplit);delete missing.movements[Object.keys(missing.movements).find(id=>missing.movements[id]!.name==='原道路细分直行')!];reject(missing,{type:'suppressDegree2Node',nodeId:'n',retainedRoadId:'r1'},'TOPOLOGY_CONTINUATION_UNDECLARED');
    const conflict=structuredClone(afterSplit);conflict.roads.r2!.widthM={state:'known',value:5};reject(conflict,{type:'suppressDegree2Node',nodeId:'n',retainedRoadId:'r1'},'TOPOLOGY_ROAD_CONFLICT');
  });
  it('retains second-segment evidence held only in fieldSources when joining its geometry',()=>{
    const splitMap=run(fixture(),split).map,before=structuredClone(splitMap);
    before.sources.second={name:'second segment evidence',category:'surveyed',description:'synthetic review only'};
    before.roads.r2!.provenance={category:'surveyed',fieldSources:{shapePoints:'second'}};
    const result=run(before,{type:'suppressDegree2Node',nodeId:'n',retainedRoadId:'r1'}).map;
    expect(result.roads.r1!.provenance.sourceRefs).toContain('second');expect(result.sources.second).toEqual(before.sources.second);
    expect(result.roads.r1!.provenance.fieldSources?.shapePoints).toBe('source_editor_geometry');
    expect(before.roads.r2!.provenance).toEqual({category:'surveyed',fieldSources:{shapePoints:'second'}});
  });
  it('keeps basic point editing available after a verified simple subdivision',()=>{
    const map=fixture();map.junctions={};map.movements={};map.resources={};map.servicePoints.p=newServicePoint('c');
    const after=run(map,split).map;expect(commandSupport(after,{type:'updateServicePoint',id:'p',patch:{nodeId:'b'}}).allowed).toBe(true);
    reject(after,{type:'duplicateSelection',selection:{nodes:[],roads:['r1','r2']},delta:[1,0,0],idMap:{a:'copy_a',n:'copy_n',b:'copy_b',r1:'copy_r1',r2:'copy_r2'}},'TOPOLOGY_COPY_DEPENDENCIES');
  });
  it('commits exactly one undo transaction and does not produce a source/history for same-node no-op',()=>{
    const map=fixture(),session=createSession(map,true),edited=editSession(session,split);expect(edited.ok).toBe(true);expect(edited.session.past).toHaveLength(1);expect(undoSession(edited.session).map).toEqual(session.map);expect(redoSession(undoSession(edited.session)).map).toEqual(edited.session.map);
    const noop=editSession(session,{type:'mergeNodes',sourceNodeId:'a',targetNodeId:'a'});expect(noop.session).toBe(session);expect(noop.session.map.sources).toEqual(map.sources);
  });
  it('uses bit-identical fractional chainage arithmetic for split and connect on long polylines',()=>{
    const map=newMap('TE01_fraction');map.nodes.a=newNode([0,0,0]);map.nodes.b=newNode([10,0,0]);map.nodes.x=newNode([8,2,0]);
    map.roads.r={...newRoad('a','b',Array.from({length:40},(_,i)=>[(i+1)*0.2,Math.sin(i+1)*0.17,0])),direction:'both'};
    const distanceM=polylineLength2D(roadPoints(map,'r'))*0.834567891,position=splitPosition(map,'r',distanceM);
    const divided=run(map,{type:'splitRoad',id:'r',distanceM,nodeId:'n',newRoadIds:['r1','r2']}).map;
    const joined=run(map,{type:'connectNodeToRoad',nodeId:'x',roadId:'r',distanceM,newRoadIds:['r1','r2'],junctionId:'jx',approvedMovements:[]}).map;
    expect(divided.nodes.n!.position).toEqual(position);expect(joined.nodes.x!.position).toEqual(divided.nodes.n!.position);
    expect(joined.roads.r1!.shapePoints).toEqual(divided.roads.r1!.shapePoints);expect(joined.roads.r2!.shapePoints).toEqual(divided.roads.r2!.shapePoints);
  });
  it('passes trusted exact-subdivision ids only and refuses spatial conflicts before sources/history',()=>{
    const spy=vi.spyOn(spatial,'inspectSpatialEdit').mockReturnValue([{code:'TE01_CONFLICT',severity:'error',jsonPath:'/roads/r1',message:'test',suggestedAction:'test'}]);
    try{const map=fixture();reject(map,split,'TE01_CONFLICT');expect(spy.mock.calls[0]![2]).toEqual({geometryPreservedRoadIds:['r1','r2']});expect(map.sources).toEqual({});}finally{spy.mockRestore();}
  });
});