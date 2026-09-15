import { describe, expect, it } from 'vitest';
import type { Polygon, Vec3 } from '../../src/domain/model';
import { loadMap } from '../../src/domain/load';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { screenToWorld, worldToScreen } from '../../src/geometry/coordinates';
import { rectanglePolygon, polygonFromVertices, polygonArea2D, transformPolygon, validatePolygon } from '../../src/geometry/polygons';
import { MIN_RECTANGLE_SIZE_M, orientedRectangleVertices, insertPolygonVertex, removePolygonVertex, movePolygonVertex, rectangleFrame, resizeRectangleCorner, resizeRectangleDimensions, type RectangleCorner } from '../../src/geometry/rectangles';
import { associatedFixture, rectangle } from '../helpers/M2A_fixtures';
import { newMap, newFacility } from '../../src/domain/factory';

function rotatedRectangle(): Polygon {
  const angle = Math.PI / 6;
  return transformPolygon(rectanglePolygon([0, 0, 4], 60, 30), ([x, y, z]) => [100 + x * Math.cos(angle) - y * Math.sin(angle), -40 + x * Math.sin(angle) + y * Math.cos(angle), z]);
}
function expectRightAngles(boundary: Polygon, width: number, height: number): void {
  expect(validatePolygon(boundary)).toEqual([]);
  for (let i = 0; i < 4; i++) {
    const a = boundary.outer[i]!; const b = boundary.outer[(i + 1) % 4]!; const c = boundary.outer[(i + 2) % 4]!;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(i % 2 === 0 ? width : height, 9);
    expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])).toBeCloseTo(0, 9);
  }
  expect(boundary.outer[4]).toEqual(boundary.outer[0]);
}

describe('local rectangle geometry without a renderer', () => {
  it.each([0, 1, 2, 3] as const)('keeps the exact opposite corner fixed for corner %s and changes dimensions independently', corner => {
    const original = rotatedRectangle();
    const before = structuredClone(original);
    const frame = rectangleFrame(original)!;
    const fixed = frame.corners[(corner + 2) % 4]!;
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]][corner]!;
    const target: Vec3 = [fixed[0] + signs[0]! * 80 * Math.cos(Math.PI / 6) - signs[1]! * 45 * Math.sin(Math.PI / 6), fixed[1] + signs[0]! * 80 * Math.sin(Math.PI / 6) + signs[1]! * 45 * Math.cos(Math.PI / 6), 999];
    const result = resizeRectangleCorner(frame, corner, target);
    expect(result.boundary.outer[(corner + 2) % 4]).toEqual(fixed);
    expect(result.widthM).toBeCloseTo(80, 10);
    expect(result.heightM).toBeCloseTo(45, 10);
    expect(result.clamped).toBe(false);
    expectRightAngles(result.boundary, 80, 45);
    expect(result.boundary.outer.every(point => point[2] === 4)).toBe(true);
    expect(original).toEqual(before);
    expect(frame.corners).toEqual(before.outer.slice(0, 4));
    const numeric = resizeRectangleDimensions(frame, 80, 45, corner);
    numeric.outer.forEach((point, i) => point.forEach((value, axis) => expect(value).toBeCloseTo(result.boundary.outer[i]![axis]!, 10)));
  });

  it('projects world coordinates independently of the camera and shares the numeric path', () => {
    const frame = rectangleFrame(rectangle())!;
    const point: Vec3 = [80, 45, 0];
    const cameras = [{ offsetX: 30, offsetY: 90, scale: 2 }, { offsetX: -1000, offsetY: 2300, scale: 5 }];
    const geometries = cameras.map(camera => resizeRectangleCorner(frame, 2, screenToWorld(worldToScreen(point, camera), camera)).boundary);
    expect(geometries[0]).toEqual(rectangle(0, 0, 80, 45));
    expect(geometries[1]).toEqual(geometries[0]);
    expect(resizeRectangleDimensions(frame, 80, 45)).toEqual(geometries[0]);
  });

  it.each([0, 1, 2, 3] as const)('clamps crossing corner %s to the same positive metre limit without flipping', corner => {
    const frame = rectangleFrame(rotatedRectangle())!;
    const fixed = frame.corners[(corner + 2) % 4]!;
    const signs = [[-1, -1], [1, -1], [1, 1], [-1, 1]][corner]!;
    const crossing: Vec3 = [fixed[0] - signs[0]! * 2 * frame.axisX[0] - signs[1]! * 3 * frame.axisY[0], fixed[1] - signs[0]! * 2 * frame.axisX[1] - signs[1]! * 3 * frame.axisY[1], 4];
    const result = resizeRectangleCorner(frame, corner, crossing);
    expect(result.widthM).toBe(MIN_RECTANGLE_SIZE_M);
    expect(result.heightM).toBe(MIN_RECTANGLE_SIZE_M);
    expect(result.clamped).toBe(true);
    expect(result.boundary.outer[(corner + 2) % 4]).toEqual(fixed);
    expectRightAngles(result.boundary, 0.01, 0.01);
  });

  it('rejects invalid numeric dimensions, coordinates and corner indices', () => {
    const frame = rectangleFrame(rectangle())!;
    for (const value of [0, -1, 0.001, NaN, Infinity]) expect(() => resizeRectangleDimensions(frame, value, 30)).toThrow(RangeError);
    expect(() => resizeRectangleCorner(frame, 2, [NaN, 45, 0])).toThrow(RangeError);
    expect(() => resizeRectangleDimensions(frame, 80, 45, 4 as RectangleCorner)).toThrow(RangeError);
  });

  it('preserves unchanged rotated and tiny legacy geometry exactly, without implicit repair', () => {
    for (const boundary of [rotatedRectangle(), rectangle(10, 20, 0.001, 0.002)]) {
      const before = JSON.stringify(boundary);
      const frame = rectangleFrame(boundary)!;
      expect(frame).not.toBeNull();
      expect(resizeRectangleCorner(frame, 2, frame.corners[2]).boundary).toEqual(boundary);
      expect(resizeRectangleDimensions(frame, frame.widthM, frame.heightM)).toEqual(boundary);
      expect(JSON.stringify(boundary)).toBe(before);
      const copy = resizeRectangleDimensions(frame, frame.widthM, frame.heightM);
      copy.outer[0][0] += 100;
      expect(JSON.stringify(boundary)).toBe(before);
    }
  });

  it.each([
    ['skew quadrilateral', { outer: [[0, 0, 0], [60, 0, 0], [55, 30, 0], [0, 30, 0], [0, 0, 0]], holes: [] }],
    ['parallelogram', { outer: [[0, 0, 0], [60, 0, 0], [70, 30, 0], [10, 30, 0], [0, 0, 0]], holes: [] }],
    ['nonplanar', { outer: [[0, 0, 0], [60, 0, 0], [60, 30, 1], [0, 30, 0], [0, 0, 0]], holes: [] }],
    ['unclosed', { outer: [[0, 0, 0], [60, 0, 0], [60, 30, 0], [0, 30, 0], [0, 1, 0]], holes: [] }],
    ['clockwise', { outer: [[0, 0, 0], [0, 30, 0], [60, 30, 0], [60, 0, 0], [0, 0, 0]], holes: [] }],
    ['degenerate', { outer: [[0, 0, 0], [60, 0, 0], [60, 0, 0], [0, 0, 0], [0, 0, 0]], holes: [] }],
    ['nonfinite', { outer: [[0, 0, 0], [Infinity, 0, 0], [60, 30, 0], [0, 30, 0], [0, 0, 0]], holes: [] }],
    ['hole', { ...rectangle(), holes: [[[10, 10, 0], [10, 20, 0], [20, 20, 0], [20, 10, 0], [10, 10, 0]]] }],
  ])('does not reinterpret %s as a rectangle', (_label, boundary) => {
    const before = structuredClone(boundary);
    expect(rectangleFrame(boundary as Polygon)).toBeNull();
    expect(boundary).toEqual(before);
  });

  it('edits outer and hole vertices without discarding rings or silently changing winding', () => {
    const boundary: Polygon = { ...rectangle(), holes: [[[10, 10, 0], [10, 20, 0], [20, 20, 0], [20, 10, 0], [10, 10, 0]]] };
    const before = structuredClone(boundary);
    const moved = movePolygonVertex(boundary, 1, 0, [11, 11, 0]);
    expect(moved.outer).toEqual(boundary.outer);
    expect(moved.holes[0]![0]).toEqual([11, 11, 0]);
    expect(moved.holes[0]![4]).toEqual([11, 11, 0]);
    expect(moved.holes[0]!.slice(1, 4)).toEqual(boundary.holes[0]!.slice(1, 4));
    expect(validatePolygon(moved)).toEqual([]);
    expect(boundary).toEqual(before);
    expect(() => movePolygonVertex(boundary, 0, 4, [1, 1, 0])).toThrow(RangeError);
    expect(() => movePolygonVertex(boundary, -1, 0, [1, 1, 0])).toThrow(RangeError);
  });
});

describe('existing domain transactions own resized boundaries', () => {
  it.each(['0.1.0', '0.2.0'] as const)('commits one facility resize after 100 previews, preserving %s IDs and all associated coordinates', schemaVersion => {
    const map = associatedFixture(); map.schemaVersion = schemaVersion;
    const session = createSession(map, true);
    const before = serializeMap(session.map);
    const frame = rectangleFrame(map.facilities.fA!.boundary)!;
    let boundary = map.facilities.fA!.boundary;
    for (let i = 1; i <= 100; i++) boundary = resizeRectangleCorner(frame, 2, [60 + i * 0.2, 30 + i * 0.15, 0]).boundary;
    expect(session.past).toHaveLength(0);
    expect(serializeMap(session.map)).toBe(before);
    const result = editSession(session, { type: 'updateFacility', id: 'fA', patch: { boundary } });
    expect(result.ok).toBe(true);
    expect(result.session.past).toHaveLength(1);
    const changed = result.session.map;
    expect(changed.schemaVersion).toBe(schemaVersion);
    expect(changed.revision).toBe(map.revision + 1);
    expect(changed.nodes).toEqual(map.nodes);
    expect(changed.roads).toEqual(map.roads);
    expect(changed.accessPoints).toEqual(map.accessPoints);
    expect(changed.servicePoints).toEqual(map.servicePoints);
    expect(changed.facilities.fA).toEqual({ ...map.facilities.fA, boundary, provenance: {
      ...map.facilities.fA!.provenance,
      sourceRefs: [...(map.facilities.fA!.provenance.sourceRefs ?? []), 'source_editor_geometry'],
      fieldSources: { ...map.facilities.fA!.provenance.fieldSources, boundary: 'source_editor_geometry' },
    } });
    expect(changed.sources.source_editor_geometry?.category).toBe('design_assumption');
    expectRightAngles(boundary, 80, 45);
    expect(serializeMap(undoSession(result.session).map)).toBe(before);
    expect(redoSession(undoSession(result.session)).map).toEqual(changed);
    const loaded = loadMap(serializeMap(changed));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(contentHash(loaded.map)).toBe(contentHash(changed));
  });

  it('uses the same boundary command for zones and rejects self-intersecting vertex edits atomically', () => {
    const map = associatedFixture();
    const session = createSession(map, true);
    const boundary = resizeRectangleDimensions(rectangleFrame(map.zones.zA!.boundary)!, 35, 15);
    const result = editSession(session, { type: 'updateZone', id: 'zA', patch: { boundary } });
    expect(result.ok).toBe(true);
    expect(result.session.map.nodes).toEqual(map.nodes);
    expect(result.session.map.zones.zA!.boundary).toEqual(boundary);
    const invalid = movePolygonVertex(map.facilities.fA!.boundary, 0, 1, [-10, 15, 0]);
    const refused = editSession(result.session, { type: 'updateFacility', id: 'fA', patch: { boundary: invalid } });
    expect(refused.ok).toBe(false);
    expect(refused.issues.some(issue => issue.code === 'POLYGON_SELF_INTERSECTION')).toBe(true);
    expect(refused.session).toBe(result.session);
    expect(refused.session.past).toHaveLength(1);
  });
});

describe('three-point rectangles and polygon canvas vertex operations', () => {
  it.each([0, 0.37, Math.PI / 2, Math.PI, -1.2])('uses only perpendicular width for an arbitrary base direction %s and retains constrained editing', angle => {
    for (const sideSign of [-1, 1]) {
      const a: Vec3 = [133, -42, 7], b: Vec3 = [a[0] + 40 * Math.cos(angle), a[1] + 40 * Math.sin(angle), 7];
      // The third point is far beyond the end of the base: its along-edge component must not skew the rectangle.
      const side: Vec3 = [a[0] + 99 * Math.cos(angle) - sideSign * 12 * Math.sin(angle), a[1] + 99 * Math.sin(angle) + sideSign * 12 * Math.cos(angle), 7];
      const before = structuredClone([a, b, side]), vertices = orientedRectangleVertices(a, b, side), boundary = polygonFromVertices(vertices);
      expect(vertices[0]).toEqual(a); expect(vertices[1]).toEqual(b);
      // Existing outer-ring normalization reverses clockwise input; that swaps its first edge without moving any corner.
      expectRightAngles(boundary, sideSign > 0 ? 40 : 12, sideSign > 0 ? 12 : 40); expect(polygonArea2D(boundary)).toBeCloseTo(480, 9);
      expect(boundary.outer.every(point => point[2] === 7)).toBe(true);
      const frame = rectangleFrame(boundary)!; expect(frame).not.toBeNull();
      const resized = resizeRectangleDimensions(frame, 60, 18);
      expectRightAngles(resized, 60, 18); expect(resized.outer[0]).toEqual(boundary.outer[0]);
      expect([a, b, side]).toEqual(before);
      vertices[0]![0] += 100; expect(a).toEqual(before[0]);
    }
  });

  it('rejects a missing base, collinear side, too-small perpendicular width, nonfinite and nonplanar input', () => {
    const a: Vec3 = [0, 0, 3], b: Vec3 = [20, 0, 3];
    for (const side of [[100, 0, 3], [100, 0.001, 3], [NaN, 10, 3], [100, Infinity, 3], [100, 10, 4]] as Vec3[]) {
      expect(() => orientedRectangleVertices(a, b, side)).toThrow(RangeError);
    }
    expect(() => orientedRectangleVertices(a, a, [0, 10, 3])).toThrow(RangeError);
    expect(() => orientedRectangleVertices(a, [0.001, 0, 3], [0, 10, 3])).toThrow(RangeError);
    expect(() => orientedRectangleVertices(a, [20, 0, 4], [0, 10, 3])).toThrow(RangeError);
  });

  it.each([0, 1])('inserts and removes midpoints on every edge of ring %s, preserving shape, winding, closure and the other rings', ringIndex => {
    const boundary: Polygon = { ...rectangle(0, 0, 100, 100), holes: [[[40, 40, 0], [40, 60, 0], [60, 60, 0], [60, 40, 0], [40, 40, 0]]] };
    const before = structuredClone(boundary), rings = [boundary.outer, ...boundary.holes];
    for (let edge = 0; edge < 4; edge++) {
      const added = insertPolygonVertex(boundary, ringIndex, edge), actual = [added.outer, ...added.holes][ringIndex]!;
      const a = rings[ringIndex]![edge]!, b = rings[ringIndex]![edge + 1]!;
      expect(actual[edge + 1]).toEqual(a.map((value, axis) => (value + b[axis]!) / 2));
      expect(actual).toHaveLength(6); expect(actual.at(-1)).toEqual(actual[0]);
      expect(validatePolygon(added)).toEqual([]); expect(polygonArea2D(added)).toBe(polygonArea2D(boundary));
      expect(removePolygonVertex(added, ringIndex, edge + 1)).toEqual(boundary);
      expect(ringIndex === 0 ? added.holes : added.outer).toEqual(ringIndex === 0 ? boundary.holes : boundary.outer);
    }
    for (const ring of [0, 1]) {
      const removed = removePolygonVertex(boundary, ring, 0), result = [removed.outer, ...removed.holes][ring]!;
      expect(result).toHaveLength(4); expect(result[0]).toEqual(rings[ring]![1]); expect(result.at(-1)).toEqual(result[0]);
    }
    expect(boundary).toEqual(before);
  });

  it('requires at least three distinct ring positions and refuses closed-point or invalid-ring indices without mutation', () => {
    const triangle = polygonFromVertices([[0, 0, 0], [10, 0, 0], [0, 10, 0]]), before = structuredClone(triangle);
    expect(() => removePolygonVertex(triangle, 0, 1)).toThrow(RangeError);
    for (const operation of [insertPolygonVertex, removePolygonVertex]) {
      expect(() => operation(triangle, 0, 3)).toThrow(RangeError);
      expect(() => operation(triangle, -1, 0)).toThrow(RangeError);
      expect(() => operation(triangle, 1, 0)).toThrow(RangeError);
      expect(() => operation(triangle, 0, 0.5)).toThrow(RangeError);
    }
    expect(triangle).toEqual(before);
  });

  it.each(['facility', 'zone'] as const)('commits %s insertion once and keeps every associated point, road and identity stable', kind => {
    const map = associatedFixture(), session = createSession(map, true);
    const original = kind === 'facility' ? map.facilities.fA!.boundary : map.zones.zA!.boundary;
    const boundary = insertPolygonVertex(original, 0, 3);
    const result = editSession(session, kind === 'facility' ? { type: 'updateFacility', id: 'fA', patch: { boundary } } : { type: 'updateZone', id: 'zA', patch: { boundary } });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    for (const field of ['nodes', 'roads', 'accessPoints', 'servicePoints', 'resources'] as const) expect(result.session.map[field]).toEqual(map[field]);
    const changed = kind === 'facility' ? result.session.map.facilities.fA! : result.session.map.zones.zA!;
    expect(changed.boundary).toEqual(boundary); expect(changed.provenance.fieldSources?.boundary).toBe('source_editor_geometry');
    expect(undoSession(result.session).map).toEqual(map);
  });

  it('rejects deleting an outer corner that would expose an existing hole and retains the original session', () => {
    const map = newMap('polygon-delete-rollback', 'synthetic geometry regression', '0.3.0');
    map.facilities.f = newFacility({ ...rectangle(0, 0, 100, 100), holes: [[[40, 40, 0], [40, 60, 0], [60, 60, 0], [60, 40, 0], [40, 40, 0]]] }, 'holed building', 'building');
    const session = createSession(map, true), boundary = removePolygonVertex(map.facilities.f.boundary, 0, 1);
    expect(validatePolygon(boundary).length).toBeGreaterThan(0);
    const result = editSession(session, { type: 'updateFacility', id: 'f', patch: { boundary } });
    expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(result.session.past).toHaveLength(0);
    expect(serializeMap(result.session.map)).toBe(serializeMap(map));
  });
});
