import type { SceneKind, SceneSnapshot } from '../../adapters/contracts';
import type { PhysicalValue, Polygon, Vec3 } from '../../domain/model';
import type { LabelMode } from '../../editor/projectController';
import { screenToWorld, worldToScreen, type Camera } from '../../geometry/coordinates';
import { geometryBounds, roadWidthBounds } from '../../geometry/roads';
import { polygonHasArea } from '../../geometry/relations';

export interface ScreenRect { x: number; y: number; width: number; height: number }
type Bounds = NonNullable<ReturnType<typeof geometryBounds>>;
export interface DisplayGeometry { points?: Vec3[]; lines?: Vec3[][]; polygons?: Polygon[] }
export interface DisplayEntry {
  key: string; kind: SceneKind; id: string;
  bounds: Bounds | null; anchor: Vec3 | null; polygon?: Polygon;
  nodeId?: string; ordinary?: boolean; adjacentM?: number;
  roadWidth?: PhysicalValue;
  offset?: Vec3;
}
export interface DisplayIndex {
  entries: DisplayEntry[];
}
export interface DisplayOptions {
  camera: Camera; width: number; height: number;
  hiddenTypes?: readonly SceneKind[]; focusKey?: string; keepKeys?: ReadonlySet<string>;
  showDetails?: boolean; navigating?: boolean; showOrdinaryNodes?: boolean; editingNodes?: boolean;
  offsets?: ReadonlyMap<string, Vec3>;
  geometryOverrides?: ReadonlyMap<string, DisplayGeometry>;
}
export interface DisplayView {
  keys: ReadonlySet<string>; candidates: DisplayEntry[];
  culledCount: number; lodCount: number; unprojectableCount: number;
}
const geometryKinds = new Set<SceneKind>(['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'siteBoundary', 'junctions', 'slots', 'resources', 'movements']);
const center = (bounds: Bounds): Vec3 => [bounds.min[0] / 2 + bounds.max[0] / 2, bounds.min[1] / 2 + bounds.max[1] / 2, bounds.min[2] / 2 + bounds.max[2] / 2];
function geometry(geometry: DisplayGeometry): Pick<DisplayEntry, 'bounds' | 'anchor' | 'polygon'> {
  const bounds = geometryBounds([...(geometry.points ?? []), ...(geometry.lines ?? []).flat(), ...(geometry.polygons ?? []).flatMap(p => [p.outer, ...p.holes].flat())]);
  const polygon = geometry.polygons?.[0];
  return { bounds, anchor: bounds ? center(bounds) : null, ...(polygon ? { polygon } : {}) };
}

/** Renderer-owned and disposable. Keep only the current immutable scene's index. */
export function createDisplayIndex(scene: SceneSnapshot): DisplayIndex {
  const nodes = new Map(scene.nodes.map(node => [node.id, node]));
  const roads = new Map(scene.roads.map(road => [road.id, road]));
  const points = new Map([...scene.accessPoints.map(point => ['accessPoints/' + point.id, point.nodeId] as const), ...scene.servicePoints.map(point => ['servicePoints/' + point.id, point.nodeId] as const)]);
  const adjacent = new Map<string, number>();
  for (const road of scene.roads) {
    for (const [id, a, b] of [[road.fromNodeId, road.points[0], road.points[1]], [road.toNodeId, road.points.at(-1), road.points.at(-2)]] as const) {
      if (a && b) adjacent.set(id, Math.min(adjacent.get(id) ?? Infinity, Math.hypot(a[0] - b[0], a[1] - b[1])));
    }
  }
  const entries = scene.items.filter(item => geometryKinds.has(item.kind)).map((item): DisplayEntry => {
    const road = item.kind === 'roads' ? roads.get(item.id) : undefined;
    const node = item.kind === 'nodes' ? nodes.get(item.id) : undefined;
    return { key: item.key, kind: item.kind, id: item.id,
      ...geometry(road ? { lines: [road.points] } : item),
      ...(road ? { bounds: roadWidthBounds(road.points, road.widthM).bounds, roadWidth: road.widthM } : {}),
      ...(node ? { nodeId: item.id, ordinary: node.kind === 'ordinary', adjacentM: adjacent.get(item.id) } : {}),
      ...(points.has(item.key) ? { nodeId: points.get(item.key) } : {}),
    };
  });
  return { entries };
}
function translated(point: Vec3, offset?: Vec3): Vec3 {
  return offset ? [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]] : point;
}
function screenBounds(entry: DisplayEntry, camera: Camera): ScreenRect | null {
  if (!entry.bounds) return null;
  const [x, bottom] = worldToScreen(translated(entry.bounds.min, entry.offset), camera);
  const [right, y] = worldToScreen(translated(entry.bounds.max, entry.offset), camera);
  return [x, y, right, bottom, right - x, bottom - y].every(Number.isFinite) ? { x, y, width: right - x, height: bottom - y } : null;
}
function intersects(a: ScreenRect, b: ScreenRect, gap = 0): boolean {
  return a.x < b.x + b.width + gap && a.x + a.width + gap > b.x && a.y < b.y + b.height + gap && a.y + a.height + gap > b.y;
}
const priority = (entry: DisplayEntry, focusKey?: string): number => entry.key === focusKey ? 0
  : entry.kind === 'facilities' || entry.kind === 'zones' ? 1 : entry.kind === 'servicePoints' ? 2
    : entry.kind === 'accessPoints' ? 3 : entry.kind === 'roads' ? 4 : 5;
const compare = (a: DisplayEntry, b: DisplayEntry, focusKey?: string) => priority(a, focusKey) - priority(b, focusKey) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/** Linear AABB query precedes vertex projection. No display subset leaves the renderer. */
export function selectDisplay(index: DisplayIndex, options: DisplayOptions): DisplayView {
  const viewport = { x: -120, y: -120, width: options.width + 240, height: options.height + 240 };
  const hidden = new Set(options.hiddenTypes);
  let culledCount = 0, lodCount = 0, unprojectableCount = 0;
  const visible: DisplayEntry[] = [];
  for (const original of index.entries) {
    if (hidden.has(original.kind)) continue;
    if ((original.kind === 'resources' || original.kind === 'movements') && original.key !== options.focusKey) continue;
    const override = options.geometryOverrides?.get(original.key), offset = options.offsets?.get(original.key);
    const entry = override || offset ? { ...original, ...(override ? geometry(override) : {}), ...(offset ? { offset } : {}) } : original;
    if (override && entry.roadWidth) entry.bounds = roadWidthBounds([...(override.points ?? []), ...(override.lines ?? []).flat()], entry.roadWidth).bounds;
    if (!entry.bounds) continue;
    const keep = entry.key === options.focusKey || options.keepKeys?.has(entry.key) || (entry.kind === 'nodes' && options.editingNodes);
    const box = screenBounds(entry, options.camera);
    if (!box) unprojectableCount++; // Preserve uncertain candidates for the existing projection warning.
    if (!keep && box && !intersects(box, viewport, 1)) { culledCount++; continue; }
    if (!keep && entry.kind === 'nodes' && entry.ordinary && (options.showOrdinaryNodes === false
      || (!options.showDetails && (options.navigating || (entry.adjacentM ?? Infinity) * options.camera.scale < 24)))) { lodCount++; continue; }
    if (!keep && (entry.kind === 'slots' || entry.kind === 'junctions') && !options.showDetails
      && (options.navigating || (box && Math.min(box.width, box.height) < 10))) { lodCount++; continue; }
    visible.push(entry);
  }
  // Only genuinely shared node IDs compete. Independent nearby objects retain their hit targets.
  const representatives = new Map<string, DisplayEntry>();
  for (const entry of visible) if (entry.nodeId) {
    const old = representatives.get(entry.nodeId);
    if (!old || compare(entry, old, options.focusKey) < 0) representatives.set(entry.nodeId, entry);
  }
  const candidates = visible.filter(entry => !entry.nodeId || representatives.get(entry.nodeId) === entry
    || options.keepKeys?.has(entry.key) || (entry.kind === 'nodes' && options.editingNodes));
  lodCount += visible.length - candidates.length;
  return { keys: new Set(candidates.map(entry => entry.key)), candidates, culledCount, lodCount, unprojectableCount };
}

export interface TextMeasurer {
  measure(text: string, font: string): number;
  clear(): void;
  readonly size: number;
  readonly measurements: number;
}
/** One canvas and a bounded FIFO cache; caller clears it on scene/font change and disposal. */
export function createTextMeasurer(measureText?: (text: string, font: string) => number): TextMeasurer {
  let context: CanvasRenderingContext2D | null = null, measurements = 0;
  const cache = new Map<string, number>();
  return {
    measure(text, font) {
      const key = font + '\n' + text;
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      let width: number;
      if (measureText) width = measureText(text, font);
      else {
        context ??= document.createElement('canvas').getContext('2d');
        if (!context) return Infinity;
        context.font = font; width = context.measureText(text).width;
      }
      measurements++;
      if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
      cache.set(key, width); return width;
    },
    clear() { cache.clear(); },
    get size() { return cache.size; },
    get measurements() { return measurements; },
  };
}
export interface DisplayLabel extends ScreenRect { key: string; text: string; fontSize: number; fill: string }
export interface LabelOptions {
  camera: Camera; width: number; height: number; mode: LabelMode; focusKey?: string;
  navigating?: boolean; reserved?: readonly ScreenRect[];
}
export interface LabelLayout {
  labels: DisplayLabel[]; candidateCount: number; measurementCount: number; geometryWork: number;
}
/** Short IDs are display strings only. Full names/IDs remain in the existing details panel. */
function labelText(entry: DisplayEntry): string {
  const id = entry.kind === 'slots' ? entry.id.split(':').at(-1)! : entry.id;
  return id.length <= 20 ? id : id.slice(0, 17) + '…';
}
function internalBox(rect: ScreenRect, entry: DisplayEntry, camera: Camera, work: (amount?: number) => void): boolean {
  if (!entry.polygon) return true;
  const points = [[rect.x, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height], [rect.x + rect.width, rect.y], [rect.x, rect.y]] as const;
  const outer = points.map(point => {
    const world = screenToWorld([...point], camera);
    return entry.offset ? [world[0] - entry.offset[0], world[1] - entry.offset[1], world[2]] as Vec3 : world;
  }) as Polygon['outer'];
  if (outer.some(point => !point.every(Number.isFinite))) return false;
  // Charge linear scans too: polygonHasArea's budget callback primarily counts edge work.
  work(entry.polygon.outer.length + entry.polygon.holes.reduce((sum, ring) => sum + ring.length, 0));
  return !polygonHasArea({ outer, holes: [] }, entry.polygon, 'outside', work);
}

/** Bounded cross-type layout. Navigation never runs ordinary-label placement. */
export function layoutLabels(view: DisplayView, options: LabelOptions, measurer: TextMeasurer): LabelLayout {
  const labels: DisplayLabel[] = [], beforeMeasurements = measurer.measurements;
  const result = { labels, candidateCount: 0, measurementCount: 0, geometryWork: 0 };
  if (options.mode === 'off') return result;
  const debug = options.mode === 'debug_all', budget = Math.max(1, Math.min(200, Math.round(options.width * options.height / 800_000 * 80)));
  const viewport = { x: 0, y: 0, width: options.width, height: options.height };
  const ordered = view.candidates.filter(entry => entry.anchor && (entry.key === options.focusKey
    || (!options.navigating && options.mode !== 'focus'))).filter(entry => {
      const box = screenBounds(entry, options.camera);
      if (!box || !intersects(box, viewport, 1)) return false;
      if (debug || entry.key === options.focusKey) return true;
      if (entry.kind === 'siteBoundary' || entry.kind === 'resources' || entry.kind === 'movements') return false;
      if (entry.polygon) return Math.min(box.width, box.height) >= 18 && box.width * box.height >= 1200;
      if (entry.kind === 'nodes') return (entry.adjacentM ?? Infinity) * options.camera.scale >= 55;
      if (entry.kind === 'roads') return Math.max(box.width, box.height) >= 140;
      return true;
    }).sort((a, b) => compare(a, b, options.focusKey));
  const seenNodes = new Set<string>();
  const candidates = ordered.filter(entry => {
    if (!entry.nodeId) return true;
    if (seenNodes.has(entry.nodeId)) return false;
    seenNodes.add(entry.nodeId); return true;
  }).slice(0, debug ? undefined : budget * 4);
  result.candidateCount = candidates.length;
  const exceeded = new Error('display geometry budget');
  const work = (amount = 1) => {
    if (amount > 100_000 - result.geometryWork) { result.geometryWork = 100_000; throw exceeded; }
    result.geometryWork += amount;
  };
  const occupied = [...options.reserved ?? []];
  for (const entry of candidates) {
    if (!debug && labels.length >= budget) break;
    if (entry.polygon && result.geometryWork >= 100_000) continue;
    const text = labelText(entry), fontSize = entry.key === options.focusKey ? 12 : 11;
    const width = Math.ceil(measurer.measure(text, `${fontSize}px Arial`)) + 2, height = fontSize + 3;
    const [x, y] = worldToScreen(translated(entry.anchor!, entry.offset), options.camera);
    if (![x, y, width].every(Number.isFinite)) continue;
    const positions = entry.polygon ? [[x - width / 2, y - height / 2], [x - width / 2, y - height - 4], [x - width - 4, y - height / 2], [x + 4, y - height / 2]]
      : [[x + 12, y - height - 4], [x + 12, y + 4], [x - width - 12, y - height - 4], [x - width - 12, y + 4]];
    for (const [left, top] of positions) {
      const rect = { x: left!, y: top!, width, height };
      if (rect.x < 4 || rect.y < 4 || rect.x + width > options.width - 4 || rect.y + height > options.height - 4) continue;
      if (!debug && occupied.some(other => intersects(rect, other, 4))) continue;
      try { if (!internalBox(rect, entry, options.camera, work)) continue; }
      catch (error) { if (error !== exceeded) throw error; break; }
      labels.push({ ...rect, key: entry.key, text, fontSize, fill: entry.key === options.focusKey ? '#9a4c0d' : '#355266' });
      occupied.push(rect); break;
    }
  }
  result.measurementCount = measurer.measurements - beforeMeasurements;
  return result;
}
