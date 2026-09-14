import { describe, expect, it } from 'vitest';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import { contentHash } from '../../src/domain/serialization';
import type { Polygon, YardMap } from '../../src/domain/model';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { validateMap } from '../../src/validation/validate';
import { getQuickTraceCrossings } from '../../src/domain/drawingDefaults';

function run(map: YardMap, command: MapCommand) {
  const before = structuredClone(map), result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected drawing command success.');
  expect(map).toEqual(before);
  expect(validateMap(result.map).ok).toBe(true);
  return result.map;
}
function network() {
  const map = newMap('FAST01_network');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.c = newNode([200, 0, 0]);
  map.roads.r = { ...newRoad('a', 'b'), direction: 'both' };
  map.roads.s = { ...newRoad('b', 'c'), direction: 'both' };
  map.junctions.j = { name: '既有路口', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'drawing' } };
  map.movements.allowed = { name: '既有直行', junctionId: 'j', incomingArc: { roadId: 'r', direction: 'forward' }, outgoingArc: { roadId: 's', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'drawing' } };
  map.movements.forbidden = { ...structuredClone(map.movements.allowed), name: '既有禁转', incomingArc: { roadId: 's', direction: 'backward' }, outgoingArc: { roadId: 'r', direction: 'backward' }, allowed: false };
  return map;
}

describe('FAST01 form-free atomic drawing', () => {
  it('creates only endpoints, keeps intermediate anchors, and undoes the whole gesture once', () => {
    const before = createSession(newMap('FAST01_empty'), true);
    const result = editSession(before, { type: 'quickTraceRoad', points: [[0, 0, 0], [50, 20, 0], [100, 0, 0]] });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1);
    const map = result.session.map, id = Object.keys(map.roads)[0]!;
    expect(Object.keys(map.nodes)).toHaveLength(2);
    expect(roadPoints(map, id)).toEqual([[0, 0, 0], [50, 20, 0], [100, 0, 0]]);
    expect(map.roads[id]).toMatchObject({ name: '道路001', direction: 'both', widthM: { state: 'known', value: 12 }, speedLimitMps: { state: 'unknown' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' } });
    expect(map.sources[map.roads[id]!.widthM.state === 'known' ? map.roads[id]!.widthM.sourceRef! : '']!.category).toBe('design_assumption');
    expect(undoSession(result.session).map).toEqual(before.map);
    expect(redoSession(undoSession(result.session)).map).toEqual(map);
  });

  it('reuses profile sources and changes defaults only for subsequent roads, with globally unique IDs', () => {
    const initial = network(); initial.nodes.road_trace_001 = newNode([500, 500, 0]);
    const first = run(initial, { type: 'quickTraceRoad', points: [[0, 100, 0], [100, 100, 0]] });
    const firstId = Object.keys(first.roads).find(id => !(id in initial.roads))!;
    const second = run(first, { type: 'quickTraceRoad', points: [[0, 200, 0], [100, 200, 0]] });
    expect(Object.keys(second.sources)).toEqual(Object.keys(first.sources));
    const third = run(second, { type: 'quickTraceRoad', points: [[0, 300, 0], [100, 300, 0]], defaults: { widthM: 16 } });
    const thirdId = Object.keys(third.roads).find(id => !(id in second.roads))!;
    expect(firstId).not.toBe('road_trace_001');
    expect(third.roads[firstId]!.widthM).toMatchObject({ value: 12 });
    expect(third.roads[thirdId]!.widthM).toMatchObject({ value: 16 });
    expect(third.roads.r).toEqual(initial.roads.r);
    expect(third.sources).toMatchObject(first.sources);
    expect(third.nodes.road_trace_001).toEqual(initial.nodes.road_trace_001);
  });

  it('joins an explicitly selected node with non-U-turn permissions and preserves existing forbidden turns', () => {
    const map = network();
    const after = run(map, { type: 'quickTraceRoad', points: [[100, 100, 0], [100, 0, 0]], endConnection: { kind: 'node', nodeId: 'b' } });
    const id = Object.keys(after.roads).find(id => !(id in map.roads))!;
    expect(after.roads[id]!.toNodeId).toBe('b');
    expect(after.nodes.b).toEqual(map.nodes.b);
    expect(after.movements.forbidden).toEqual(map.movements.forbidden);
    expect(after.movements.allowed).toEqual(map.movements.allowed);
    const added = Object.entries(after.movements).filter(([mid]) => !(mid in map.movements)).map(([, m]) => m);
    expect(added).toHaveLength(4);
    expect(added.every(m => m.allowed && m.incomingArc.roadId !== m.outgoingArc.roadId && (m.incomingArc.roadId === id || m.outgoingArc.roadId === id))).toBe(true);
  });

  it('splits at an explicit road endpoint candidate while keeping reverse service paths and one shared capacity', () => {
    const map = network(); map.movements.forbidden!.allowed = true;
    map.servicePoints.forward = { ...newServicePoint('b'), arrival: { mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'r', direction: 'forward' }] } };
    map.servicePoints.backward = { ...newServicePoint('a'), arrival: { mode: 'explicit_internal', entryNodeId: 'b', internalPath: [{ roadId: 'r', direction: 'backward' }] } };
    map.resources.shared = { name: '共享单车容量', kind: 'road', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'roads', entityId: 'r' }], provenance: { category: 'design_assumption' } };
    map.roads.r!.resourceIds = ['shared'];
    const session = createSession(map, true);
    const result = editSession(session, { type: 'quickTraceRoad', points: [[50, 100, 0], [50, 0, 0]], endConnection: { kind: 'road', roadId: 'r', distanceM: 50 } });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    const after = result.session.map, forward = after.servicePoints.forward!.arrival!, backward = after.servicePoints.backward!.arrival!;
    expect(forward.mode).toBe('explicit_internal'); expect(backward.mode).toBe('explicit_internal');
    if (forward.mode !== 'explicit_internal' || backward.mode !== 'explicit_internal') throw new Error('Expected explicit paths.');
    const ids = forward.internalPath.map(arc => arc.roadId);
    expect(ids).toHaveLength(2);
    expect(backward.internalPath).toEqual([...ids].reverse().map(roadId => ({ roadId, direction: 'backward' })));
    expect(ids.reduce((sum, id) => sum + roadLength(after, id), 0)).toBeCloseTo(100, 10);
    expect(after.resources.shared!.capacity).toEqual(map.resources.shared!.capacity);
    expect(Object.keys(after.resources)).toEqual(['shared']);
    expect(after.resources.shared!.appliesTo).toEqual(ids.map(entityId => ({ entityType: 'roads', entityId })));
    expect(after.movements.allowed!.incomingArc.roadId).toBe(ids[1]);
    expect(Object.keys(after.nodes)).toHaveLength(5);
    expect(result.session.past).toHaveLength(1);
    expect(undoSession(result.session).map).toEqual(session.map);
  });

  it('Alt/no candidate leaves coincident geometry disconnected without scanning old crossings', () => {
    const map = network();
    const after = run(map, { type: 'quickTraceRoad', points: [[100, 100, 0], [100, 0, 0]], endConnection: { kind: 'node', nodeId: 'b' }, disconnect: true });
    const id = Object.keys(after.roads).find(id => !(id in map.roads))!;
    expect(after.roads[id]!.toNodeId).not.toBe('b');
    expect(after.movements).toEqual(map.movements);
    expect(after.roads.r).toEqual(map.roads.r); expect(after.roads.s).toEqual(map.roads.s);
  });

  it('rejects cross-plane attachment and opaque split dependencies without partial edits or history', () => {
    const map = network(), originalHash = contentHash(map);
    const badLayer = applyMapCommand(map, { type: 'quickTraceRoad', points: [[0, 50, 5], [100, 0, 5]], endConnection: { kind: 'node', nodeId: 'b' } });
    expect(badLayer.ok).toBe(false); if (!badLayer.ok) expect(badLayer.issues[0]!.code).toBe('LOCAL_NONPLANAR_EDIT');
    expect(contentHash(map)).toBe(originalHash);
    map.extensionNamespaces['test.meta'] = { version: '1', category: 'metadata' }; map.metadata.extensions = { 'test.meta': { road: 'r' } };
    const before = createSession(map), result = editSession(before, { type: 'quickTraceRoad', points: [[50, 100, 0], [50, 0, 0]], endConnection: { kind: 'road', roadId: 'r', distanceM: 50 } });
    expect(result.ok).toBe(false); expect(result.session).toBe(before); expect(result.issues[0]!.code).toBe('TOPOLOGY_OPAQUE_REFERENCE');
  });

  it('connects crossings only between enabled same-plane quick-trace roads and undoes all subdivisions together', () => {
    const first = run(newMap('FAST01_cross', 'cross', '0.3.0'), { type: 'quickTraceRoad', points: [[0, 0, 0], [100, 0, 0]] });
    const points: [number, number, number][] = [[50, -50, 0], [50, 50, 0]];
    const hash = contentHash(first), preview = getQuickTraceCrossings(first, points);
    expect(preview).toHaveLength(1); expect(preview[0]).toMatchObject({ distanceM: 50, roadDistanceM: 50, point: [50, 0, 0] });
    expect(contentHash(first)).toBe(hash);
    const before = createSession(first), result = editSession(before, { type: 'quickTraceRoad', points });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    const after = result.session.map;
    expect(Object.keys(after.roads)).toHaveLength(4); expect(Object.keys(after.nodes)).toHaveLength(5);
    const junction = Object.values(after.junctions)[0]!;
    expect(Object.values(after.junctions)).toHaveLength(1);
    expect(Object.values(after.movements).filter(m => m.allowed)).toHaveLength(12);
    expect(Object.values(after.roads).every(road => road.fromNodeId === junction.nodeIds[0] || road.toNodeId === junction.nodeIds[0])).toBe(true);
    expect(Object.values(after.roads).every(road => road.geometry?.spans.every((span: import('../../src/domain/model').RoadSpan) => span.kind === 'line') && !('shapePoints' in road))).toBe(true);
    expect(result.session.past).toHaveLength(1); expect(undoSession(result.session).map).toEqual(before.map);
  });

  it('keeps old imported crossings, disabled crossings and other levels disconnected', () => {
    const old = network(), points: [number, number, number][] = [[50, -50, 0], [50, 50, 0]];
    expect(getQuickTraceCrossings(old, points)).toEqual([]);
    const drawn = run(newMap('FAST01_cross_disabled'), { type: 'quickTraceRoad', points: [[0, 0, 0], [100, 0, 0]] });
    for (const command of [
      { type: 'quickTraceRoad' as const, points, disconnect: true },
      { type: 'quickTraceRoad' as const, points, defaults: { widthM: 12, connectNewCrossings: false } },
      { type: 'quickTraceRoad' as const, points: points.map(([x, y]) => [x, y, 3]) as [number, number, number][] },
    ]) {
      const after = run(drawn, command);
      expect(Object.keys(after.roads)).toHaveLength(2); expect(Object.keys(after.nodes)).toHaveLength(4);
      expect(after.movements).toEqual({}); expect(after.junctions).toEqual({});
    }
  });
  it('creates generic boundaries in 0.3 without changing old entities, and width handles retain image-estimate provenance', () => {
    const map = newMap('FAST01_generic', 'FAST01', '0.3.0');
    const boundary: Polygon = { outer: [[0, 100, 0], [50, 100, 0], [50, 150, 0], [0, 150, 0], [0, 100, 0]], holes: [] };
    const building = run(map, { type: 'quickTraceBoundary', kind: 'building', boundary });
    const area = run(building, { type: 'quickTraceBoundary', kind: 'area', boundary: { outer: boundary.outer.map(([x, y, z]) => [x + 100, y, z]) as Polygon['outer'], holes: [] } });
    expect(Object.values(area.facilities)[0]).toMatchObject({ name: '建筑001', kind: 'building', boundary, accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' } });
    expect(Object.values(area.zones)[0]).toMatchObject({ name: '区域001', kind: 'unclassified', passability: 'unknown' });
    const roads = run(network(), { type: 'updateRoadBatch', ids: ['r'], patch: { widthM: { state: 'known', value: 16 } }, designAssumption: { id: 'source_width_estimate', origin: 'manual_image_estimate' } });
    expect(roads.sources.source_width_estimate!.category).toBe('imagery_derived');
    expect(roads.roads.r!.heightLimitM).toEqual({ state: 'unknown' });
  });
});
