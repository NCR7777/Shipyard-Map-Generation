import type { MapNode, MapRoad, RoadGeometry, RoadSpan, Vec3, YardMap } from '../domain/model';

/** Resolved world-metre geometry. The first and last anchors come from network nodes. */
export interface ResolvedPath { anchors: Vec3[]; spans: RoadSpan[] }

export function roadGeometryAnchors(road: MapRoad): Vec3[] {
  return road.geometry ? road.geometry.anchors : road.shapePoints;
}

export function hasNonlinearGeometry(road: MapRoad): boolean {
  return road.geometry?.spans.some(span => span.kind === 'cubic') ?? false;
}

export function isStraightRoad(road: MapRoad): boolean {
  return roadGeometryAnchors(road).length === 0 && !hasNonlinearGeometry(road);
}

export function getRoadPath(map: YardMap, roadId: string): ResolvedPath {
  if (!Object.hasOwn(map.roads, roadId)) throw new Error('Unknown road: ' + roadId);
  const road = map.roads[roadId]!;
  if (!Object.hasOwn(map.nodes, road.fromNodeId) || !Object.hasOwn(map.nodes, road.toNodeId))
    throw new Error('Dangling endpoint: ' + roadId);
  const from = map.nodes[road.fromNodeId]!, to = map.nodes[road.toNodeId]!;
  // A path depends only on the road and its two endpoint nodes; frozen ones are shared across map revisions.
  const cacheable = cacheableRoad(road, from, to);
  const cached = cacheable ? roadPaths.get(road) : undefined;
  if (cached && cached.from === from && cached.to === to) return cached.path;
  const path: ResolvedPath = {
    anchors: [from.position, ...roadGeometryAnchors(road), to.position].map(point => [...point]),
    spans: road.geometry ? structuredClone(road.geometry.spans) : Array.from({ length: road.shapePoints.length + 1 }, () => ({ kind: 'line' as const })),
  };
  if (cacheable) { freezePath(path); roadPaths.set(road, { from, to, path }); }
  return path;
}

/** Line editing cannot silently discard cubic control points. */
export function withRoadAnchors<T extends MapRoad>(road: T, anchors: Vec3[]): T {
  if (hasNonlinearGeometry(road)) throw new Error('CUBIC_LINE_EDIT_UNSUPPORTED: use a path geometry command.');
  const points = anchors.map(point => [...point] as Vec3);
  return { ...road, ...(road.geometry
    ? { geometry: { kind: 'path', anchors: points, spans: Array.from({ length: points.length + 1 }, () => ({ kind: 'line' as const })) } }
    : { shapePoints: points }) } as T;
}

/** Network endpoints are transformed separately once by the owning transaction. */
export function transformRoadGeometry<T extends MapRoad>(road: T, transform: (point: Vec3) => Vec3): T {
  return { ...road, ...(road.geometry
    ? { geometry: { kind: 'path', anchors: road.geometry.anchors.map(transform), spans: road.geometry.spans.map(span => span.kind === 'line' ? { kind: 'line' as const } : { kind: 'cubic' as const, control1: transform(span.control1), control2: transform(span.control2) }) } }
    : { shapePoints: road.shapePoints.map(transform) }) } as T;
}

/** Normalize a newly created road for the destination map, never downgrade a path implicitly. */
export function roadForMap(map: YardMap, road: MapRoad): MapRoad {
  if (map.schemaVersion === '0.3.0') {
    if (road.geometry) return structuredClone(road);
    const { shapePoints, ...properties } = structuredClone(road);
    return { ...properties, geometry: { kind: 'path', anchors: shapePoints, spans: [{ kind: 'line' }, ...shapePoints.map(() => ({ kind: 'line' as const }))] } };
  }
  if (road.geometry) throw new Error('ROAD_VERSION_UPGRADE_REQUIRED: path geometry needs schema 0.3.0.');
  return structuredClone(road);
}


export const GEOMETRY_TOLERANCE_VERSION = 'world-metre-0.01-1e-4-flat0.05-v1';
export const PATH_FLATNESS_M = 0.05;
const MAX_DEPTH = 24;
const MAX_LEAVES = 65_536;
const MAX_SEARCH_WORK = 131_072;
type Controls = [Vec3, Vec3, Vec3, Vec3];
export interface LengthResult { lengthM: number; lowerM: number; upperM: number; errorM: number; converged: boolean }
export interface PathSample { spanIndex: number; t: number; position: Vec3; sM: number; sLowerM: number; sUpperM: number }
export interface FlattenedPath { samples: PathSample[]; errorM: number; length: LengthResult; converged: boolean }
export interface PathProjection { spanIndex: number; t: number; point: Vec3; sM: number; offsetM: number; errorM: number; ambiguous: boolean; converged: boolean }
export interface PathPose { position: Vec3; yawRad: number; spanIndex: number; t: number; sM: number; errorM: number; converged: boolean }
interface Leaf { spanIndex: number; kind: 'line' | 'cubic'; t0: number; t1: number; controls: Controls; lowerM: number; upperM: number; flatnessM: number; s0M: number; s1M: number }
interface Prepared { leaves: Leaf[]; flat: FlattenedPath }
const roadPaths = new WeakMap<MapRoad, { from: MapNode; to: MapNode; path: ResolvedPath }>();
const preparedPaths = new WeakMap<ResolvedPath, Map<string, Prepared>>();
const frozenPaths = new WeakSet<ResolvedPath>();
const copy = (p: Vec3): Vec3 => [...p];
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => t === 0 ? copy(a) : t === 1 ? copy(b) : [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];
const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const cross = (a: Vec3, b: Vec3): number => a[0] * b[1] - a[1] * b[0];
const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clamp = (value: number, low: number, high: number): number => Math.max(low, Math.min(high, value));

function cacheableRoad(road: MapRoad, from: MapNode, to: MapNode): boolean {
  if (!Object.isFrozen(road)) return false;
  if (![from, to].every(node => Object.isFrozen(node) && Object.isFrozen(node.position))) return false;
  return road.geometry ? Object.isFrozen(road.geometry) && Object.isFrozen(road.geometry.anchors) && road.geometry.anchors.every(Object.isFrozen)
    && Object.isFrozen(road.geometry.spans) && road.geometry.spans.every(span => Object.isFrozen(span) && (span.kind === 'line' || Object.isFrozen(span.control1) && Object.isFrozen(span.control2)))
    : Object.isFrozen(road.shapePoints) && road.shapePoints.every(Object.isFrozen);
}
function freezePath(path: ResolvedPath): void {
  path.anchors.forEach(Object.freeze);
  for (const span of path.spans) { if (span.kind === 'cubic') { Object.freeze(span.control1); Object.freeze(span.control2); } Object.freeze(span); }
  Object.freeze(path.anchors); Object.freeze(path.spans); Object.freeze(path); frozenPaths.add(path);
}
/** Own an immutable reader copy so repeated projection reuses the world-metre table. */
export function immutablePathCopy(path: ResolvedPath): ResolvedPath { const copy = structuredClone(path); freezePath(copy); return copy; }
function immutablePath(path: ResolvedPath): boolean {
  if (frozenPaths.has(path)) return true;
  const immutable = Object.isFrozen(path) && Object.isFrozen(path.anchors) && Object.isFrozen(path.spans)
    && path.anchors.every(Object.isFrozen) && path.spans.every(span => Object.isFrozen(span) && (span.kind === 'line' || Object.isFrozen(span.control1) && Object.isFrozen(span.control2)));
  if (immutable) frozenPaths.add(path); return immutable;
}
function controlsOf(path: ResolvedPath, index: number): Controls {
  const span = path.spans[index], a = path.anchors[index], b = path.anchors[index + 1];
  if (!span || !a || !b) throw new RangeError('PATH_SPAN_INDEX: invalid path span.');
  return span.kind === 'cubic' ? [a, span.control1, span.control2, b] : [a, lerp(a, b, 1 / 3), lerp(a, b, 2 / 3), b];
}
function divide(controls: Controls, t = 0.5): [Controls, Controls] {
  const [a, b, c, d] = controls, ab = lerp(a, b, t), bc = lerp(b, c, t), cd = lerp(c, d, t);
  const abc = lerp(ab, bc, t), bcd = lerp(bc, cd, t), middle = lerp(abc, bcd, t);
  return [[a, ab, abc, middle], [middle, bcd, cd, d]];
}
function controlPoint(controls: Controls, t: number): Vec3 { return divide(controls, t)[0][3]; }
function derivative(path: ResolvedPath, index: number, t: number): Vec3 {
  const [a, b, c, d] = controlsOf(path, index);
  if (path.spans[index]!.kind === 'line') return subtract(d, a);
  return [0, 1, 2].map(axis => 3 * ((1 - t) ** 2 * (b[axis]! - a[axis]!) + 2 * (1 - t) * t * (c[axis]! - b[axis]!) + t * t * (d[axis]! - c[axis]!))) as Vec3;
}
function secondDerivative(path: ResolvedPath, index: number, t: number): Vec3 {
  if (path.spans[index]!.kind === 'line') return [0, 0, 0];
  const [a, b, c, d] = controlsOf(path, index);
  return [0, 1, 2].map(axis => 6 * ((1 - t) * (c[axis]! - 2 * b[axis]! + a[axis]!) + t * (d[axis]! - 2 * c[axis]! + b[axis]!))) as Vec3;
}
export function pointAt(path: ResolvedPath, spanIndex: number, t: number): Vec3 {
  if (!Number.isFinite(t) || t < 0 || t > 1) throw new RangeError('PATH_PARAMETER: t must be in [0,1].');
  const controls = controlsOf(path, spanIndex);
  return path.spans[spanIndex]!.kind === 'line' ? lerp(controls[0], controls[3], t) : controlPoint(controls, t);
}
/** Unit horizontal tangent. At a cusp prefer the outgoing branch; fully collapsed paths return zero. */
export function tangentAt(path: ResolvedPath, spanIndex: number, t: number): Vec3 {
  pointAt(path, spanIndex, t);
  const direct = derivative(path, spanIndex, t), norm = Math.hypot(direct[0], direct[1]);
  if (Number.isFinite(norm) && norm > 0) return [direct[0] / norm, direct[1] / norm, direct[2] / norm];
  const candidates: Vec3[] = [];
  for (const step of [1e-7, 1e-5, 1e-3]) {
    if (t < 1) candidates.push(subtract(pointAt(path, spanIndex, Math.min(1, t + step)), pointAt(path, spanIndex, t)));
    if (t > 0) candidates.push(subtract(pointAt(path, spanIndex, t), pointAt(path, spanIndex, Math.max(0, t - step))));
  }
  for (let offset = 1; offset < path.spans.length; offset++) {
    if (spanIndex + offset < path.spans.length) candidates.push(subtract(path.anchors[spanIndex + offset + 1]!, path.anchors[spanIndex + offset]!));
    if (spanIndex - offset >= 0) candidates.push(subtract(path.anchors[spanIndex - offset + 1]!, path.anchors[spanIndex - offset]!));
  }
  for (const value of candidates) { const norm = Math.hypot(value[0], value[1]); if (Number.isFinite(norm) && norm > 0) return [value[0] / norm, value[1] / norm, value[2] / norm]; }
  return [0, 0, 0];
}
function pointSegmentDistance(point: Vec3, a: Vec3, b: Vec3): number {
  const delta = subtract(b, a), length = Math.hypot(...delta);
  if (length === 0) return Math.hypot(...subtract(point, a));
  const unit = delta.map(value => value / length) as Vec3;
  const from = subtract(point, a), t = clamp((from[0] * unit[0] + from[1] * unit[1] + from[2] * unit[2]) / length, 0, 1);
  return Math.hypot(...subtract(point, lerp(a, b, t)));
}
function measure(c: Controls): { lowerM: number; upperM: number; flatnessM: number } {
  return { lowerM: distance(c[0], c[3]), upperM: distance(c[0], c[1]) + distance(c[1], c[2]) + distance(c[2], c[3]), flatnessM: Math.max(pointSegmentDistance(c[1], c[0], c[3]), pointSegmentDistance(c[2], c[0], c[3])) };
}
function resultLength(lowerM: number, upperM: number, converged: boolean, cubic = true): LengthResult {
  const roundoff = cubic ? 32 * Number.EPSILON * Math.max(1, upperM) : 0;
  const low = Math.max(0, lowerM - roundoff), high = upperM + roundoff;
  return { lengthM: lowerM / 2 + upperM / 2, lowerM: low, upperM: high, errorM: (high - low) / 2, converged: converged && Number.isFinite(high) };
}
function prepare(path: ResolvedPath, spatialTolerance = PATH_FLATNESS_M, requestedLengthTolerance?: number): Prepared {
  if (!(spatialTolerance > 0) || requestedLengthTolerance !== undefined && (!(requestedLengthTolerance > 0) || !Number.isFinite(requestedLengthTolerance))) throw new RangeError('PATH_TOLERANCE: tolerance must be positive and finite.');
  const key = spatialTolerance + '/' + (requestedLengthTolerance ?? 'default');
  const cache = immutablePath(path) ? preparedPaths.get(path)?.get(key) : undefined;
  if (cache) return cache;
  if (path.anchors.length !== path.spans.length + 1 || !path.spans.length) throw new Error('ROAD_SPAN_COUNT: path anchors and spans disagree.');
  const roots = path.spans.map((span, spanIndex) => { const controls = controlsOf(path, spanIndex); const metrics = span.kind === 'line' ? { lowerM: distance(controls[0], controls[3]), upperM: distance(controls[0], controls[3]), flatnessM: 0 } : measure(controls); return { spanIndex, kind: span.kind, controls, ...metrics }; });
  const initialUpper = roots.reduce((sum, leaf) => sum + leaf.upperM, 0);
  const lengthTolerance = requestedLengthTolerance ?? Math.max(0.01, 1e-4 * initialUpper);
  let converged = Number.isFinite(initialUpper), generated = roots.length;
  const leaves: Leaf[] = [];
  for (const root of roots) {
    const stack = [{ ...root, t0: 0, t1: 1, depth: 0, budget: initialUpper ? lengthTolerance * root.upperM / initialUpper : lengthTolerance / roots.length }];
    while (stack.length) {
      const leaf = stack.pop()!;
      const sufficient = leaf.kind === 'line' || leaf.upperM - leaf.lowerM <= 2 * leaf.budget && leaf.flatnessM <= spatialTolerance;
      if (sufficient || leaf.depth >= MAX_DEPTH || generated >= MAX_LEAVES || !Number.isFinite(leaf.upperM)) {
        if (!sufficient) converged = false;
        leaves.push({ ...leaf, s0M: 0, s1M: 0 }); continue;
      }
      generated++; const [left, right] = divide(leaf.controls), middle = (leaf.t0 + leaf.t1) / 2;
      stack.push({ ...leaf, controls: right, ...measure(right), t0: middle, depth: leaf.depth + 1, budget: leaf.budget / 2 });
      stack.push({ ...leaf, controls: left, ...measure(left), t1: middle, depth: leaf.depth + 1, budget: leaf.budget / 2 });
    }
  }
  let low = 0, high = 0, flatError = 0;
  const samples: PathSample[] = [{ spanIndex: 0, t: 0, position: copy(path.anchors[0]!), sM: 0, sLowerM: 0, sUpperM: 0 }];
  for (const leaf of leaves) {
    leaf.s0M = low / 2 + high / 2; low += leaf.lowerM; high += leaf.upperM; leaf.s1M = low / 2 + high / 2;
    flatError = Math.max(flatError, leaf.flatnessM);
    samples.push({ spanIndex: leaf.spanIndex, t: leaf.t1, position: copy(leaf.controls[3]), sM: leaf.s1M, sLowerM: low, sUpperM: high });
  }
  const length = resultLength(low, high, converged, roots.some(leaf => leaf.kind === 'cubic'));
  length.converged &&= length.errorM <= lengthTolerance + 64 * Number.EPSILON * Math.max(1, length.upperM);
  const prepared = { leaves, flat: { samples, errorM: flatError, length, converged: converged && length.converged } };
  if (immutablePath(path)) { const entries = preparedPaths.get(path) ?? new Map<string, Prepared>(); entries.set(key, prepared); preparedPaths.set(path, entries); }
  return prepared;
}
export function pathLength(path: ResolvedPath, toleranceM?: number): LengthResult { return { ...prepare(path, PATH_FLATNESS_M, toleranceM).flat.length }; }
/** Derived parameter/chainage samples. They never become network nodes or authoritative anchors. */
export function flattenPath(path: ResolvedPath, toleranceM = PATH_FLATNESS_M): FlattenedPath {
  const flat = prepare(path, toleranceM).flat;
  return { ...flat, length: { ...flat.length }, samples: flat.samples.map(sample => ({ ...sample, position: copy(sample.position) })) };
}
function partialLength(controls: Controls, t: number, toleranceM = 1e-7): LengthResult {
  if (t <= 0) return resultLength(0, 0, true, false);
  const root = t >= 1 ? controls : divide(controls, t)[0];
  const stack = [{ controls: root, budget: toleranceM, depth: 0 }]; let low = 0, high = 0, work = 0, converged = true;
  while (stack.length) {
    const leaf = stack.pop()!, m = measure(leaf.controls);
    if (m.upperM - m.lowerM <= 2 * leaf.budget || leaf.depth >= MAX_DEPTH || ++work > MAX_LEAVES || !Number.isFinite(m.upperM)) { low += m.lowerM; high += m.upperM; converged &&= m.upperM - m.lowerM <= 2 * leaf.budget; continue; }
    const halves = divide(leaf.controls); for (const value of halves) stack.push({ controls: value, budget: leaf.budget / 2, depth: leaf.depth + 1 });
  }
  return resultLength(low, high, converged);
}
function chainageAt(prepared: Prepared, spanIndex: number, t: number): { sM: number; errorM: number } {
  const leaf = prepared.leaves.find(value => value.spanIndex === spanIndex && t <= value.t1 + Number.EPSILON)!;
  const local = clamp((t - leaf.t0) / (leaf.t1 - leaf.t0), 0, 1);
  const part = leaf.kind === 'line' ? { lengthM: local * leaf.lowerM, errorM: 0 } : partialLength(leaf.controls, local);
  return { sM: leaf.s0M + part.lengthM, errorM: prepared.flat.length.errorM + part.errorM };
}
export function poseAtDistance(path: ResolvedPath, direction: 'forward' | 'backward', sM: number): PathPose {
  const prepared = prepare(path), length = prepared.flat.length;
  if (!Number.isFinite(sM) || sM < 0 || sM > length.lengthM + length.errorM + 1e-8) throw new RangeError('PATH_DISTANCE: chainage is outside the road.');
  const canonicalS = direction === 'forward' ? clamp(sM, 0, length.lengthM) : length.lengthM - clamp(sM, 0, length.lengthM);
  let low = 0, high = prepared.leaves.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; if (prepared.leaves[middle]!.s1M < canonicalS) low = middle + 1; else high = middle; }
  const leaf = prepared.leaves[low]!; const leafLength = leaf.s1M - leaf.s0M;
  let localT = leafLength > 0 ? clamp((canonicalS - leaf.s0M) / leafLength, 0, 1) : 0;
  let localError = 0, converged = prepared.flat.converged;
  if (leaf.kind === 'cubic' && localT > 0 && localT < 1) {
    let a = 0, b = 1; const total = partialLength(leaf.controls, 1);
    const target = localT * total.lengthM;
    for (let iteration = 0; iteration < 40; iteration++) {
      localT = (a + b) / 2; const part = partialLength(leaf.controls, localT); localError = part.errorM + total.errorM; converged &&= part.converged && total.converged;
      if (Math.abs(part.lengthM - target) <= Math.max(1e-8, total.lengthM * 1e-10)) break;
      if (part.lengthM < target) a = localT; else b = localT;
    }
  }
  const t = canonicalS === 0 ? 0 : canonicalS === length.lengthM ? 1 : leaf.t0 + localT * (leaf.t1 - leaf.t0);
  const spanIndex = canonicalS === 0 ? 0 : canonicalS === length.lengthM ? path.spans.length - 1 : leaf.spanIndex;
  const tangent = tangentAt(path, spanIndex, t); const sign = direction === 'forward' ? 1 : -1;
  return { position: pointAt(path, spanIndex, t), yawRad: Math.atan2(sign * tangent[1], sign * tangent[0]), spanIndex, t, sM: clamp(sM, 0, length.lengthM), errorM: length.errorM + localError, converged: converged && Math.hypot(tangent[0], tangent[1]) > 0 };
}
export function splitPath(path: ResolvedPath, spanIndex: number, t: number): [ResolvedPath, ResolvedPath] {
  const middle = pointAt(path, spanIndex, t), span = path.spans[spanIndex]!;
  if (t === 0) return [{ anchors: path.anchors.slice(0, spanIndex + 1).map(copy), spans: structuredClone(path.spans.slice(0, spanIndex)) }, { anchors: path.anchors.slice(spanIndex).map(copy), spans: structuredClone(path.spans.slice(spanIndex)) }];
  if (t === 1) return [{ anchors: path.anchors.slice(0, spanIndex + 2).map(copy), spans: structuredClone(path.spans.slice(0, spanIndex + 1)) }, { anchors: path.anchors.slice(spanIndex + 1).map(copy), spans: structuredClone(path.spans.slice(spanIndex + 1)) }];
  const [a, b] = divide(controlsOf(path, spanIndex), t);
  const left: RoadSpan = span.kind === 'line' ? { kind: 'line' } : { kind: 'cubic', control1: a[1], control2: a[2] };
  const right: RoadSpan = span.kind === 'line' ? { kind: 'line' } : { kind: 'cubic', control1: b[1], control2: b[2] };
  return [{ anchors: [...path.anchors.slice(0, spanIndex + 1).map(copy), middle], spans: [...structuredClone(path.spans.slice(0, spanIndex)), left] }, { anchors: [copy(middle), ...path.anchors.slice(spanIndex + 1).map(copy)], spans: [right, ...structuredClone(path.spans.slice(spanIndex + 1))] }];
}
export function reversePath(path: ResolvedPath): ResolvedPath {
  return { anchors: [...path.anchors].reverse().map(copy), spans: [...path.spans].reverse().map(span => span.kind === 'line' ? { kind: 'line' } : { kind: 'cubic', control1: copy(span.control2), control2: copy(span.control1) }) };
}
export function pathToRoadGeometry(path: ResolvedPath): RoadGeometry {
  if (path.spans.length < 1 || path.anchors.length !== path.spans.length + 1) throw new Error('ROAD_SPAN_COUNT: cannot persist an empty or mismatched road path.');
  return { kind: 'path', anchors: path.anchors.slice(1, -1).map(copy), spans: structuredClone(path.spans) as RoadGeometry['spans'] };
}
export function movePathAnchor(path: ResolvedPath, index: number, position: Vec3): ResolvedPath {
  const previous = path.anchors[index]; if (!previous) throw new RangeError('PATH_ANCHOR_INDEX: unknown anchor.');
  const delta = subtract(position, previous), next = structuredClone(path); next.anchors[index] = copy(position);
  const translate = (point: Vec3): Vec3 => [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]];
  const incoming = next.spans[index - 1], outgoing = next.spans[index];
  if (incoming?.kind === 'cubic') incoming.control2 = translate(incoming.control2);
  if (outgoing?.kind === 'cubic') outgoing.control1 = translate(outgoing.control1);
  return next;
}
const pathBounds = new WeakMap<ResolvedPath, { min: Vec3; max: Vec3 }>();
export function boundsOfPath(path: ResolvedPath): { min: Vec3; max: Vec3 } {
  const cached = pathBounds.get(path); if (cached) return { min: [...cached.min], max: [...cached.max] };
  const bounds = computeBounds(path);
  if (immutablePath(path)) pathBounds.set(path, { min: [...bounds.min], max: [...bounds.max] });
  return bounds;
}
function computeBounds(path: ResolvedPath): { min: Vec3; max: Vec3 } {
  const points = path.anchors.map(copy);
  for (let index = 0; index < path.spans.length; index++) if (path.spans[index]!.kind === 'cubic') {
    const c = controlsOf(path, index);
    for (const axis of [0, 1, 2] as const) {
      const a = -c[0][axis] + 3 * c[1][axis] - 3 * c[2][axis] + c[3][axis];
      const b = 2 * (c[0][axis] - 2 * c[1][axis] + c[2][axis]); const d = c[1][axis] - c[0][axis];
      const scale = Math.max(1, Math.abs(a), Math.abs(b), Math.abs(d)); const epsilon = 32 * Number.EPSILON * scale;
      const roots: number[] = [];
      if (Math.abs(a) <= epsilon) { if (Math.abs(b) > epsilon) roots.push(-d / b); }
      else { const discriminant = b * b - 4 * a * d; if (discriminant >= 0 && Number.isFinite(discriminant)) { const q = -0.5 * (b + (b >= 0 ? 1 : -1) * Math.sqrt(discriminant)); roots.push(q / a); if (q !== 0) roots.push(d / q); } else if (!Number.isFinite(discriminant)) points.push(...c.map(copy)); }
      for (const t of roots) if (t > 0 && t < 1 && Number.isFinite(t)) points.push(pointAt(path, index, t));
    }
  }
  const min: Vec3 = [...points[0]!], max: Vec3 = [...points[0]!];
  for (const point of points) for (const axis of [0, 1, 2] as const) { min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]); }
  return { min, max };
}
function controlsBounds(controls: Controls): { min: Vec3; max: Vec3 } { return { min: [0, 1, 2].map(axis => Math.min(...controls.map(point => point[axis]!))) as Vec3, max: [0, 1, 2].map(axis => Math.max(...controls.map(point => point[axis]!))) as Vec3 }; }
function boxDistance(point: Vec3, controls: Controls): number { const box = controlsBounds(controls); return Math.hypot(Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]), Math.max(box.min[1] - point[1], 0, point[1] - box.max[1])); }
function refineProjection(path: ResolvedPath, point: Vec3, leaf: Pick<Leaf, 'spanIndex' | 't0' | 't1' | 'controls'>): { t: number; offsetM: number; stationary: boolean } {
  const a = leaf.controls[0], b = leaf.controls[3], length = distance(a, b), delta = subtract(b, a);
  let local = length ? clamp(((point[0] - a[0]) * (delta[0] / length) + (point[1] - a[1]) * (delta[1] / length)) / length, 0, 1) : 0.5;
  let t = leaf.t0 + local * (leaf.t1 - leaf.t0);
  for (let i = 0; i < 16; i++) {
    const value = subtract(pointAt(path, leaf.spanIndex, t), point), first = derivative(path, leaf.spanIndex, t), second = secondDerivative(path, leaf.spanIndex, t);
    const slope = value[0] * first[0] + value[1] * first[1], curvature = first[0] ** 2 + first[1] ** 2 + value[0] * second[0] + value[1] * second[1];
    if (!Number.isFinite(curvature) || curvature <= 0) break;
    const next = clamp(t - slope / curvature, leaf.t0, leaf.t1); if (Math.abs(next - t) < 1e-13) break; t = next;
  }
  const choices = [leaf.t0, t, leaf.t1].map(value => ({ t: value, offsetM: distance(pointAt(path, leaf.spanIndex, value), point) })).sort((x, y) => x.offsetM - y.offsetM);
  const best = choices[0]!; local = best.t;
  const value = subtract(pointAt(path, leaf.spanIndex, local), point), first = derivative(path, leaf.spanIndex, local);
  return { ...best, stationary: local === 0 || local === 1 || Math.abs(value[0] * first[0] + value[1] * first[1]) <= 1e-8 * Math.max(1, Math.hypot(value[0], value[1]) * Math.hypot(first[0], first[1])) };
}
export function projectToPath(path: ResolvedPath, point: Vec3, toleranceM = 0.001): PathProjection {
  if (!(toleranceM > 0) || !Number.isFinite(toleranceM) || !point.every(Number.isFinite)) throw new RangeError('PATH_PROJECTION_INPUT: finite point and positive tolerance required.');
  const prepared = prepare(path); let best = { spanIndex: 0, t: 0, offsetM: distance(path.anchors[0]!, point) };
  const minima: { spanIndex: number; t: number; offsetM: number }[] = [];
  let work = 0, unresolved = Infinity, converged = prepared.flat.converged;
  const stack = prepared.leaves.map(leaf => ({ ...leaf, depth: 0, lower: boxDistance(point, leaf.controls) }));
  for (const leaf of stack) {
    const candidate = refineProjection(path, point, leaf); if (candidate.offsetM < best.offsetM) best = { spanIndex: leaf.spanIndex, ...candidate };
    if (candidate.stationary) minima.push({ spanIndex: leaf.spanIndex, ...candidate });
  }
  while (stack.length) {
    const leaf = stack.pop()!;
    if (leaf.lower > best.offsetM + toleranceM) continue;
    if (best.offsetM - leaf.lower <= toleranceM || leaf.depth >= MAX_DEPTH || ++work > MAX_SEARCH_WORK) {
      unresolved = Math.min(unresolved, leaf.lower); if (best.offsetM - leaf.lower > toleranceM) converged = false; continue;
    }
    const [left, right] = divide(leaf.controls), middle = (leaf.t0 + leaf.t1) / 2;
    for (const child of [{ ...leaf, controls: left, t1: middle }, { ...leaf, controls: right, t0: middle }]) {
      const candidate = refineProjection(path, point, child); if (candidate.offsetM < best.offsetM) best = { spanIndex: leaf.spanIndex, ...candidate };
      if (candidate.stationary) minima.push({ spanIndex: leaf.spanIndex, ...candidate });
      stack.push({ ...child, depth: leaf.depth + 1, lower: boxDistance(point, child.controls) });
    }
  }
  const location = chainageAt(prepared, best.spanIndex, best.t);
  const ambiguous = minima.some(candidate => candidate.offsetM <= best.offsetM + toleranceM && Math.abs(chainageAt(prepared, candidate.spanIndex, candidate.t).sM - location.sM) > Math.max(8 * toleranceM, prepared.flat.length.lengthM * 1e-6));
  return { ...best, point: pointAt(path, best.spanIndex, best.t), sM: location.sM, errorM: Math.max(0, best.offsetM - Math.min(best.offsetM, unresolved)), ambiguous, converged };
}


export interface PathIntersection {
  a: { spanIndex: number; t: number; sM: number };
  b: { spanIndex: number; t: number; sM: number };
  point: Vec3; errorM: number;
}
export interface PathIntersections { intersections: PathIntersection[]; ambiguous: boolean; converged: boolean }
/** Candidate boxes and exact curve equations share the same span parameters; tangencies remain unresolved. */
export function intersectPaths(a: ResolvedPath, b: ResolvedPath, toleranceM = 0.001): PathIntersections {
  if (!(toleranceM > 0) || !Number.isFinite(toleranceM)) throw new RangeError('PATH_TOLERANCE: tolerance must be positive and finite.');
  const first = prepare(a, Math.min(PATH_FLATNESS_M, toleranceM)), second = prepare(b, Math.min(PATH_FLATNESS_M, toleranceM));
  const intersections: PathIntersection[] = []; let ambiguous = false, converged = first.flat.converged && second.flat.converged, work = 0;
  type Piece = Pick<Leaf, 'spanIndex' | 'kind' | 'controls' | 't0' | 't1'>;
  const overlaps = (x: Piece, y: Piece): boolean => { const p = controlsBounds(x.controls), q = controlsBounds(y.controls); const roundoff = 64 * Number.EPSILON * Math.max(1, ...p.min.map(Math.abs), ...p.max.map(Math.abs), ...q.min.map(Math.abs), ...q.max.map(Math.abs)); return [0, 1, 2].every(axis => p.min[axis]! <= q.max[axis]! + roundoff && q.min[axis]! <= p.max[axis]! + roundoff); };
  function record(x: Piece, y: Piece, t: number, u: number): void {
    const p = pointAt(a, x.spanIndex, t), q = pointAt(b, y.spanIndex, u), errorM = Math.hypot(...subtract(p, q));
    if (errorM > toleranceM) return;
    const av = { spanIndex: x.spanIndex, t, sM: chainageAt(first, x.spanIndex, t).sM }, bv = { spanIndex: y.spanIndex, t: u, sM: chainageAt(second, y.spanIndex, u).sM };
    if (intersections.some(hit => Math.abs(hit.a.sM - av.sM) <= toleranceM && Math.abs(hit.b.sM - bv.sM) <= toleranceM)) return;
    if (intersections.some(hit => distance(hit.point, p) <= toleranceM && (Math.abs(hit.a.sM - av.sM) > toleranceM || Math.abs(hit.b.sM - bv.sM) > toleranceM))) ambiguous = true;
    intersections.push({ a: av, b: bv, point: p, errorM });
  }
  function linearPair(x: Piece, y: Piece): boolean {
    if (x.kind !== 'line' || y.kind !== 'line') return false;
    const p = x.controls[0], q = y.controls[0], r = subtract(x.controls[3], p), s = subtract(y.controls[3], q), delta = subtract(q, p);
    const denominator = cross(r, s), scale = Math.hypot(r[0], r[1]) * Math.hypot(s[0], s[1]);
    if (Math.abs(denominator) > 64 * Number.EPSILON * scale) {
      const t = cross(delta, s) / denominator, u = cross(delta, r) / denominator;
      if (t >= -1e-12 && t <= 1 + 1e-12 && u >= -1e-12 && u <= 1 + 1e-12) record(x, y, x.t0 + clamp(t, 0, 1) * (x.t1 - x.t0), y.t0 + clamp(u, 0, 1) * (y.t1 - y.t0));
      return true;
    }
    const length = Math.hypot(r[0], r[1]);
    if (!length) return true;
    if (Math.abs(cross(delta, r)) / length > toleranceM) return true;
    const parameter = (point: Vec3): number => ((point[0] - p[0]) * (r[0] / length) + (point[1] - p[1]) * (r[1] / length)) / length;
    const ends = [parameter(q), parameter(y.controls[3])].sort((v, w) => v - w), left = Math.max(0, ends[0]!), right = Math.min(1, ends[1]!);
    if (right < left - toleranceM / length) return true;
    if ((right - left) * length > toleranceM) { ambiguous = true; return true; }
    const t = clamp((left + right) / 2, 0, 1), position = lerp(p, x.controls[3], t), otherLength = Math.hypot(s[0], s[1]);
    const u = otherLength ? clamp(((position[0] - q[0]) * (s[0] / otherLength) + (position[1] - q[1]) * (s[1] / otherLength)) / otherLength, 0, 1) : 0;
    record(x, y, x.t0 + t * (x.t1 - x.t0), y.t0 + u * (y.t1 - y.t0)); return true;
  }
  const orderedSecond = second.leaves.map(leaf => ({ leaf, box: controlsBounds(leaf.controls) })).sort((x, y) => x.box.min[0] - y.box.min[0]);
  let candidateChecks = 0;
  for (const rootA of first.leaves) {
    const box = controlsBounds(rootA.controls);
    for (const entry of orderedSecond) {
      if (entry.box.min[0] > box.max[0]) break;
      if (++candidateChecks > 2_000_000) { converged = false; break; }
      if (entry.box.max[0] < box.min[0]) continue;
      const rootB = entry.leaf;
      if (!overlaps(rootA, rootB)) continue;
    const stack = [{ x: rootA as Piece, y: rootB as Piece, depth: 0 }];
    while (stack.length) {
      const { x, y, depth } = stack.pop()!;
      if (!overlaps(x, y)) continue;
      if (++work > MAX_SEARCH_WORK) { converged = false; stack.length = 0; break; }
      if (linearPair(x, y)) continue;
      const p = x.controls[0], q = y.controls[0], r = subtract(x.controls[3], p), s = subtract(y.controls[3], q), delta = subtract(q, p), den = cross(r, s);
      let t = x.t0 + (den ? clamp(cross(delta, s) / den, 0, 1) : 0.5) * (x.t1 - x.t0);
      let u = y.t0 + (den ? clamp(cross(delta, r) / den, 0, 1) : 0.5) * (y.t1 - y.t0), transverse = true;
      for (let iteration = 0; iteration < 24; iteration++) {
        const value = subtract(pointAt(a, x.spanIndex, t), pointAt(b, y.spanIndex, u)), da = derivative(a, x.spanIndex, t), db = derivative(b, y.spanIndex, u), determinant = cross(da, db), scale = Math.hypot(da[0], da[1]) * Math.hypot(db[0], db[1]);
        if (!scale || Math.abs(determinant) <= 1e-7 * scale) { transverse = false; break; }
        if (Math.hypot(value[0], value[1]) <= Math.min(1e-8, toleranceM / 8)) break;
        const nextT = t - cross(value, db) / determinant, nextU = u - cross(value, da) / determinant;
        if (!Number.isFinite(nextT) || !Number.isFinite(nextU) || nextT < x.t0 - 1e-10 || nextT > x.t1 + 1e-10 || nextU < y.t0 - 1e-10 || nextU > y.t1 + 1e-10) break;
        if (Math.abs(t - nextT) + Math.abs(u - nextU) < 1e-14) break;
        t = clamp(nextT, x.t0, x.t1); u = clamp(nextU, y.t0, y.t1);
      }
      const residual = Math.hypot(...subtract(pointAt(a, x.spanIndex, t), pointAt(b, y.spanIndex, u)));
      if (transverse && residual <= Math.min(1e-7, toleranceM / 4)) { record(x, y, t, u); continue; }
      const boxA = controlsBounds(x.controls), boxB = controlsBounds(y.controls), extentA = Math.hypot(...subtract(boxA.max, boxA.min)), extentB = Math.hypot(...subtract(boxB.max, boxB.min));
      const shared = [x.t0, x.t1].flatMap(tx => [y.t0, y.t1].map(ty => ({ tx, ty, distance: Math.hypot(...subtract(pointAt(a, x.spanIndex, tx), pointAt(b, y.spanIndex, ty))) }))).find(value => value.distance <= 1e-9);
      if (Math.max(extentA, extentB) <= toleranceM || depth >= MAX_DEPTH) {
        if (shared && (shared.tx === 0 || shared.tx === 1) && (shared.ty === 0 || shared.ty === 1)) record(x, y, shared.tx, shared.ty);
        else ambiguous = true;
        if (depth >= MAX_DEPTH && Math.max(extentA, extentB) > toleranceM) converged = false;
        continue;
      }
      if (extentA >= extentB) { const [left, right] = divide(x.controls), middle = (x.t0 + x.t1) / 2; stack.push({ x: { ...x, controls: right, t0: middle }, y, depth: depth + 1 }, { x: { ...x, controls: left, t1: middle }, y, depth: depth + 1 }); }
      else { const [left, right] = divide(y.controls), middle = (y.t0 + y.t1) / 2; stack.push({ x, y: { ...y, controls: right, t0: middle }, depth: depth + 1 }, { x, y: { ...y, controls: left, t1: middle }, depth: depth + 1 }); }
    }
  }
  }
  return { intersections: intersections.sort((x, y) => x.a.sM - y.a.sM || x.b.sM - y.b.sM), ambiguous, converged };
}
