import { describe, it, expect } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { inspectAccessDetachment, type DetachAccessPointCommand } from '../../src/domain/accessDetachment';
import { newMap } from '../../src/domain/factory';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { loadMap } from '../../src/domain/load';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import type { YardMap } from '../../src/domain/model';
import { testNode } from '../helpers/M1_fixtures';
import { rectangle, testFacility } from '../helpers/M2A_fixtures';
import { roadLength } from '../../src/geometry/roads';
const NS = 'sr02.planning';
const command: DetachAccessPointCommand = { type: 'detachAccessPoint', id: 'ap', distanceM: 4, nodeId: 'privateAccess', connectorRoadId: 'connector', internalRoadId: 'privateRoad' };
function fixture(reverse = false): YardMap {
  const map = newMap('EA01_synthetic', 'synthetic entrance topology test', '0.2.0');
  map.extensionNamespaces[NS] = { version: '1.0', category: 'behavior' };
  for (const [id, x, y] of [['public', -10, 5], ['south', -10, -20], ['north', -10, 20], ['work', 5, 5]] as const) map.nodes[id] = testNode(id, x, y);
  const road = { name: 'declared road', fromNodeId: 'south', toNodeId: 'public', shapePoints: [], direction: 'both' as const, widthM: { state: 'unknown' as const }, heightLimitM: { state: 'unknown' as const }, massLimitKg: { state: 'unknown' as const }, speedLimitMps: { state: 'unknown' as const }, resourceIds: [], provenance: { category: 'synthetic' as const } };
  map.roads.southRoad = structuredClone(road); map.roads.northRoad = { ...structuredClone(road), fromNodeId: 'public', toNodeId: 'north' };
  map.roads.internal = { ...structuredClone(road), fromNodeId: reverse ? 'work' : 'public', toNodeId: reverse ? 'public' : 'work', extensions: { [NS]: { role: 'internal', ownerEntityId: 'owner', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } } };
  map.facilities.owner = { ...testFacility('synthetic owner', rectangle(0, 0, 10, 10)), accessPointIds: ['ap'], servicePointIds: ['sp'] };
  map.accessPoints.ap = { name: 'entrance', facilityId: 'owner', nodeId: 'public', provenance: { category: 'synthetic' } };
  map.servicePoints.sp = { name: 'loading', facilityId: 'owner', accessPointId: 'ap', nodeId: 'work', kind: 'loading', arrival: { mode: 'explicit_internal', internalPath: [{ roadId: 'internal', direction: reverse ? 'backward' : 'forward' }] }, resourceIds: [], provenance: { category: 'synthetic' } };
  map.junctions.j = { name: 'public junction', nodeIds: ['public'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.enter = { name: 'permission', junctionId: 'j', incomingArc: { roadId: 'southRoad', direction: 'forward' }, outgoingArc: { roadId: 'internal', direction: reverse ? 'backward' : 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.forbidden = { ...structuredClone(map.movements.enter), incomingArc: { roadId: 'northRoad', direction: 'backward' }, allowed: false };
  return map;
}
function success(map: YardMap, cmd: MapCommand = command) {
  const result = applyMapCommand(map, cmd); expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error('rejected'); return result.map;
}
function reject(map: YardMap, code: string, cmd: MapCommand = command) {
  const before = contentHash(map), session = createSession(map, true), result = editSession(session, cmd);
  expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(contentHash(map)).toBe(before);
  expect(result.issues.some(issue => issue.code === code), JSON.stringify(result.issues)).toBe(true);
}
describe('EA01 private access at an explicit public anchor', () => {
  it.each([false, true])('preserves public geometry and declared directions with reverse endpoints=%s', reverse => {
    const map = fixture(reverse), before = structuredClone(map), support = commandSupport(map, command), next = success(map);
    expect(support.allowed).toBe(true); expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'accessPoints', id: 'ap' }, { kind: 'servicePoints', id: 'sp' }, { kind: 'junctions', id: 'j' }, { kind: 'facilities', id: 'owner' }, { kind: 'sources', id: 'source_editor_access_detachment' }]));
    expect(map).toEqual(before); expect(next.coordinateFrame).toEqual(map.coordinateFrame); expect(next.nodes.public).toEqual(map.nodes.public);
    for (const id of ['southRoad', 'northRoad']) expect(next.roads[id]).toEqual(map.roads[id]); expect(next.junctions.j).toEqual(map.junctions.j);
    expect(next.roads.internal).toBeUndefined(); expect(roadLength(next, 'connector') + roadLength(next, 'privateRoad')).toBe(roadLength(map, 'internal'));
    expect(next.nodes.privateAccess!.position).toEqual([-6, 5, 0]); expect(next.accessPoints.ap!.nodeId).toBe('privateAccess'); expect(next.servicePoints.sp!.nodeId).toBe('work');
    expect(next.servicePoints.sp!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'privateRoad', direction: reverse ? 'backward' : 'forward' }] });
    for (const id of ['enter', 'forbidden']) expect(next.movements[id]).toEqual({ ...map.movements[id], outgoingArc: { ...map.movements[id]!.outgoingArc, roadId: 'connector' }, provenance: next.movements[id]!.provenance });
    expect(next.movements.forbidden!.allowed).toBe(false); expect(next.resources).toEqual(map.resources);
    const added = Object.values(next.movements).filter(item => item.junctionId !== 'j'); expect(added).toHaveLength(2);
    expect(added.every(item => item.incomingArc.roadId !== item.outgoingArc.roadId && item.allowed && item.resourceIds.length === 0)).toBe(true);
    expect(next.roads.connector!.extensions?.[NS]).toEqual({ role: 'main', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' }); expect(next.roads.privateRoad!.extensions).toEqual(map.roads.internal!.extensions);
    expect(next.sources.source_editor_access_detachment!.description).toContain('原声明及新段角色'); expect(next.roads.connector!.provenance.fieldSources?.['extensions/' + NS]).toBe('source_editor_access_detachment');
  });
  it('inherits only the original one-way continuation', () => {
    const map = fixture(true); map.roads.internal!.direction = 'backward'; const next = success(map), turns = Object.values(next.movements).filter(item => item.junctionId !== 'j'); expect(turns).toHaveLength(1); expect(turns[0]!.incomingArc.direction).toBe('backward');
  });
  it('moves the whole owner and private entrance without moving public nodes', () => {
    const map = success(fixture());
    for (const cmd of [{ type: 'translateSelection', selection: { nodes: [], roads: [], facilities: ['owner'] }, facilityMovePolicy: 'withStaticContents', delta: [20, 0, 0] }, { type: 'movePoint', kind: 'accessPoints', id: 'ap', position: [-6, 6, 0] }] as MapCommand[]) {
      const next = success(map, cmd); expect(next.nodes.public).toEqual(map.nodes.public); for (const id of ['southRoad', 'northRoad']) expect(next.roads[id]).toEqual(map.roads[id]); expect(next.resources).toEqual(map.resources); expect(next.coordinateFrame).toEqual(map.coordinateFrame);
    }
  });
  it('undo/redo and reload retain one complete source/identity transaction', () => {
    const map = fixture(), session = createSession(map, true), result = editSession(session, command); expect(result.ok).toBe(true); expect(result.session.past).toHaveLength(1);
    const undone = undoSession(result.session); expect(undone.map).toEqual(map); const redo = redoSession(undone); expect(redo.map).toEqual(result.session.map);
    const loaded = loadMap(serializeMap(redo.map)); expect(loaded.ok).toBe(true); if (loaded.ok) { expect(loaded.report.ok).toBe(true); expect(loaded.map).toEqual(redo.map); } reject(redo.map, 'ACCESS_DETACH_CONNECTIONS');
  });
  it('preserves source collision and known metadata without silently relabeling its historical fields', () => {
    const map = fixture(); map.sources.source_editor_access_detachment = { name: 'original', category: 'synthetic', description: 'keep' };
    map.extensionNamespaces['example.metadata'] = { version: '1.0', category: 'metadata' }; map.roads.internal!.extensions!['example.metadata'] = { oldRole: 'original_internal_class', nested: { keep: 3 } };
    const next = success(map); expect(next.sources.source_editor_access_detachment).toEqual(map.sources.source_editor_access_detachment); expect(next.sources.source_editor_access_detachment_1).toBeDefined(); expect(next.roads.connector!.extensions?.['example.metadata']).toEqual(map.roads.internal!.extensions?.['example.metadata']);
  });
  it('suggests a point outside known road bands and marks unavailable evidence explicitly', () => {
    const map = fixture(); let info = inspectAccessDetachment(map, 'ap'); expect(info.supported).toBe(true); if (info.supported) expect(info.suggestionNote).toContain('未找到');
    for (const id of ['southRoad', 'northRoad']) map.roads[id]!.widthM = { state: 'known', value: 16 };
    info = inspectAccessDetachment(map, 'ap'); if (!info.supported) throw new Error('unsupported'); expect(info.suggestedDistanceM).toBe(9); expect(info.position).toEqual([-1, 5, 0]);
    map.roads.southRoad!.widthM = { state: 'known', value: 100 }; info = inspectAccessDetachment(map, 'ap'); if (info.supported) expect(info.suggestionNote).toContain('未找到');
  });
  it('does not exempt a newly unowned connector from workshop traversal checks', () => { const map = fixture(); map.facilities.owner!.boundary = rectangle(-15, 0, 25, 10); reject(map, 'OWNER_ROAD_NEW_BUILDING_CROSSING'); });
  it.each([0, -1, 15, NaN, Infinity])('rejects invalid distance %s atomically', distanceM => reject(fixture(), 'INVALID_SPLIT_POSITION', { ...command, distanceM }));
  it('rejects resource splitting and multi-node junctions', () => {
    const resources = fixture(); resources.resources.r = { name: 'declared resource', kind: 'road', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown', appliesTo: [], provenance: { category: 'synthetic' } }; resources.roads.internal!.resourceIds = ['r']; reject(resources, 'ACCESS_DETACH_RESOURCE');
    const junction = fixture(); junction.junctions.j!.nodeIds.push('south'); reject(junction, 'ACCESS_DETACH_JUNCTION');
  });
  it('rejects manual geometry, nonplanar geometry and unknown direction', () => {
    const shaped = fixture(); shaped.roads.internal!.shapePoints = [[-8, 5, 0]]; reject(shaped, 'ACCESS_DETACH_GEOMETRY');
    const z = fixture(); z.nodes.work!.position[2] = 1; reject(z, 'ACCESS_DETACH_GEOMETRY');
    const direction = fixture(); direction.roads.internal!.direction = 'unknown'; reject(direction, 'ACCESS_DETACH_DIRECTION');
  });
  it('rejects shared anchors, shared services and proxy points without stripping refs', () => {
    const ap = fixture(); ap.accessPoints.other = structuredClone(ap.accessPoints.ap!); ap.facilities.owner!.accessPointIds.push('other'); reject(ap, 'ACCESS_DETACH_SHARED_OWNER');
    const sp = fixture(); sp.servicePoints.other = structuredClone(sp.servicePoints.sp!); sp.facilities.owner!.servicePointIds.push('other'); reject(sp, 'ACCESS_DETACH_SHARED_SERVICE');
    const proxy = fixture(); proxy.servicePoints.sp!.nodeId = 'public'; proxy.servicePoints.sp!.arrival = { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'explicit proxy test' }; reject(proxy, 'ACCESS_DETACH_SHARED_SERVICE');
  });
  it('retains global unknown behavior and ID collision protection', () => {
    const map = fixture(); map.extensionNamespaces['example.behavior'] = { version: '1', category: 'behavior' }; map.extensions = { 'example.behavior': { keep: true } }; expect(applyMapCommand(map, command).ok).toBe(false); expect(map.extensions).toEqual({ 'example.behavior': { keep: true } });
    const collision = fixture(), result = editSession(createSession(collision, true), { ...command, nodeId: 'public' }); expect(result.ok).toBe(false); expect(result.session.past).toHaveLength(0);
  });
});
