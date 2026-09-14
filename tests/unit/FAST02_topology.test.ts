import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { getQuickTraceCrossings } from '../../src/domain/drawingDefaults';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import { loadMap } from '../../src/domain/load';
import type { PathRoad, RoadGeometry, Vec3, YardMap } from '../../src/domain/model';
import { serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { getRoadPath, pathLength, pointAt, poseAtDistance } from '../../src/geometry/roadPath';
import { roadLength } from '../../src/geometry/roads';
import { validateMap } from '../../src/validation/validate';

const arch: RoadGeometry = { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [0, 100, 0], control2: [100, 100, 0] }] };
function pathRoad(from: string, to: string, geometry: RoadGeometry): PathRoad {
  const road = newRoad(from, to);
  const { shapePoints, ...properties } = road;
  void shapePoints;
  return { ...properties, direction: 'both', geometry: structuredClone(geometry) };
}
function fixture() {
  const map = newMap('FAST02_curve', 'synthetic curve topology', '0.3.0');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.c = newNode([150, 0, 0]);
  map.roads.r = pathRoad('a', 'b', arch); map.roads.s = pathRoad('b', 'c', { kind: 'path', anchors: [], spans: [{ kind: 'line' }] });
  map.junctions.j = { name: '既有许可', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.allowed = { name: '原允许方向', junctionId: 'j', incomingArc: { roadId: 'r', direction: 'forward' }, outgoingArc: { roadId: 's', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.forbidden = { ...structuredClone(map.movements.allowed), name: '原禁止方向', incomingArc: { roadId: 's', direction: 'backward' }, outgoingArc: { roadId: 'r', direction: 'backward' }, allowed: false };
  map.servicePoints.forward = { ...newServicePoint('b'), arrival: { mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'r', direction: 'forward' }] } };
  map.servicePoints.backward = { ...newServicePoint('a'), arrival: { mode: 'explicit_internal', entryNodeId: 'b', internalPath: [{ roadId: 'r', direction: 'backward' }] } };
  map.resources.shared = { name: '既有共享单车容量', kind: 'road', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'roads', entityId: 'r' }], provenance: { category: 'synthetic' } };
  map.roads.r.resourceIds = ['shared'];
  return map;
}
function run(map: YardMap, command: MapCommand): YardMap {
  const before = structuredClone(map), result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected successful curve command.');
  expect(map).toEqual(before); expect(validateMap(result.map).ok).toBe(true);
  return result.map;
}
const split: MapCommand = { type: 'splitRoad', id: 'r', distanceM: 100, nodeId: 'middle', newRoadIds: ['left', 'right'] };

describe('FAST02 unified curve topology', () => {
  it('splits a cubic exactly at arc length and retains direction-sensitive references and one shared capacity', () => {
    const before = fixture(), after = run(before, split);
    expect(roadLength(before, 'r')).toBeCloseTo(200, 3);
    expect(after.nodes.middle!.position[0]).toBeCloseTo(50, 5); expect(after.nodes.middle!.position[1]).toBeCloseTo(75, 5);
    expect(commandSupport(before, split).geometryPreservedRoadIds).toEqual(['left', 'right']);
    const left = getRoadPath(after, 'left'), right = getRoadPath(after, 'right');
    expect(left.spans[0]!.kind).toBe('cubic'); expect(right.spans[0]!.kind).toBe('cubic');
    // Independent polynomial identity for this exact arch, including both sides of the cut.
    for (let i = 0; i <= 20; i++) {
      const t = i / 20, actual = t <= 0.5 ? pointAt(left, 0, 2 * t) : pointAt(right, 0, 2 * t - 1);
      expect(actual[0]).toBeCloseTo(300 * t * t - 200 * t * t * t, 4);
      expect(actual[1]).toBeCloseTo(300 * t * (1 - t), 4);
    }
    const wholeLength = pathLength(getRoadPath(before, 'r')), a = pathLength(left), b = pathLength(right);
    expect(Math.abs(a.lengthM + b.lengthM - wholeLength.lengthM)).toBeLessThanOrEqual(wholeLength.errorM + a.errorM + b.errorM + 1e-6);
    expect(after.servicePoints.forward!.arrival).toMatchObject({ internalPath: [{ roadId: 'left', direction: 'forward' }, { roadId: 'right', direction: 'forward' }] });
    expect(after.servicePoints.backward!.arrival).toMatchObject({ internalPath: [{ roadId: 'right', direction: 'backward' }, { roadId: 'left', direction: 'backward' }] });
    expect(after.movements.allowed!.incomingArc.roadId).toBe('right');
    expect(after.movements.forbidden).toMatchObject({ allowed: false, outgoingArc: { roadId: 'right', direction: 'backward' } });
    expect(Object.keys(after.resources)).toEqual(['shared']); expect(after.resources.shared!.capacity).toEqual(before.resources.shared!.capacity);
    expect(after.resources.shared!.appliesTo).toEqual([{ entityType: 'roads', entityId: 'left' }, { entityType: 'roads', entityId: 'right' }]);
    expect(Object.keys(after.nodes)).toHaveLength(4);
  });

  it('creates a curved T branch at the true curve and undoes split, branch, sources and turns as one gesture', () => {
    const map = fixture(), before = createSession(map, true);
    const branch: RoadGeometry = { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [20, 140, 0], control2: [80, 120, 0] }] };
    const result = editSession(before, { type: 'quickTraceRoad', points: [[50, 150, 0], [50, 75, 0]], geometry: branch, endConnection: { kind: 'road', roadId: 'r', distanceM: 100 } });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1);
    const after = result.session.map, node = Object.entries(after.nodes).find(([, n]) => Math.abs(n.position[0] - 50) < 1e-5 && Math.abs(n.position[1] - 75) < 1e-5)!;
    expect(node).toBeDefined();
    expect(Object.values(after.roads).filter(r => r.fromNodeId === node[0] || r.toNodeId === node[0])).toHaveLength(3);
    expect(Object.values(after.movements).filter(m => after.junctions[m.junctionId]!.nodeIds.includes(node[0]) && m.allowed)).toHaveLength(6);
    expect(after.movements.forbidden!.allowed).toBe(false);
    expect(Object.keys(after.nodes)).toHaveLength(5); expect(Object.keys(after.resources)).toHaveLength(1);
    expect(undoSession(result.session).map).toEqual(before.map);
  });

  it('joins curve to curve using one shared endpoint and keeps controls out of the node dictionary', () => {
    const map = newMap('FAST02_curve_curve', 'synthetic', '0.3.0');
    const first = run(map, { type: 'quickTraceRoad', points: [[0, 0, 0], [100, 0, 0]], geometry: arch });
    const road = Object.values(first.roads)[0]!;
    const second = run(first, { type: 'quickTraceRoad', points: [[100, 0, 0], [200, -100, 0]], geometry: { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [100, -50, 0], control2: [150, -100, 0] }] }, startConnection: { kind: 'node', nodeId: road.toNodeId } });
    expect(Object.keys(second.nodes)).toHaveLength(3); expect(Object.keys(second.roads)).toHaveLength(2);
    expect(Object.values(second.movements)).toHaveLength(2);
    expect(Object.values(second.movements).every(m => m.allowed && m.incomingArc.roadId !== m.outgoingArc.roadId)).toBe(true);
  });

  it('finds an actual line-cubic crossing where the chord has no intersection', () => {
    const first = run(newMap('FAST02_actual_crossing', 'synthetic', '0.3.0'), { type: 'quickTraceRoad', points: [[0, 0, 0], [100, 0, 0]], geometry: arch });
    const points: Vec3[] = [[50, 50, 0], [50, 150, 0]];
    const candidates = getQuickTraceCrossings(first, points);
    expect(candidates).toHaveLength(1); expect(candidates[0]!.point[1]).toBeCloseTo(75, 3);
    const after = run(first, { type: 'quickTraceRoad', points });
    expect(Object.keys(after.roads)).toHaveLength(4); expect(Object.keys(after.nodes)).toHaveLength(5);
    expect(Object.values(after.movements)).toHaveLength(12);
    const total = Object.keys(after.roads).reduce((sum, id) => sum + roadLength(after, id), 0);
    expect(total).toBeCloseTo(300, 2);
  });

  it('moves adjacent controls with a shared node, then transforms selected paths only once', () => {
    const map = newMap('FAST02_handles', 'synthetic', '0.3.0');
    map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.d = newNode([-100, 0, 0]);
    map.roads.r = pathRoad('a', 'b', arch);
    map.roads.q = pathRoad('a', 'd', { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [-20, -100, 0], control2: [-100, -100, 0] }] });
    const moved = run(map, { type: 'updateNode', id: 'a', patch: { position: [10, 20, 0] } });
    expect(getRoadPath(moved, 'r').spans[0]).toMatchObject({ control1: [10, 120, 0], control2: [100, 100, 0] });
    expect(getRoadPath(moved, 'q').spans[0]).toMatchObject({ control1: [-10, -80, 0], control2: [-100, -100, 0] });
    expect(moved.nodes.b).toEqual(map.nodes.b);
    const translated = run(map, { type: 'translateSelection', selection: { nodes: ['a'], roads: ['r', 'q'] }, delta: [20, 30, 0] });
    expect(translated.nodes.a!.position).toEqual([20, 30, 0]);
    expect(getRoadPath(translated, 'r').spans[0]).toMatchObject({ control1: [20, 130, 0], control2: [120, 130, 0] });
    expect(getRoadPath(translated, 'q').spans[0]).toMatchObject({ control1: [0, -70, 0], control2: [-80, -70, 0] });
    const copied = run(map, { type: 'duplicateSelection', selection: { nodes: [], roads: ['r'] }, delta: [200, 200, 0], idMap: { a: 'copy_a', b: 'copy_b', r: 'copy_r' } });
    expect(copied.nodes.copy_a!.position).toEqual([200, 200, 0]);
    expect(getRoadPath(copied, 'copy_r').spans[0]).toMatchObject({ control1: [200, 300, 0], control2: [300, 300, 0] });
    expect(copied.roads.r).toEqual(map.roads.r);
  });

  it('suppresses a split node using reversed real spans and reverses service arc directions correctly', () => {
    const map = fixture(), divided = run(map, split);
    const after = run(divided, { type: 'suppressDegree2Node', nodeId: 'middle', retainedRoadId: 'right' });
    expect(after.roads.right).toMatchObject({ fromNodeId: 'b', toNodeId: 'a' });
    expect(getRoadPath(after, 'right').spans.every(span => span.kind === 'cubic')).toBe(true);
    expect(roadLength(after, 'right')).toBeCloseTo(200, 3);
    for (const distance of [0, 40, 100, 160, 200]) {
      const reversed = poseAtDistance(getRoadPath(after, 'right'), 'forward', distance).position;
      const expected = poseAtDistance(getRoadPath(map, 'r'), 'backward', distance).position;
      expect(Math.hypot(reversed[0] - expected[0], reversed[1] - expected[1])).toBeLessThan(0.003);
    }
    expect(after.servicePoints.forward!.arrival).toMatchObject({ internalPath: [{ roadId: 'right', direction: 'backward' }] });
    expect(after.servicePoints.backward!.arrival).toMatchObject({ internalPath: [{ roadId: 'right', direction: 'forward' }] });
    expect(after.movements.forbidden).toMatchObject({ allowed: false, outgoingArc: { roadId: 'right', direction: 'forward' } });
    expect(after.resources.shared!.appliesTo).toEqual([{ entityType: 'roads', entityId: 'right' }]);
    expect(after.resources.shared!.capacity).toEqual(map.resources.shared!.capacity);
  });

  it('stores a mixed line-cubic-line path, translates its anchors and controls together, and reopens without drift', () => {
    const geometry: RoadGeometry = { kind: 'path', anchors: [[50, 0, 0], [100, 50, 0]], spans: [{ kind: 'line' }, { kind: 'cubic', control1: [75, 0, 0], control2: [100, 25, 0] }, { kind: 'line' }] };
    const map = run(newMap('FAST02_mixed', 'synthetic', '0.3.0'), { type: 'quickTraceRoad', points: [[0, 0, 0], ...geometry.anchors, [100, 100, 0]], geometry });
    const id = Object.keys(map.roads)[0]!;
    expect(Object.keys(map.nodes)).toHaveLength(2); expect(map.roads[id]!.geometry).toEqual(geometry);
    expect(roadLength(map, id)).toBeGreaterThan(150);
    const moved = run(map, { type: 'translateSelection', selection: { nodes: [], roads: [id] }, delta: [7, 11, 0] });
    expect(moved.roads[id]!.geometry!.anchors).toEqual([[57, 11, 0], [107, 61, 0]]);
    expect(moved.roads[id]!.geometry!.spans[1]).toMatchObject({ control1: [82, 11, 0], control2: [107, 36, 0] });
    const reopened = loadMap(serializeMap(moved));
    expect(reopened.ok).toBe(true); if (!reopened.ok) throw new Error('Reopen failed.');
    expect(reopened.map).toEqual(moved);
  });
});
