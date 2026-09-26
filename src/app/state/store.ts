import { useSyncExternalStore } from 'react';
import type { SceneItem, SceneKind, SceneSnapshot } from '../../adapters/contracts';
import { toSceneSnapshot } from '../../compiler/scene';
import { loadMap } from '../../domain/load';
import type { Issue, ServicePoint, Vec2, Vec3, YardMap } from '../../domain/model';
import { DEFAULT_DRAWING_CONFIG, type DrawingConfig } from '../../editor/projectController';
import type { EditorSession } from '../../editor/session';
import type { Camera } from '../../geometry/coordinates';
import { validateMap } from '../../validation/validate';
import { createDisplayIndex, type DisplayIndex } from '../canvas/display';
import type { Raster } from './backgrounds';

export type Tool = 'select' | 'pan' | 'node' | 'road' | 'curve' | 'building' | 'zone' | 'measure' | 'entrance' | 'service';
export type ShapeKind = 'rect2' | 'rect3' | 'polygon';
export type LeftTab = 'objects' | 'layers';
export type RightTab = 'properties' | 'relations' | 'sources';
export interface Message { text: string; tone: 'info' | 'error' }
/** Frame these keys (none = whole map), a world box, centre a point at the current zoom, or restore a saved camera. */
export type FrameRequest = { keys: readonly string[] } | { point: Vec3 } | { bounds: { min: Vec3; max: Vec3 } } | { camera: Camera };
/** Where the page stands with browser storage. `memory`: edits stay in this page only (storage failed, or the user chose so). */
export type ProjectPhase = 'starting' | 'none' | 'open' | 'memory' | 'failed';

export interface AppState {
  session: EditorSession | null;
  fileName: string;
  /** Scene keys (`kind/id`) in selection order. */
  selection: readonly string[];
  tool: Tool;
  drawing: DrawingConfig;
  panels: { left: boolean; right: boolean; drawer: boolean };
  leftTab: LeftTab;
  rightTab: RightTab;
  overlay: null | 'palette' | 'help' | 'mapChoice' | 'delete' | 'rotate' | 'upgrade' | 'projects' | 'newMap' | 'reloadProject' | 'discardMemory' | 'confirmLink';
  /** The drawing tool waiting for the map to be upgraded to 0.3.0. */
  upgradeFor: Tool | null;
  /** Shape each area tool draws. */
  shapes: { building: ShapeKind; zone: ShapeKind };
  /** Candidate maps when a package or selection holds more than one. */
  mapChoice: readonly { label: string; detail: string; open: () => void }[] | null;
  message: Message | null;
  /** Settled camera scale in px/m, for display only; the canvas owns the live camera. */
  scale: number;
  /** Each new request object moves the camera once. */
  frameRequest: FrameRequest | null;
  /** Decoded background images by SHA-256. */
  rasters: Readonly<Record<string, Raster>>;
  /** Display preferences per background layer; not part of the map. */
  backgroundView: { hidden: readonly string[]; opacity: Readonly<Record<string, number>>; comparison: boolean };
  /** Counts opened maps: drafts, gestures and tools belong to one map, whatever its change token. */
  mapEpoch: number;
  /** How a selected rectangular outline is edited: keep it a rectangle, or move its vertices freely. */
  boundaryMode: 'rect' | 'free';
  /** Display units for masses and speeds; values are stored in kg and m/s whatever is shown. Saved with the project's view. */
  units: DisplayUnits;
  /** The browser project behind the open map (P4a); its save state is read from the project controller. */
  project: { phase: ProjectPhase; failure: string | null };
  /** The camera once it settles (not while panning or zooming), saved with the project's view. */
  camera: Camera | null;
  /** Another map is replacing this one: its edits are all stored, and new ones are refused until the switch ends. */
  switching: boolean;
  /** The background image being adjusted: only it can move, and only while this is set. `measure`: the image pixels
   *  picked so far for setting its scale from a known length (null: not measuring). */
  adjusting: Adjusting | null;
  /** Object-directory groups the user opened, for the map of `epoch` (a new map starts with all folded). */
  objectGroups: { epoch: number; open: readonly SceneKind[] };
  /** The entrance tool places entrances on this building only (started from the building's inspector); null: any building. */
  entranceFor: string | null;
  /** The kind of service point the service point tool places, the in-site transfer assumption it declares for one placed
   *  on an entrance (a node proxy must state one), how one inside a building is reached, and its internal route's width
   *  (8 m: the real maps' routes are 8 or 6 m wide, narrower than a new public road). */
  serviceKind: ServicePoint['kind'];
  serviceTransfer: 'included_in_service_duration' | 'excluded_from_model';
  serviceInside: 'internal' | 'draft';
  routeWidthM: number;
}
export interface Adjusting { id: string; epoch: number; keepAspect: boolean; measure: readonly Vec2[] | null }
export interface DisplayUnits { mass: 't' | 'kg'; speed: 'km/h' | 'm/s' }
export const DEFAULT_UNITS: DisplayUnits = { mass: 't', speed: 'km/h' };
export function setUnits(patch: Partial<DisplayUnits>): void { store.set(({ units }) => ({ units: { ...units, ...patch } })); }

const initial: AppState = {
  session: null, fileName: '', selection: [], tool: 'select', drawing: { ...DEFAULT_DRAWING_CONFIG },
  panels: { left: true, right: true, drawer: false }, leftTab: 'objects', rightTab: 'properties',
  overlay: null, upgradeFor: null, shapes: { building: 'rect2', zone: 'polygon' }, mapChoice: null, message: null, scale: 1, frameRequest: null,
  rasters: {}, backgroundView: { hidden: [], opacity: {}, comparison: false }, mapEpoch: 0, boundaryMode: 'rect', units: DEFAULT_UNITS,
  project: { phase: 'starting', failure: null }, camera: null, switching: false, adjusting: null, objectGroups: { epoch: 0, open: [] }, entranceFor: null, serviceKind: 'loading', serviceTransfer: 'included_in_service_duration', serviceInside: 'internal', routeWidthM: 8,
};

let state = initial;
const listeners = new Set<() => void>();
export const store = {
  get: (): AppState => state,
  set(patch: Partial<AppState> | ((current: AppState) => Partial<AppState>)): void {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
    listeners.forEach(listener => listener());
  },
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
/** The selector must return a stored value or a cached derivation, never a fresh object. */
export function useApp<T>(selector: (current: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

// Derived views are pure functions of the frozen map, cached by its identity.
function memo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const cache = new WeakMap<K, V>();
  return key => { let value = cache.get(key); if (value === undefined) { value = compute(key); cache.set(key, value); } return value; };
}
export const sceneOf = memo((map: YardMap): SceneSnapshot => toSceneSnapshot(map));
export const displayIndexOf = memo((scene: SceneSnapshot): DisplayIndex => createDisplayIndex(scene));
export const issuesOf = memo((map: YardMap): readonly Issue[] => validateMap(map).issues);
const itemIndex = memo((scene: SceneSnapshot): ReadonlyMap<string, SceneItem> => new Map(scene.items.map(item => [item.key, item])));
export const itemOf = (scene: SceneSnapshot, key: string): SceneItem | undefined => itemIndex(scene).get(key);

export function notify(text: string, tone: Message['tone'] = 'info'): void { store.set({ message: { text, tone } }); }
export function frame(keys: readonly string[] = []): void { store.set({ frameRequest: { keys } }); }
export function framePoint(point: Vec3): void { store.set({ frameRequest: { point } }); }
export function frameBounds(bounds: { min: Vec3; max: Vec3 }): void { store.set({ frameRequest: { bounds } }); }

/** The map in the text if it passes the shared import pipeline; otherwise says why and gives null. */
export function parseMapText(text: string, fileName: string): YardMap | null {
  const loaded = loadMap(text);
  if (loaded.ok) return loaded.map;
  const first = loaded.report.issues.find(issue => issue.severity === 'error') ?? loaded.report.issues[0];
  notify(`无法打开 ${fileName}：${first ? first.message : '地图未通过校验。'}`, 'error');
  return null;
}

export function select(keys: readonly string[], mode: 'replace' | 'toggle' | 'add' = 'replace'): void {
  store.set(({ selection }) => {
    if (mode === 'replace') return { selection: [...new Set(keys)] };
    const next = new Set(selection);
    for (const key of keys) {
      if (mode === 'toggle' && next.has(key)) next.delete(key); else next.add(key);
    }
    return { selection: [...next] };
  });
}

export function setDrawing(patch: Partial<DrawingConfig>): void { store.set(({ drawing }) => ({ drawing: { ...drawing, ...patch } })); }

export function toggleType(list: 'hiddenTypes' | 'lockedTypes', kind: SceneKind): void {
  const current = store.get().drawing[list];
  setDrawing({ [list]: current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind] });
}
