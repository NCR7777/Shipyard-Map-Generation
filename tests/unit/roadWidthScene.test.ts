import { describe, expect, it } from 'vitest';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import type { PhysicalValue, SchemaVersion, Vec3 } from '../../src/domain/model';
import { serializeMap } from '../../src/domain/serialization';
import { roadWidthBounds } from '../../src/geometry/roads';
import { editorFixture } from '../helpers/M1_fixtures';

describe('view-only road widths and scene bounds', () => {
  it.each<SchemaVersion>(['0.1.0', '0.2.0'])('passes node kinds and independent width values through Schema %s scenes', version => {
    const map = newMap('width_scene', 'Synthetic width scene', version);
    map.nodes.a = newNode([0, 0, 0]);
    map.nodes.b = { ...newNode([100, 0, 0]), kind: 'junction' };
    map.nodes.c = { ...newNode([100, 50, 0]), kind: 'access' };
    map.roads.ab = { ...newRoad('a', 'b'), widthM: { state: 'known', value: 12, sourceRef: 'src_width' } };
    map.sources.src_width = { name: 'Width assumption', category: 'design_assumption', description: 'Synthetic test width; not a survey.' };
    const before = serializeMap(map);
    const scene = toSceneSnapshot(map);
    expect(scene.nodes.map(node => node.kind)).toEqual(['ordinary', 'junction', 'access']);
    expect(scene.roads[0]!.widthM).toEqual(map.roads.ab.widthM);
    expect(scene.roads[0]!.widthM).not.toBe(map.roads.ab.widthM);
    if (scene.roads[0]!.widthM.state !== 'known') throw new Error('Known width was lost.');
    scene.roads[0]!.widthM.value = 40;
    scene.roads[0]!.points[0]![0] = -99;
    scene.nodes[0]!.position[0] = -99;
    expect(serializeMap(map)).toBe(before);
    expect(toSceneSnapshot(map).roads[0]!.widthM).toEqual({ state: 'known', value: 12, sourceRef: 'src_width' });
  });

  it('includes round caps and a bent road width in XY without expanding Z', () => {
    const map = editorFixture();
    map.nodes.nA!.position = [0, 0, 2];
    map.nodes.nB!.position = [100, 0, 4];
    map.roads.rAB!.shapePoints = [[40, 60, 3]];
    map.roads.rAB!.widthM = { state: 'known', value: 20 };
    const scene = toSceneSnapshot(map);
    expect(scene.bounds).toEqual({ min: [-10, -10, 2], max: [110, 70, 4] });
    expect(scene.roads[0]!.points).toEqual([[0, 0, 2], [40, 60, 3], [100, 0, 4]]);
    expect(map.roads.rAB!.corridorPolygon).toBeUndefined();
  });

  it('fits the full width even when it is wider than the road is long', () => {
    const map = editorFixture();
    map.roads.rAB!.widthM = { state: 'known', value: 500 };
    expect(toSceneSnapshot(map).bounds).toEqual({ min: [-250, -250, 0], max: [350, 250, 0] });
  });

  it.each(['unknown', 'unrestricted', 'not_applicable'] as const)('preserves %s instead of inventing a displayed physical width', state => {
    const map = editorFixture();
    map.roads.rAB!.widthM = { state, reason: 'No finite road width is declared.' };
    const scene = toSceneSnapshot(map);
    expect(scene.roads[0]!.widthM).toEqual(map.roads.rAB!.widthM);
    expect(scene.bounds).toEqual({ min: [0, 0, 0], max: [100, 0, 0] });
    const width = scene.roads[0]!.widthM;
    if (width.state === 'known') throw new Error('A physical width was fabricated.');
    width.reason = 'Snapshot-only change';
    expect(map.roads.rAB!.widthM).toEqual({ state, reason: 'No finite road width is declared.' });
  });

  it('keeps an empty map without fabricated extents', () => {
    expect(toSceneSnapshot(newMap('empty_width_scene')).bounds).toBeNull();
  });

  it('retains finite bounds and reports an unrepresentable round envelope', () => {
    const map = editorFixture();
    map.nodes.nA!.position = [Number.MAX_VALUE * 0.75, 0, 0];
    map.nodes.nB!.position = [Number.MAX_VALUE, 0, 0];
    map.roads.rAB!.widthM = { state: 'known', value: Number.MAX_VALUE };
    const before = serializeMap(map);
    const scene = toSceneSnapshot(map);
    expect(scene.roads).toHaveLength(1);
    expect(scene.roads[0]!.widthM).toEqual(map.roads.rAB!.widthM);
    expect(scene.bounds!.max[0]).toBe(Number.MAX_VALUE);
    expect([...scene.bounds!.min, ...scene.bounds!.max].every(Number.isFinite)).toBe(true);
    expect(scene.missingCapabilities.some(message => message.includes('rAB') && message.includes('数值范围'))).toBe(true);
    expect(serializeMap(map)).toBe(before);
  });

  it('reports overflow of the envelope span even if both bounds are finite', () => {
    const points: Vec3[] = [[0, 0, 0], [Number.MAX_VALUE / 2, 0, 0]];
    const result = roadWidthBounds(points, { state: 'known', value: Number.MAX_VALUE });
    expect(result.limited).toBe(true);
    expect([...result.bounds!.min, ...result.bounds!.max].every(Number.isFinite)).toBe(true);
    expect(points).toEqual([[0, 0, 0], [Number.MAX_VALUE / 2, 0, 0]]);
  });

  it('reports a positive width whose half-width underflows instead of silently treating it as zero', () => {
    const result = roadWidthBounds([[0, 0, 0], [1, 0, 0]], { state: 'known', value: Number.MIN_VALUE });
    expect(result.limited).toBe(true);
    expect([...result.bounds!.min, ...result.bounds!.max].every(Number.isFinite)).toBe(true);
  });

  it.each<PhysicalValue>([{ state: 'known', value: 0 }, { state: 'known', value: -1 }])('does not expand nonpositive width $value into a road band', width => {
    expect(roadWidthBounds([[0, 0, 0], [100, 0, 0]], width).bounds).toEqual({ min: [0, 0, 0], max: [100, 0, 0] });
  });

  it('leaves topology and command results unchanged when two road bands overlap', () => {
    const map = editorFixture();
    map.nodes.nC = newNode([0, 15, 0]);
    map.nodes.nD = newNode([100, 15, 0]);
    map.roads.rAB!.widthM = { state: 'known', value: 20 };
    map.roads.rCD = { ...newRoad('nC', 'nD'), widthM: { state: 'known', value: 20 } };
    const before = serializeMap(map);
    const command: MapCommand = { type: 'updateNode', id: 'nB', patch: { name: 'Renamed endpoint' } };
    const resultBefore = applyMapCommand(map, command);
    const scene = toSceneSnapshot(map);
    expect(scene.bounds).toEqual({ min: [-10, -10, 0], max: [110, 25, 0] });
    expect(scene.nodes).toHaveLength(4);
    expect(scene.roads.map(road => [road.fromNodeId, road.toNodeId])).toEqual([['nA', 'nB'], ['nC', 'nD']]);
    expect(map.movements).toEqual({});
    expect(map.junctions).toEqual({});
    expect(serializeMap(map)).toBe(before);
    expect(resultBefore.ok).toBe(true);
    expect(applyMapCommand(map, command)).toEqual(resultBefore);
  });
});
