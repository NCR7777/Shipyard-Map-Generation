import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand, type Selection } from '../../src/domain/commands';
import { newFacility, newMap, newNode, newRoad, newZone } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import { entranceCommand, projectToOutline } from '../../src/app/canvas/entrances';
import { rectangle } from '../helpers/M2A_fixtures';
import { currentServiceFixture, internalServiceFixture, zoneServiceFixture } from '../helpers/M2A1_fixtures';

const selection = (values: Partial<Selection>): Selection => ({ nodes: [], roads: [], ...values });
function advanced<T extends YardMap>(map: T): T {
  map.resources.unrelated = { name: 'unrelated fixed capacity', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'known', value: 7 }, controlModel: 'exclusive', appliesTo: [], provenance: { category: 'synthetic' } };
  return map;
}
function apply(map: YardMap, command: MapCommand) {
  const original = structuredClone(map), support = commandSupport(map, command);
  expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
  const result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected deletion success');
  expect(map).toEqual(original); expect(validateMap(result.map).ok).toBe(true);
  return result;
}
function reject(map: YardMap, command: MapCommand, code: string) {
  const original = structuredClone(map), session = createSession(map, true), support = commandSupport(map, command);
  expect(support.allowed).toBe(false); expect(support.issues.map(issue => issue.code)).toContain(code);
  const result = editSession(session, command);
  expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(map).toEqual(original);
}
function network() {
  const map = advanced(currentServiceFixture());
  map.nodes.nC = newNode([200, 0, 0]);
  map.roads.rBC = { ...newRoad('nB', 'nC'), direction: 'both' };
  map.junctions.j = { name: 'retained junction', nodeIds: ['nB'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.m = { name: 'explicit turn', junctionId: 'j', incomingArc: { roadId: 'rAB', direction: 'forward' }, outgoingArc: { roadId: 'rBC', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.facilities.free = newFacility(rectangle(120, 50, 10, 10));
  return map;
}

describe('deletion uses supported references instead of the whole-map advanced gate', () => {
  it.each(['building', 'area'] as const)('deletes a fresh FAST01 %s after quick-trace roads create a junction', kind => {
    let map: YardMap = newMap('delete_fast01', 'synthetic repro', '0.3.0');
    map = apply(map, { type: 'quickTraceRoad', points: [[0, 0, 0], [100, 0, 0]] }).map;
    map = apply(map, { type: 'quickTraceRoad', points: [[50, -50, 0], [50, 50, 0]] }).map;
    map = apply(map, { type: 'quickTraceBoundary', kind, boundary: rectangle(120, 120, 10, 10) }).map;
    const collection = kind === 'building' ? 'facilities' : 'zones', id = Object.keys(map[collection])[0]!;
    expect(map[collection][id]!.kind).toBe(kind === 'building' ? 'building' : 'unclassified');
    const result = apply(map, { type: 'deleteSelection', selection: selection({ [collection]: [id] }) });
    expect(result.map[collection][id]).toBeUndefined(); expect(result.map.roads).toEqual(map.roads);
    expect(result.map.nodes).toEqual(map.nodes); expect(result.map.movements).toEqual(map.movements);
    expect(result.map.junctions).toEqual(map.junctions); expect(result.map.sources).toEqual(map.sources);
  });

  it.each([
    { kind: 'facilities', id: 'fA', members: true },
    { kind: 'zones', id: 'zA', members: true },
    { kind: 'zones', id: 'zB', members: false },
    { kind: 'accessPoints', id: 'aA', members: false },
    { kind: 'servicePoints', id: 'sA', members: false },
  ] as const)('allows ordinary $kind deletion with explicit member policies on a map containing unrelated resources', ({ kind, id, members }) => {
    const map = advanced(zoneServiceFixture());
    if (kind === 'accessPoints') delete map.servicePoints.sA!.accessPointId;
    const command: MapCommand = { type: 'deleteSelection', selection: selection({ [kind]: [id] }), ...(members ? { facilityPolicy: 'withAssociatedPoints', zonePolicy: 'withAssociatedPoints' } : {}) };
    const result = apply(map, command);
    expect(result.map[kind][id]).toBeUndefined(); expect(result.map.roads).toEqual(map.roads);
    expect(result.map.nodes).toEqual(map.nodes); expect(result.map.resources).toEqual(map.resources);
    if (kind === 'accessPoints') expect(result.map.facilities.fA!.accessPointIds).toEqual([]);
    if (kind === 'servicePoints') expect(result.map.facilities.fA!.servicePointIds).toEqual([]);
  });

  it('preserves explicit member and surviving access-reference protections before any mutation', () => {
    const map = advanced(zoneServiceFixture());
    reject(map, { type: 'deleteSelection', selection: selection({ facilities: ['fA'] }) }, 'FACILITY_HAS_POINTS');
    reject(map, { type: 'deleteSelection', selection: selection({ zones: ['zA'] }) }, 'ZONE_HAS_POINTS');
    reject(map, { type: 'deleteSelection', selection: selection({ accessPoints: ['aA'] }) }, 'ENTITY_IN_USE');
    expect(apply(map, { type: 'deleteSelection', selection: selection({ accessPoints: ['aA'], servicePoints: ['sA'] }) }).map.facilities.fA).toMatchObject({ accessPointIds: [], servicePointIds: [] });
  });

  it('uses the same explicit turn/resource cascade for a mixed road and boundary selection', () => {
    const map = network(); map.resources.unrelated!.appliesTo = [{ entityType: 'roads', entityId: 'rAB' }, { entityType: 'facilities', entityId: 'free' }];
    const command: MapCommand = { type: 'deleteSelection', selection: selection({ roads: ['rAB'], facilities: ['free'] }) };
    reject(map, command, 'TOPOLOGY_DELETE_DEPENDENCIES');
    const support = commandSupport(map, { ...command, topologyPolicy: 'cascade' });
    expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'roads', id: 'rAB' }, { kind: 'facilities', id: 'free' }, { kind: 'movements', id: 'm' }, { kind: 'resources', id: 'unrelated' }]));
    const session = createSession(map, true), result = editSession(session, { ...command, topologyPolicy: 'cascade' });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    const after = result.session.map;
    expect(after.facilities.free).toBeUndefined(); expect(after.roads.rAB).toBeUndefined(); expect(after.movements.m).toBeUndefined();
    expect(after.roads.rBC).toEqual(map.roads.rBC); expect(after.nodes).toEqual(map.nodes); expect(after.junctions).toEqual(map.junctions);
    expect(after.resources.unrelated!.appliesTo).toEqual([]); expect(after.resources.unrelated!.capacity).toEqual(map.resources.unrelated!.capacity);
    expect(after.revision).toBe(map.revision + 1);
    const undone = undoSession(result.session); expect(undone.map).toEqual(map); expect(redoSession(undone).map).toEqual(after);
  });

  it.each(['facilities', 'zones', 'accessPoints', 'servicePoints'] as const)('requires explicit cleanup of a resource targeting deleted %s and preserves its capacity', kind => {
    const map = advanced(zoneServiceFixture()), id = { facilities: 'fA', zones: 'zA', accessPoints: 'aA', servicePoints: 'sA' }[kind];
    delete map.servicePoints.sA!.accessPointId;
    map.resources.unrelated!.appliesTo = [{ entityType: kind, entityId: id }, { entityType: 'roads', entityId: 'rAB' }];
    const command: MapCommand = { type: 'deleteSelection', selection: selection({ [kind]: [id] }), facilityPolicy: 'withAssociatedPoints', zonePolicy: 'withAssociatedPoints' };
    reject(map, command, 'TOPOLOGY_DELETE_DEPENDENCIES');
    const after = apply(map, { ...command, topologyPolicy: 'cascade' }).map;
    expect(after.resources.unrelated!.appliesTo).toEqual([{ entityType: 'roads', entityId: 'rAB' }]);
    expect(after.resources.unrelated!.capacity).toEqual(map.resources.unrelated!.capacity); expect(after.roads).toEqual(map.roads);
  });

  it('does not delete a retained service internal path when an unrelated facility joins the road selection', () => {
    const map = advanced(internalServiceFixture()); map.facilities.free = newFacility(rectangle(120, 50, 10, 10));
    reject(map, { type: 'deleteSelection', selection: selection({ roads: ['rInternal'], facilities: ['free'] }), topologyPolicy: 'cascade' }, 'TOPOLOGY_SERVICE_PATH_DEPENDENCY');
    const after = apply(map, { type: 'deleteSelection', selection: selection({ facilities: ['fA'], roads: ['rInternal'] }), facilityPolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(after.roads.rAB).toEqual(map.roads.rAB); expect(after.nodes.nA).toEqual(map.nodes.nA); expect(after.nodes.nS).toBeUndefined();
  });

  it('retains road-, junction-, and resource-used point nodes during deleteUnused cleanup', () => {
    const map = advanced(currentServiceFixture());
    map.junctions.j = { name: 'still declared node', nodeIds: ['nS'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
    map.resources.unrelated!.appliesTo = [{ entityType: 'nodes', entityId: 'nS' }];
    const after = apply(map, { type: 'deleteSelection', selection: selection({ facilities: ['fA'] }), facilityPolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(after.nodes).toEqual(map.nodes); expect(after.roads).toEqual(map.roads); expect(after.junctions).toEqual(map.junctions); expect(after.resources).toEqual(map.resources);
  });

  it('rejects retained static owner references and removes private roads only when explicitly selected', () => {
    const map = advanced(internalServiceFixture());
    map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.roads.rInternal!.extensions = { 'sr02.planning': { role: 'internal', ownerEntityId: 'fA', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } };
    const command: MapCommand = { type: 'deleteSelection', selection: selection({ facilities: ['fA'] }), facilityPolicy: 'withAssociatedPoints', topologyPolicy: 'cascade', orphanNodes: 'deleteUnused' };
    reject(map, command, 'TOPOLOGY_PLANNING_DEPENDENCY');
    const support = commandSupport(map, command);
    expect(support.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PLANNING_REFERENCE', jsonPath: '/roads/rInternal/extensions/sr02.planning/ownerEntityId' })]));
    const after = apply(map, { ...command, selection: selection({ facilities: ['fA'], roads: ['rInternal'] }) }).map;
    expect(after.roads.rInternal).toBeUndefined(); expect(after.roads.rAB).toEqual(map.roads.rAB); expect(after.nodes.nA).toEqual(map.nodes.nA);
  });

  it('rejects an external storage resource slot reference after the selected owner is removed', () => {
    const map = advanced(currentServiceFixture()); map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.facilities.fA!.extensions = { 'sr02.planning': { role: 'yard', dimensionBasis: 'synthetic', slotGapM: 0, slotLengthM: 2, slotWidthM: 2, transportAisleWidthM: 1, slots: [{ id: 'slot', boundary: rectangle(3, 3, 2, 2) }], storageResourceId: 'storage' } };
    map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 4 }, controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'fA' }], provenance: { category: 'synthetic' }, extensions: { 'sr02.planning': { slotAreaM2: 4, slotIds: ['slot'], unitMeaning: 'cargo_storage_area' } } };
    const command: MapCommand = { type: 'deleteSelection', selection: selection({ facilities: ['fA'] }), facilityPolicy: 'withAssociatedPoints', topologyPolicy: 'cascade' };
    reject(map, command, 'TOPOLOGY_PLANNING_DEPENDENCY');
    expect(commandSupport(map, command).issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PLANNING_REFERENCE', jsonPath: '/resources/storage/extensions/sr02.planning/slotIds/0' })]));
  });

  it('removes owner-embedded parking slots with that owner while protecting a retained slot reference to a service', () => {
    const map = advanced(zoneServiceFixture()); map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.servicePoints.sZone!.kind = 'parking';
    map.zones.zA!.extensions = { 'sr02.planning': { role: 'parking', quantityBasis: 'synthetic', slotLengthM: 4, slotWidthM: 4, transportAisleWidthM: 1, slots: [{ id: 'bay', boundary: rectangle(78, 28, 4, 4), servicePointId: 'sZone' }] } };
    reject(map, { type: 'deleteSelection', selection: selection({ servicePoints: ['sZone'] }) }, 'TOPOLOGY_PLANNING_DEPENDENCY');
    const after = apply(map, { type: 'deleteSelection', selection: selection({ zones: ['zA'] }), zonePolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(after.zones.zA).toBeUndefined(); expect(after.servicePoints.sZone).toBeUndefined(); expect(after.roads).toEqual(map.roads); expect(after.nodes).toEqual(map.nodes); expect(after.resources).toEqual(map.resources);
  });

  it('retains unknown behavior and exact opaque references instead of dropping them to permit deletion', () => {
    const map = advanced(currentServiceFixture()); map.facilities.free = newFacility(rectangle(120, 50, 10, 10));
    map.extensionNamespaces['test.opaque'] = { version: '1', category: 'metadata' }; map.metadata.extensions = { 'test.opaque': { facility: 'free' } };
    reject(map, { type: 'deleteSelection', selection: selection({ facilities: ['free'] }) }, 'TOPOLOGY_OPAQUE_REFERENCE');
    map.extensionNamespaces['test.unknown'] = { version: '1', category: 'behavior' }; map.extensions['test.unknown'] = { untouched: true };
    reject(map, { type: 'deleteSelection', selection: selection({ facilities: ['free'] }) }, 'READ_ONLY_MAP');
  });
});


describe('independent additions use their existing maintenance rules on advanced maps', () => {
  // Ported from ../map (deferred creation through PointCreationPanel), now through the entrance tool's command builder.
  // Deferred service points follow with P3b2.
  it('creates a deferred entrance with its node and the owner reverse reference in one transaction', () => {
    const map = network();
    map.sources.image = { name: 'image reference', category: 'imagery_derived', description: 'synthetic reference for this test' };
    map.facilities.fA!.provenance = { category: 'drawing', sourceRefs: ['image'] };
    const on = projectToOutline(map, 'fA', [-5, 15, 0])!;
    const before = structuredClone(map), { command } = entranceCommand(map, 'fA', on, { point: 'access_deferred', node: 'node_deferred' });
    expect(commandSupport(map, command).allowed).toBe(true);
    const session = createSession(map, true), result = editSession(session, command);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    const after = result.session.map, point = after.accessPoints.access_deferred!;
    expect(after.nodes.node_deferred!.position).toEqual(on);
    expect(point.provenance).toMatchObject({ category: 'drawing', sourceRefs: ['image'] }); expect(after.nodes.node_deferred!.provenance).toEqual(point.provenance);
    expect(after.facilities.fA!.accessPointIds).toContain('access_deferred');
    for (const collection of ['roads', 'junctions', 'movements', 'resources', 'sources'] as const) expect(after[collection]).toEqual(before[collection]);
    expect(after.revision).toBe(before.revision + 1); expect(undoSession(result.session).map).toEqual(before); expect(redoSession(undoSession(result.session)).map).toEqual(after); expect(map).toEqual(before);
    const collision = { ...command, id: 'rAB' } as MapCommand;
    const failed = editSession(session, collision); expect(failed.ok).toBe(false); expect(failed.session).toBe(session); expect(map).toEqual(before);
  });

  it('allows independent nodes and empty boundaries while keeping raw road creation gated', () => {
    const map = network();
    const additions: MapCommand[] = [
      { type: 'addNode', id: 'independent', node: newNode([300, 0, 0]) },
      { type: 'addFacility', id: 'building', facility: newFacility(rectangle(300, 0, 20, 20)) },
      { type: 'addZone', id: 'area', zone: newZone(rectangle(400, 0, 20, 20)) },
    ];
    for (const command of additions) {
      const result = apply(map, command);
      for (const collection of ['roads', 'junctions', 'movements', 'resources'] as const) expect(result.map[collection]).toEqual(map[collection]);
    }
    reject(map, { type: 'addRoad', id: 'rawRoad', road: newRoad('nA', 'nC') }, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
  });
});
