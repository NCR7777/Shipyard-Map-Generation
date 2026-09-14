import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad, newFacility, newZone } from '../../src/domain/factory';
import type { LegacyYardMap, YardMapV02, Polygon } from '../../src/domain/model';
import { contentHash, parseMap, serializeMap } from '../../src/domain/serialization';
import { upgradeMapToV03 } from '../../src/domain/upgradeV03';
import { validateMap } from '../../src/validation/validate';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { getRoadPath, transformRoadGeometry, withRoadAnchors } from '../../src/geometry/roadPath';

function legacyFixture(version: '0.1.0' | '0.2.0'): LegacyYardMap | YardMapV02 {
  const map = newMap('FAST01_schema_synthetic', '合成迁移检查', version) as LegacyYardMap | YardMapV02;
  map.nodes.a = newNode([0, 0, 3]); map.nodes.b = newNode([40, 30, 3]);
  map.roads.r = newRoad('a', 'b', [[10.9876543210987, 5.2345678901234, 3], [20, 20, 3]]) as LegacyYardMap['roads'][string];
  map.sources.original = { name: 'synthetic source', category: 'synthetic', description: 'Original test provenance retained exactly' };
  map.roads.r!.provenance = { category: 'synthetic', sourceRefs: ['original'], fieldSources: { shapePoints: 'original' } };
  map.roads.r!.provenance.note = '人工原始折角；不得拉直';
  return map;
}

const boundary: Polygon = { outer: [[0, 40, 3], [20, 40, 3], [20, 60, 3], [0, 60, 3], [0, 40, 3]], holes: [] };

describe('FAST01 versioned line geometry and explicit copy migration', () => {
  it.each(['0.1.0', '0.2.0'] as const)('keeps %s unchanged until explicit migration and preserves exact declared data', version => {
    const original = legacyFixture(version); const snapshot = structuredClone(original);
    const beforeText = serializeMap(original); const beforeHash = contentHash(original);
    expect(parseMap(beforeText)).toEqual({ ok: true, map: original });
    const migrated = upgradeMapToV03(original);
    expect(original).toEqual(snapshot); expect(contentHash(original)).toBe(beforeHash);
    expect(migrated.map).toEqual({ ...snapshot, schemaVersion: '0.3.0', revision: snapshot.revision + 1, roads: {
      r: { ...Object.fromEntries(Object.entries(snapshot.roads.r!).filter(([key]) => key !== 'shapePoints')), geometry: {
        kind: 'path', anchors: snapshot.roads.r!.shapePoints, spans: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }],
      } },
    } });
    expect(roadPoints(migrated.map, 'r')).toEqual(roadPoints(original, 'r'));
    expect(roadLength(migrated.map, 'r')).toBe(roadLength(original, 'r'));
    const text = serializeMap(migrated.map); expect(Object.hasOwn(JSON.parse(text).roads.r, 'shapePoints')).toBe(false);
    expect(parseMap(text)).toEqual({ ok: true, map: migrated.map });
    expect(migrated.changes.map(change => change.path)).toEqual(['/schemaVersion', '/revision', '/roads/r/shapePoints', '/roads/r/geometry']);
    expect(serializeMap(original)).toBe(beforeText);
  });

  it('allows generic objects only in 0.3 and preserves their unknown physical semantics', () => {
    const old = legacyFixture('0.2.0'); const { map } = upgradeMapToV03(old);
    map.facilities.building = newFacility(boundary, '建筑001', 'building');
    map.zones.zone = newZone(boundary, '区域001', 'unclassified');
    expect(validateMap(map).ok).toBe(true);
    expect(map.facilities.building.heightM).toEqual({ state: 'unknown' });
    expect(map.zones.zone.passability).toBe('unknown');
    expect(validateMap({ ...old, facilities: map.facilities, zones: map.zones }).ok).toBe(false);
    const again = upgradeMapToV03(map); expect(again.changes).toEqual([]); expect(again.map).toEqual(map); expect(again.map).not.toBe(map);
  });

  it('rejects competing geometry, mismatched spans and unknown path fields at the input boundary', () => {
    const { map } = upgradeMapToV03(legacyFixture('0.2.0'));
    expect(validateMap({ ...map, roads: { r: { ...map.roads.r, shapePoints: [] } } }).issues.some(issue => issue.code === 'UNKNOWN_CORE_FIELD')).toBe(true);
    map.roads.r!.geometry.spans = [{ kind: 'line' }];
    expect(validateMap(map).issues.map(issue => issue.code)).toContain('ROAD_SPAN_COUNT');
    expect(validateMap({ ...map, roads: { r: { ...map.roads.r, geometry: { ...map.roads.r!.geometry, arbitrary: true } } } }).issues.map(issue => issue.code)).toContain('UNKNOWN_CORE_FIELD');
  });

  it('resolves shared endpoints and never adds samples or handles as network nodes', () => {
    const { map } = upgradeMapToV03(legacyFixture('0.2.0')); const ids = Object.keys(map.nodes);
    const road = map.roads.r!;
    map.roads.r = withRoadAnchors(road, [[22, 8, 3]]);
    map.nodes.a!.position = [-5, 0, 3];
    expect(getRoadPath(map, 'r')).toEqual({ anchors: [[-5, 0, 3], [22, 8, 3], [40, 30, 3]], spans: [{ kind: 'line' }, { kind: 'line' }] });
    expect(Object.keys(map.nodes)).toEqual(ids); expect('shapePoints' in map.roads.r).toBe(false);
  });

  it('preserves cubic controls in transforms and refuses destructive line-only edits', () => {
    const { map } = upgradeMapToV03(legacyFixture('0.2.0'));
    map.roads.r!.geometry = { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [5, 20, 3], control2: [35, 20, 3] }] };
    const changed = transformRoadGeometry(map.roads.r!, point => [point[0] + 2, point[1] - 3, point[2]]);
    expect(changed.geometry.spans).toEqual([{ kind: 'cubic', control1: [7, 17, 3], control2: [37, 17, 3] }]);
    expect(map.roads.r!.geometry.spans).toEqual([{ kind: 'cubic', control1: [5, 20, 3], control2: [35, 20, 3] }]);
    expect(() => withRoadAnchors(map.roads.r!, [])).toThrow('CUBIC_LINE_EDIT_UNSUPPORTED');
  });
});
