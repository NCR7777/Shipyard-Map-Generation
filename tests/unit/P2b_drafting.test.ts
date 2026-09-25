import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { constrainAxis, roadCommand, segmentReadout, selfIntersects, shapeBoundary, shapeCommand, snapTarget, snapToGrid } from '../../src/app/canvas/drafting';
import { draftStore, dropStaleDraft, setTool } from '../../src/app/state/draft';
import { store } from '../../src/app/state/store';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { loadMap } from '../../src/domain/load';
import type { Vec3, YardMap } from '../../src/domain/model';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { worldToScreen, type Camera } from '../../src/geometry/coordinates';

function example(): YardMap {
  const loaded = loadMap(readFileSync(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), 'utf8'));
  if (!loaded.ok) throw new Error('example did not load');
  return loaded.map;
}
const camera: Camera = { offsetX: 100, offsetY: 400, scale: 4 };
const screen = (point: Vec3) => worldToScreen(point, camera);
const signedArea = (ring: readonly Vec3[]) => ring.slice(0, -1).reduce((sum, p, i) => sum + p[0] * ring[i + 1]![1] - ring[i + 1]![0] * p[1], 0) / 2;

describe('where a road click connects', () => {
  const scene = toSceneSnapshot(example()), all = { z: 0, nodes: true, roads: true };
  it('a node within 12 px wins over the road under it', () => {
    const [x, y] = screen([100, 0, 0]);
    expect(snapTarget(scene, [x + 8, y], camera, all)?.connection).toEqual({ kind: 'node', nodeId: 'nRoadEast' });
  });
  it('a road interior point is a split connection at its distance along the road; far away there is none', () => {
    const [x, y] = screen([70, 1, 0]), target = snapTarget(scene, [x, y], camera, all)!;
    expect(target.connection).toMatchObject({ kind: 'road', roadId: 'rMain' });
    expect((target.connection as { distanceM: number }).distanceM).toBeCloseTo(70, 3);
    expect(target.position[1]).toBeCloseTo(0, 6);
    const [fx, fy] = screen([70, 20, 0]);
    expect(snapTarget(scene, [fx, fy], camera, all)).toBeNull();
  });
  it('switched-off layers never connect, a road end is never a split, and the start node is not the end target', () => {
    const [x, y] = screen([100, 0, 0]), [ix, iy] = screen([95, 0, 0]);
    expect(snapTarget(scene, [ix, iy], camera, { ...all, nodes: false })?.connection.kind).toBe('road');
    expect(snapTarget(scene, [ix, iy], camera, { ...all, nodes: false, roads: false })).toBeNull();
    expect(snapTarget(scene, [x, y], camera, { ...all, nodes: false })).toBeNull();
    expect(snapTarget(scene, [x, y], camera, { ...all, excludeNodeId: 'nRoadEast' })?.connection).not.toEqual({ kind: 'node', nodeId: 'nRoadEast' });
  });
});

describe('coordinates, readouts and shapes', () => {
  it('grid snap rounds to the step and keeps Z; Shift keeps the longer axis', () => {
    expect(snapToGrid([12.4, -7.6, 3], 5)).toEqual([10, -10, 3]);
    expect(snapToGrid([12.4, -7.6, 3], 0)).toEqual([12.4, -7.6, 3]);
    expect(constrainAxis([0, 0, 0], [10, 3, 0])).toEqual([10, 0, 0]);
    expect(constrainAxis([0, 0, 0], [2, -9, 0])).toEqual([0, -9, 0]);
  });
  it('bearing is clockwise from north (+Y)', () => {
    expect(segmentReadout([0, 0, 0], [0, 10, 0])).toEqual({ lengthM: 10, bearingDeg: 0 });
    expect(segmentReadout([0, 0, 0], [10, 0, 0]).bearingDeg).toBeCloseTo(90);
    expect(segmentReadout([0, 0, 0], [-3, -4, 0])).toMatchObject({ lengthM: 5 });
    expect(segmentReadout([0, 0, 0], [-3, -4, 0]).bearingDeg).toBeCloseTo(216.87, 2);
  });
  it('boundaries are closed and counter-clockwise, whichever way they were drawn; degenerate ones are refused', () => {
    const rect = shapeBoundary('rect2', [[10, 10, 0], [0, 0, 0]])!;
    expect(rect.outer).toHaveLength(5); expect(signedArea(rect.outer)).toBeCloseTo(100);
    for (const side of [[5, 20, 0], [5, -20, 0]] as Vec3[]) {
      const oblique = shapeBoundary('rect3', [[0, 0, 0], [10, 10, 0], side])!;
      expect(signedArea(oblique.outer)).toBeGreaterThan(0);
    }
    const clockwise = shapeBoundary('polygon', [[0, 0, 0], [0, 10, 0], [10, 0, 0]])!;
    expect(signedArea(clockwise.outer)).toBeCloseTo(50);
    expect(shapeBoundary('polygon', [[0, 0, 0], [5, 5, 0], [10, 10, 0]])).toBeNull();
    expect(shapeBoundary('rect2', [[0, 0, 0], [10, 0, 0]])).toBeNull();
    expect(shapeBoundary('rect3', [[0, 0, 0], [10, 0, 0]])).toBeNull();
  });
  it('a figure eight is told apart from a thin shape, and turning an outline around keeps the first vertex', () => {
    const eight: Vec3[] = [[0, 0, 0], [10, 10, 0], [10, 0, 0], [0, 10, 0]], lopsided: Vec3[] = [[0, 0, 0], [20, 10, 0], [20, 0, 0], [0, 10, 0]];
    expect(selfIntersects(eight)).toBe(true); expect(shapeBoundary('polygon', eight)).toBeNull();
    expect(selfIntersects(lopsided)).toBe(true); expect(shapeBoundary('polygon', lopsided)).toBeNull();
    expect(selfIntersects([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]])).toBe(false);
    expect(shapeBoundary('polygon', [[5, 0, 0], [0, 10, 0], [10, 10, 0]])!.outer[0]).toEqual([5, 0, 0]);
  });
});

describe('commands from drafts', () => {
  it('a road carries its connections and the session defaults', () => {
    const command = roadCommand({ points: [[0, 0, 0], [10, 0, 0]], spans: [{ kind: 'line' }], continuity: 'corner', startConnection: { kind: 'node', nodeId: 'a' } },
      { ...DEFAULT_DRAWING_CONFIG, roadWidthM: 8, roadDirection: 'forward', connectNewCrossings: false });
    expect(command).toMatchObject({ type: 'quickTraceRoad', startConnection: { kind: 'node', nodeId: 'a' }, defaults: { widthM: 8, direction: 'forward', connectNewCrossings: false } });
    expect(command).not.toHaveProperty('endConnection');
  });
  it('generic kinds quick-trace; a chosen kind is added with a numbered name', () => {
    const map = example(), boundary = shapeBoundary('rect2', [[0, 0, 0], [10, 10, 0]])!;
    expect(shapeCommand(map, 'building', boundary, DEFAULT_DRAWING_CONFIG)).toMatchObject({ type: 'quickTraceBoundary', kind: 'building' });
    expect(shapeCommand(map, 'zone', boundary, { ...DEFAULT_DRAWING_CONFIG, zoneKind: 'waiting' })).toMatchObject({ type: 'addZone', zone: { name: '区域002', kind: 'waiting' } });
  });
});

// ../map RF01: one activity at a time, bound to the map revision it started on and independent of the camera.
describe('a draft belongs to its tool and map revision', () => {
  beforeEach(() => { draftStore.set(null); store.set({ tool: 'road' }); });
  const road = (token: number) => ({ kind: 'road' as const, token, road: { points: [[0, 0, 0]] as Vec3[], spans: [], continuity: 'corner' as const } });
  it('road and curve continue the same draft; panning keeps any draft; other tools drop it', () => {
    draftStore.set(road(1));
    setTool('curve'); expect(draftStore.get()).not.toBeNull();
    setTool('pan'); expect(draftStore.get()).not.toBeNull();
    setTool('building'); expect(draftStore.get()).toBeNull();
    expect(store.get().tool).toBe('building');
  });
  it('a change of map revision drops it; the same revision keeps it; measurements are never tied to a revision', () => {
    draftStore.set(road(3));
    dropStaleDraft(3); expect(draftStore.get()).not.toBeNull();
    dropStaleDraft(4); expect(draftStore.get()).toBeNull();
    draftStore.set({ kind: 'measure', points: [[0, 0, 0]], finished: false });
    dropStaleDraft(9); expect(draftStore.get()).not.toBeNull();
  });
});
