import { describe, expect, it } from 'vitest';
import { inspectPlanning, MAX_PLANNING_SLOTS, PLANNING_NAMESPACE } from '../../src/domain/planning';
import { newMap } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';
import { testNode } from '../helpers/M1_fixtures';
import { rectangle, testFacility, testZone } from '../helpers/M2A_fixtures';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

const payload = (entity: { extensions?: Record<string, unknown> }) => entity.extensions![PLANNING_NAMESPACE] as Record<string, unknown>;
const slotRecords = (map: YardMap) => payload(map.facilities.fA!).slots as Record<string, unknown>[];
function fixture(): YardMap {
  const map = newMap('map_planning_test', 'synthetic planning reader');
  map.extensionNamespaces[PLANNING_NAMESPACE] = { version: '1.0', category: 'behavior' };
  map.extensions[PLANNING_NAMESPACE] = { assumptionId: 'test_design', role: 'synthetic_planning', siteAreaBasis: 'test only' };
  map.facilities.fA = { ...testFacility(), extensions: { [PLANNING_NAMESPACE]: {
    role: 'production', dimensionBasis: 'synthetic', slotGapM: 4, slotLengthM: 20, slotWidthM: 10,
    transportAisleWidthM: 12, storageResourceId: 'storeA',
    slots: [{ id: 'slotA', boundary: rectangle(1, 1, 20, 10) }, { id: 'slotB', boundary: rectangle(25, 1, 20, 10) }],
  } } };
  map.resources.storeA = {
    name: 'Storage area', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 400 },
    controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'fA' }], provenance: { category: 'synthetic' },
    extensions: { [PLANNING_NAMESPACE]: { slotAreaM2: 200, slotIds: ['slotA', 'slotB'], unitMeaning: 'cargo_storage_area' } },
  };
  map.nodes.nParking = testNode('parking', 105, 111);
  map.servicePoints.parkingA = { name: 'Bay service', kind: 'parking', nodeId: 'nParking', zoneId: 'zParking', resourceIds: [], provenance: { category: 'synthetic' } };
  map.zones.zParking = { ...testZone('waiting'), boundary: rectangle(100, 100, 40, 30), extensions: { [PLANNING_NAMESPACE]: {
    role: 'parking', quantityBasis: 'fleet_and_standby_design', slotLengthM: 20, slotWidthM: 8, transportAisleWidthM: 12,
    slots: [{ id: 'bayA', servicePointId: 'parkingA', boundary: rectangle(101, 101, 8, 20) }],
  } } };
  return map;
}
function refused(map: YardMap, suffix: string, path?: string): void {
  const before = JSON.stringify(map); const result = inspectPlanning(map);
  expect(result.supported).toBe(false);
  expect(result.issues).toContainEqual(expect.objectContaining({ code: 'PLANNING_' + suffix, severity: 'warning', ...(path ? { jsonPath: path } : {}) }));
  expect(JSON.stringify(map)).toBe(before);
}

describe('P1 fixed sr02.planning static reader', () => {
  it('is absent on ordinary maps and extracts independent slot snapshots without mutation', () => {
    expect(inspectPlanning(newMap('ordinary', 'ordinary'))).toEqual({ present: false, supported: true, issues: [], slots: [] });
    const map = fixture(); const before = JSON.stringify(map); const result = inspectPlanning(map);
    expect(result.present).toBe(true); expect(result.supported, JSON.stringify(result.issues)).toBe(true);
    expect(result.slots.map(slot => [slot.ownerKind, slot.ownerId, slot.id, slot.parking])).toEqual([
      ['facilities', 'fA', 'slotA', false], ['facilities', 'fA', 'slotB', false], ['zones', 'zParking', 'bayA', true],
    ]);
    result.slots[0]!.boundary.outer[0][0] = -999;
    expect(JSON.stringify(map)).toBe(before);
  });
  it.each(['version', 'category', 'undeclared'])('refuses unsupported declaration: %s', mode => {
    const map = fixture();
    if (mode === 'version') map.extensionNamespaces[PLANNING_NAMESPACE]!.version = '2.0';
    if (mode === 'category') map.extensionNamespaces[PLANNING_NAMESPACE]!.category = 'metadata';
    if (mode === 'undeclared') delete map.extensionNamespaces[PLANNING_NAMESPACE];
    refused(map, 'UNSUPPORTED_DECLARATION', '/extensionNamespaces/sr02.planning');
    expect(inspectPlanning(map).slots).toEqual([]);
  });
  it('does not claim another behavior namespace is understood or inspect it', () => {
    const map = newMap('other', 'other');
    map.extensionNamespaces['test.other'] = { version: '1', category: 'behavior' };
    map.extensions['test.other'] = { mystery: true };
    expect(inspectPlanning(map)).toEqual({ present: false, supported: true, issues: [], slots: [] });
  });
  it.each(['root', 'owner', 'slot', 'polygon'])('rejects unknown behavior fields in %s', where => {
    const map = fixture();
    const target = where === 'root' ? payload(map) : where === 'owner' ? payload(map.facilities.fA!) : where === 'slot' ? slotRecords(map)[0]! : slotRecords(map)[0]!.boundary as Record<string, unknown>;
    target['future/motion'] = { transforms: [1, 2, 3] };
    refused(map, 'UNKNOWN_FIELD');
    expect(inspectPlanning(map).issues.some(issue => issue.jsonPath.endsWith('/future~1motion'))).toBe(true);
  });
  it('scans entity-only namespace occurrences rather than depending on a top-level payload', () => {
    const map = newMap('nested', 'nested'); map.nodes.nA = testNode('A', 0);
    map.extensionNamespaces[PLANNING_NAMESPACE] = { version: '1.0', category: 'behavior' };
    map.nodes.nA.extensions = { [PLANNING_NAMESPACE]: {} };
    const result = inspectPlanning(map);
    expect(result.present).toBe(true); refused(map, 'UNSUPPORTED_LOCATION', '/nodes/nA/extensions/sr02.planning');
  });
  it('preserves explicitly read-only SR02/SR03 source records but rejects other source fields', () => {
    const map = fixture();
    map.metadata.extensions = { [PLANNING_NAMESPACE]: { publicFactsFile: 'sources.json', publicReference: 'synthetic',
      evidenceRegister: { reportedDimensions: [20, 10], note: 'not active geometry', arbitraryHistoricalField: true } } };
    map.sources.src = { name: 'source', category: 'synthetic', description: 'test', extensions: { [PLANNING_NAMESPACE]: { evidenceRecord: { facts: ['unchanged'], nested: { position: [999, 999] } } } } };
    const original = JSON.stringify(map);
    expect(inspectPlanning(map).supported).toBe(true); expect(JSON.stringify(map)).toBe(original);
    payload(map.sources.src).motion = 'new semantics'; refused(map, 'UNKNOWN_FIELD');
  });
  it.each(['owner', 'overlay'])('validates explicit %s references', mode => {
    const map = fixture();
    if (mode === 'owner') {
      map.roads.owned = { name: 'test', fromNodeId: 'nParking', toNodeId: 'nParking', direction: 'both', shapePoints: [],
        widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' }, resourceIds: [], provenance: { category: 'synthetic' },
        extensions: { [PLANNING_NAMESPACE]: { role: 'internal', ownerEntityId: 'missing', physicalMeaning: 'declared_design_corridor_not_surveyed_clearance' } } };
    } else map.zones.overlay = { ...testZone(), extensions: { [PLANNING_NAMESPACE]: { role: 'dock_exclusion', overlayOf: 'missing', waterSurface: true } } };
    refused(map, 'REFERENCE');
  });
  it.each([
    ['slot id', (m: YardMap) => { slotRecords(m)[1]!.id = 'slotA'; }, 'DUPLICATE_SLOT'],
    ['core id collision', (m: YardMap) => { slotRecords(m)[0]!.id = 'fA'; }, 'DUPLICATE_SLOT'],
    ['missing resource', (m: YardMap) => { payload(m.facilities.fA!).storageResourceId = 'absent'; }, 'REFERENCE'],
    ['missing slot', (m: YardMap) => { payload(m.resources.storeA!).slotIds = ['slotA', 'absent']; }, 'REFERENCE'],
    ['omitted slot', (m: YardMap) => { payload(m.resources.storeA!).slotIds = ['slotA']; }, 'RESOURCE_SLOTS'],
    ['repeated resource slot', (m: YardMap) => { payload(m.resources.storeA!).slotIds = ['slotA', 'slotA']; }, 'DUPLICATE_SLOT'],
    ['wrong resource owner', (m: YardMap) => { m.resources.storeA!.appliesTo = [{ entityType: 'zones', entityId: 'zParking' }]; }, 'RESOURCE_OWNER'],
    ['capacity', (m: YardMap) => { m.resources.storeA!.capacity = { state: 'known', value: 500 }; }, 'CAPACITY'],
    ['unit', (m: YardMap) => { m.resources.storeA!.capacityUnit = 'vehicle'; }, 'CAPACITY'],
    ['slot area', (m: YardMap) => { payload(m.resources.storeA!).slotAreaM2 = 201; }, 'SLOT_AREA'],
    ['parking owner', (m: YardMap) => { m.servicePoints.parkingA!.zoneId = 'missing'; }, 'SLOT_SERVICE_OWNER'],
    ['parking reference', (m: YardMap) => { (payload(m.zones.zParking!).slots as Record<string, unknown>[])[0]!.servicePointId = 'absent'; }, 'REFERENCE'],
  ] as const)('detects %s inconsistency', (_name, mutate, code) => { const map = fixture(); mutate(map); refused(map, code); });
  it('refuses a second storage owner reusing the first resource without reciprocal ownership', () => {
    const map = fixture(); map.facilities.fB = structuredClone(map.facilities.fA!);
    payload(map.facilities.fB).slots = [{ id: 'slotC', boundary: rectangle(1, 1, 20, 10) }, { id: 'slotD', boundary: rectangle(25, 1, 20, 10) }];
    refused(map, 'STORAGE_RESOURCE', '/facilities/fB/extensions/sr02.planning/storageResourceId');
  });
  it('requires every parking service of a declared parking owner to have a bay', () => {
    const map = fixture(); map.servicePoints.parkingB = { ...structuredClone(map.servicePoints.parkingA!), name: 'unlisted parking' };
    refused(map, 'PARKING_SLOT_MISSING', '/servicePoints/parkingB');
  });
  it('rejects a finite geometry area inconsistent with declared dimensions', () => {
    const map = fixture(); slotRecords(map)[0]!.boundary = rectangle(1, 1, 21, 10);
    refused(map, 'SLOT_AREA', '/facilities/fA/extensions/sr02.planning/slots/0/boundary');
  });
  it.each([null, {}, { outer: [], holes: [] }, { outer: [[0, 0, NaN], [1, 0, 0], [1, 1, 0], [0, 0, 0]], holes: [] }])('does not throw on malformed boundary %#', boundary => {
    const map = fixture(); slotRecords(map)[0]!.boundary = boundary;
    expect(() => inspectPlanning(map)).not.toThrow(); expect(inspectPlanning(map).supported).toBe(false);
  });
  it.each([null, [null], [7]])('does not throw on malformed owner slot array %#', slots => {
    const map = fixture(); payload(map.facilities.fA!).slots = slots;
    expect(() => inspectPlanning(map)).not.toThrow(); expect(inspectPlanning(map).supported).toBe(false);
  });
  it('uses existing polygon semantics instead of silently correcting clockwise geometry', () => {
    const map = fixture(); const boundary = rectangle(1, 1, 20, 10); boundary.outer.reverse();
    slotRecords(map)[0]!.boundary = boundary; refused(map, 'POLYGON_WINDING');
  });
  it('bounds slot count before expensive geometry and rejects new nested execution values', () => {
    const map = fixture(); payload(map.facilities.fA!).slots = Array(MAX_PLANNING_SLOTS + 1).fill(slotRecords(map)[0]);
    refused(map, 'COMPLEXITY_LIMIT');
    const other = fixture();
    other.servicePoints.parkingA!.extensions = { [PLANNING_NAMESPACE]: { capability: 'loading_and_unloading', handling: 'run_custom_controller' } };
    refused(other, 'VALUE', '/servicePoints/parkingA/extensions/sr02.planning/handling');
  });
});

describe('P1 frozen original compatibility', () => {
  for (const target of P1_TARGETS.filter(target => target.family === 'SR02' || target.family === 'SR03')) {
    it(target.id + ' keeps every original slot and byte', async () => {
      const { text, map } = await readP1Target(target);
      const before = JSON.stringify(map); const result = inspectPlanning(map);
      expect(result.supported, JSON.stringify(result.issues)).toBe(true); expect(result.issues).toEqual([]);
      expect(result.slots).toHaveLength(target.counts[12]); expect(JSON.stringify(map)).toBe(before);
      expect((await readP1Target(target)).text).toBe(text);
    });
  }
});
