import { describe, expect, it, vi } from 'vitest';
import { applyMapCommand, commandSupport, selectionImpact, type MapCommand } from '../../src/domain/commands';
import { newMap, newNode, newRoad, newFacility, newZone, newAccessPoint, newServicePoint } from '../../src/domain/factory';
import { createSession, editSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import { rectangle } from '../helpers/M2A_fixtures';
import * as spatial from '../../src/validation/spatialDiagnostics';
import type { Issue, YardMap } from '../../src/domain/model';

function fixture(): YardMap {
  const map = newMap('GA01_dependencies', 'synthetic dependency tests');
  map.coordinateFrame.geographicAnchor = { crs: 'EPSG:32651', coordinateOrder: 'E,N,Z', origin: [42, 36, 2], rotationRad: 0.3, method: 'synthetic fixture' };
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([10, 0, 0]); map.nodes.c = newNode([20, 0, 0]);
  map.roads.ab = { ...newRoad('a', 'b'), direction: 'both', widthM: { state: 'known', value: 1 } };
  map.roads.bc = { ...newRoad('b', 'c'), direction: 'both', widthM: { state: 'known', value: 1 } };
  map.junctions.j = { name: 'ID only junction', nodeIds: ['b'], model: 'explicit_movements', resourceIds: ['r'], provenance: { category: 'synthetic' } };
  map.movements.m = { name: 'ID only turn', junctionId: 'j', incomingArc: { roadId: 'ab', direction: 'forward' }, outgoingArc: { roadId: 'bc', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.resources.r = { name: 'ID only resource', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'j' }], provenance: { category: 'synthetic' } };
  return map;
}
const move = (id = 'a'): MapCommand => ({ type: 'updateNode', id, patch: { position: [0, 1, 0] } });
const shape: MapCommand = { type: 'updateRoad', id: 'ab', patch: { shapePoints: [[5, 1, 0]] } };
function reject(map: YardMap, command: MapCommand, code: string) {
  const original = structuredClone(map), session = createSession(map, true);
  const support = commandSupport(map, command);
  expect(support.allowed).toBe(false); expect(support.issues.map(issue => issue.code)).toContain(code);
  const result = editSession(session, command);
  expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(map).toEqual(original);
}
function run(map: YardMap, command: MapCommand) {
  const before = structuredClone(map), result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected command success');
  expect(map).toEqual(before); expect(result.map.coordinateFrame).toEqual(map.coordinateFrame);
  return result;
}
function owner(map: YardMap) {
  map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
  map.facilities.owner = newFacility(rectangle(-5, -5, 30, 15));
  map.facilities.owner.extensions = { 'sr02.planning': {
    role: 'yard', dimensionBasis: 'synthetic', slotGapM: 0, slotLengthM: 2, slotWidthM: 2, transportAisleWidthM: 1,
    slots: [{ id: 'slot', boundary: rectangle(0, 3, 2, 2) }], storageResourceId: 'storage',
  } };
  map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 4 }, controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'owner' }], provenance: { category: 'synthetic' }, extensions: { 'sr02.planning': { slotAreaM2: 4, slotIds: ['slot'], unitMeaning: 'cargo_storage_area' } } };
  map.roads.ab!.extensions = { 'sr02.planning': { role: 'internal', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance', ownerEntityId: 'owner' } };
}

describe('GA01-B bounded operation dependencies', () => {
  it('allows an independent node to change while preserving pure-ID turns and resources', () => {
    const map = fixture(); const result = run(map, move());
    expect(result.changed).toBe(true); expect(result.map.nodes.a!.position).toEqual([0, 1, 0]);
    expect(result.map.movements).toEqual(map.movements); expect(result.map.resources).toEqual(map.resources); expect(result.map.roads).toEqual(map.roads);
    expect(result.transaction?.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'movements', id: 'm' }, { kind: 'junctions', id: 'j' }, { kind: 'resources', id: 'r' }]));
  });
  it('does not block unrelated resources or planning slot owners elsewhere', () => {
    const map = fixture(); owner(map);
    const result = run(map, { type: 'updateNode', id: 'c', patch: { position: [21, 0, 0] } });
    expect(result.map.facilities).toEqual(map.facilities); expect(result.map.resources).toEqual(map.resources);
  });
  it('permits a pure point/road translation but never rotates it or mixes owner movement', () => {
    const map = fixture();
    const result = run(map, { type: 'translateSelection', selection: { nodes: [], roads: ['ab'] }, delta: [0, 1, 0] });
    expect(result.map.nodes.a!.position).toEqual([0, 1, 0]); expect(result.map.nodes.b!.position).toEqual([10, 1, 0]);
    expect(result.map.nodes.c).toEqual(map.nodes.c);
    reject(map, { type: 'rotateSelection', selection: { nodes: ['a'], roads: [] }, pivot: [0, 0, 0], angleRad: 0.1 }, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
    map.facilities.free = newFacility(rectangle(30, 30, 5, 5));
    reject(map, { type: 'translateSelection', selection: { nodes: ['a'], roads: [], facilities: ['free'] }, delta: [1, 0, 0], facilityMovePolicy: 'boundaryOnly' }, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
  });
  it('edits shapePoints without treating the endpoint nodes or neighboring road as moved', () => {
    const map = fixture(); const support = commandSupport(map, shape);
    expect(support.allowed).toBe(true); expect(support.impact).toBeUndefined();
    expect(support.affectedRefs).not.toContainEqual({ kind: 'nodes', id: 'a' });
    expect(support.affectedRefs).not.toContainEqual({ kind: 'roads', id: 'bc' });
    const result = run(map, shape);
    expect(result.map.nodes).toEqual(map.nodes); expect(result.map.roads.bc).toEqual(map.roads.bc);
    expect(result.map.roads.ab!.provenance.fieldSources?.shapePoints).toBe('source_editor_geometry');
  });
  it.each(['corridor', 'observed'] as const)('refuses independent road %s geometry without deleting it', kind => {
    const map = fixture();
    if (kind === 'corridor') map.roads.ab!.corridorPolygon = rectangle(-1, -1, 12, 2);
    else map.roads.ab!.observedLengthM = { state: 'unknown' };
    reject(map, move(), 'ROAD_GEOMETRY_DEPENDENCY'); reject(map, shape, 'ROAD_GEOMETRY_DEPENDENCY');
  });
  it('finds a node-only junction even without movements and prevents leaving its boundary behind', () => {
    const map = fixture(); map.movements = {}; map.junctions.j!.nodeIds = ['a']; map.junctions.j!.boundary = rectangle(-1, -1, 2, 2);
    expect(selectionImpact(map, { nodes: ['a'], roads: [] }).affectedRefs).toContainEqual({ kind: 'junctions', id: 'j' });
    reject(map, move(), 'LOCAL_JUNCTION_GEOMETRY');
  });
  it('includes endpoint junctions without movements for road shape and width without moving endpoints', () => {
    const map = fixture(); map.movements = {};
    for (const command of [shape, { type: 'updateRoad', id: 'ab', patch: { widthM: { state: 'known', value: 2 } }, designAssumption: { id: 'width_source' } }] as MapCommand[]) {
      const support = commandSupport(map, command);
      expect(support.allowed).toBe(true);
      expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'junctions', id: 'j' }, { kind: 'resources', id: 'r' }]));
      expect(support.affectedRefs.some(ref => ref.kind === 'nodes')).toBe(false);
      expect(support.affectedRefs).not.toContainEqual({ kind: 'roads', id: 'bc' });
      expect(run(map, command).map.nodes).toEqual(map.nodes);
    }
    map.junctions.j!.boundary = rectangle(9, -1, 2, 2);
    reject(map, shape, 'LOCAL_JUNCTION_GEOMETRY');
    reject(map, { type: 'updateRoad', id: 'ab', patch: { widthM: { state: 'known', value: 2 } }, designAssumption: { id: 'width_source' } }, 'LOCAL_JUNCTION_GEOMETRY');
  });
  it('includes owner overlays, owner slots and overlay resources for physical-field locks without rewriting them', () => {
    const map = fixture(); owner(map);
    map.zones.overlay = { ...newZone(rectangle(40, 40, 5, 5)), resourceIds: ['overlay_resource'], extensions: { 'sr02.planning': { role: 'dock_exclusion', overlayOf: 'owner', waterSurface: false } } };
    map.resources.overlay_resource = { ...map.resources.r!, appliesTo: [{ entityType: 'zones', entityId: 'overlay' }] };
    expect(validateMap(map).ok).toBe(true);
    const command: MapCommand = { type: 'updateRoad', id: 'ab', patch: { speedLimitMps: { state: 'known', value: 2 } }, designAssumption: { id: 'speed_source' } };
    const support = commandSupport(map, command);
    expect(support.allowed).toBe(true);
    expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'facilities', id: 'owner' }, { kind: 'zones', id: 'overlay' }, { kind: 'slots', id: 'slot', ownerId: 'owner' }, { kind: 'resources', id: 'overlay_resource' }, { kind: 'resources', id: 'storage' }]));
    const result = run(map, command);
    expect(result.map.zones).toEqual(map.zones); expect(result.map.facilities).toEqual(map.facilities); expect(result.map.resources).toEqual(map.resources);
    reject(map, shape, 'LOCAL_OWNER_DEPENDENCY');
    reject(map, { type: 'translateSelection', selection: { nodes: [], roads: [], facilities: ['owner'] }, delta: [1, 0, 0], facilityMovePolicy: 'withStaticContents' }, 'STATIC_OVERLAY_DEPENDENCY');
  });
  it('refuses partial multi-node junction movement and independent turn paths', () => {
    const map = fixture(); map.junctions.j!.nodeIds = ['a', 'b'];
    reject(map, move(), 'LOCAL_PARTIAL_JUNCTION');
    map.junctions.j!.nodeIds = ['b']; map.movements.m!.internalPath = [[9, 0, 0], [11, 0, 0]];
    reject(map, move(), 'LOCAL_MOVEMENT_GEOMETRY'); reject(map, shape, 'LOCAL_MOVEMENT_GEOMETRY');
  });
  it('preserves owner slots and resource locks instead of editing their internal road alone', () => {
    const map = fixture(); owner(map); expect(validateMap(map).ok).toBe(true);
    const refs = selectionImpact(map, { nodes: ['a'], roads: [] }).affectedRefs;
    expect(refs).toEqual(expect.arrayContaining([{ kind: 'facilities', id: 'owner' }, { kind: 'slots', id: 'slot', ownerId: 'owner' }, { kind: 'extensions', id: '/facilities/owner/extensions/sr02.planning' }, { kind: 'resources', id: 'storage' }]));
    reject(map, move(), 'LOCAL_OWNER_DEPENDENCY'); reject(map, shape, 'LOCAL_OWNER_DEPENDENCY');
    reject(map, { type: 'updateRoad', id: 'ab', patch: { widthM: { state: 'known', value: 2 } }, designAssumption: { id: 'assumption' } }, 'LOCAL_OWNER_DEPENDENCY');
  });
  it('tracks service entry nodes and every internally referenced road plus indirect resource ownership', () => {
    const map = fixture(); map.zones.zone = newZone(rectangle(-5, -5, 30, 15));
    map.servicePoints.service = { ...newServicePoint('c'), zoneId: 'zone', arrival: { mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'ab', direction: 'forward' }, { roadId: 'bc', direction: 'forward' }] } };
    map.resources.r!.appliesTo = [{ entityType: 'servicePoints', entityId: 'service' }];
    const refs = selectionImpact(map, { nodes: ['a'], roads: [] }).affectedRefs;
    expect(refs).toEqual(expect.arrayContaining([{ kind: 'servicePoints', id: 'service' }, { kind: 'zones', id: 'zone' }, { kind: 'resources', id: 'r' }]));
    reject(map, move(), 'LOCAL_POINT_DEPENDENCY'); reject(map, shape, 'LOCAL_INTERNAL_PATH_DEPENDENCY');
  });
  it('protects a shared access node and its remote service target', () => {
    const map = fixture(); map.facilities.owner = newFacility(rectangle(-5, -5, 30, 15));
    map.accessPoints.access = newAccessPoint('owner', 'a'); map.facilities.owner.accessPointIds = ['access'];
    map.servicePoints.service = newServicePoint('c', 'service', 'loading', 'owner', 'access'); map.facilities.owner.servicePointIds = ['service'];
    expect(selectionImpact(map, { nodes: ['a'], roads: [] }).affectedRefs).toContainEqual({ kind: 'servicePoints', id: 'service' });
    reject(map, move(), 'LOCAL_POINT_DEPENDENCY');
  });
  it('lets existing direction validation reject prohibited movement or internal path arcs', () => {
    const map = fixture(); const command: MapCommand = { type: 'updateRoad', id: 'ab', patch: { direction: 'backward' } };
    expect(commandSupport(map, command).allowed).toBe(true);
    const result = applyMapCommand(map, command); expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.map(issue => issue.code)).toContain('ARC_DIRECTION_CONFLICT');
    const expanded = run(map, { type: 'updateRoad', id: 'ab', patch: { direction: 'forward' } });
    expect(expanded.map.movements).toEqual(map.movements);
  });
  it.each(['heightLimitM', 'massLimitKg', 'speedLimitMps'] as const)('changes %s without rewriting an unrelated declared corridor or length', field => {
    const map = fixture(); map.roads.ab!.corridorPolygon = rectangle(-1, -1, 12, 2); map.roads.ab!.observedLengthM = { state: 'known', value: 10 };
    const result = run(map, { type: 'updateRoad', id: 'ab', patch: { [field]: { state: 'known', value: 5 } }, designAssumption: { id: 'physical_assumption' } });
    expect(result.map.roads.ab!.corridorPolygon).toEqual(map.roads.ab!.corridorPolygon); expect(result.map.roads.ab!.observedLengthM).toEqual(map.roads.ab!.observedLengthM);
    expect(result.map.roads.ab!.provenance.fieldSources?.[field]).toBe('physical_assumption');
  });
  it('limits newly opened advanced point/road geometry to XY and preserves a nonzero plane', () => {
    const map = fixture();
    for (const node of Object.values(map.nodes)) node.position[2] = 7;
    reject(map, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 0] } }, 'LOCAL_NONPLANAR_EDIT');
    reject(map, { type: 'translateSelection', selection: { nodes: ['a'], roads: [] }, delta: [0, 0, 1] }, 'LOCAL_NONPLANAR_EDIT');
    reject(map, shape, 'LOCAL_NONPLANAR_EDIT');
    const result = run(map, { type: 'updateRoad', id: 'ab', patch: { shapePoints: [[5, 1, 7]] } });
    expect(result.map.roads.ab!.shapePoints).toEqual([[5, 1, 7]]);
    expect(run(map, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 7] } }).map.nodes.a!.position).toEqual([1, 2, 7]);
    map.nodes.b!.position[2] = 8;
    reject(map, { type: 'updateRoad', id: 'ab', patch: { shapePoints: [[5, 1, 7]] } }, 'LOCAL_NONPLANAR_EDIT');
    reject(map, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 7] } }, 'LOCAL_NONPLANAR_EDIT');
    const plain = fixture(); plain.junctions = {}; plain.movements = {}; plain.resources = {};
    expect(run(plain, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 3] } }).map.nodes.a!.position).toEqual([1, 2, 3]);
  });
  it('retains creation/copy limits, requires explicit deletion dependencies and safely splits references', () => {
    const map = fixture();
    for (const command of [
      { type: 'addNode', id: 'new', node: newNode([30, 0, 0]) },
      { type: 'duplicateSelection', selection: { nodes: ['a'], roads: [] }, delta: [1, 0, 0], idMap: { a: 'new' } },
    ] as MapCommand[]) reject(map, command, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
    reject(map, { type: 'deleteSelection', selection: { nodes: ['a'], roads: [] } }, 'TOPOLOGY_DELETE_DEPENDENCIES');
    const split = run(map, { type: 'splitRoad', id: 'ab', distanceM: 5, nodeId: 'new', newRoadIds: ['new1', 'new2'] }).map;
    expect(split.movements.m!.incomingArc).toEqual({ roadId: 'new2', direction: 'forward' });
    expect(split.movements.m!.resourceIds).toEqual(map.movements.m!.resourceIds);
    expect(split.resources).toEqual(map.resources);
  });
  it('passes temporary warnings through the session and does not inspect a no-op', () => {
    const warning: Issue = { code: 'GA01_TEST_UNKNOWN', severity: 'warning', jsonPath: '/roads/ab', message: 'test warning', suggestedAction: 'test only' };
    const spy = vi.spyOn(spatial, 'inspectSpatialEdit').mockReturnValue([warning]);
    try {
      const map = fixture(), session = createSession(map, true);
      const edited = editSession(session, move()); expect(edited.ok).toBe(true); expect(edited.issues).toEqual([warning]);
      expect(JSON.stringify(edited.session.map)).not.toContain('GA01_TEST_UNKNOWN');
      spy.mockClear(); const unchanged = editSession(session, { type: 'updateNode', id: 'a', patch: { position: [...map.nodes.a!.position] } });
      expect(unchanged.session).toBe(session); expect(unchanged.issues).toEqual([]); expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('rejects spatial errors before generating provenance or history', () => {
    const issue: Issue = { code: 'GA01_TEST_CONFLICT', severity: 'error', jsonPath: '/roads/ab', message: 'test conflict', suggestedAction: 'test only' };
    const spy = vi.spyOn(spatial, 'inspectSpatialEdit').mockReturnValue([issue]);
    try {
      const map = fixture(), session = createSession(map, true), result = editSession(session, move());
      expect(result.ok).toBe(false); expect(result.issues).toEqual([issue]); expect(result.session).toBe(session);
      expect(map.sources.source_editor_geometry).toBeUndefined();
    } finally { spy.mockRestore(); }
  });
});
