import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/domain/model';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { freezeMap } from '../../src/domain/commands';
import { boundsOfPath, flattenPath, getRoadPath, intersectPaths, movePathAnchor, pathLength, pathToRoadGeometry, pointAt, poseAtDistance, projectToPath, reversePath, splitPath, tangentAt, type ResolvedPath } from '../../src/geometry/roadPath';
import { roadLength, roadPoints } from '../../src/geometry/roads';

const arch = (): ResolvedPath => ({ anchors: [[0, 0, 0], [100, 0, 0]], spans: [{ kind: 'cubic', control1: [0, 100, 0], control2: [100, 100, 0] }] });
const line = (a: Vec3, b: Vec3): ResolvedPath => ({ anchors: [a, b], spans: [{ kind: 'line' }] });
const separation = (a: Vec3, b: Vec3) => Math.hypot(...a.map((value, index) => value - b[index]!));
const near = (actual: Vec3, expected: Vec3, epsilon = 1e-8) => expect(separation(actual, expected)).toBeLessThanOrEqual(epsilon);

describe('FAST02 shared world-metre cubic kernel', () => {
  it('has exact endpoints, the analytic midpoint/tangent, and bounded analytic length 200 m', () => {
    const path = arch();
    near(pointAt(path, 0, 0), [0, 0, 0]); near(pointAt(path, 0, 1), [100, 0, 0]); near(pointAt(path, 0, 0.5), [50, 75, 0]);
    near(tangentAt(path, 0, 0), [0, 1, 0]); near(tangentAt(path, 0, 0.5), [1, 0, 0]); near(tangentAt(path, 0, 1), [0, -1, 0]);
    // |B'(t)| = 300 (2t² - 2t + 1), whose integral on [0,1] is exactly 200.
    for (const tolerance of [0.01, 0.001, 0.0001]) {
      const length = pathLength(path, tolerance);
      expect(length.converged).toBe(true); expect(length.lowerM).toBeLessThanOrEqual(200); expect(length.upperM).toBeGreaterThanOrEqual(200);
      expect(Math.abs(length.lengthM - 200)).toBeLessThanOrEqual(length.errorM); expect(length.errorM).toBeLessThanOrEqual(tolerance + 1e-9);
    }
    expect(boundsOfPath(path)).toEqual({ min: [0, 0, 0], max: [100, 75, 0] });
  });

  it('preserves exact cubic geometry on split, mixed-span joints, and reverse controls', () => {
    const original = arch(), t = 0.37; const [left, right] = splitPath(original, 0, t);
    for (let i = 0; i <= 20; i++) { const u = i / 20; near(pointAt(left, 0, u), pointAt(original, 0, u * t)); near(pointAt(right, 0, u), pointAt(original, 0, t + u * (1 - t))); }
    const a = pathLength(original), b = pathLength(left), c = pathLength(right);
    expect(Math.abs(a.lengthM - b.lengthM - c.lengthM)).toBeLessThanOrEqual(a.errorM + b.errorM + c.errorM);
    const reversed = reversePath(original);
    expect(pathToRoadGeometry(reversed).spans).toEqual([{ kind: 'cubic', control1: [100, 100, 0], control2: [0, 100, 0] }]);
    for (let i = 0; i <= 20; i++) near(pointAt(reversed, 0, i / 20), pointAt(original, 0, 1 - i / 20));
    const mixed: ResolvedPath = { anchors: [[-10, 0, 0], ...original.anchors, [110, 0, 0]], spans: [{ kind: 'line' }, ...original.spans, { kind: 'line' }] };
    const [before, after] = splitPath(mixed, 1, 0);
    expect(before.spans).toEqual([{ kind: 'line' }]); expect(after.spans).toHaveLength(2);
    expect(pathToRoadGeometry(before).anchors).toEqual([]); expect(pathToRoadGeometry(after).anchors).toEqual([[100, 0, 0]]);
  });

  it('walks by arc length with near-uniform distance, reverse yaw and exact waits handled by callers', () => {
    const path = arch(), length = pathLength(path).lengthM, points = Array.from({ length: 21 }, (_, i) => poseAtDistance(path, 'forward', i * length / 20));
    near(points[10]!.position, [50, 75, 0], 1e-5);
    const steps = points.slice(1).map((pose, i) => separation(pose.position, points[i]!.position));
    expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.05);
    expect(points.every(pose => pose.converged)).toBe(true);
    expect(Math.abs(points[1]!.t - 0.05)).toBeGreaterThan(0.005);
    const forward = poseAtDistance(path, 'forward', 63), backward = poseAtDistance(path, 'backward', length - 63);
    near(forward.position, backward.position, 1e-8); expect(Math.cos(forward.yawRad - backward.yawRad)).toBeCloseTo(-1, 12);
    near(poseAtDistance(path, 'backward', 0).position, [100, 0, 0]); near(poseAtDistance(path, 'backward', length).position, [0, 0, 0]);
  });

  it('refines the global closest point and detects multiple road branches', () => {
    const result = projectToPath(arch(), [50, 90, 0]);
    expect(result.converged).toBe(true); expect(result.ambiguous).toBe(false); expect(result.errorM).toBeLessThanOrEqual(0.001 + 1e-10);
    near(result.point, [50, 75, 0], 1e-8); expect(result.offsetM).toBeCloseTo(15, 10); expect(result.sM).toBeCloseTo(100, 3);
    const crossing: ResolvedPath = { anchors: [[-10, -10, 0], [10, 10, 0], [-10, 10, 0], [10, -10, 0]], spans: [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }] };
    expect(projectToPath(crossing, [0, 0, 0]).ambiguous).toBe(true);
    const loop: ResolvedPath = { anchors: [[0, 0, 0], [0, 0, 0]], spans: [{ kind: 'cubic', control1: [100, 200, 0], control2: [-100, 200, 0] }] };
    expect(pathLength(loop).lengthM).toBeGreaterThan(300); expect(pathLength(loop).converged).toBe(true);
    expect(projectToPath(loop, [0, 0, 0]).ambiguous).toBe(true);
  });

  it('does not mistake collinear backtracking or coincident cubic endpoints for a zero path', () => {
    const fold: ResolvedPath = { anchors: [[0, 0, 0], [0, 0, 0]], spans: [{ kind: 'cubic', control1: [100, 0, 0], control2: [-100, 0, 0] }] };
    const flat = flattenPath(fold); expect(flat.samples.length).toBeGreaterThan(3); expect(flat.length.lengthM).toBeGreaterThan(100); expect(flat.converged).toBe(true);
    const degenerate: ResolvedPath = { anchors: [[0, 0, 0], [10, 0, 0]], spans: [{ kind: 'cubic', control1: [0, 0, 0], control2: [10, 0, 0] }] };
    near(tangentAt(degenerate, 0, 0), [1, 0, 0]); near(tangentAt(degenerate, 0, 1), [1, 0, 0]);
    expect(poseAtDistance(degenerate, 'forward', 5).yawRad).toBe(0);
    const zero = line([0, 0, 0], [0, 0, 0]); expect(pathLength(zero).lengthM).toBe(0); expect(poseAtDistance(zero, 'forward', 0).converged).toBe(false);
  });

  it('retains parameters and conservative world error in derived samples independently of display zoom', () => {
    const path = arch(), original = structuredClone(path), flat = flattenPath(path, 0.05);
    expect(flat.converged).toBe(true); expect(flat.errorM).toBeLessThanOrEqual(0.05); expect(flat.samples[0]!.sM).toBe(0);
    for (const sample of flat.samples) near(sample.position, pointAt(path, sample.spanIndex, sample.t));
    expect(flat.samples.every((sample, index) => index === 0 || sample.sM >= flat.samples[index - 1]!.sM)).toBe(true);
    for (const scale of [0.05, 1, 15]) { const screen = flat.samples.map(sample => sample.position.map(value => value * scale)); expect(screen.length).toBe(flat.samples.length); expect(pathLength(path)).toEqual(pathLength(original)); }
    expect(path).toEqual(original); expect(path.anchors).toHaveLength(2); expect(flat.samples.length).toBeGreaterThan(10);
  });

  it('translates only the adjacent handles with an edited anchor', () => {
    const path: ResolvedPath = { anchors: [[0, 0, 0], [10, 0, 0], [20, 0, 0]], spans: [{ kind: 'cubic', control1: [2, 3, 0], control2: [8, 3, 0] }, { kind: 'cubic', control1: [12, 3, 0], control2: [18, 3, 0] }] };
    const changed = movePathAnchor(path, 1, [10, 5, 0]);
    expect(changed.spans).toEqual([{ kind: 'cubic', control1: [2, 3, 0], control2: [8, 8, 0] }, { kind: 'cubic', control1: [12, 8, 0], control2: [18, 3, 0] }]);
    expect(path.anchors[1]).toEqual([10, 0, 0]);
  });

  it('computes curve/line and curve/curve crossings without treating near points as intersections', () => {
    const a = arch(), vertical = line([50, 0, 0], [50, 100, 0]), hit = intersectPaths(a, vertical);
    expect(hit.converged).toBe(true); expect(hit.ambiguous).toBe(false); expect(hit.intersections).toHaveLength(1); near(hit.intersections[0]!.point, [50, 75, 0]);
    const crossing: ResolvedPath = { anchors: [[50, 0, 0], [50, 100, 0]], spans: [{ kind: 'cubic', control1: [30, 25, 0], control2: [70, 75, 0] }] };
    const curves = intersectPaths(a, crossing); expect(curves.converged).toBe(true); expect(curves.ambiguous).toBe(false); expect(curves.intersections).toHaveLength(1);
    const curveHit = curves.intersections[0]!; near(pointAt(a, curveHit.a.spanIndex, curveHit.a.t), pointAt(crossing, curveHit.b.spanIndex, curveHit.b.t), 1e-7);
    expect(intersectPaths(a, line([0, 76, 0], [100, 76, 0])).intersections).toHaveLength(0);
    expect(intersectPaths(a, line([50, 0, 2], [50, 100, 2])).intersections).toHaveLength(0);
  });

  it('accepts smooth shared endpoints but marks interval overlap and interior tangency ambiguous', () => {
    const continuation: ResolvedPath = { anchors: [[100, 0, 0], [200, -100, 0]], spans: [{ kind: 'cubic', control1: [100, -50, 0], control2: [150, -100, 0] }] };
    const joined = intersectPaths(arch(), continuation); expect(joined.converged).toBe(true); expect(joined.ambiguous).toBe(false); expect(joined.intersections).toHaveLength(1);
    near(joined.intersections[0]!.point, [100, 0, 0]);
    expect(intersectPaths(line([0, 0, 0], [10, 0, 0]), line([10, 0, 0], [20, 0, 0])).ambiguous).toBe(false);
    expect(intersectPaths(line([0, 0, 0], [10, 0, 0]), line([5, 0, 0], [15, 0, 0])).ambiguous).toBe(true);
    expect(intersectPaths(arch(), line([0, 75, 0], [100, 75, 0])).ambiguous).toBe(true);
  });

  it('caches deeply frozen maps only, and derived point edits cannot poison future geometry reads', () => {
    const map = newMap('FAST02_cache', 'synthetic', '0.2.0'); map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([10, 0, 0]); map.roads.r = newRoad('a', 'b');
    expect(getRoadPath(map, 'r')).not.toBe(getRoadPath(map, 'r')); const shallow = Object.freeze(map);
    getRoadPath(shallow, 'r'); shallow.nodes.b!.position = [20, 0, 0]; expect(roadLength(shallow, 'r')).toBe(20);
    const frozen = freezeMap(structuredClone(map)); expect(getRoadPath(frozen, 'r')).toBe(getRoadPath(frozen, 'r'));
    const points = roadPoints(frozen, 'r'); points.reverse(); points[0]![0] = 777; expect(roadPoints(frozen, 'r')).toEqual([[0, 0, 0], [20, 0, 0]]);
    const path = getRoadPath(frozen, 'r'), flat = flattenPath(path); flat.samples[0]!.position[0] = 888; expect(flattenPath(path).samples[0]!.position).toEqual([0, 0, 0]);
  });
});
