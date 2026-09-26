import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bendStopsMoving, editCommand, insertAnchor, removeAnchor, type Target } from '../../src/app/canvas/handles';
import { OPERATIONS } from '../../src/app/ops/registry';
import { store } from '../../src/app/state/store';
import { applyMapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { Vec3, YardMap } from '../../src/domain/model';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { flattenPath, getRoadPath, pathLength, pointAt, projectToPath, type ResolvedPath } from '../../src/geometry/roadPath';

const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
function example(change: (json: Record<string, Record<string, unknown>>) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
const road = (path: ResolvedPath, widthM: number | null = 10): Extract<Target, { kind: 'roads' }> => ({ kind: 'roads', id: 'r', path, widthM, curves: true, ends: ['a', 'b'] });
/** The largest distance from the samples of one path to the other path: equal shapes give about 0. */
function deviation(one: ResolvedPath, other: ResolvedPath): number {
  return Math.max(...flattenPath(one, 0.001).samples.map(sample => projectToPath(other, sample.position).offsetM));
}
const straight: ResolvedPath = { anchors: [[0, 0, 0], [100, 0, 0]], spans: [{ kind: 'line' }] };
const curve: ResolvedPath = { anchors: [[0, 0, 0], [100, 0, 0]], spans: [{ kind: 'cubic', control1: [20, 40, 0], control2: [80, 40, 0] }] };

describe('a bend inserted on a road', () => {
  it('goes at the nearest point of the line: a straight span splits in two, the road the same line', () => {
    const path = insertAnchor(road(straight), [30, 4, 0], 6)!;
    expect(path.anchors).toEqual([[0, 0, 0], [30, 0, 0], [100, 0, 0]]);
    expect(path.spans).toEqual([{ kind: 'line' }, { kind: 'line' }]);
  });
  it('on a curve: two curves along the same shape', () => {
    const at = pointAt(curve, 0, 0.3), path = insertAnchor(road(curve), [at[0], at[1] + 0.5, 0], 6)!;
    expect(path.anchors).toHaveLength(3);
    expect(path.spans.map(span => span.kind)).toEqual(['cubic', 'cubic']);
    expect(deviation(path, curve)).toBeLessThan(0.01);
    expect(deviation(curve, path)).toBeLessThan(0.01);
    expect(Math.abs(pathLength(path).lengthM - pathLength(curve).lengthM)).toBeLessThan(0.01);
  });
  it('on a road at one height, the new points exactly at that height (a rounding off it would be refused by the kernel)', () => {
    const high: ResolvedPath = { anchors: [[0, 0, 3.3], [100, 0, 3.3]], spans: [{ kind: 'cubic', control1: [20, 40, 3.3], control2: [80, 40, 3.3] }] };
    for (const t of [0.1, 0.3, 0.7, 0.93]) {
      const at = pointAt(high, 0, t), path = insertAnchor(road(high), at, 6)!;
      expect([...path.anchors, ...path.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : [])].every(point => point[2] === 3.3)).toBe(true);
    }
  });
  it('nowhere off the line (beyond the reach) or at an end', () => {
    expect(insertAnchor(road(straight), [30, 7, 0], 6)).toBeNull();
    expect(insertAnchor(road(straight), [-1, 0, 0], 6)).toBeNull();
    expect(insertAnchor(road(straight), [100.5, 0, 0], 6)).toBeNull();
  });
});

describe('a bend removed from a road', () => {
  it('joins two straight spans into one, restoring the road it was inserted in', () => {
    const inserted = insertAnchor(road(straight), [30, 0, 0], 6)!;
    expect(removeAnchor(road(inserted), { kind: 'anchor', index: 1, at: [30, 0, 0] })).toEqual(straight);
    const bent: ResolvedPath = { anchors: [[0, 0, 0], [40, 20, 0], [100, 0, 0]], spans: [{ kind: 'line' }, { kind: 'line' }] };
    expect(removeAnchor(road(bent), { kind: 'anchor', index: 1, at: [40, 20, 0] })).toEqual(straight);
  });
  it('joins curves into one curve keeping the end tangents; a curve split and joined comes back close to the original', () => {
    const at = pointAt(curve, 0, 0.3), split = insertAnchor(road(curve), at, 6)!;
    const joined = removeAnchor(road(split), { kind: 'anchor', index: 1, at: split.anchors[1]! });
    expect(joined.anchors).toEqual(curve.anchors);
    expect(joined.spans[0]!.kind).toBe('cubic');
    // Tangent directions at the ends kept.
    const direction = (from: Vec3, to: Vec3) => Math.atan2(to[1] - from[1], to[0] - from[0]);
    const span = joined.spans[0] as { control1: Vec3; control2: Vec3 }, original = curve.spans[0] as { control1: Vec3; control2: Vec3 };
    expect(direction([0, 0, 0], span.control1)).toBeCloseTo(direction([0, 0, 0], original.control1), 9);
    expect(direction([100, 0, 0], span.control2)).toBeCloseTo(direction([100, 0, 0], original.control2), 9);
    // The split's parameter is read from the inner controls, so the curve comes back as it was (to rounding).
    expect(deviation(joined, curve)).toBeLessThan(1e-6);
    expect((joined.spans[0] as { control1: Vec3 }).control1.map(v => Math.round(v * 1e6) / 1e6)).toEqual(original.control1);
    expect((joined.spans[0] as { control2: Vec3 }).control2.map(v => Math.round(v * 1e6) / 1e6)).toEqual(original.control2);
    // A curve beside a straight span: one curve from the first anchor to the last.
    const mixed: ResolvedPath = { anchors: [[0, 0, 0], [50, 0, 0], [100, 0, 0]], spans: [{ kind: 'line' }, { kind: 'cubic', control1: [60, 10, 0], control2: [90, 10, 0] }] };
    const merged = removeAnchor(road(mixed), { kind: 'anchor', index: 1, at: [50, 0, 0] });
    expect(merged.anchors).toEqual([[0, 0, 0], [100, 0, 0]]);
    expect(merged.spans[0]!.kind).toBe('cubic');
  });
  it('a bend inserted near either end of a curve comes back as it was too (the join checked by splitting it again)', () => {
    for (const t of [0.01, 0.03, 0.5, 0.97, 0.99]) {
      const split = insertAnchor(road(curve), pointAt(curve, 0, t), 6)!;
      const joined = removeAnchor(road(split), { kind: 'anchor', index: 1, at: split.anchors[1]! });
      expect(deviation(joined, curve)).toBeLessThan(1e-6);
    }
  });
  it('a side of zero length leaves the other span as it is, before or after the bend', () => {
    const touching: ResolvedPath = { anchors: [[0, 0, 0], [0, 0, 0], [100, 0, 0]], spans: [{ kind: 'line' }, { kind: 'cubic', control1: [20, 40, 0], control2: [80, 40, 0] }] };
    expect(removeAnchor(road(touching), { kind: 'anchor', index: 1, at: [0, 0, 0] })).toEqual(curve);
    const trailing: ResolvedPath = { anchors: [[0, 0, 0], [100, 0, 0], [100, 0, 0]], spans: [{ kind: 'cubic', control1: [20, 40, 0], control2: [80, 40, 0] }, { kind: 'line' }] };
    expect(removeAnchor(road(trailing), { kind: 'anchor', index: 1, at: [100, 0, 0] })).toEqual(curve);
  });
  it('two curves not from one split: t from the inner controls when sensible, else the lengths, never below 0.1 or above 0.9', () => {
    // A curve split at 0.3 whose far control was then moved: not one split any more, but its inner controls still say 0.3,
    // so the near control comes back as it was (the lengths' ratio would give another).
    const split = insertAnchor(road(curve), pointAt(curve, 0, 0.3), 6)!;
    const moved = structuredClone(split);
    (moved.spans[1] as { control2: Vec3 }).control2 = [80, 45, 0];
    const joined = removeAnchor(road(moved), { kind: 'anchor', index: 1, at: moved.anchors[1]! });
    expect((joined.spans[0] as { control1: Vec3 }).control1.map(v => Math.round(v * 1e6) / 1e6)).toEqual([20, 40, 0]);
    // A 1 m curve beside a 200 m one with its inner control far from the bend: t from the lengths (about 0.005) is held at 0.1,
    // so the near control goes out ten times, not two hundred.
    const unequal: ResolvedPath = { anchors: [[0, 0, 0], [1, 0, 0], [201, 0, 0]], spans: [{ kind: 'cubic', control1: [0.3, 0.3, 0], control2: [0.7, 0.3, 0] }, { kind: 'cubic', control1: [60, 80, 0], control2: [180, 40, 0] }] };
    const far = removeAnchor(road(unequal), { kind: 'anchor', index: 1, at: [1, 0, 0] });
    expect((far.spans[0] as { control1: Vec3 }).control1.map(v => Math.round(v * 1e6) / 1e6)).toEqual([3, 3, 0]);
  });
  it('never straightens two curves because an inner control sits on the bend, nor flings controls far out', () => {
    const length = (p: ResolvedPath) => pathLength(p).lengthM;
    // The left curve's inner control on the bend itself.
    const onBend: ResolvedPath = { anchors: [[0, 0, 0], [50, 20, 0], [100, 0, 0]], spans: [{ kind: 'cubic', control1: [10, 20, 0], control2: [50, 20, 0] }, { kind: 'cubic', control1: [70, 20, 0], control2: [90, 20, 0] }] };
    const joined = removeAnchor(road(onBend), { kind: 'anchor', index: 1, at: [50, 20, 0] });
    expect(joined.spans[0]!.kind).toBe('cubic');
    expect(length(joined)).toBeLessThan(2 * length(onBend));
    // Inner controls at very different distances from the bend (a split parameter near 0 read from them).
    const lopsided: ResolvedPath = { anchors: [[0, 0, 0], [60, 30, 0], [121, 0, 0]], spans: [{ kind: 'cubic', control1: [20, 30, 0], control2: [59.5, 30, 0] }, { kind: 'cubic', control1: [110, 30, 0], control2: [115, 20, 0] }] };
    const far = removeAnchor(road(lopsided), { kind: 'anchor', index: 1, at: [60, 30, 0] });
    expect(length(far)).toBeLessThan(2 * length(lopsided));
    const span = far.spans[0] as { control1: Vec3; control2: Vec3 };
    for (const control of [span.control1, span.control2]) expect(Math.hypot(control[0] - 60, control[1])).toBeLessThan(400);
  });
});

describe('the edit on the map', () => {
  it('a 0.2 map gets the shape points, one undo step; the kernel keeps the road; removing gives it back', () => {
    const map = example(), id = 'rMain', path = getRoadPath(map, id), target = { ...road(path, null), id, ends: [map.roads[id]!.fromNodeId, map.roads[id]!.toNodeId] as [string, string] };
    const middle = pointAt(path, 0, 0.5), inserted = insertAnchor(target, middle, 6)!;
    const change = editCommand(map, target, { path: inserted, label: '插入折点' })!;
    expect(change.command).toMatchObject({ type: 'updateRoad', id, patch: map.schemaVersion === '0.3.0' ? { geometry: expect.anything() } : { shapePoints: [middle] } });
    const result = editSession(createSession(map, true), change.command);
    if (!result.ok) throw new Error(result.issues.map(issue => issue.code).join());
    expect(getRoadPath(result.session.map, id).anchors).toHaveLength(path.anchors.length + 1);
    expect(undoSession(result.session).map).toEqual(map);
    const after = result.session.map, back = removeAnchor({ ...target, path: getRoadPath(after, id) }, { kind: 'anchor', index: 1, at: middle });
    const removal = applyMapCommand(after, editCommand(after, { ...target, path: getRoadPath(after, id) }, { path: back, label: '删除折点' })!.command);
    if (!removal.ok) throw new Error(removal.issues.map(issue => issue.code).join());
    // The same geometry again (the road's field sources record the edits).
    expect(getRoadPath(removal.map, id)).toEqual(path);
    expect(removal.map.roads[id]!.shapePoints ?? removal.map.roads[id]!.geometry).toEqual(map.roads[id]!.shapePoints ?? map.roads[id]!.geometry);
  });
});

describe('an inserted bend that would pin a building, and a 0.3 map', () => {
  // A yard east of the waiting zone with its own entrance node on its west wall, one straight road out to the west.
  const yard = (json: Record<string, Record<string, unknown>>) => {
    json.facilities!.fYard = { name: '堆场', kind: 'yard', boundary: { outer: [[110, 10, 0], [130, 10, 0], [130, 30, 0], [110, 30, 0], [110, 10, 0]], holes: [] },
      accessPointIds: ['aYard'], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    json.nodes!.nYardGate = { name: '堆场门', position: [110, 20, 0], kind: 'access', provenance: { category: 'synthetic' } };
    json.nodes!.nYardOut = { name: '堆场门外', position: [104, 20, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
    json.accessPoints!.aYard = { name: '堆场门', facilityId: 'fYard', nodeId: 'nYardGate', provenance: { category: 'synthetic' } };
    json.roads!.rYardIn = { ...(json.roads!.rMain as object), name: '堆场接入段', fromNodeId: 'nYardOut', toNodeId: 'nYardGate', shapePoints: [] };
  };
  const targetOf = (map: YardMap, id: string) => ({ ...road(getRoadPath(map, id), null), id, ends: [map.roads[id]!.fromNodeId, map.roads[id]!.toNodeId] as [string, string] });
  it("a bend in a building's entrance connector is refused with the reason; one on a public road is not", () => {
    const map = example(yard), connector = targetOf(map, 'rYardIn'), bend = insertAnchor(connector, [107, 20, 0], 6)!;
    expect(bendStopsMoving(map, 'rYardIn', bend, connector)).toContain('「堆场」将不能移动');
    const main = targetOf(map, 'rMain');
    expect(bendStopsMoving(map, 'rMain', insertAnchor(main, [60, 0, 0], 6)!, main)).toBeNull();
  });
  it('a 0.3 map gets the path geometry; the kernel keeps the road; removing gives the same geometry back', () => {
    const upgraded = applyMapCommand(example(), { type: 'upgradeSchema', targetVersion: '0.3.0' });
    if (!upgraded.ok) throw new Error(upgraded.issues.map(issue => issue.code).join());
    const map = upgraded.map, target = targetOf(map, 'rMain'), path = target.path;
    const inserted = insertAnchor(target, pointAt(path, 0, 0.5), 6)!, change = editCommand(map, target, { path: inserted, label: '插入折点' })!;
    expect(change.command).toMatchObject({ type: 'updateRoad', patch: { geometry: { kind: 'path', anchors: [pointAt(path, 0, 0.5)] } } });
    const result = applyMapCommand(map, change.command);
    if (!result.ok) throw new Error(result.issues.map(issue => issue.code).join());
    const after = result.map, back = removeAnchor(targetOf(after, 'rMain'), { kind: 'anchor', index: 1, at: pointAt(path, 0, 0.5) });
    const removal = applyMapCommand(after, editCommand(after, targetOf(after, 'rMain'), { path: back, label: '删除折点' })!.command);
    if (!removal.ok) throw new Error(removal.issues.map(issue => issue.code).join());
    expect(removal.map.roads.rMain!.geometry).toEqual(map.roads.rMain!.geometry);
  });
});

describe('another browser project, in the file menu', () => {
  it('needs an open map in a ready browser project', () => {
    const op = OPERATIONS.find(operation => operation.id === 'file.saveAsProject')!;
    expect(op).toMatchObject({ label: '另存为浏览器工程', menu: 'file' });
    const at = (phase: 'open' | 'memory' | 'starting', session = true) => {
      store.set({ session: session ? { map: example(), past: [], future: [], acknowledgedHash: null, changeToken: 0 } : null, project: { phase, failure: null }, drawing: { ...DEFAULT_DRAWING_CONFIG } });
      return op.enabled!(store.get());
    };
    expect(at('open')).toBe(true);
    expect(at('memory')).toContain('导出副本');
    expect(at('starting')).toContain('尚未就绪');
    expect(at('open', false)).toBe('请先打开地图');
    store.set({ session: null, project: { phase: 'starting', failure: null } });
  });
});
