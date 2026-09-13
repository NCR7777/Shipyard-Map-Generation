import { describe, expect, it } from 'vitest';
import { newAccessPoint, newFacility, newMap, newNode, newRoad, newZone } from '../../src/domain/factory';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { runConnectedPoint, type ConnectedPointCommand, type ConnectedPointSplit } from '../../src/domain/connectedPoint';
import { validateMap } from '../../src/validation/validate';
import { applyMapCommand } from '../../src/domain/commands';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { serializeMap } from '../../src/domain/serialization';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';

function fixture() {
  const map = newMap('UX02_connected', 'Synthetic connected point contract');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([50, 0, 0]); map.nodes.c = newNode([100, 0, 0]);
  map.roads.ab = { ...newRoad('a', 'b'), direction: 'both', widthM: { state: 'known', value: 5 } };
  map.roads.bc = { ...newRoad('b', 'c'), direction: 'both', widthM: { state: 'known', value: 5 } };
  map.facilities.f = newFacility(rectanglePolygon([40, 20, 0], 20, 20));
  map.sources.old = { name: 'Original declaration', category: 'synthetic', description: 'Synthetic source retention test' };
  map.facilities.f.provenance.fieldSources = { accessPointIds: 'old' };
  map.resources.jr = { name: 'Existing public conflict', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'j' }], provenance: { category: 'synthetic' } };
  map.resources.sr = { name: 'Shared service capacity', kind: 'loading', capacityUnit: 'vehicle', capacity: { state: 'known', value: 2 }, controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'f' }], provenance: { category: 'synthetic', fieldSources: { appliesTo: 'old' } } };
  map.junctions.j = { name: 'Public junction', nodeIds: ['b'], model: 'explicit_movements', resourceIds: ['jr'], provenance: { category: 'synthetic' } };
  map.movements.allowed = { name: 'Existing allowed', junctionId: 'j', incomingArc: { roadId: 'ab', direction: 'forward' }, outgoingArc: { roadId: 'bc', direction: 'forward' }, allowed: true, resourceIds: ['jr'], provenance: { category: 'synthetic' } };
  map.movements.forbidden = { ...structuredClone(map.movements.allowed), name: 'Existing forbidden', incomingArc: { roadId: 'bc', direction: 'backward' }, outgoingArc: { roadId: 'ab', direction: 'backward' }, allowed: false };
  const report = validateMap(map); expect(report.ok, JSON.stringify(report.issues)).toBe(true); return map;
}
function access(): ConnectedPointCommand {
  return { type: 'createConnectedPoint', kind: 'accessPoint', pointId: 'ap', name: 'Explicit gate', owner: { kind: 'facilities', id: 'f' }, source: { id: 'created' }, nodeId: 'gate', position: [50, 20, 0], connectorRoadId: 'drive', connector: { direction: 'both', widthM: { state: 'known', value: 4 } }, connection: { kind: 'node', nodeId: 'b' }, junctionId: 'j', approvedMovements: [] };
}
const noSplit: ConnectedPointSplit = () => { throw Error('Endpoint-only test must not invoke split'); };
function candidate(map: YardMap, command: ConnectedPointCommand) {
  const before = structuredClone(map), next = structuredClone(map), details = runConnectedPoint(next, command, noSplit);
  expect(map).toEqual(before); expect(next.coordinateFrame).toEqual(before.coordinateFrame);
  const validation = validateMap(next); expect(validation.ok, JSON.stringify(validation.issues)).toBe(true); return { map: next, details };
}
function withGate() { return candidate(fixture(), access()).map; }
function service(): ConnectedPointCommand {
  return { type: 'createConnectedPoint', kind: 'servicePoint', pointId: 'sp', name: 'Internal service', serviceKind: 'loading', owner: { kind: 'facilities', id: 'f' }, source: { id: 'service_source' }, nodeId: 'service_node', position: [50, 30, 0], connectorRoadId: 'internal', connector: { direction: 'forward', widthM: { state: 'unknown' } }, connection: { kind: 'node', nodeId: 'gate' }, junctionId: 'service_junction', arrival: { mode: 'explicit_internal', accessPointId: 'ap', prefixPath: [] }, resourceIds: ['sr'] };
}

describe('UX02 finite connected point candidate', () => {
  it('creates a dedicated boundary AP and branch, preserving fixed public graph and old forbidden turns without default new permission', () => {
    const before = fixture(), { map, details } = candidate(before, access());
    expect(map.nodes.b).toEqual(before.nodes.b); expect(map.junctions).toEqual(before.junctions); expect(map.movements).toEqual(before.movements); expect(map.resources).toEqual(before.resources);
    expect(map.roads.drive).toMatchObject({ fromNodeId: 'b', toNodeId: 'gate', direction: 'both', widthM: { state: 'known', value: 4, sourceRef: 'created' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' } });
    expect(map.accessPoints.ap).toMatchObject({ nodeId: 'gate', facilityId: 'f' }); expect(map.facilities.f!.accessPointIds).toEqual(['ap']);
    expect(map.facilities.f!.provenance.sourceRefs).toEqual(['old', 'created']); expect(map.sources.created!.category).toBe('design_assumption');
    expect(Object.keys(map.nodes).sort()).toEqual(['a', 'b', 'c', 'gate']); expect(Object.keys(map.sources)).toHaveLength(2); expect(details.proposedMovements).toHaveLength(4);
  });
  it('adds only explicitly approved branch turn and reuses the existing conflict resource without changing its capacity', () => {
    const before = fixture(), command = access(); if (!('approvedMovements' in command)) throw Error('geometry');
    command.approvedMovements = [{ id: 'approved_branch', incomingArc: { roadId: 'ab', direction: 'forward' }, outgoingArc: { roadId: 'drive', direction: 'forward' } }];
    const { map } = candidate(before, command);
    expect(Object.keys(map.movements)).toHaveLength(3); expect(map.movements.forbidden).toEqual(before.movements.forbidden); expect(map.movements.approved_branch!.resourceIds).toEqual(['jr']); expect(map.resources).toEqual(before.resources);
    expect(map.movements.approved_branch!.provenance.sourceRefs).toEqual(['created']);
  });
  it('node_proxy reuses the chosen owner AP node and shares existing service capacity without creating duplicate geometry or resources', () => {
    const before = withGate(), { map } = candidate(before, { type: 'createConnectedPoint', kind: 'servicePoint', pointId: 'proxy', name: 'Boundary handoff', owner: { kind: 'facilities', id: 'f' }, serviceKind: 'loading', source: { id: 'proxy_source' }, resourceIds: ['sr'], arrival: { mode: 'node_proxy', accessPointId: 'ap', transferAssumption: 'included_in_service_duration', note: 'Explicit unmeasured internal transfer assumption' } });
    expect(map.nodes).toEqual(before.nodes); expect(map.roads).toEqual(before.roads); expect(map.movements).toEqual(before.movements);
    expect(map.servicePoints.proxy!.nodeId).toBe('gate'); expect(map.servicePoints.proxy!.arrival!.mode).toBe('node_proxy');
    expect(map.resources.sr!.capacity).toEqual(before.resources.sr!.capacity); expect(Object.keys(map.resources)).toEqual(Object.keys(before.resources));
    expect(map.resources.sr!.appliesTo).toEqual([...before.resources.sr!.appliesTo, { entityType: 'servicePoints', entityId: 'proxy' }]); expect(map.resources.sr!.provenance.sourceRefs).toEqual(['old', 'proxy_source']);
  });
  it('explicit internal service starts at its owner AP, creates one owned path and leaves public nodes, capacities and previous arrivals unchanged', () => {
    const before = withGate(), { map } = candidate(before, service());
    expect(map.nodes.b).toEqual(before.nodes.b); expect(map.nodes.gate).toEqual(before.nodes.gate); expect(map.accessPoints).toEqual(before.accessPoints);
    expect(map.servicePoints.sp!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'internal', direction: 'forward' }] });
    expect(map.roads.internal!.extensions).toEqual({ 'sr02.planning': { role: 'internal', ownerEntityId: 'f', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance' } });
    expect(map.servicePoints.sp!.accessPointId).toBe('ap'); expect(map.resources.sr!.capacity).toEqual(before.resources.sr!.capacity);
  });
  it('rejects off-boundary AP, wrong owner proxy, noncontinuous internal prefix, unknown service direction and independent junction geometry', () => {
    const before = fixture(), off = access(); if (!('position' in off)) throw Error('geometry'); off.position = [50, 30, 0];
    expect(() => runConnectedPoint(structuredClone(before), off, noSplit)).toThrow(/新入口须位于/);
    const map = withGate(), wrong = service(); if (!('position' in wrong)) throw Error('geometry'); wrong.connector.direction = 'unknown';
    expect(() => runConnectedPoint(structuredClone(map), wrong, noSplit)).toThrow(/方向已明确允许/);
    const path = service(); if (path.kind !== 'servicePoint' || path.arrival.mode !== 'explicit_internal') throw Error('arrival'); path.arrival.prefixPath = [{ roadId: 'drive', direction: 'forward' }];
    expect(() => runConnectedPoint(structuredClone(map), path, noSplit)).toThrow(/前缀路径必须完全属于/);
    const independent = fixture(); independent.junctions.j!.boundary = rectanglePolygon([48, -2, 0], 4, 4);
    expect(() => runConnectedPoint(structuredClone(independent), access(), noSplit)).toThrow(/独立边界/);
    const other = withGate(); other.facilities.other = newFacility(rectanglePolygon([70, 20, 0], 20, 20)); other.accessPoints.other_ap = newAccessPoint('other', 'c'); other.facilities.other.accessPointIds = ['other_ap'];
    expect(() => runConnectedPoint(other, { type: 'createConnectedPoint', kind: 'servicePoint', pointId: 'p', name: 'Wrong owner', owner: { kind: 'facilities', id: 'f' }, serviceKind: 'loading', source: { id: 'p_source' }, arrival: { mode: 'node_proxy', accessPointId: 'other_ap', transferAssumption: 'excluded_from_model', note: 'Explicit' } }, noSplit)).toThrow(/同一设施/);
  });
});

// Exercises the actual command layer, not an alternate split implementation or arbitrary batch.
describe('UX02 connected point single transaction', () => {
  it('reuses TE01 exact split and reference remapping, with one undo/redo and full JSON roundtrip', () => {
    const before = fixture(); before.resources.jr!.appliesTo.push({ entityType: 'roads', entityId: 'ab' });
    const command = access(); if (!('connection' in command)) throw Error('geometry');
    command.position = [40, 20, 0]; command.connection = { kind: 'road', roadId: 'ab', distanceM: 25, nodeId: 'cut', newRoadIds: ['ab1', 'ab2'] }; command.junctionId = 'new_junction';
    const initial = createSession(before, true), result = editSession(initial, command);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); const after = result.session.map;
    expect(before.roads.ab).toBeDefined(); expect(after.roads.ab).toBeUndefined(); expect(after.nodes.cut!.position).toEqual([25, 0, 0]); expect(after.nodes.gate!.position).toEqual([40, 20, 0]);
    expect(after.movements.allowed!.incomingArc.roadId).toBe('ab2'); expect(after.movements.forbidden!.outgoingArc.roadId).toBe('ab2'); expect(after.movements.forbidden!.allowed).toBe(false);
    expect(after.resources.jr!.appliesTo).toEqual(expect.arrayContaining([{ entityType: 'roads', entityId: 'ab1' }, { entityType: 'roads', entityId: 'ab2' }])); expect(after.resources.jr!.capacity).toEqual(before.resources.jr!.capacity);
    expect(after.junctions.new_junction!.nodeIds).toEqual(['cut']); expect(after.roads.drive!.fromNodeId).toBe('cut'); expect(Object.values(after.movements).filter(m => m.name === '原道路细分直行')).toHaveLength(2);
    const undone = undoSession(result.session); expect(undone.map).toEqual(before); expect(redoSession(undone).map).toEqual(after);
    const loaded = loadMap(serializeMap(after)); expect(loaded.ok).toBe(true); if (loaded.ok) expect(loaded.map).toEqual(after);
  });
  it('creates a zone service only from an explicit entry and preserves complete owner routing when splitting an existing private internal path', () => {
    const zone = fixture(); zone.zones.z = newZone(rectanglePolygon([0, 20, 0], 20, 20));
    const zoneCommand: ConnectedPointCommand = { type: 'createConnectedPoint', kind: 'servicePoint', pointId: 'zone_sp', name: 'Zone handoff', owner: { kind: 'zones', id: 'z' }, serviceKind: 'other', source: { id: 'zone_source' }, arrival: { mode: 'explicit_internal', entryNodeId: 'a', prefixPath: [] }, nodeId: 'zone_node', position: [10, 30, 0], connectorRoadId: 'zone_road', connector: { direction: 'forward', widthM: { state: 'known', value: 2 } }, connection: { kind: 'node', nodeId: 'a' }, junctionId: 'zone_junction' };
    const zr = applyMapCommand(zone, zoneCommand); expect(zr.ok, JSON.stringify(zr)).toBe(true);
    if (zr.ok) { expect(zr.map.servicePoints.zone_sp!.arrival).toEqual({ mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'zone_road', direction: 'forward' }] }); expect(zr.map.zones).toEqual(zone.zones); }
    const gate = withGate(), first = applyMapCommand(gate, service()); expect(first.ok, JSON.stringify(first)).toBe(true); if (!first.ok) throw Error('service');
    const cmd: ConnectedPointCommand = { type: 'createConnectedPoint', kind: 'servicePoint', pointId: 'second_sp', name: 'Second private service', owner: { kind: 'facilities', id: 'f' }, serviceKind: 'unloading', source: { id: 'second_source' }, arrival: { mode: 'explicit_internal', accessPointId: 'ap', prefixPath: [{ roadId: 'internal1', direction: 'forward' }] }, nodeId: 'second_node', position: [55, 30, 0], connectorRoadId: 'second_connector', connector: { direction: 'forward', widthM: { state: 'unknown' } }, connection: { kind: 'road', roadId: 'internal', distanceM: 5, nodeId: 'private_cut', newRoadIds: ['internal1', 'internal2'] }, junctionId: 'private_junction' };
    const result = applyMapCommand(first.map, cmd); expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw Error('second service');
    expect(result.map.servicePoints.sp!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'internal1', direction: 'forward' }, { roadId: 'internal2', direction: 'forward' }] });
    expect(result.map.servicePoints.second_sp!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'internal1', direction: 'forward' }, { roadId: 'second_connector', direction: 'forward' }] });
    expect(result.map.servicePoints.sp!.provenance.sourceRefs).toContain('second_source'); expect(result.map.resources.sr!.capacity).toEqual(first.map.resources.sr!.capacity);
    expect(Object.keys(result.map.sources)).toHaveLength(Object.keys(first.map.sources).length + 1);
  });
  it('invalid turn approval or conflicting candidate IDs reject without changing map, history or sources', () => {
    const before = fixture(), command = access(); if (!('approvedMovements' in command)) throw Error('geometry'); command.approvedMovements = [{ id: 'wrong', incomingArc: { roadId: 'bc', direction: 'backward' }, outgoingArc: { roadId: 'ab', direction: 'backward' } }];
    const session = createSession(before, true), rejected = editSession(session, command); expect(rejected.ok).toBe(false); expect(rejected.session).toBe(session); expect(rejected.issues.map(i => i.code)).toContain('TOPOLOGY_TURN_NOT_PROPOSED');
    const collision = access(); collision.pointId = 'b'; const result = applyMapCommand(before, collision); expect(result.ok).toBe(false); expect(Object.keys(before.accessPoints)).toHaveLength(0); expect(Object.keys(before.sources)).toEqual(['old']);
  });
});
