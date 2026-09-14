import { describe, it, expect } from 'vitest';
import { applyMapCommand, commandSupport, prepareBoundaryRepair, canEditBoundary, type MapCommand } from '../../src/domain/commands';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { continuousRoadIds } from '../../src/domain/ownerEditing';
import { contentHash } from '../../src/domain/serialization';
import { newMap } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';
import { testNode } from '../helpers/M1_fixtures';
import { rectangle, testFacility } from '../helpers/M2A_fixtures';

const NS = 'sr02.planning';
function fixture(): YardMap {
  const map = newMap('UX_owner', 'explicit synthetic owner test', '0.2.0');
  map.nodes.gate = { ...testNode('gate', 0, 5), kind: 'access' }; map.nodes.public = testNode('public', -10, 5);
  map.roads.access = { name: '', fromNodeId: 'public', toNodeId: 'gate', shapePoints: [], direction: 'both', widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' }, resourceIds: [], provenance: { category: 'synthetic' } };
  map.facilities.owner = { ...testFacility('', rectangle(0, 0, 10, 10)), accessPointIds: ['ap'], servicePointIds: ['sp'] };
  map.accessPoints.ap = { name: '', facilityId: 'owner', nodeId: 'gate', provenance: { category: 'synthetic' } };
  map.servicePoints.sp = { name: '', facilityId: 'owner', accessPointId: 'ap', nodeId: 'gate', kind: 'loading', arrival: { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: 'transfer included outside map routing' }, resourceIds: [], provenance: { category: 'synthetic' } };
  return map;
}
const move = (delta: [number, number, number] = [0, 1, 0]): MapCommand => ({ type: 'translateSelection', selection: { nodes: [], roads: [], facilities: ['owner'] }, facilityMovePolicy: 'withStaticContents', delta });
function success(map: YardMap, command: MapCommand) {
  const result = applyMapCommand(map, command); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('rejected'); return result;
}
function reject(map: YardMap, command: MapCommand, code: string) {
  const session = createSession(map, true), hash = contentHash(map), result = editSession(session, command);
  expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(contentHash(map)).toBe(hash); expect(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues)).toBe(true);
}
describe('UX02 explicit owner geometry and atomic road editing', () => {
  it('moves zero-slot colocated AP/SP via the unique leaf connector, leaving the public endpoint exact', () => {
    const map = fixture(), before = structuredClone(map), support = commandSupport(map, move());
    expect(support.allowed).toBe(true); expect(support.impact?.connectorRoadIds).toEqual(['access']); expect(support.impact?.fixedAnchorNodeIds).toEqual(['public']);
    const session = createSession(map, true), result = editSession(session, move()); expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1); expect(result.session.map.nodes.gate!.position).toEqual([0, 6, 0]); expect(result.session.map.nodes.public).toEqual(map.nodes.public);
    expect(result.session.map.accessPoints).toEqual(map.accessPoints); expect(result.session.map.servicePoints).toEqual(map.servicePoints); expect(result.session.map.roads).toEqual(map.roads);
    expect(result.session.map.coordinateFrame).toEqual(map.coordinateFrame); expect(map).toEqual(before);
    expect(undoSession(result.session).map).toEqual(map); expect(redoSession(undoSession(result.session)).map).toEqual(result.session.map);
  });
  it('also accepts recognized main road metadata without granting ownership from its label', () => {
    const map = fixture(); map.extensionNamespaces[NS] = { version: '1.0', category: 'behavior' };
    map.roads.access!.extensions = { [NS]: { role: 'main', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } };
    expect(success(map, move()).map.nodes.public).toEqual(map.nodes.public);
  });
  it('moves empty facilities and explicitly owned isolated points without inventing roads or slots', () => {
    const map = fixture(); delete map.roads.access;
    expect(success(map, move()).map.nodes.gate!.position).toEqual([0, 6, 0]);
    delete map.accessPoints.ap; delete map.servicePoints.sp; map.facilities.owner!.accessPointIds = []; map.facilities.owner!.servicePointIds = [];
    expect(success(map, move()).map.facilities.owner!.boundary.outer[0]).toEqual([0, 1, 0]);
  });
  it('keeps shared public entrance fixed and rejects relocating it individually', () => {
    const map = fixture(); map.nodes.other = testNode('', -10, 8); map.roads.otherRoad = { ...structuredClone(map.roads.access!), fromNodeId: 'other' };
    expect(commandSupport(map, move()).impact?.fixedAnchorNodeIds).toContain('gate');
    reject(map, { type: 'movePoint', kind: 'accessPoints', id: 'ap', position: [0, 6, 0] }, 'OWNER_PUBLIC_NODE');
    reject(map, move([2, 0, 0]), 'OWNER_ENTRANCE_REPOSITION_REQUIRED');
  });
  it('rejects folded automatic connectors and other-owner colocated business refs', () => {
    const map = fixture(); map.roads.access!.shapePoints = [[-5, 4, 0]]; reject(map, move(), 'STATIC_CONNECTOR_SHAPE_UNSUPPORTED');
    map.roads.access!.shapePoints = []; map.facilities.other = testFacility('', rectangle(0, 20, 10, 10)); map.facilities.other.servicePointIds = ['otherPoint'];
    map.servicePoints.otherPoint = { ...structuredClone(map.servicePoints.sp!), facilityId: 'other' }; delete map.servicePoints.otherPoint.accessPointId;
    reject(map, move(), 'STATIC_SHARED_NODE');
  });
  it('moves a dedicated access with one external connector and a declared internal road without moving the public anchor', () => {
    const map = fixture(); map.extensionNamespaces[NS] = { version: '1.0', category: 'behavior' };
    map.nodes.work = { ...testNode('', 5, 5), kind: 'service' };
    map.roads.internal = { ...structuredClone(map.roads.access!), fromNodeId: 'gate', toNodeId: 'work', extensions: { [NS]: { role: 'internal', ownerEntityId: 'owner', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } } };
    map.servicePoints.sp!.nodeId = 'work'; map.servicePoints.sp!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'internal', direction: 'forward' }] };
    const moved = success(map, move([1, 1, 0]));
    expect(moved.map.nodes.gate!.position).toEqual([1, 6, 0]); expect(moved.map.nodes.work!.position).toEqual([6, 6, 0]); expect(moved.map.nodes.public).toEqual(map.nodes.public);
    for (const key of ['roads', 'accessPoints', 'servicePoints', 'movements', 'resources', 'coordinateFrame'] as const) expect(moved.map[key]).toEqual(map[key]);
    const pointMove: MapCommand = { type: 'movePoint', kind: 'accessPoints', id: 'ap', position: [0, 6, 0] };
    const along = success(map, pointMove); expect(along.map.nodes.work).toEqual(map.nodes.work); expect(along.map.nodes.public).toEqual(map.nodes.public);
    reject(map, { ...pointMove, position: [1, 5, 0] }, 'OWNER_ENTRANCE_REPOSITION_REQUIRED');
    const through = structuredClone(map); through.nodes.other = testNode('', -20, 5); through.roads.otherRoad = { ...structuredClone(map.roads.access!), fromNodeId: 'other', toNodeId: 'gate' };
    reject(through, pointMove, 'OWNER_PUBLIC_NODE');
    const foreign = structuredClone(map); foreign.facilities.other = { ...testFacility('', rectangle(30, 0, 10, 10)), accessPointIds: ['otherAccess'], servicePointIds: [] }; foreign.accessPoints.otherAccess = { ...structuredClone(map.accessPoints.ap!), facilityId: 'other' };
    reject(foreign, pointMove, 'OWNER_SHARED_NODE');
    const unowned = structuredClone(map); unowned.servicePoints.otherService = { ...structuredClone(map.servicePoints.sp!), nodeId: 'gate', arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'unowned test' } }; delete unowned.servicePoints.otherService!.facilityId; delete unowned.servicePoints.otherService!.accessPointId;
    reject(unowned, pointMove, 'OWNER_SHARED_NODE');
    const folded = structuredClone(map); folded.roads.access!.shapePoints = [[-5, 6, 0]]; reject(folded, move(), 'STATIC_CONNECTOR_SHAPE_UNSUPPORTED');
  });
  it('marker drag preview and point commit share the authoritative node and affected identities', () => {
    const map = fixture(), preview = commandSupport(map, { type: 'translateSelection', selection: { nodes: [], roads: [], accessPoints: ['ap'] }, delta: [0, 0, 0] });
    expect(preview.allowed).toBe(true); expect(preview.impact?.selection.nodes).toEqual(['gate']); expect(preview.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'accessPoints', id: 'ap' }, { kind: 'servicePoints', id: 'sp' }]));
    expect(success(map, { type: 'movePoint', kind: 'accessPoints', id: 'ap', position: [0, 6, 0] }).map.nodes.gate!.position).toEqual([0, 6, 0]);
    reject(map, { type: 'movePoint', kind: 'accessPoints', id: 'ap', position: [0, 6, 1] }, 'LOCAL_NONPLANAR_EDIT');
  });
  it('allows legal outline refinement without scaling contents, and previews a unique entrance repair atomically', () => {
    const map = fixture(); expect(canEditBoundary(map, 'facilities', 'owner')).toBe(true);
    const wider = success(map, { type: 'updateFacility', id: 'owner', patch: { boundary: rectangle(0, 0, 12, 10) } }); expect(wider.map.nodes).toEqual(map.nodes);
    const boundary = rectangle(1, 0, 10, 10); reject(map, { type: 'updateFacility', id: 'owner', patch: { boundary } }, 'OWNER_ENTRANCE_REPOSITION_REQUIRED');
    const repair = prepareBoundaryRepair(map, 'owner', boundary); expect(repair.allowed, JSON.stringify(repair.issues)).toBe(true); expect(repair.command.entranceAdjustments).toEqual([{ id: 'ap', position: [1, 5, 0] }]);
    const applied = success(map, repair.command); expect(applied.map.nodes.gate!.position).toEqual([1, 5, 0]); expect(applied.map.nodes.public).toEqual(map.nodes.public);
  });
  it('does not turn a new workshop crossing into an allowed connector', () => {
    const map = fixture(); map.facilities.obstacle = testFacility('', rectangle(-7, 7, 2, 2));
    reject(map, move([0, 10, 0]), 'OWNER_ROAD_NEW_BUILDING_CROSSING');
  });
  it('preserves old physical source relationships on clear/replacement and adds one batch source', () => {
    const map = fixture(); map.sources.old = { name: 'old', category: 'synthetic', description: '' }; map.sources.field = { name: 'field', category: 'synthetic', description: '' };
    map.roads.access!.widthM = { state: 'known', value: 1, sourceRef: 'old' }; map.roads.access!.provenance.fieldSources = { widthM: 'field' };
    const cleared = success(map, { type: 'updateRoad', id: 'access', patch: { widthM: { state: 'unknown' } } }); expect(cleared.map.roads.access!.provenance.sourceRefs).toEqual(expect.arrayContaining(['old', 'field']));
    map.nodes.far = testNode('', -20, 5); map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public' };
    const result = success(map, { type: 'updateRoadBatch', ids: ['access', 'second'], patch: { widthM: { state: 'known', value: 2 } }, designAssumption: { id: 'design' } });
    expect(Object.keys(result.map.sources)).toHaveLength(3); expect(result.map.roads.access!.provenance.sourceRefs).toEqual(expect.arrayContaining(['old', 'field']));
    expect(result.map.roads.second!.widthM).toEqual({ state: 'known', value: 2, sourceRef: 'design' }); expect(result.map.revision).toBe(map.revision + 1);
    expect(success(map, { type: 'updateRoadBatch', ids: ['access','second'], patch: {} }).changed).toBe(false);
  });
  it('rejects the complete road batch if one direction contradicts a turn', () => {
    const map = fixture(); map.nodes.far = testNode('', -20, 5); map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public' };
    map.junctions.j = { name: '', nodeIds: ['public'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
    map.movements.m = { name: '', junctionId: 'j', incomingArc: { roadId: 'second', direction: 'forward' }, outgoingArc: { roadId: 'access', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
    reject(map, { type: 'updateRoadBatch', ids: ['access','second'], patch: { direction: 'backward' } }, 'ARC_DIRECTION_CONFLICT');
  });
  it('continuous selection stops at branch/physical boundary and never changes the map', () => {
    const map = fixture(); map.nodes.far = testNode('', -20, 5); map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public' };
    const before = contentHash(map); expect(continuousRoadIds(map, 'access')).toEqual(['access','second']); expect(contentHash(map)).toBe(before);
    map.roads.second!.heightLimitM = { state: 'unrestricted' }; expect(continuousRoadIds(map, 'access')).toEqual(['access']);
  });
  it('edits dedicated internal nodes and shape without changing owner, service path or resources', () => {
    const map = fixture(); map.extensionNamespaces[NS] = { version: '1.0', category: 'behavior' };
    const owned = { [NS]: { role: 'internal', ownerEntityId: 'owner', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } };
    map.roads.access!.extensions = structuredClone(owned); map.nodes.work = { ...testNode('', 5, 5), kind: 'service' };
    map.nodes.far = testNode('', -20, 5); map.roads.publicRoad = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public', extensions: {} };
    map.roads.internal = { ...structuredClone(map.roads.access!), fromNodeId: 'gate', toNodeId: 'work', extensions: structuredClone(owned) };
    map.servicePoints.sp!.nodeId = 'work'; map.servicePoints.sp!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'internal', direction: 'forward' }] };
    const whole = success(map, move()); expect(whole.map.nodes.public).toEqual(map.nodes.public); expect(whole.map.nodes.work!.position).toEqual([5, 6, 0]);
    const moved = success(map, { type: 'updateNode', id: 'work', patch: { position: [6, 5, 0] } }); expect(moved.map.servicePoints).toEqual(map.servicePoints);
    const shaped = success(map, { type: 'updateRoad', id: 'internal', patch: { shapePoints: [[3, 6, 0]] } }); expect(shaped.map.nodes).toEqual(map.nodes); expect(shaped.map.roads.internal!.extensions).toEqual(owned);
    reject(map, { type: 'updateRoad', id: 'internal', patch: { shapePoints: [[20, 5, 0]] } }, 'OWNER_INTERNAL_ROAD_OUTSIDE');
    reject(map, { type: 'updateNode', id: 'work', patch: { position: [20, 5, 0] } }, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
  });
  it('preserves no-op identity, known extensions and rejects unknown behavior without adding sources', () => {
    const map = fixture(), session = createSession(map, true);
    const same = editSession(session, { type: 'movePoint', kind: 'servicePoints', id: 'sp', position: [0, 5, 0] }); expect(same.session).toBe(session);
    map.extensionNamespaces['example.future'] = { version: '1', category: 'behavior' }; map.extensions['example.future'] = { keep: true };
    reject(map, move(), 'READ_ONLY_MAP');
  });
  it('assigns new-road preset width to the explicit current design source', () => {
    const map = fixture(); map.sources.old = { name: 'measurement', category: 'surveyed', description: 'original observation' };
    map.nodes.far = testNode('', -20, 5);
    const result = success(map, { type: 'addRoad', id: 'newRoad', road: { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public', widthM: { state: 'known', value: 3, sourceRef: 'old' } }, designAssumption: { id: 'preset' } });
    expect(result.map.roads.newRoad!.widthM).toEqual({ state: 'known', value: 3, sourceRef: 'preset' }); expect(result.map.roads.access).toEqual(map.roads.access);
    expect(result.map.sources.preset!.category).toBe('design_assumption'); expect(result.map.sources.old).toEqual(map.sources.old);
  });

  it('batch known numeric re-entry is a no-op and mixed values only attribute changed roads', () => {
    const map = fixture(); map.sources.old = { name: 'old', category: 'synthetic', description: 'old width' };
    map.roads.access!.widthM = { state: 'known', value: 6, sourceRef: 'old' };
    const command: MapCommand = { type: 'updateRoadBatch', ids: ['access'], patch: { widthM: { state: 'known', value: 6 } }, designAssumption: { id: 'design' } };
    const session = createSession(map, true), result = editSession(session, command); expect(result.ok).toBe(true); expect(result.session).toBe(session);
    map.nodes.far = testNode('', -20, 5); map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'public', widthM: { state: 'known', value: 3, sourceRef: 'old' } };
    const mixed = success(map, { ...command, ids: ['access', 'second'] }); expect(mixed.map.roads.access).toEqual(map.roads.access);
    expect(mixed.map.roads.second!.widthM).toEqual({ state: 'known', value: 6, sourceRef: 'design' });
  });
  it('continuous batches stop at opposite stored direction even if oriented travel is continuous', () => {
    const map = fixture(); map.nodes.far = testNode('', -20, 5); map.roads.access!.direction = 'forward';
    map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'public', toNodeId: 'far', direction: 'backward' };
    expect(continuousRoadIds(map, 'access')).toEqual(['access']);
    for (const direction of ['both', 'unknown'] as const) {
      map.roads.access!.direction = direction; map.roads.second!.direction = direction;
      expect(continuousRoadIds(map, 'access')).toEqual(['access']);
    }
  });
  it('returns located repair refusal for shared entrance nodes without throwing', () => {
    const map = fixture(); map.nodes.far = testNode('', -20, 5);
    map.roads.second = { ...structuredClone(map.roads.access!), fromNodeId: 'far', toNodeId: 'gate' };
    const result = prepareBoundaryRepair(map, 'owner', { outer: [[1, 0, 0], [11, 0, 0], [11, 10, 0], [1, 10, 0], [1, 0, 0]], holes: [] });
    expect(result.allowed).toBe(false); expect(result.issues[0]!.code).toBe('OWNER_PUBLIC_NODE'); expect(result.issues[0]!.jsonPath).toContain('/nodes/gate');
  });

});

// SV01 regression: the original Geoje map contains old outside service locations.
// Whole-owner rigid movement preserves that declared relation; independent edits do not.
function oldOutsideService(): YardMap {
  const map = fixture(); map.extensionNamespaces[NS] = { version: '1.0', category: 'behavior' };
  map.nodes.work = { ...testNode('', 12, 5), kind: 'service' };
  map.roads.internal = { ...structuredClone(map.roads.access!), fromNodeId: 'gate', toNodeId: 'work', extensions: { [NS]: { role: 'internal', ownerEntityId: 'owner', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } } };
  map.servicePoints.sp!.nodeId = 'work'; map.servicePoints.sp!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'internal', direction: 'forward' }] };
  return map;
}
describe('SV01 unchanged legacy service-owner relation', () => {
  it('keeps old outside service diagnostics as warnings for actual whole-owner translation and rotation', () => {
    const map = oldOutsideService(), initial = createSession(map, true);
    const commands: MapCommand[] = [move([1, 1, 0]), { type: 'rotateSelection', selection: { nodes: [], roads: [], facilities: ['owner'] }, facilityMovePolicy: 'withStaticContents', pivot: [5, 5, 0], angleRad: 0.05 }];
    for (const command of commands) {
      const result = editSession(initial, command); expect(result.ok, JSON.stringify(result.issues)).toBe(true);
      expect(result.issues.find(issue => issue.code === 'SPATIAL_SERVICE_OUTSIDE_OWNER')?.severity).toBe('warning');
      expect(result.session.past).toHaveLength(1); expect(undoSession(result.session).map).toEqual(initial.map);
      expect(redoSession(undoSession(result.session)).map).toEqual(result.session.map);
      for (const key of ['coordinateFrame', 'accessPoints', 'servicePoints', 'resources', 'movements'] as const) expect(result.session.map[key]).toEqual(map[key]);
      expect(result.session.map.nodes.public).toEqual(map.nodes.public);
    }
  });
  it('still rejects independent outside point and boundary changes, including forged command exemption fields', () => {
    const map = oldOutsideService();
    const point: MapCommand = { type: 'movePoint', kind: 'servicePoints', id: 'sp', position: [12.1, 5, 0] };
    reject(map, point, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
    reject(map, { ...point, rigidServiceIds: ['sp'] } as MapCommand, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
    reject(map, { type: 'updateFacility', id: 'owner', patch: { boundary: rectangle(0, 0, 11, 10) } }, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
    reject(map, { ...move([1, 0, 0]), facilityMovePolicy: 'boundaryOnly' } as MapCommand, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
  });
  it('never exempts newly outside services or unknown behavior', () => {
    const map = oldOutsideService(); map.nodes.work!.position = [8, 5, 0];
    reject(map, { type: 'movePoint', kind: 'servicePoints', id: 'sp', position: [12, 5, 0] }, 'SPATIAL_SERVICE_OUTSIDE_OWNER');
    const hidden = oldOutsideService(); hidden.extensionNamespaces['example.future'] = { version: '1', category: 'behavior' }; hidden.extensions['example.future'] = { keep: true };
    reject(hidden, move(), 'READ_ONLY_MAP');
  });
});
