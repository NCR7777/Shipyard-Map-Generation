import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../../src/domain/factory';
import type { PathRoad, Polygon, RoadGeometry, YardMap } from '../../src/domain/model';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { getRoadPath, pathLength, pointAt } from '../../src/geometry/roadPath';
import { validateMap } from '../../src/validation/validate';

type WidthCommand = Extract<MapCommand, { type: 'splitRoadAndSetWidth' }>;
const arch: RoadGeometry = { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [0, 100, 0], control2: [100, 100, 0] }] };
function pathRoad(from: string, to: string, geometry: RoadGeometry): PathRoad {
  const { shapePoints, ...road } = newRoad(from, to);
  void shapePoints;
  return { ...road, direction: 'both', geometry: structuredClone(geometry) };
}
function fixture() {
  const map = newMap('FAST01_local_width', 'synthetic width-transition regression', '0.3.0');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.c = newNode([150, 0, 0]);
  map.sources.original_width = { name: '原宽度假设', category: 'design_assumption', description: 'Synthetic fixture width, not a field measurement.' };
  map.roads.r = {
    ...pathRoad('a', 'b', arch), widthM: { state: 'known', value: 2, sourceRef: 'original_width' }, resourceIds: ['shared'],
    provenance: { category: 'synthetic', sourceRefs: ['original_width'], fieldSources: { widthM: 'original_width' } },
    heightLimitM: { state: 'unknown', reason: '未测净高' }, massLimitKg: { state: 'unknown', reason: '未核验承载' }, speedLimitMps: { state: 'unknown', reason: '未设限速' },
  };
  map.roads.s = pathRoad('b', 'c', { kind: 'path', anchors: [], spans: [{ kind: 'line' }] });
  map.junctions.j = { name: '既有转向', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.allowed = { name: '原允许方向', junctionId: 'j', incomingArc: { roadId: 'r', direction: 'forward' }, outgoingArc: { roadId: 's', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.forbidden = { ...structuredClone(map.movements.allowed), name: '原禁止方向', incomingArc: { roadId: 's', direction: 'backward' }, outgoingArc: { roadId: 'r', direction: 'backward' }, allowed: false };
  map.servicePoints.forward = { ...newServicePoint('b'), arrival: { mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'r', direction: 'forward' }] } };
  map.servicePoints.backward = { ...newServicePoint('a'), arrival: { mode: 'explicit_internal', entryNodeId: 'b', internalPath: [{ roadId: 'r', direction: 'backward' }] } };
  map.resources.shared = { name: '原共享单车容量', kind: 'road', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'roads', entityId: 'r' }], provenance: { category: 'synthetic' } };
  return map;
}
function command(patch: Partial<WidthCommand> = {}): WidthCommand {
  // This arch has speed 300(1 - 2t + 2t²), hence s(1/4) = 59.375 m.
  return { type: 'splitRoadAndSetWidth', roadId: 'r', distanceM: 59.375, widthM: 14, ...patch };
}
function reject(map: YardMap, cmd: WidthCommand, code: string) {
  const before = serializeMap(map), session = createSession(map, true), result = editSession(session, cmd);
  expect(result.ok, JSON.stringify(result.issues)).toBe(false);
  expect(result.issues.map(issue => issue.code)).toContain(code);
  expect(result.session).toBe(session); expect(result.session.past).toHaveLength(0);
  expect(serializeMap(map)).toBe(before); expect(serializeMap(result.session.map)).toBe(before);
}
function rectangle(x: number, y: number, half = 0.5): Polygon {
  return { outer: [[x - half, y - half, 0], [x + half, y - half, 0], [x + half, y + half, 0], [x - half, y + half, 0], [x - half, y - half, 0]], holes: [] };
}

describe('FAST01 atomic local road width', () => {
  it.each(['forward', 'backward'] as const)('changes only the %s half at a non-midpoint arc length and preserves the cubic analytically', direction => {
    const map = fixture(), before = serializeMap(map), cmd = command({ direction }), result = applyMapCommand(map, cmd);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok || !result.mapping) throw new Error('Expected local-width split mapping.');
    const after = result.map, [leftId, rightId] = result.mapping.newRoadIds;
    const changedId = direction === 'forward' ? rightId : leftId, unchangedId = direction === 'forward' ? leftId : rightId;
    expect(commandSupport(map, cmd).geometryPreservedRoadIds).toEqual([unchangedId]);
    expect(after.nodes[result.mapping.nodeId]!.position[0]).toBeCloseTo(15.625, 4);
    expect(after.nodes[result.mapping.nodeId]!.position[1]).toBeCloseTo(56.25, 4);
    const left = getRoadPath(after, leftId), right = getRoadPath(after, rightId);
    expect(left.spans[0]!.kind).toBe('cubic'); expect(right.spans[0]!.kind).toBe('cubic');
    for (let index = 0; index <= 40; index++) {
      const t = index / 40, actual = t <= 0.25 ? pointAt(left, 0, t * 4) : pointAt(right, 0, (t - 0.25) / 0.75);
      expect(actual[0]).toBeCloseTo(300 * t * t - 200 * t * t * t, 4);
      expect(actual[1]).toBeCloseTo(300 * t * (1 - t), 4);
    }
    const oldLength = pathLength(getRoadPath(map, 'r')), leftLength = pathLength(left), rightLength = pathLength(right);
    expect(Math.abs(leftLength.lengthM - 59.375)).toBeLessThan(0.002);
    expect(Math.abs(leftLength.lengthM + rightLength.lengthM - oldLength.lengthM)).toBeLessThanOrEqual(oldLength.errorM + leftLength.errorM + rightLength.errorM + 1e-6);
    const changed = after.roads[changedId]!, unchanged = after.roads[unchangedId]!;
    expect(changed.widthM).toMatchObject({ state: 'known', value: 14 });
    if (changed.widthM.state !== 'known') throw new Error('Expected declared width.');
    expect(changed.widthM.sourceRef).not.toBe('original_width');
    expect(after.sources[changed.widthM.sourceRef!]!.category).toBe('design_assumption');
    expect(changed.provenance.fieldSources?.widthM).toBe(changed.widthM.sourceRef);
    expect(unchanged.widthM).toEqual(map.roads.r!.widthM);
    expect(unchanged.provenance.fieldSources?.widthM).toBe('original_width');
    expect(after.sources.original_width).toEqual(map.sources.original_width);
    for (const road of [changed, unchanged]) {
      expect(road.direction).toBe('both'); expect(road.resourceIds).toEqual(['shared']);
      for (const field of ['heightLimitM', 'massLimitKg', 'speedLimitMps'] as const) expect(road[field]).toEqual(map.roads.r![field]);
    }
    expect(after.servicePoints.forward!.arrival).toMatchObject({ internalPath: [{ roadId: leftId, direction: 'forward' }, { roadId: rightId, direction: 'forward' }] });
    expect(after.servicePoints.backward!.arrival).toMatchObject({ internalPath: [{ roadId: rightId, direction: 'backward' }, { roadId: leftId, direction: 'backward' }] });
    expect(after.movements.allowed!.incomingArc).toEqual({ roadId: rightId, direction: 'forward' });
    expect(after.movements.forbidden).toMatchObject({ allowed: false, outgoingArc: { roadId: rightId, direction: 'backward' } });
    expect(Object.keys(after.resources)).toEqual(['shared']);
    expect(after.resources.shared!.capacity).toEqual(map.resources.shared!.capacity);
    expect(after.resources.shared!.appliesTo).toEqual([{ entityType: 'roads', entityId: leftId }, { entityType: 'roads', entityId: rightId }]);
    expect(Object.keys(after.nodes)).toHaveLength(4); expect(Object.keys(after.roads)).toHaveLength(3);
    expect(after.roads.s).toEqual(map.roads.s); expect(after.coordinateFrame).toEqual(map.coordinateFrame);
    expect(validateMap(after).ok).toBe(true); expect(serializeMap(map)).toBe(before);
  });

  it('undoes geometry, width sources, lineage, turns and resource remapping together, and redoes identical content', () => {
    const session = createSession(fixture(), true), original = serializeMap(session.map);
    const result = editSession(session, command({ designAssumption: { id: 'image_width', origin: 'manual_image_estimate' } }));
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1); expect(result.session.map.revision).toBe(session.map.revision + 1);
    expect(result.session.map.sources.image_width!.category).toBe('imagery_derived');
    const undone = undoSession(result.session);
    expect(serializeMap(undone.map)).toBe(original); expect(undone.past).toHaveLength(0);
    expect(redoSession(undone).map).toEqual(result.session.map);
    expect(contentHash(redoSession(undone).map)).toBe(contentHash(result.session.map));
  });

  it.each([NaN, Infinity, 0, -1, 1001])('rejects invalid width %s without consuming a node, source or undo entry', widthM => {
    reject(fixture(), command({ widthM }), 'INVALID_ROAD_WIDTH');
  });
  it.each([0, 1e-7, 200, 201, NaN])('rejects end or invalid cut %s and rolls everything back', distanceM => {
    reject(fixture(), command({ distanceM }), 'INVALID_SPLIT_POSITION');
  });
  it('refuses unknown metadata references and independent road geometry before any partial mutation', () => {
    const opaque = fixture(); opaque.extensionNamespaces['test.meta'] = { version: '1', category: 'metadata' };
    opaque.metadata.extensions = { 'test.meta': { roadId: 'r' } };
    reject(opaque, command(), 'TOPOLOGY_OPAQUE_REFERENCE');
    const measured = fixture(); measured.roads.r!.observedLengthM = { state: 'unknown' };
    reject(measured, command(), 'TOPOLOGY_INDEPENDENT_GEOMETRY');
    reject(fixture(), command({ designAssumption: { id: 'original_width' } }), 'DUPLICATE_ENTITY_ID');
  });

  it.each([
    ['forward', 'workshop'], ['backward', 'workshop'], ['forward', 'water'], ['backward', 'water'],
  ] as const)('checks the newly widened %s band against an existing %s', (direction, kind) => {
    const map = fixture();
    // Five metres along the arch's exact normal at t=3/4 or t=1/4: clear at width 2, hit at width 14.
    const boundary = direction === 'forward' ? rectangle(88.375, 59.25) : rectangle(11.625, 59.25);
    if (kind === 'workshop') map.facilities.obstacle = newFacility(boundary);
    else map.zones.obstacle = { ...newZone(boundary, '明确禁行水面', 'water'), passability: 'forbidden' };
    const narrow = applyMapCommand(map, command({ direction, distanceM: 100, widthM: 2 }));
    expect(narrow.ok, JSON.stringify(narrow)).toBe(true);
    reject(map, command({ direction, distanceM: 100 }), kind === 'workshop' ? 'OWNER_ROAD_NEW_BUILDING_BAND_CONFLICT' : 'SPATIAL_ROAD_FORBIDDEN');
  });

  it('reports generic-building overlap without silently turning classification into a hard prohibition', () => {
    const map = fixture(); map.facilities.obstacle = newFacility(rectangle(88.375, 59.25), '通用建筑', 'building');
    const result = applyMapCommand(map, command({ distanceM: 100 }));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'SPATIAL_ROAD_BUILDING_OVERLAP', severity: 'warning' })]));
  });
});
