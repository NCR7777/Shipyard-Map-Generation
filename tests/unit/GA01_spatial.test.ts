import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../../src/domain/factory';
import { inspectPlanning } from '../../src/domain/planning';
import { inspectSpatial, inspectSpatialEdit } from '../../src/validation/spatialDiagnostics';
import { rectangle } from '../helpers/M2A_fixtures';

function roads() {
  const map = newMap('GA01_spatial', 'synthetic local spatial guard');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]);
  map.roads.r = { ...newRoad('a', 'b'), widthM: { state: 'known', value: 10 } };
  map.zones.old = { ...newZone(rectangle(20, 4, 10, 4)), passability: 'forbidden' };
  return map;
}
function slotted() {
  const map = roads();
  map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
  map.facilities.owner = { ...newFacility(rectangle(200, 0, 40, 20)), extensions: { 'sr02.planning': {
    role: 'production', dimensionBasis: 'synthetic', slotGapM: 1, slotLengthM: 10, slotWidthM: 10, transportAisleWidthM: 2, storageResourceId: 'storage',
    slots: [{ id: 'slot_a', boundary: rectangle(200, 0, 10, 10) }, { id: 'slot_b', boundary: rectangle(220, 0, 10, 10) }],
  } } };
  map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 200 }, controlModel: 'shared_capacity',
    appliesTo: [{ entityType: 'facilities', entityId: 'owner' }], provenance: { category: 'synthetic' },
    extensions: { 'sr02.planning': { slotAreaM2: 100, slotIds: ['slot_a', 'slot_b'], unitMeaning: 'cargo_storage_area' } } };
  expect(inspectPlanning(map).supported).toBe(true);
  return map;
}
const errors = (issues: ReturnType<typeof inspectSpatialEdit>) => issues.filter(issue => issue.severity === 'error');
describe('GA01 commit-only changed spatial relations', () => {
  it('ignores unchanged legacy conflicts and source/name-only edits, but requires changed relations to be clear', () => {
    const before = roads(), after = structuredClone(before);
    expect(inspectSpatial(before).issues.some(issue => issue.code === 'SPATIAL_ROAD_FORBIDDEN')).toBe(true);
    after.metadata.name += ' renamed'; after.roads.r!.widthM = { state: 'known', value: 10, sourceRef: 'new_source' };
    expect(inspectSpatialEdit(before, after)).toEqual([]);
    after.roads.r!.widthM = { state: 'known', value: 9 };
    expect(errors(inspectSpatialEdit(before, after)).map(issue => issue.code)).toContain('SPATIAL_ROAD_FORBIDDEN');
    after.roads.r!.widthM = { state: 'known', value: 8 };
    expect(errors(inspectSpatialEdit(before, after))).toEqual([]); // Contact is not positive overlap.
    expect(before.roads.r!.widthM).toEqual({ state: 'known', value: 10 });
  });
  it('checks a changed forbidden zone against every road without subtracting same-code legacy issues', () => {
    const before = roads(); before.zones.changed = { ...newZone(rectangle(40, 20, 10, 10)), passability: 'forbidden' };
    const after = structuredClone(before); after.zones.changed!.boundary = rectangle(40, 3, 10, 10);
    const issues = errors(inspectSpatialEdit(before, after));
    expect(issues).toHaveLength(1); expect(issues[0]?.message).toContain('zones/changed');
    expect(issues[0]?.jsonPath).toBe('/roads/r/widthM');
  });
  it('checks a changed road against all explicit forbidden spaces, with unknown width remaining unconfirmed', () => {
    const before = roads(); before.zones = { far: { ...newZone(rectangle(40, 20, 10, 10)), passability: 'forbidden' } };
    const after = structuredClone(before); after.roads.r!.shapePoints = [[45, 25, 0]];
    expect(errors(inspectSpatialEdit(before, after)).map(issue => issue.code)).toContain('SPATIAL_ROAD_FORBIDDEN');
    after.roads.r!.widthM = { state: 'unknown' };
    expect(errors(inspectSpatialEdit(before, after))).toEqual([]);
    expect(inspectSpatialEdit(before, after).some(issue => issue.code === 'SPATIAL_ROAD_FORBIDDEN_CANDIDATE')).toBe(true);
  });
  it('does not use a centerline box to claim clearance for unknown-width roads beside a changed forbidden area', () => {
    const before = roads(); before.roads.r!.widthM = { state: 'unknown' }; before.zones.old!.boundary = rectangle(20, 10, 10, 4);
    const after = structuredClone(before); after.zones.old!.boundary = rectangle(20, 8, 10, 4);
    const issues = inspectSpatialEdit(before, after);
    expect(issues.some(issue => issue.code === 'SPATIAL_WIDTH_UNCHECKED')).toBe(true);
    expect(errors(issues)).toEqual([]);
  });
  it('keeps unrelated objects outside the scope even when their old slots are outside owner', () => {
    const before = slotted(); before.facilities.owner!.boundary = rectangle(200, 0, 5, 5);
    before.nodes.c = newNode([0, 100, 0]); before.nodes.d = newNode([100, 100, 0]); before.roads.safe = newRoad('c', 'd');
    const after = structuredClone(before); after.nodes.c!.position[0] += 1;
    expect(errors(inspectSpatialEdit(before, after))).toEqual([]);
  });
  it('checks owner containment and only changed slot pairs; legal containment is not a conflict', () => {
    const before = slotted(), after = structuredClone(before);
    after.facilities.owner!.boundary = rectangle(199, -1, 42, 22);
    expect(errors(inspectSpatialEdit(before, after))).toEqual([]);
    after.facilities.owner!.boundary = rectangle(205, 0, 30, 20);
    expect(errors(inspectSpatialEdit(before, after)).map(issue => issue.code)).toContain('SPATIAL_SLOT_OUTSIDE_OWNER');
    after.facilities.owner!.boundary = structuredClone(before.facilities.owner!.boundary);
    const payload = after.facilities.owner!.extensions!['sr02.planning'] as { slots: { boundary: ReturnType<typeof rectangle> }[] };
    payload.slots[1]!.boundary = rectangle(205, 0, 10, 10);
    expect(errors(inspectSpatialEdit(before, after)).map(issue => issue.code)).toContain('SPATIAL_SLOT_OVERLAP');
    expect(after.resources).toEqual(before.resources);
  });
  it('checks explicit internal service containment, never inventing containment for proxies or renames', () => {
    const before = roads(); before.facilities.owner = newFacility(rectangle(0, -10, 20, 20));
    before.servicePoints.s = { ...newServicePoint('a', 's', 'other', 'owner'), arrival: { mode: 'explicit_internal', internalPath: [] } };
    const after = structuredClone(before); after.nodes.a!.position = [-1, 0, 0];
    expect(errors(inspectSpatialEdit(before, after)).map(issue => issue.code)).toContain('SPATIAL_SERVICE_OUTSIDE_OWNER');
    after.servicePoints.s!.arrival = { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: 'synthetic proxy' };
    expect(inspectSpatialEdit(before, after).some(issue => issue.code === 'SPATIAL_SERVICE_PROXY_UNCHECKED')).toBe(true);
    const renamed = structuredClone(before); renamed.servicePoints.s!.name = 'name only';
    expect(inspectSpatialEdit(before, renamed)).toEqual([]);
  });
  it('rejects budget exhaustion and truncated issue lists instead of treating either as success', () => {
    const before = roads(), after = structuredClone(before); after.nodes.a!.position[0] += 1;
    expect(inspectSpatial(after, { maxComparisons: 0 }).completion).toBe('budget_exhausted');
    expect(errors(inspectSpatialEdit(before, after, { maxComparisons: 0 })).map(issue => issue.code)).toContain('SPATIAL_EDIT_INCOMPLETE');
    for (let i = 0; i < 201; i++) before.zones['z' + i] = structuredClone(before.zones.old!);
    const many = structuredClone(before); many.nodes.a!.position[0] += 1;
    expect(inspectSpatial(many).completion).toBe('truncated');
    expect(errors(inspectSpatialEdit(before, many)).map(issue => issue.code)).toContain('SPATIAL_EDIT_INCOMPLETE');
  });
});
