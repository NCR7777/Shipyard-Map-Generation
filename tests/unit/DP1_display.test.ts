import { describe, expect, it } from 'vitest';
import type { SceneItem, SceneSnapshot } from '../../src/adapters/contracts';
import type { Polygon, Vec3 } from '../../src/domain/model';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { createDisplayIndex, createTextMeasurer, layoutLabels, selectDisplay, type DisplayEntry, type DisplayView } from '../../src/renderers/2d/display';
import { editorFixture } from '../helpers/M1_fixtures';

const camera = { offsetX: 0, offsetY: 300, scale: 1 };
const options = { camera, width: 400, height: 300 };
const polygon = (x: number, y: number, width: number, height: number) => rectanglePolygon([x, y, 0], width, height);
function item(kind: SceneItem['kind'], id: string, data: Partial<SceneItem> = {}): SceneItem {
  return { key: kind + '/' + id, kind, id, name: '完整名称 ' + id, jsonPath: '/' + kind + '/' + id,
    status: 'geometry', reason: '', points: [], lines: [], polygons: [], ...data };
}
function scene(items: SceneItem[], data: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return { ...toSceneSnapshot(editorFixture()), nodes: [], roads: [], facilities: [], zones: [], accessPoints: [], servicePoints: [], items, ...data };
}
function view(entries: DisplayEntry[]): DisplayView {
  return { keys: new Set(entries.map(entry => entry.key)), candidates: entries, culledCount: 0, lodCount: 0, unprojectableCount: 0 };
}
const measure = () => createTextMeasurer(text => text.length * 6);
function overlap(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) {
  return a.x < b.x + b.width + 4 && a.x + a.width + 4 > b.x && a.y < b.y + b.height + 4 && a.y + a.height + 4 > b.y;
}

describe('DP1 renderer-only culling and labels', () => {
  it('keeps crossing roads, containing polygons and width edges with all source vertices offscreen', () => {
    const points: Vec3[] = [[-1000, 450, 0], [2000, 450, 0]];
    const data = scene([item('roads', 'wide', { lines: [points] }), item('facilities', 'cover', { polygons: [polygon(-1000, -1000, 3000, 3000)] }), item('nodes', 'far', { points: [[10000, 10000, 0]] })], {
      roads: [{ id: 'wide', name: 'road', fromNodeId: 'a', toNodeId: 'b', points, lengthM: 3000, widthM: { state: 'known', value: 100 } }],
    });
    const before = JSON.stringify(data), index = createDisplayIndex(data), displayed = selectDisplay(index, options);
    expect(displayed.keys).toEqual(new Set(['roads/wide', 'facilities/cover']));
    expect(displayed.culledCount).toBe(1);
    selectDisplay(index, { ...options, camera: { ...camera, scale: 2 } });
    expect(JSON.stringify(data)).toBe(before);
  });

  it('keeps preview geometry and declared width, focus and drag exceptions while respecting explicit hiding', () => {
    const points: Vec3[] = [[9000, 0, 0], [10000, 0, 0]];
    const data = scene([item('roads', 'r', { lines: [points] }), item('facilities', 'f', { polygons: [polygon(9000, 9000, 50, 50)] })], {
      roads: [{ id: 'r', name: 'r', fromNodeId: 'a', toNodeId: 'b', points, lengthM: 1000, widthM: { state: 'known', value: 100 } }],
    });
    const index = createDisplayIndex(data);
    const displayed = selectDisplay(index, { ...options, geometryOverrides: new Map([['roads/r', { lines: [[[-1000, 450, 0], [2000, 450, 0]] as Vec3[]] }]]), keepKeys: new Set(['facilities/f']) });
    expect(displayed.keys).toEqual(new Set(['roads/r', 'facilities/f']));
    expect(selectDisplay(index, { ...options, focusKey: 'facilities/f', hiddenTypes: ['facilities'] }).keys.has('facilities/f')).toBe(false);
    const moved = selectDisplay(index, { ...options, offsets: new Map([['facilities/f', [-8900, -8900, 0] as Vec3]]) });
    expect(moved.keys.has('facilities/f')).toBe(true);
    expect(index.entries.find(entry => entry.key === 'facilities/f')!.offset).toBeUndefined();
  });

  it('preserves uncertain extreme candidates for projection diagnostics, not false culling', () => {
    const index = createDisplayIndex(scene([item('nodes', 'extreme', { points: [[Number.MAX_VALUE, 0, 0]] })]));
    const displayed = selectDisplay(index, { ...options, camera: { ...camera, scale: 100 } });
    expect(displayed.keys.has('nodes/extreme')).toBe(true);
    expect(displayed.unprojectableCount).toBe(1);
  });

  it('applies CSS-size detail LOD and restores focused and explicitly requested details', () => {
    const index = createDisplayIndex(scene([item('slots', 'small', { polygons: [polygon(50, 50, 5, 5)] }), item('junctions', 'large', { polygons: [polygon(100, 100, 20, 20)] })]));
    expect(selectDisplay(index, options).keys).toEqual(new Set(['junctions/large']));
    expect(selectDisplay(index, { ...options, navigating: true }).keys.size).toBe(0);
    expect(selectDisplay(index, { ...options, navigating: true, focusKey: 'slots/small' }).keys).toEqual(new Set(['slots/small']));
    expect(selectDisplay(index, { ...options, showDetails: true }).keys.size).toBe(2);
  });

  it('uses adjacent endpoint segments for ordinary-node LOD and only deduplicates the same node ID', () => {
    const points: Vec3[] = [[50, 50, 0], [60, 50, 0], [300, 50, 0]];
    const nodes: SceneSnapshot['nodes'] = [{ id: 'a', name: 'A', kind: 'ordinary', position: points[0]! }, { id: 'b', name: 'B', kind: 'ordinary', position: points[2]! }];
    const data = scene([item('nodes', 'a', { points: [points[0]!] }), item('nodes', 'b', { points: [points[2]!] }), item('accessPoints', 'ap', { points: [points[2]!] }), item('servicePoints', 'sp', { points: [points[2]!] }), item('servicePoints', 'near', { points: [[300.01, 50, 0]] })], {
      nodes, roads: [{ id: 'r', name: 'R', fromNodeId: 'a', toNodeId: 'b', points, lengthM: 250, widthM: { state: 'unknown' } }],
      accessPoints: [{ id: 'ap', name: 'AP', nodeId: 'b', facilityId: 'f', position: points[2]! }],
      servicePoints: [{ id: 'sp', name: 'SP', nodeId: 'b', kind: 'loading', position: points[2]! }, { id: 'near', name: 'near', nodeId: 'different', kind: 'loading', position: [300.01, 50, 0] }],
    });
    const index = createDisplayIndex(data);
    expect(selectDisplay(index, options).keys).toEqual(new Set(['servicePoints/sp', 'servicePoints/near']));
    expect(selectDisplay(index, { ...options, editingNodes: true }).keys.has('nodes/a')).toBe(true);
    expect(selectDisplay(index, { ...options, focusKey: 'accessPoints/ap' }).keys.has('accessPoints/ap')).toBe(true);
    expect(selectDisplay(index, { ...options, hiddenTypes: ['servicePoints'] }).keys.has('accessPoints/ap')).toBe(true);
  });

  it('bounds measurement cache at 2048 and keys fonts separately', () => {
    const measurer = measure();
    measurer.measure('same', '11px Arial'); measurer.measure('same', '11px Arial');
    expect(measurer.measurements).toBe(1);
    measurer.measure('same', '12px Arial'); expect(measurer.measurements).toBe(2);
    for (let i = 0; i < 3000; i++) measurer.measure(String(i), '11px Arial');
    expect(measurer.size).toBe(2048);
    measurer.clear(); expect(measurer.size).toBe(0);
  });

  it('uses one bounded deterministic cross-type layout and avoids reserved HUD/handle boxes', () => {
    const entries: DisplayEntry[] = Array.from({ length: 1000 }, (_, i) => ({ key: (i % 2 ? 'servicePoints/' : 'nodes/') + i, kind: i % 2 ? 'servicePoints' : 'nodes', id: String(i),
      bounds: { min: [40 + i % 30 * 10, 30 + Math.floor(i / 30) * 8, 0], max: [40 + i % 30 * 10, 30 + Math.floor(i / 30) * 8, 0] }, anchor: [40 + i % 30 * 10, 30 + Math.floor(i / 30) * 8, 0] }));
    const reserved = [{ x: 0, y: 0, width: 150, height: 140 }], measurer = measure();
    const result = layoutLabels(view(entries), { ...options, mode: 'auto', reserved }, measurer);
    expect(result.labels.length).toBeGreaterThan(0);
    expect(result.labels.length).toBeLessThanOrEqual(12);
    expect(result.candidateCount).toBeLessThanOrEqual(48);
    for (let i = 0; i < result.labels.length; i++) {
      expect(reserved.some(rect => overlap(result.labels[i]!, rect))).toBe(false);
      for (let j = i + 1; j < result.labels.length; j++) expect(overlap(result.labels[i]!, result.labels[j]!)).toBe(false);
    }
    expect(layoutLabels(view([...entries].reverse()), { ...options, mode: 'auto', reserved }, measurer).labels).toEqual(result.labels);
    expect(layoutLabels(view(entries), { ...options, mode: 'auto', reserved }, measurer).measurementCount).toBe(0);
  });

  it('only keeps one focus during navigation and focus mode; off measures nothing', () => {
    const entries: DisplayEntry[] = ['one', 'two'].map((id, i) => ({ key: 'servicePoints/' + id, kind: 'servicePoints', id,
      bounds: { min: [70 + i * 100, 50, 0], max: [70 + i * 100, 50, 0] }, anchor: [70 + i * 100, 50, 0] }));
    for (const state of [{ mode: 'auto' as const, navigating: true }, { mode: 'focus' as const }]) {
      expect(layoutLabels(view(entries), { ...options, ...state, focusKey: 'servicePoints/two' }, measure()).labels.map(label => label.key)).toEqual(['servicePoints/two']);
    }
    const result = layoutLabels(view(entries), { ...options, mode: 'off', focusKey: 'servicePoints/two' }, measure());
    expect(result.labels).toEqual([]); expect(result.measurementCount).toBe(0);
  });

  it('deduplicates shared-node labels, truncates only display ID, and debug remains in the viewport', () => {
    const id = 'original_very_long_stable_identifier';
    const entries: DisplayEntry[] = [{ key: 'nodes/n', kind: 'nodes', id: 'n', nodeId: 'n', bounds: { min: [100, 100, 0], max: [100, 100, 0] }, anchor: [100, 100, 0] },
      { key: 'servicePoints/' + id, kind: 'servicePoints', id, nodeId: 'n', bounds: { min: [100, 100, 0], max: [100, 100, 0] }, anchor: [100, 100, 0] },
      { key: 'nodes/offscreen', kind: 'nodes', id: 'offscreen', bounds: { min: [10000, 10000, 0], max: [10000, 10000, 0] }, anchor: [10000, 10000, 0] }];
    const result = layoutLabels(view(entries), { ...options, mode: 'debug_all' }, measure());
    expect(result.labels).toHaveLength(1); expect(result.labels[0]!.text).toBe(id.slice(0, 17) + '…');
    expect(result.labels[0]!.key).toBe('servicePoints/' + id); expect(entries[1]!.id).toBe(id);
  });

  it('rejects text boxes spanning a hole even when the outer-ring center is plausible', () => {
    const boundary: Polygon = { ...polygon(50, 50, 200, 200), holes: [polygon(65, 65, 170, 170).outer.slice().reverse() as Polygon['outer']] };
    const index = createDisplayIndex(scene([item('facilities', 'NO_LABEL', { polygons: [boundary] })]));
    const result = layoutLabels(selectDisplay(index, options), { ...options, mode: 'auto' }, measure());
    expect(result.labels).toEqual([]); expect(result.geometryWork).toBeGreaterThan(0);
  });

  it('omits a concave C-shaped facility label when every near-center position lies in its open bay', () => {
    const boundary: Polygon = { outer: [[40, 40, 0], [260, 40, 0], [260, 260, 0], [40, 260, 0],
      [40, 210, 0], [210, 210, 0], [210, 90, 0], [40, 90, 0], [40, 40, 0]], holes: [] };
    const data = scene([item('facilities', 'C_BAY', { polygons: [boundary] })]);
    const before = JSON.stringify(data), index = createDisplayIndex(data), display = selectDisplay(index, options);
    // The bounding-box center is in the absent left-middle bay (x < 210, 90 < y < 210).
    expect(index.entries.find(entry => entry.key === 'facilities/C_BAY')!.anchor).toEqual([150, 150, 0]);
    expect(display.keys.has('facilities/C_BAY')).toBe(true);
    const result = layoutLabels(display, { ...options, mode: 'auto' }, measure());
    expect(result.labels).toEqual([]);
    expect(result.geometryWork).toBeGreaterThan(0);
    expect(JSON.stringify(data)).toBe(before);
  });

  it('keeps rectangle labels inside rotated geometry and follows transient translation without changing it', () => {
    const base = polygon(0, 0, 120, 80);
    const boundary: Polygon = { outer: base.outer.map(([x, y, z]) => [160 + x * Math.cos(0.4) - y * Math.sin(0.4), 60 + x * Math.sin(0.4) + y * Math.cos(0.4), z]) as Polygon['outer'], holes: [] };
    const index = createDisplayIndex(scene([item('facilities', 'B01', { polygons: [boundary] })]));
    const before = JSON.stringify(boundary), measurer = measure();
    const original = layoutLabels(selectDisplay(index, options), { ...options, mode: 'auto' }, measurer);
    const moved = layoutLabels(selectDisplay(index, { ...options, offsets: new Map([['facilities/B01', [20, 10, 0] as Vec3]]) }), { ...options, mode: 'auto' }, measurer);
    expect(original.labels).toHaveLength(1); expect(moved.labels).toHaveLength(1);
    expect(moved.labels[0]!.x - original.labels[0]!.x).toBeCloseTo(20); expect(moved.labels[0]!.y - original.labels[0]!.y).toBeCloseTo(-10);
    expect(JSON.stringify(boundary)).toBe(before);
  });

  it('stops expensive polygon proofs within a bounded work allowance', () => {
    const ring = Array.from({ length: 2000 }, (_, i): Vec3 => [180 + 120 * Math.cos(i * Math.PI / 1000), 150 + 120 * Math.sin(i * Math.PI / 1000), 0]);
    const boundary: Polygon = { outer: [ring[0]!, ring[1]!, ring[2]!, ring[3]!, ...ring.slice(4), ring[0]!], holes: [] };
    const index = createDisplayIndex(scene([item('facilities', 'complex', { polygons: [boundary] })]));
    const result = layoutLabels(selectDisplay(index, options), { ...options, mode: 'auto' }, measure());
    expect(result.labels).toEqual([]); expect(result.geometryWork).toBe(100000);
  });
});
