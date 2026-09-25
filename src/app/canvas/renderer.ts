import type { SceneKind, SceneSnapshot } from '../../adapters/contracts';
import type { Polygon, Vec2, Vec3 } from '../../domain/model';
import type { DrawingConfig } from '../../editor/projectController';
import { worldToScreen, type Camera } from '../../geometry/coordinates';
import type { BackgroundTransform } from '../../geometry/backgrounds';
import type { ResolvedPath } from '../../geometry/roadPath';
import type { BackgroundDraw } from '../state/backgrounds';
import type { AdjustFrame } from './backgroundAdjust';
import type { Handle } from './handles';
import type { Overlay } from './movePreview';
import { createTextMeasurer, layoutLabels, selectDisplay, type DisplayIndex, type DisplayView } from './display';
import { PALETTE } from './palette';

type Opacity = 'zoneFillOpacity' | 'facilityFillOpacity' | 'roadFillOpacity';
/** One draw call in world coordinates. Widths are metres or screen pixels; opacity is read from the settings at draw time. */
interface Batch { path: Path2D; fill?: string; stroke?: string; widthPx?: number; widthM?: number; dashPx?: number[]; opacity?: Opacity; alpha?: number }
export interface ScreenBox { x0: number; y0: number; x1: number; y1: number }
/** A background image being adjusted, in screen pixels: its frame and handles, measured points, and a label. */
export interface AdjustVisual { frame: AdjustFrame | null; measure: readonly Vec2[]; label: { at: Vec2; lines: string[] } | null }
/** What a drawing tool shows before anything is committed; all positions are world metres. */
export interface DraftVisual {
  /** Road draft: centreline, and a translucent band at the width new roads will get. */
  road?: { path: ResolvedPath; widthM: number } | undefined;
  /** Area draft: the boundary it would commit (null while incomplete), and the clicked outline so far. */
  area?: { polygon: Polygon | null; outline: Vec3[] } | undefined;
  /** Measurement polyline. */
  line?: Vec3[] | undefined;
  vertices: Vec3[];
  /** Where a click would connect (node or road centreline); coordinate snaps are not shown as connections. */
  snap?: { position: Vec3; kind: 'node' | 'road' } | null | undefined;
  /** New crossings the road would connect to (when that setting is on). */
  crossings?: Vec3[] | undefined;
  /** Readout lines shown next to this point. */
  label?: { at: Vec3; lines: string[] } | null | undefined;
}

function ring(path: Path2D, points: readonly Vec3[]): void {
  points.forEach((point, index) => index ? path.lineTo(point[0], point[1]) : path.moveTo(point[0], point[1]));
  path.closePath();
}
function polygonPath(path: Path2D, polygon: Polygon): void { ring(path, polygon.outer); polygon.holes.forEach(hole => ring(path, hole)); }
function roadPath(path: Path2D, resolved: ResolvedPath): void {
  const [first] = resolved.anchors; if (!first) return;
  path.moveTo(first[0], first[1]);
  resolved.spans.forEach((span, index) => {
    const next = resolved.anchors[index + 1]!;
    if (span.kind === 'cubic') path.bezierCurveTo(span.control1[0], span.control1[1], span.control2[0], span.control2[1], next[0], next[1]);
    else path.lineTo(next[0], next[1]);
  });
}
type Geometry = Map<string, { road?: SceneSnapshot['roads'][number]; polygons: Polygon[] }>;
const lookups = new WeakMap<SceneSnapshot, Geometry>();
/** key → drawable geometry, built once per scene. */
function lookup(scene: SceneSnapshot): Geometry {
  let map = lookups.get(scene);
  if (!map) {
    map = new Map(scene.items.map(item => [item.key, { polygons: item.polygons }]));
    for (const road of scene.roads) map.set('roads/' + road.id, { road, polygons: [] });
    lookups.set(scene, map);
  }
  return map;
}
/** The same lookup for a gesture overlay, which carries areas and roads in their own lists. */
function overlayLookup(overlay: Overlay): Geometry {
  const map: Geometry = new Map(overlay.items.map(item => [item.key, { polygons: item.polygons }]));
  for (const area of overlay.facilities) map.set('facilities/' + area.id, { polygons: [area.boundary] });
  for (const area of overlay.zones) map.set('zones/' + area.id, { polygons: [area.boundary] });
  for (const road of overlay.roads) map.set('roads/' + road.id, { road, polygons: [] });
  return map;
}

/** The only settings that change which paths exist. */
const pathSettings = (drawing: DrawingConfig) => JSON.stringify([drawing.hiddenTypes, drawing.showRoadBands, drawing.showRoadCenterlines]);

/** Static map paths, rebuilt only when the scene or a path setting changes. Small separate paths let Chrome reuse
 *  their tessellation while panning; one path per area also keeps overlapping same-colour areas from cancelling out. */
function buildBatches(scene: Overlay, drawing: DrawingConfig, skip: ReadonlySet<string> = new Set()): Batch[] {
  const hidden = new Set<SceneKind>(drawing.hiddenTypes), fills: Batch[] = [], outlines: Batch[] = [], batches: Batch[] = [];
  for (const kind of ['zones', 'facilities'] as const) if (!hidden.has(kind)) {
    const areas: readonly { id: string; boundary: Polygon; appearance?: { color: string; stroke: string } }[] = scene[kind];
    for (const area of areas) {
      if (skip.has(kind + '/' + area.id)) continue;
      const path = new Path2D(); polygonPath(path, area.boundary);
      fills.push({ path, fill: area.appearance?.color ?? PALETTE.areaFallback, opacity: kind === 'zones' ? 'zoneFillOpacity' : 'facilityFillOpacity' });
      outlines.push({ path, stroke: area.appearance?.stroke ?? PALETTE.areaStroke, widthPx: 1.2 });
    }
  }
  batches.push(...fills);
  if (!hidden.has('roads') && drawing.showRoadBands) {
    for (const road of scene.roads) if (road.widthM.state === 'known' && !skip.has('roads/' + road.id)) {
      const path = new Path2D(); roadPath(path, road.path);
      batches.push({ path, stroke: PALETTE.roadBand, widthM: road.widthM.value, opacity: 'roadFillOpacity' });
    }
  }
  batches.push(...outlines);
  for (const kind of ['slots', 'junctions'] as const) if (!hidden.has(kind)) {
    const path = new Path2D(); scene.items.filter(item => item.kind === kind && !skip.has(item.key)).forEach(item => item.polygons.forEach(polygon => polygonPath(path, polygon)));
    batches.push({ path, stroke: PALETTE.detailStroke, widthPx: 1 });
  }
  if (!hidden.has('siteBoundary')) {
    const path = new Path2D(); scene.items.filter(item => item.kind === 'siteBoundary').forEach(item => item.polygons.forEach(polygon => polygonPath(path, polygon)));
    batches.push({ path, stroke: PALETTE.siteBoundary, widthPx: 1.5, dashPx: [8, 5] });
  }
  if (!hidden.has('roads') && drawing.showRoadCenterlines) {
    const known = new Path2D(), unknown = new Path2D();
    for (const road of scene.roads) if (!skip.has('roads/' + road.id)) roadPath(road.widthM.state === 'known' ? known : unknown, road.path);
    batches.push({ path: known, stroke: PALETTE.centerline, widthPx: 1.4 }, { path: unknown, stroke: PALETTE.centerlineUnknown, widthPx: 1.4, dashPx: [6, 4] });
  }
  return batches;
}

/** Imagery comparison fades fills further, as in ../map: road bands to a quarter, areas to 24/53. */
const COMPARISON: Record<Opacity, number> = { roadFillOpacity: 0.25, facilityFillOpacity: 24 / 53, zoneFillOpacity: 24 / 53 };

function drawBatches(ctx: CanvasRenderingContext2D, batches: readonly Batch[], scale: number, drawing: DrawingConfig, comparison = false): void {
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const batch of batches) {
    ctx.globalAlpha = batch.opacity ? drawing[batch.opacity] * (comparison ? COMPARISON[batch.opacity] : 1) : batch.alpha ?? 1;
    if (batch.fill) { ctx.fillStyle = batch.fill; ctx.fill(batch.path, 'evenodd'); continue; }
    if (!batch.stroke) continue;
    ctx.strokeStyle = batch.stroke;
    ctx.lineWidth = batch.widthM ?? (batch.widthPx ?? 1) / scale;
    ctx.setLineDash((batch.dashPx ?? []).map(value => value / scale));
    ctx.stroke(batch.path);
  }
  ctx.globalAlpha = 1; ctx.setLineDash([]);
}

/** Entrances and work points sharing a node form one marker; coincident coordinates alone never merge them. */
export function associatedPointGroups(scene: Pick<SceneSnapshot, 'accessPoints' | 'servicePoints'>, hiddenTypes: readonly SceneKind[] = [], visibleKeys?: ReadonlySet<string>) {
  const points = [...scene.accessPoints.map(point => ({ ...point, entityType: 'accessPoints' as const })), ...scene.servicePoints.map(point => ({ ...point, entityType: 'servicePoints' as const }))];
  const groups = new Map<string, typeof points>();
  for (const point of points) {
    if (hiddenTypes.includes(point.entityType)) continue;
    const group = groups.get(point.nodeId); if (group) group.push(point); else groups.set(point.nodeId, [point]);
  }
  return [...groups.values()].filter(group => !visibleKeys || group.some(point => visibleKeys.has(point.entityType + '/' + point.id)));
}

const sprites = new Map<string, HTMLCanvasElement>();
/** A dot pre-rendered at device resolution; blitting it is far cheaper than re-tessellating many circles every frame. */
function drawDot(ctx: CanvasRenderingContext2D, p: readonly number[], fill: string, stroke: string, radius: number, ratio: number): void {
  const size = Math.ceil((radius + 1.5) * 2), key = [fill, stroke, radius, ratio].join('|');
  let sprite = sprites.get(key);
  if (!sprite) {
    sprite = document.createElement('canvas'); sprite.width = sprite.height = Math.ceil(size * ratio);
    const dot = sprite.getContext('2d')!; dot.scale(ratio, ratio);
    dot.beginPath(); dot.arc(size / 2, size / 2, radius, 0, Math.PI * 2);
    dot.fillStyle = fill; dot.fill(); dot.lineWidth = 1.5; dot.strokeStyle = stroke; dot.stroke();
    sprites.set(key, sprite);
  }
  ctx.drawImage(sprite, Math.round(p[0]! - size / 2), Math.round(p[1]! - size / 2), size, size);
}
/** Below this scale (px/m) the whole yard is in view: points become dots and point/node labels wait for zoom. */
const OVERVIEW_SCALE = 1, POINT_LABEL_SCALE = 2;

export interface RenderState {
  scene: SceneSnapshot; index: DisplayIndex; drawing: DrawingConfig; selection: ReadonlySet<string>; hover: string | null;
  backgrounds: readonly BackgroundDraw[]; comparison: boolean;
}

/** One canvas, one pass per frame: grid and overlays in screen pixels, map geometry under the world transform. */
export class MapRenderer {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly measurer = createTextMeasurer();
  private width = 0;
  private height = 0;
  private ratio = 1;
  private frame = 0;
  private camera: Camera = { offsetX: 0, offsetY: 0, scale: 1 };
  private navigating = false;
  private state: RenderState | null = null;
  private batchKey = '';
  private batches: Batch[] = [];
  private highlight: Batch[] = [];
  /** Gesture preview: objects hidden from the static layer and redrawn from the overlay each frame. */
  private overlay: { hidden: ReadonlySet<string>; scene: Overlay; batches: Batch[] } | null = null;
  private box: ScreenBox | null = null;
  private draft: DraftVisual | null = null;
  /** Handles of the one selected object, recomputed per frame from the camera (the width handle keeps a screen offset). */
  private handles: ((camera: Camera) => Handle[]) | null = null;
  /** The background image being adjusted: drawn where a drag has it (until the committed transform arrives) and its frame. */
  private backgroundPreview: { id: string; transform: BackgroundTransform } | null = null;
  private adjust: ((camera: Camera) => AdjustVisual) | null = null;
  /** What is shown for the current state, camera and size. Computed on demand, by the next frame or by a hit test,
   *  whichever comes first: a click right after a map opens (before its first frame) still hits what is there. */
  private view: DisplayView | null = null;
  private viewStale = true;
  private viewFor: { camera: Camera; width: number; height: number; navigating: boolean } | null = null;
  /** The view computed at gesture start (with half-screen overscan) is reused until the camera settles. */
  private viewDuringGesture = false;

  constructor(container: HTMLDivElement, width: number, height: number) {
    this.context = this.canvas.getContext('2d', { alpha: false })!;
    container.append(this.canvas);
    this.resize(width, height);
  }
  destroy(): void { cancelAnimationFrame(this.frame); this.canvas.remove(); this.measurer.clear(); }
  get size() { return { width: this.width, height: this.height }; }
  /** Keys shown for the current state and camera; clicks may only hit what the user can see. */
  get visibleKeys(): ReadonlySet<string> { return this.currentView()?.keys ?? new Set(); }
  private currentView(): DisplayView | null {
    const state = this.state; if (!state) return null;
    const { width, height } = this.size, camera = this.camera, at = this.viewFor;
    // Settling re-applies the same camera with navigating off: that view (no overscan, full detail) is computed again.
    const current = !!this.view && !this.viewStale && at?.camera === camera && at.width === width && at.height === height && at.navigating === this.navigating;
    // During a pan or zoom the view computed at its start (with half-screen overscan) is kept until the camera settles.
    const kept = !!this.view && !this.viewStale && this.navigating && this.viewDuringGesture;
    if (!current && !kept) {
      const focusKey = state.selection.size === 1 ? [...state.selection][0] : undefined;
      this.view = selectDisplay(state.index, { camera, width, height, hiddenTypes: state.drawing.hiddenTypes, navigating: this.navigating,
        // A hovered node shows even when plain nodes are hidden: a road's end then shows what a press would drag.
        showOrdinaryNodes: state.drawing.showOrdinaryNodes, keepKeys: state.hover?.startsWith('nodes/') ? new Set([...state.selection, state.hover]) : state.selection,
        ...(focusKey ? { focusKey } : {}) });
      this.viewFor = { camera, width, height, navigating: this.navigating }; this.viewDuringGesture = this.navigating; this.viewStale = false;
    }
    return this.view;
  }

  resize(width: number, height: number): void {
    this.ratio = window.devicePixelRatio || 1;
    this.width = width; this.height = height;
    this.canvas.width = Math.max(1, Math.round(width * this.ratio)); this.canvas.height = Math.max(1, Math.round(height * this.ratio));
    this.canvas.style.width = width + 'px'; this.canvas.style.height = height + 'px';
    this.redraw();
  }

  setState(next: RenderState): void {
    const previous = this.state, key = pathSettings(next.drawing); this.state = next; this.viewStale = true;
    // A preview belongs to the scene it was planned on; the committed scene replaces it without a frame of the old one.
    if (previous && previous.scene !== next.scene) this.overlay = null;
    if (!previous || previous.scene !== next.scene || key !== this.batchKey) {
      this.batches = buildBatches(next.scene, next.drawing, this.overlay?.hidden); this.batchKey = key;
      if (previous?.scene !== next.scene) this.measurer.clear();
    }
    if (this.overlay) this.overlay.batches = buildBatches(this.overlay.scene, next.drawing);
    if (!previous || previous.scene !== next.scene || previous.selection !== next.selection || previous.hover !== next.hover) this.highlight = this.buildHighlight(next);
    this.redraw();
  }
  /** Shows a gesture preview (or ends it with null). The static layer is rebuilt only when the hidden set changes. */
  setOverlay(hidden: ReadonlySet<string>, scene: Overlay): void;
  setOverlay(clear: null): void;
  setOverlay(hidden: ReadonlySet<string> | null, scene?: Overlay): void {
    const state = this.state, before = this.overlay?.hidden;
    if (!state) return;
    this.overlay = hidden && scene ? { hidden, scene, batches: buildBatches(scene, state.drawing) } : null;
    if (before !== (this.overlay?.hidden)) this.batches = buildBatches(state.scene, state.drawing, this.overlay?.hidden);
    this.highlight = this.buildHighlight(state);
    this.viewStale = true;
    this.redraw();
  }
  setCamera(camera: Camera, navigating: boolean): void { this.camera = camera; this.navigating = navigating; this.redraw(); }
  setBox(box: ScreenBox | null): void { this.box = box; this.redraw(); }
  setDraft(draft: DraftVisual | null): void { this.draft = draft; this.redraw(); }
  setHandles(handles: ((camera: Camera) => Handle[]) | null): void { this.handles = handles; this.redraw(); }
  setBackgroundPreview(preview: { id: string; transform: BackgroundTransform } | null): void { this.backgroundPreview = preview; this.redraw(); }
  setAdjust(adjust: ((camera: Camera) => AdjustVisual) | null): void { this.adjust = adjust; this.redraw(); }

  /** Coalesces any number of changes into one draw per animation frame. */
  private redraw(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }
  private draw(): void {
    // A window moved to a screen with another pixel ratio keeps its size but needs a new backing store.
    if ((window.devicePixelRatio || 1) !== this.ratio) this.resize(this.width, this.height);
    const ctx = this.context, ratio = this.ratio, { offsetX, offsetY, scale } = this.camera;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = PALETTE.background; ctx.fillRect(0, 0, this.width, this.height);
    if (!this.state) return;
    const world = () => ctx.setTransform(ratio * scale, 0, 0, -ratio * scale, ratio * offsetX, ratio * offsetY);
    // Images map pixels (x right, y down) to world metres through imageToWorld, under the world transform.
    for (const image of this.state.backgrounds) {
      // Device pixels per image pixel; the smallest level still at or above one pixel per device pixel is drawn over the full image rect.
      const t = this.backgroundPreview?.id === image.id ? this.backgroundPreview.transform : image.transform, full = image.levels[0]!, perPixel = ratio * scale * Math.sqrt(Math.abs(t[0] * t[3] - t[1] * t[2]));
      const level = image.levels[Math.max(0, Math.min(image.levels.length - 1, Math.floor(-Math.log2(perPixel))))]!;
      world(); ctx.globalAlpha = image.opacity; ctx.transform(...t); ctx.drawImage(level, 0, 0, full.width, full.height);
    }
    ctx.globalAlpha = 1; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawGrid(ctx, this.state.backgrounds.length ? 0.3 : 1);
    world();
    drawBatches(ctx, this.batches, scale, this.state.drawing, this.state.comparison);
    if (this.overlay) drawBatches(ctx, this.overlay.batches, scale, this.state.drawing, this.state.comparison);
    drawBatches(ctx, this.highlight, scale, this.state.drawing);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    this.drawScreen(ctx);
  }

  /** Grid step in metres: 1, 2 or 5 × 10ⁿ with at least ~70 px between lines. */
  static gridStep(scale: number): number {
    const raw = 70 / scale, power = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map(factor => factor * power).find(step => step >= raw)!;
  }
  private drawGrid(ctx: CanvasRenderingContext2D, alpha: number): void {
    const { width, height } = this.size, { offsetX, offsetY, scale } = this.camera;
    if (!this.state || !Number.isFinite(scale) || scale <= 0) return;
    const step = MapRenderer.gridStep(scale), x0 = Math.floor(-offsetX / scale / step) * step, y0 = Math.floor((offsetY - height) / scale / step) * step;
    const minor = new Path2D(), major = new Path2D(), labels: [string, number, number][] = [];
    for (let x = x0; offsetX + x * scale <= width; x += step) {
      const sx = Math.round(offsetX + x * scale) + 0.5, isMajor = Math.round(x / step) % 5 === 0, path = isMajor ? major : minor;
      path.moveTo(sx, 0); path.lineTo(sx, height);
      if (isMajor) labels.push([String(Number(x.toPrecision(12))), sx + 3, height - 6]);
    }
    for (let y = y0; offsetY - y * scale >= 0; y += step) {
      const sy = Math.round(offsetY - y * scale) + 0.5, isMajor = Math.round(y / step) % 5 === 0, path = isMajor ? major : minor;
      path.moveTo(0, sy); path.lineTo(width, sy);
      if (isMajor) labels.push([String(Number(y.toPrecision(12))), 4, sy - 3]);
    }
    ctx.save(); ctx.lineWidth = 1; ctx.globalAlpha = alpha;
    ctx.strokeStyle = PALETTE.gridMinor; ctx.stroke(minor); ctx.strokeStyle = PALETTE.gridMajor; ctx.stroke(major);
    ctx.font = '10px Inter, "Segoe UI", sans-serif'; ctx.fillStyle = PALETTE.gridText;
    for (const [text, x, y] of labels) ctx.fillText(text, x, y);
    ctx.restore();
  }

  /** Colours as in ../map: brown rectangle corners and vertices (purple on holes), green insert and width, yellow anchors, blue tangents. */
  private drawHandles(ctx: CanvasRenderingContext2D, handles: readonly Handle[]): void {
    const screen = (point: Vec3) => worldToScreen(point, this.camera);
    ctx.save(); ctx.lineWidth = 1.5;
    for (const handle of handles) {
      if (handle.kind !== 'control' && handle.kind !== 'width') continue;
      const [x, y] = screen(handle.at), [ax, ay] = screen(handle.kind === 'control' ? handle.anchor : handle.edge);
      ctx.strokeStyle = handle.kind === 'control' ? '#3b82f6' : '#2e9a5a'; ctx.setLineDash(handle.kind === 'width' ? [3, 3] : []);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(x, y); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const handle of handles) {
      const [x, y] = screen(handle.at);
      ctx.beginPath();
      if (handle.kind === 'corner') { ctx.rect(x - 5, y - 5, 10, 10); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#8a5a2b'; }
      else if (handle.kind === 'vertex') { ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.strokeStyle = handle.ring ? '#7c3aed' : '#8a5a2b'; }
      else if (handle.kind === 'insert') { ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fillStyle = '#dff3e6'; ctx.strokeStyle = '#2e9a5a'; }
      else if (handle.kind === 'anchor') { ctx.rect(x - 4.5, y - 4.5, 9, 9); ctx.fillStyle = '#facc15'; ctx.strokeStyle = '#7a5b00'; }
      else if (handle.kind === 'end') { ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#7a5b00'; }
      else if (handle.kind === 'control') { ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#3b82f6'; }
      else if (handle.kind === 'bend') { ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fillStyle = '#fff7ed'; ctx.strokeStyle = '#e2791b'; }
      else { ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#2e9a5a'; }
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }

  /** Drafts are drawn in screen space from world points, above everything committed. */
  private drawDraft(ctx: CanvasRenderingContext2D, draft: DraftVisual): void {
    const camera = this.camera, screen = (point: Vec3) => worldToScreen(point, camera);
    ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const stroke = (points: readonly Vec3[], close = false) => {
      ctx.beginPath(); points.forEach((point, index) => { const [x, y] = screen(point); if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); if (close) ctx.closePath();
    };
    if (draft.road) {
      const path = new Path2D(); roadPath(path, draft.road.path);
      ctx.save(); ctx.setTransform(this.ratio * camera.scale, 0, 0, -this.ratio * camera.scale, this.ratio * camera.offsetX, this.ratio * camera.offsetY);
      ctx.globalAlpha = 0.28; ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = draft.road.widthM; ctx.stroke(path);
      ctx.globalAlpha = 1; ctx.lineWidth = 2 / camera.scale; ctx.stroke(path);
      ctx.restore();
    }
    if (draft.area) {
      if (draft.area.polygon) {
        stroke(draft.area.polygon.outer, true); ctx.fillStyle = 'rgba(15,124,134,0.14)'; ctx.fill();
        ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2; ctx.stroke();
      } else if (draft.area.outline.length > 1) {
        stroke(draft.area.outline); ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    if (draft.line && draft.line.length > 1) { stroke(draft.line); ctx.strokeStyle = PALETTE.selection; ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = '#fff'; ctx.strokeStyle = PALETTE.accent; ctx.lineWidth = 1.5;
    for (const point of draft.vertices) { const [x, y] = screen(point); ctx.fillRect(x - 3.5, y - 3.5, 7, 7); ctx.strokeRect(x - 3.5, y - 3.5, 7, 7); }
    ctx.strokeStyle = '#2e9a5a'; ctx.lineWidth = 2;
    for (const point of draft.crossings ?? []) { const [x, y] = screen(point); ctx.beginPath(); ctx.moveTo(x - 5, y); ctx.lineTo(x + 5, y); ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 5); ctx.stroke(); }
    if (draft.snap) {
      // A green ring marks an explicit connection: the click joins that node, or splits that road there.
      const [x, y] = screen(draft.snap.position); ctx.strokeStyle = '#2e9a5a'; ctx.lineWidth = 2.5;
      ctx.beginPath(); if (draft.snap.kind === 'node') ctx.arc(x, y, 8, 0, Math.PI * 2); else { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); }
      ctx.stroke();
    }
    if (draft.label?.lines.length) this.drawLabel(ctx, screen(draft.label.at), draft.label.lines);
    ctx.restore();
  }
  /** A dark tag beside a screen point, kept inside the canvas. */
  private drawLabel(ctx: CanvasRenderingContext2D, [x, y]: Vec2, lines: readonly string[]): void {
    ctx.save(); ctx.font = '500 11px Inter, "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    const width = Math.max(...lines.map(line => ctx.measureText(line).width)) + 12, height = lines.length * 15 + 6;
    const left = Math.min(x + 14, this.width - width - 4), top = Math.min(y + 14, this.height - height - 4);
    ctx.fillStyle = 'rgba(31,52,64,0.88)'; ctx.beginPath(); ctx.roundRect(left, top, width, height, 4); ctx.fill();
    ctx.fillStyle = '#fff'; lines.forEach((line, index) => ctx.fillText(line, left + 6, top + 4 + index * 15));
    ctx.restore();
  }
  /** The adjusted image's outline, corner squares and rotation handle; measured points joined by a dashed line. */
  private drawAdjust(ctx: CanvasRenderingContext2D, visual: AdjustVisual): void {
    ctx.save(); ctx.lineWidth = 1.5;
    const frame = visual.frame;
    if (frame) {
      ctx.strokeStyle = PALETTE.accent; ctx.beginPath();
      frame.corners.forEach(([x, y], index) => { if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(...frame.topMiddle); ctx.lineTo(...frame.rotate); ctx.stroke();
      ctx.fillStyle = '#fff';
      for (const [x, y] of frame.corners) { ctx.fillRect(x - 5, y - 5, 10, 10); ctx.strokeRect(x - 5, y - 5, 10, 10); }
      ctx.beginPath(); ctx.arc(frame.rotate[0], frame.rotate[1], 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    if (visual.measure.length) {
      ctx.strokeStyle = PALETTE.selection; ctx.lineWidth = 2;
      if (visual.measure.length > 1) { ctx.setLineDash([8, 4]); ctx.beginPath(); visual.measure.forEach(([x, y], index) => { if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke(); ctx.setLineDash([]); }
      for (const [x, y] of visual.measure) { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke(); }
    }
    ctx.restore();
    if (visual.label?.lines.length) this.drawLabel(ctx, visual.label.at, visual.label.lines);
  }

  private buildHighlight(state: RenderState): Batch[] {
    const out: Batch[] = [], geometry = lookup(state.scene), moved = this.overlay ? overlayLookup(this.overlay.scene) : null;
    const add = (keys: Iterable<string>, color: string, widthPx: number, alpha: number) => {
      const area = new Path2D(), line = new Path2D(); let hasArea = false, hasLine = false;
      for (const key of keys) {
        // Selected objects under a move preview are highlighted where they are being dragged to.
        const found = (this.overlay?.hidden.has(key) ? moved?.get(key) : undefined) ?? geometry.get(key); if (!found) continue;
        if (found.road) { roadPath(line, found.road.path); hasLine = true; }
        for (const polygon of found.polygons) { polygonPath(area, polygon); hasArea = true; }
      }
      if (hasArea) out.push({ path: area, fill: color, alpha }, { path: area, stroke: color, widthPx });
      if (hasLine) out.push({ path: line, stroke: color, widthPx: widthPx + 2, alpha: 0.9 });
    };
    if (state.hover && !state.selection.has(state.hover)) add([state.hover], PALETTE.hover, 1.5, 0.08);
    add(state.selection, PALETTE.selection, 2.5, 0.14);
    return out;
  }

  private drawScreen(ctx: CanvasRenderingContext2D): void {
    const state = this.state; if (!state) return;
    const { width, height } = this.size, camera = this.camera, hidden = new Set<SceneKind>(state.drawing.hiddenTypes);
    const focusKey = state.selection.size === 1 ? [...state.selection][0] : undefined;
    const view = this.currentView()!, ratio = this.ratio, hiddenKeys = this.overlay?.hidden;
    // Objects under a preview are drawn from the overlay below, not at their committed place.
    const visible = hiddenKeys?.size ? new Set([...view.keys].filter(key => !hiddenKeys.has(key))) : view.keys;
    const onScreen = (p: readonly number[]) => p[0]! > -20 && p[1]! > -20 && p[0]! < width + 20 && p[1]! < height + 20;
    ctx.save();
    // One-way arrows at road midpoints where the road is long enough on screen.
    if (!hidden.has('roads')) {
      ctx.fillStyle = PALETTE.centerline;
      for (const road of state.scene.roads) {
        if ((road.direction !== 'forward' && road.direction !== 'backward') || road.lengthM * camera.scale < 60 || !visible.has('roads/' + road.id)) continue;
        const middle = Math.floor((road.points.length - 1) / 2), a = road.points[middle], b = road.points[middle + 1]; if (!a || !b) continue;
        const pa = worldToScreen(a, camera), pb = worldToScreen(b, camera), mx = (pa[0] + pb[0]) / 2, my = (pa[1] + pb[1]) / 2;
        if (!onScreen([mx, my])) continue;
        const angle = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) + (road.direction === 'backward' ? Math.PI : 0);
        ctx.save(); ctx.translate(mx, my); ctx.rotate(angle); ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4.5); ctx.lineTo(-4, 4.5); ctx.closePath(); ctx.fill(); ctx.restore();
      }
    }
    const overlayNodes = new Set(this.overlay?.scene.nodes);
    for (const node of [...state.scene.nodes, ...overlayNodes]) {
      // Overlay nodes show only where their committed node was shown (hidden types, ordinary-node setting, view).
      const key = 'nodes/' + node.id; if (overlayNodes.has(node) ? !view.keys.has(key) : !visible.has(key)) continue;
      const p = worldToScreen(node.position, camera); if (!onScreen(p)) continue;
      if (state.selection.has(key) || state.hover === key) drawDot(ctx, p, PALETTE.selection, PALETTE.selectionDark, 5, ratio);
      else drawDot(ctx, p, '#fff', PALETTE.node, 3.5, ratio);
    }
    const overview = camera.scale < OVERVIEW_SCALE;
    ctx.font = '600 10px Inter, "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const overlayGroups = this.overlay ? associatedPointGroups(this.overlay.scene, state.drawing.hiddenTypes, view.keys) : [];
    for (const group of [...associatedPointGroups(state.scene, state.drawing.hiddenTypes, visible), ...overlayGroups]) {
      const p = worldToScreen(group[0]!.position, camera); if (!onScreen(p)) continue;
      const keys = group.map(point => point.entityType + '/' + point.id), selected = keys.some(key => state.selection.has(key) || state.hover === key);
      const service = group.some(point => point.entityType === 'servicePoints'), access = group.some(point => point.entityType === 'accessPoints');
      const color = selected ? PALETTE.selection : service ? PALETTE.service : PALETTE.access;
      if (overview && !selected) { drawDot(ctx, p, color, '#fff', 2.5, ratio); continue; }
      const text = access && service ? '入作' : service ? '作' : '入', w = text.length > 1 ? 24 : 16;
      ctx.fillStyle = color; ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.roundRect(p[0] - w / 2, p[1] - 8, w, 16, service ? 8 : 3); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText(text, p[0], p[1] + 0.5);
    }
    const labelView = { ...view, candidates: view.candidates.filter(entry => !hiddenKeys?.has(entry.key) && (camera.scale >= POINT_LABEL_SCALE || entry.key === focusKey
      || (entry.kind !== 'accessPoints' && entry.kind !== 'servicePoints' && entry.kind !== 'nodes'))) };
    const labels = layoutLabels(labelView, { camera, width, height, mode: state.drawing.labelMode, navigating: this.navigating, ...(focusKey ? { focusKey } : {}) }, this.measurer);
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const label of labels.labels) {
      ctx.font = `${label.key === focusKey ? 600 : 500} ${label.fontSize}px Inter, "Segoe UI", "Microsoft YaHei", sans-serif`;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.92)'; ctx.strokeText(label.text, label.x + 1, label.y + 1.5);
      ctx.fillStyle = label.key === focusKey ? PALETTE.selectionDark : PALETTE.label; ctx.fillText(label.text, label.x + 1, label.y + 1.5);
    }
    if (this.handles) this.drawHandles(ctx, this.handles(this.camera));
    if (this.draft) this.drawDraft(ctx, this.draft);
    if (this.adjust) this.drawAdjust(ctx, this.adjust(this.camera));
    if (this.box) {
      const { x0, y0, x1, y1 } = this.box, crossing = x1 < x0;
      ctx.fillStyle = crossing ? 'rgba(46,160,90,0.08)' : 'rgba(15,124,134,0.08)'; ctx.strokeStyle = crossing ? '#2e9a5a' : PALETTE.accent;
      ctx.lineWidth = 1; ctx.setLineDash(crossing ? [5, 3] : []);
      ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.strokeRect(Math.min(x0, x1) + 0.5, Math.min(y0, y1) + 0.5, Math.abs(x1 - x0), Math.abs(y1 - y0));
    }
    ctx.restore();
  }
}
