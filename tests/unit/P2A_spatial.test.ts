import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../../src/domain/factory';
import type { Polygon, YardMap } from '../../src/domain/model';
import { inspectPlanning, PLANNING_NAMESPACE } from '../../src/domain/planning';
import { polygonFromVertices, transformPolygon } from '../../src/geometry/polygons';
import { polygonHasArea } from '../../src/geometry/relations';
import { inspectSpatial } from '../../src/validation/spatialDiagnostics';
import { rectangle } from '../helpers/M2A_fixtures';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

function slotMap(boundaries = [rectangle(1, 1, 10, 10), rectangle(15, 1, 10, 10)], owner = rectangle(0, 0, 60, 30)): YardMap {
  const map = newMap('spatial_test', 'synthetic spatial test');
  map.extensionNamespaces[PLANNING_NAMESPACE] = { version: '1.0', category: 'behavior' };
  const slots = boundaries.map((boundary, i) => ({ id: 'slot' + i, boundary }));
  const first = boundaries[0]!;
  const length = first.outer[1][0] - first.outer[0][0], width = first.outer[2][1] - first.outer[1][1];
  map.facilities.fA = { ...newFacility(owner), extensions: { [PLANNING_NAMESPACE]: {
    role: 'production', dimensionBasis: 'synthetic', slotGapM: 1, slotLengthM: length, slotWidthM: width,
    transportAisleWidthM: 2, storageResourceId: 'storage', slots,
  } } };
  map.resources.storage = {
    name: 'synthetic storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: slots.length * length * width },
    controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'fA' }], provenance: { category: 'synthetic' },
    extensions: { [PLANNING_NAMESPACE]: { slotAreaM2: length * width, slotIds: slots.map(slot => slot.id), unitMeaning: 'cargo_storage_area' } },
  };
  expect(inspectPlanning(map).supported).toBe(true);
  return map;
}
function roadMap(zone = rectangle(20, 4, 10, 4)): YardMap {
  const map = newMap('road_space', 'synthetic declared band test');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]);
  map.roads.r = { ...newRoad('a', 'b'), widthM: { state: 'known', value: 10 } };
  map.zones.forbidden = { ...newZone(zone), passability: 'forbidden' };
  return map;
}
const codes = (map: YardMap) => inspectSpatial(map).issues.map(issue => issue.code);
const hole = (polygon: Polygon) => [...polygon.outer].reverse() as Polygon['outer'];

describe('P2A declared spatial relations, pure Node and immutable maps', () => {
  it('keeps valid parent/slot containment and boundary contact without overlap errors', () => {
    const map = slotMap([rectangle(0, 0, 10, 10), rectangle(10, 0, 10, 10)]);
    const before = JSON.stringify(map); expect(codes(map)).toEqual([]); expect(JSON.stringify(map)).toBe(before);
    expect(inspectSpatial(map).checks.find(check => check.id === 'spatial.declaration_coverage')?.status).toBe('not_checked');
  });
  it('detects positive-area and identical sibling overlap, but not only touching edges', () => {
    expect(codes(slotMap([rectangle(1, 1, 10, 10), rectangle(5, 5, 10, 10)]))).toContain('SPATIAL_SLOT_OVERLAP');
    expect(codes(slotMap([rectangle(1, 1, 10, 10), rectangle(1, 1, 10, 10)]))).toContain('SPATIAL_SLOT_OVERLAP');
  });
  it('locates an out-of-owner slot field', () => {
    const result = inspectSpatial(slotMap([rectangle(-1, 1, 10, 10)]));
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'SPATIAL_SLOT_OUTSIDE_OWNER', entityId: 'fA', jsonPath: '/facilities/fA/extensions/sr02.planning/slots/0/boundary', severity: 'error' }));
  });
  it('detects a contained owner hole even when every slot vertex lies in the outer ring', () => {
    const owner = rectangle(); owner.holes.push(hole(rectangle(5, 5, 2, 2)));
    expect(codes(slotMap([rectangle(1, 1, 10, 10)], owner))).toContain('SPATIAL_SLOT_OUTSIDE_OWNER');
  });
  it('detects an edge spanning a concave owner notch despite all slot vertices being inside', () => {
    const owner = polygonFromVertices([[0,0,0],[60,0,0],[60,30,0],[40,30,0],[40,10,0],[20,10,0],[20,30,0],[0,30,0]]);
    expect(codes(slotMap([rectangle(10, 15, 40, 10)], owner))).toContain('SPATIAL_SLOT_OUTSIDE_OWNER');
  });
  it('uses face interiors including holes, not intersecting bounding boxes', () => {
    const a = polygonFromVertices([[0,0,0],[10,0,0],[0,10,0]]);
    const b = polygonFromVertices([[10,10,0],[10,6,0],[6,10,0]]);
    expect(polygonHasArea(a, b, 'intersection', () => {})).toBe(false);
    const donut = rectangle(0,0,20,20); donut.holes.push(hole(rectangle(4,4,12,12)));
    expect(polygonHasArea(rectangle(5,5,10,10), donut, 'intersection', () => {})).toBe(false);
    expect(polygonHasArea(rectangle(5,5,10,10), donut, 'outside', () => {})).toBe(true);
  });
  it('checks a known road half-width band even when its centerline misses the forbidden area', () => {
    expect(codes(roadMap())).toContain('SPATIAL_ROAD_FORBIDDEN');
    expect(codes(roadMap(rectangle(20,5,10,4)))).not.toContain('SPATIAL_ROAD_FORBIDDEN');
  });
  it('uses round caps and joins, excludes tangency, and rejects bbox-only diagonal overlap', () => {
    expect(codes(roadMap(rectangle(-4,3,1,1)))).toContain('SPATIAL_ROAD_FORBIDDEN');
    expect(codes(roadMap(rectangle(-5,3,1,1)))).not.toContain('SPATIAL_ROAD_FORBIDDEN');
    const bent = roadMap(rectangle(22,-4,1,1)); bent.nodes.b!.position=[20,20,0]; bent.roads.r!.shapePoints=[[20,0,0]];
    expect(codes(bent)).toContain('SPATIAL_ROAD_FORBIDDEN');
    const diagonal = roadMap(rectangle(0,80,10,10)); diagonal.nodes.b!.position=[100,100,0]; diagonal.roads.r!.widthM={state:'known',value:2};
    expect(codes(diagonal)).not.toContain('SPATIAL_ROAD_FORBIDDEN');
  });
  it('keeps a road inside a forbidden polygon hole clear until its round band reaches the hole edge', () => {
    const forbidden = rectangle(-20,-20,140,40); forbidden.holes.push(hole(rectangle(-10,-10,120,20)));
    expect(codes(roadMap(forbidden))).not.toContain('SPATIAL_ROAD_FORBIDDEN');
    const wider=roadMap(forbidden); wider.roads.r!.widthM={state:'known',value:22};
    expect(codes(wider)).toContain('SPATIAL_ROAD_FORBIDDEN');
  });
  it('uses manual corridor geometry over width and checks complete centerline against corridor holes', () => {
    const map=roadMap(); map.roads.r!.corridorPolygon=rectangle(0,-1,100,2); map.roads.r!.widthM={state:'known',value:100};
    expect(codes(map)).toEqual([]);
    map.roads.r!.corridorPolygon=rectangle(-1,-10,102,20);
    map.roads.r!.corridorPolygon.holes.push(hole(rectangle(40,-1,5,2)));
    expect(codes(map)).toContain('SPATIAL_CORRIDOR_CENTERLINE_OUTSIDE');
  });
  it('unknown widths and non-coplanar roads yield candidates and incomplete checks', () => {
    const unknown=roadMap(rectangle(20,-1,10,2)); unknown.roads.r!.widthM={state:'unknown'};
    const result=inspectSpatial(unknown);
    expect(result.issues).toContainEqual(expect.objectContaining({code:'SPATIAL_ROAD_FORBIDDEN_CANDIDATE',severity:'warning'}));
    expect(result.checks.find(check=>check.id==='spatial.road_forbidden')?.status).toBe('not_checked');
    const raised=roadMap(); raised.nodes.a!.position[2]=10; raised.nodes.b!.position[2]=10;
    expect(codes(raised)).toContain('SPATIAL_ROAD_FORBIDDEN_CANDIDATE');
    expect(codes(raised)).not.toContain('SPATIAL_ROAD_FORBIDDEN');
  });
  it('does not infer prohibition from building/water kind, owner containment or declared overlay', () => {
    const map=roadMap(); map.zones.forbidden!.passability='unknown'; map.zones.forbidden!.kind='water';
    map.facilities.dock=newFacility(rectangle(-5,-5,110,10),'dock','dock');
    expect(codes(map)).toEqual([]);
    map.extensionNamespaces[PLANNING_NAMESPACE]={version:'1.0',category:'behavior'};
    map.zones.forbidden!.extensions={[PLANNING_NAMESPACE]:{role:'dock_exclusion',overlayOf:'dock',waterSurface:true}};
    expect(codes(map)).toEqual([]);
  });
  it('missing forbidden declarations remain unchecked even if known widths or manual corridors exist', () => {
    const map=roadMap(); map.zones={};
    let check=inspectSpatial(map).checks.find(item=>item.id==='spatial.road_forbidden');
    expect(check?.status).toBe('not_checked'); expect(check?.detail).toContain('无明确禁入声明');
    map.roads.r!.corridorPolygon=rectangle(0,-1,100,2);
    check=inspectSpatial(map).checks.find(item=>item.id==='spatial.road_forbidden');
    expect(check?.status).toBe('partial'); expect(check?.detail).toContain('未确认道路与实际建筑/禁区关系');
  });
  it('unsupported behavior cannot upgrade spatial candidates into confirmed errors', () => {
    const map=roadMap(); map.extensionNamespaces.future={version:'2',category:'behavior'}; map.extensions.future={bridge:true};
    expect(inspectSpatial(map).issues.every(issue=>issue.severity==='warning')).toBe(true);
    expect(inspectSpatial(map).checks.some(check=>check.status!=='checked')).toBe(true);
  });
  it('distinguishes explicit internal service misplacement from proxy abstraction', () => {
    const map=roadMap(); map.facilities.fA=newFacility(rectangle(200,200,20,20));
    map.servicePoints.s={...newServicePoint('a','service','other','fA'),arrival:{mode:'explicit_internal',internalPath:[]}};
    expect(codes(map)).toContain('SPATIAL_SERVICE_OUTSIDE_OWNER');
    map.servicePoints.s!.arrival={mode:'node_proxy',transferAssumption:'included_in_service_duration',note:'explicit test abstraction'};
    expect(codes(map)).toContain('SPATIAL_SERVICE_PROXY_UNCHECKED');
    expect(codes(map)).not.toContain('SPATIAL_SERVICE_OUTSIDE_OWNER');
  });
  it('budget exhaustion is explicit, preserves partial issues and never reports all checks complete', () => {
    const result=inspectSpatial(slotMap(),{maxComparisons:1});
    expect(result.checks.find(check=>check.id==='spatial.slot_containment')?.status).toBe('partial');
    expect(result.checks.find(check=>check.id==='spatial.road_forbidden')?.status).toBe('not_checked');
    expect(result.checks.some(check=>check.detail.includes('预算'))).toBe(true);
  });
  it.each(P1_TARGETS.filter(target=>target.family==='SR03'))('reads $id unchanged and diagnoses in-memory fault copies',async target=>{
    const {map,text}=await readP1Target(target);
    const result=inspectSpatial(map);
    expect(result.issues).toEqual([]);
    expect(result.checks.filter(check=>!['spatial.declaration_coverage','spatial.road_forbidden'].includes(check.id)).every(check=>check.status==='checked')).toBe(true);
    expect(result.checks.find(check=>check.id==='spatial.road_forbidden')?.status).toBe(target.yard==='A' ? 'not_checked' : 'checked');
    const slots=inspectPlanning(map).slots; const first=slots[0]!;
    const copy=structuredClone(map);
    const owner=copy[first.ownerKind][first.ownerId]!;
    const payload=owner.extensions![PLANNING_NAMESPACE] as {slots:{id:string;boundary:Polygon}[]};
    const selected=payload.slots.find(slot=>slot.id===first.id)!;
    selected.boundary=transformPolygon(selected.boundary,point=>[point[0]+100000,point[1],point[2]]);
    expect(codes(copy)).toContain('SPATIAL_SLOT_OUTSIDE_OWNER');
    expect(JSON.stringify(map)).toBe(JSON.stringify(JSON.parse(text)));
    expect((await readP1Target(target)).text).toBe(text);
  });
});
