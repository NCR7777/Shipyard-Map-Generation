import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { shapeBoundary } from '../../src/app/canvas/drafting';
import { dragHandle, editCommand, handleAt, handlePoint, handlesOf, handleTarget, roadWidthHandle, selectedTarget, widthFromRoadHandle, type Target } from '../../src/app/canvas/handles';
import { DEFAULT_DRAWING_CONFIG as DEFAULT_DRAWING } from '../../src/editor/projectController';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { loadMap } from '../../src/domain/load';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { worldToScreen, type Camera } from '../../src/geometry/coordinates';
import { bendPathSpan, curveThroughMidpoint } from '../../src/geometry/curveEditing';
import { pointAt, type ResolvedPath } from '../../src/geometry/roadPath';

function example(): YardMap {
  const loaded = loadMap(readFileSync(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), 'utf8'));
  if (!loaded.ok) throw new Error('example did not load');
  return loaded.map;
}
const camera: Camera = { offsetX: 0, offsetY: 0, scale: 4 };
const rect: Polygon = { outer: [[0, 0, 0], [30, 0, 0], [30, 20, 0], [0, 20, 0], [0, 0, 0]], holes: [] };

// ../map fastTraceDrawing FAST01 / FAST02, now against the ported handle module and the kernel geometry.
describe('ported ../map drawing checks', () => {
  it('FAST01: the width control keeps metric width at zero displacement, on both normal sides, at any zoom', () => {
    for (const scale of [0.615, 10]) for (const tangent of [[1, 0, 0], [-1, 0, 0], [0.6, 0.8, 0]] as Vec3[]) for (const sign of [-1, 1] as const) {
      const handle = roadWidthHandle([100, 200, 0], tangent, 12, sign, { scale, offsetX: 0, offsetY: 0 });
      expect(widthFromRoadHandle(handle, handle.position)).toBeCloseTo(12, 10);
      expect(Math.hypot(handle.position[0] - 100, handle.position[1] - 200) * scale).toBeCloseTo(Math.max(16, 6 * scale), 10);
      const moved: Vec3 = [handle.position[0] + handle.normal[0] * sign * 12, handle.position[1] + handle.normal[1] * sign * 12, 0];
      expect(widthFromRoadHandle(handle, moved)).toBeCloseTo(36, 10);
      expect(Math.hypot(handle.edgeScreen[0] - 100 * scale, handle.edgeScreen[1] + 200 * scale)).toBeCloseTo(6 * scale, 10);
    }
  });
  it('FAST01: a three-point oblique rectangle has four right angles', () => {
    const ring = shapeBoundary('rect3', [[0, 0, 0], [30, 10, 0], [5, 25, 0]])!.outer;
    for (let i = 0; i < 4; i++) {
      const a = ring[i]!, b = ring[i + 1]!, c = ring[(i + 2) % 4]!;
      expect((b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])).toBeCloseTo(0, 9);
    }
  });
  it('FAST02: bending at the midpoint keeps the endpoints and moves an existing curve by its offset', () => {
    const a: Vec3 = [0, 0, 0], b: Vec3 = [100, 0, 0], path: ResolvedPath = { anchors: [a, b], spans: [curveThroughMidpoint(a, b, [50, 30, 0])] };
    expect(pointAt(path, 0, 0.5)).toEqual([50, 30, 0]);
    const bent = bendPathSpan(path, 0, [50, 60, 0]);
    expect(bent.anchors).toEqual(path.anchors); expect(pointAt(bent, 0, 0.5)).toEqual([50, 60, 0]); expect(pointAt(path, 0, 0.5)).toEqual([50, 30, 0]);
  });
});

describe('which handles an object offers', () => {
  it('a rectangle shows four corners and its edge midpoints; free editing shows vertices and edge midpoints, holes included', () => {
    const area = (mode: 'rect' | 'free', boundary = rect): Target => ({ kind: 'facilities', id: 'f', boundary, mode });
    // The midpoints let a rectangle take a new vertex (it becomes a free polygon) without switching modes first.
    expect(handlesOf(area('rect'), camera).map(handle => handle.kind)).toEqual(['corner', 'corner', 'corner', 'corner', 'insert', 'insert', 'insert', 'insert']);
    const holed: Polygon = { ...rect, holes: [[[10, 5, 0], [10, 10, 0], [15, 10, 0], [15, 5, 0], [10, 5, 0]]] };
    // At 8 px/m the 5 m hole is 40 px across: room for its edge midpoints (see the 16 px clearance below).
    const free = handlesOf(area('free', holed), { ...camera, scale: 8 });
    expect(free.filter(handle => handle.kind === 'vertex')).toHaveLength(8);
    expect(free.filter(handle => handle.kind === 'insert')).toHaveLength(8);
  });
  it('a rectangle whose outline is no longer one (a drag preview) shows as a polygon', () => {
    const five: Polygon = { outer: [[0, 0, 0], [30, 0, 0], [30, 20, 0], [15, 25, 0], [0, 20, 0], [0, 0, 0]], holes: [] };
    const handles = handlesOf({ kind: 'facilities', id: 'f', boundary: five, mode: 'rect' }, camera);
    expect(handles.filter(handle => handle.kind === 'vertex')).toHaveLength(5);
    expect(handles.some(handle => handle.kind === 'corner')).toBe(false);
  });
  it('no edge midpoint closer than 17 px (more than twice the hit radius) to another edge: a thin shape keeps only its corners', () => {
    const thin: Polygon = { outer: [[0, 0, 0], [60, 0, 0], [60, 1, 0], [0, 1, 0], [0, 0, 0]], holes: [] };
    const at = (scale: number) => handlesOf({ kind: 'facilities', id: 'f', boundary: thin, mode: 'rect' }, { offsetX: 0, offsetY: 0, scale }).map(handle => handle.kind);
    // 14 px thick: a press in the middle is 7 px from both long-edge midpoints, within their 8 px reach; so none are offered.
    expect(at(14)).toEqual(['corner', 'corner', 'corner', 'corner']);
    // At exactly twice the hit radius a press in the middle would be 8 px from both: still none.
    expect(at(16)).toEqual(['corner', 'corner', 'corner', 'corner']);
    // At 17 px per metre the long edges have room; the short ones (0.5 m from the long edges) do not.
    expect(at(17)).toEqual(['corner', 'corner', 'corner', 'corner', 'insert', 'insert']);
  });
  it('an object smaller than 24 px on screen shows no handles', () => {
    const area: Target = { kind: 'facilities', id: 'f', boundary: rect, mode: 'rect' };
    // 25.5 × 17 px: only the corners; every edge midpoint is within 17 px of another edge.
    expect(handlesOf(area, { offsetX: 0, offsetY: 0, scale: 0.85 }).map(handle => handle.kind)).toEqual(['corner', 'corner', 'corner', 'corner']);
    expect(handlesOf(area, { offsetX: 0, offsetY: 0, scale: 0.75 })).toEqual([]);
    const road: Target = { kind: 'roads', id: 'r', path: { anchors: [[0, 0, 0], [5, 0, 0], [10, 0, 0]], spans: [{ kind: 'line' }, { kind: 'line' }] }, widthM: 12, curves: true, ends: ['n0', 'n1'] };
    expect(handlesOf(road, { offsetX: 0, offsetY: 0, scale: 2 })).toEqual([]);
    expect(handlesOf(road, { offsetX: 0, offsetY: 0, scale: 3 }).length).toBeGreaterThan(0);
  });
  it('roads: the two ends and interior anchors always; tangents and bends only on 0.3 maps; width handles only for a known width', () => {
    const path: ResolvedPath = { anchors: [[0, 0, 0], [50, 0, 0], [100, 20, 0]], spans: [{ kind: 'line' }, curveThroughMidpoint([50, 0, 0], [100, 20, 0], [75, 20, 0])] };
    const handles = (curves: boolean, widthM: number | null) => handlesOf({ kind: 'roads', id: 'r', path, widthM, curves, ends: ['nFrom', 'nTo'] }, camera);
    const kinds = (curves: boolean, widthM: number | null) => handles(curves, widthM).map(handle => handle.kind);
    expect(kinds(true, 12)).toEqual(['end', 'end', 'anchor', 'bend', 'control', 'control', 'bend', 'width', 'width']);
    expect(kinds(false, null)).toEqual(['end', 'end', 'anchor']);
    expect(handles(false, null).slice(0, 2)).toEqual([{ kind: 'end', nodeId: 'nFrom', at: [0, 0, 0] }, { kind: 'end', nodeId: 'nTo', at: [100, 20, 0] }]);
  });
  it('a vertex and an edge midpoint never both reach one press; nothing further than 8 px is hit', () => {
    // A 4 m edge at 8.5 px/m: its midpoint (2, 0) is 17 px from the vertex (4, 0), just enough room to be offered;
    // halfway between them (8.5 px from each) neither is reached, and each is taken on its own spot.
    const near2: Camera = { offsetX: 0, offsetY: 0, scale: 8.5 };
    const short: Polygon = { outer: [[0, 0, 0], [4, 0, 0], [30, 20, 0], [0, 20, 0], [0, 0, 0]], holes: [] };
    const handles = handlesOf({ kind: 'zones', id: 'z', boundary: short, mode: 'free' }, near2);
    const [vx, vy] = worldToScreen([4, 0, 0], near2), [mx] = worldToScreen([2, 0, 0], near2);
    expect(handleAt(handles, [(vx + mx) / 2, vy], near2)).toBeNull();
    expect(handleAt(handles, [vx, vy], near2)).toMatchObject({ kind: 'vertex', index: 1 });
    expect(handleAt(handles, [mx, vy], near2)).toMatchObject({ kind: 'insert', edge: 0 });
    const [x, y] = worldToScreen([30, 0, 0], camera), near = handlesOf({ kind: 'zones', id: 'z', boundary: rect, mode: 'free' }, camera);
    expect(handleAt(near, [x + 8, y], camera)).toMatchObject({ kind: 'vertex', index: 1 });
    expect(handleAt(near, [x + 9, y], camera)).toBeNull();
  });
  it('only an editable single building, zone or road gets handles', () => {
    const map = example(), scene = toSceneSnapshot(map);
    expect(handleTarget(map, scene, 'zones/zWaiting', 'rect')).toMatchObject({ kind: 'zones', mode: 'rect' });
    expect(handleTarget(map, scene, 'roads/rMain', 'rect')).toMatchObject({ kind: 'roads', curves: false, widthM: null });
    expect(handleTarget(map, scene, 'nodes/nLoading', 'rect')).toBeNull();
    // A zone that is no longer a rectangle is edited vertex by vertex even in rectangle mode.
    const skewed = { ...scene, zones: scene.zones.map(zone => ({ ...zone, boundary: { outer: [[70, 30, 0], [90, 30, 0], [95, 50, 0], [70, 50, 0], [70, 30, 0]], holes: [] } as Polygon })) };
    expect(handleTarget(map, skewed, 'zones/zWaiting', 'rect')).toMatchObject({ mode: 'free' });
    expect(handleTarget(map, scene, 'zones/zWaiting', 'free')).toMatchObject({ mode: 'free' });
  });
  it('handles need the select tool, exactly one selected object, an editable map and an unlocked layer', () => {
    const map = example(), scene = toSceneSnapshot(map);
    const state = { tool: 'select' as const, selection: ['roads/rMain'], boundaryMode: 'rect' as const, drawing: DEFAULT_DRAWING };
    expect(selectedTarget(map, scene, state, false)).toMatchObject({ kind: 'roads', id: 'rMain' });
    // Roads have no kernel-side boundary check: a read-only map must be refused here.
    expect(selectedTarget(map, scene, state, true)).toBeNull();
    expect(selectedTarget(map, scene, { ...state, drawing: { ...DEFAULT_DRAWING, lockedTypes: ['roads'] } }, false)).toBeNull();
    expect(selectedTarget(map, scene, { ...state, tool: 'road' }, false)).toBeNull();
    expect(selectedTarget(map, scene, { ...state, selection: ['roads/rMain', 'zones/zWaiting'] }, false)).toBeNull();
  });
});

describe('dragging a handle and committing it', () => {
  it('an outline equal by value makes no command, whatever the key order (a corner released where it was pressed)', () => {
    const map = example(), target: Target = { kind: 'facilities', id: 'fWorkshop', boundary: rect, mode: 'rect' };
    expect(editCommand(map, target, { boundary: { holes: [], outer: rect.outer }, label: '' })).toBeNull();
    expect(editCommand(map, target, dragHandle(target, { kind: 'corner', corner: 2, at: [30, 20, 0] }, [30, 20, 0], camera))).toBeNull();
  });
  it('a corner resizes with the opposite corner fixed; clamping is reported', () => {
    const target: Target = { kind: 'facilities', id: 'f', boundary: rect, mode: 'rect' };
    const edit = dragHandle(target, { kind: 'corner', corner: 2, at: [30, 20, 0] }, [40, 35, 0], camera);
    expect('boundary' in edit && edit.boundary.outer).toContainEqual([0, 0, 0]);
    expect('boundary' in edit && edit.boundary.outer).toContainEqual([40, 35, 0]);
    expect(edit.label).toBe('40.00 × 35.00 m');
    expect(dragHandle(target, { kind: 'corner', corner: 2, at: [30, 20, 0] }, [-5, -5, 0], camera).label).toContain('最小尺寸');
  });
  it('a dragged handle keeps its grab offset; outline and centreline points snap to the grid, tangents and widths do not', () => {
    const vertex = { kind: 'vertex' as const, ring: 0, index: 1, at: [30, 0, 0] as Vec3 };
    // Grabbed 1.5 m left of the vertex and moved 4.2 m right: the vertex moves 4.2 m, not to the pointer.
    const close = (actual: Vec3, expected: Vec3) => actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 9));
    close(handlePoint(vertex, [28.5, 0, 0], [32.7, 0, 0], 0), [34.2, 0, 0]);
    expect(handlePoint(vertex, [28.5, 0, 0], [32.7, 0.4, 0], 1)).toEqual([34, 0, 0]);
    const control = { kind: 'control' as const, span: 0, which: 1 as const, at: [10, 10, 0] as Vec3, anchor: [0, 0, 0] as Vec3 };
    close(handlePoint(control, [10, 10, 0], [12.3, 10.4, 0], 1), [12.3, 10.4, 0]);
  });
  it('dragging an edge midpoint inserts the vertex there', () => {
    const edit = dragHandle({ kind: 'zones', id: 'z', boundary: rect, mode: 'free' }, { kind: 'insert', ring: 0, edge: 0, at: [15, 0, 0] }, [15, -6, 0], camera);
    expect('boundary' in edit && edit.boundary.outer).toEqual([[0, 0, 0], [30, 0, 0], [30, 20, 0], [0, 20, 0], [0, 0, 0]].flatMap((point, index) => index === 1 ? [[15, -6, 0], point] : [point]));
  });
  it('commands: unchanged makes none; a 0.2 road edits its shape points; a width is a manual image estimate in millimetres', () => {
    const map = example(), target: Target = { kind: 'roads', id: 'rMain', path: { anchors: [[0, 0, 0], [50, 0, 0], [100, 0, 0]], spans: [{ kind: 'line' }, { kind: 'line' }] }, widthM: 12, curves: false, ends: ['nRoadWest', 'nRoadEast'] };
    expect(editCommand(map, target, { path: target.path, label: '' })).toBeNull();
    expect(editCommand(map, target, { widthM: 12, label: '' })).toBeNull();
    const moved = editCommand(map, target, dragHandle(target, { kind: 'anchor', index: 1, at: [50, 0, 0] }, [50, 5, 0], camera))!;
    expect(moved.command).toEqual({ type: 'updateRoad', id: 'rMain', patch: { shapePoints: [[50, 5, 0]] } });
    const width = editCommand(map, target, { widthM: 18.123456, label: '' })!;
    expect(width.command).toMatchObject({ type: 'updateRoadBatch', ids: ['rMain'], patch: { widthM: { state: 'known', value: 18.123 } }, designAssumption: { origin: 'manual_image_estimate' } });
  });
});
