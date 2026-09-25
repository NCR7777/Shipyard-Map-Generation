import { useSyncExternalStore } from 'react';
import { downloadMap } from '../../adapters/files';
import { IndexedDBProjectStore } from '../../adapters/projectStore';
import { newMap } from '../../domain/factory';
import type { YardMap } from '../../domain/model';
import { DEFAULT_DRAWING_CONFIG, ProjectController, type EditorState, type EditorStateInput, type ProjectControllerState, type ProjectRecovery, type ProjectSummary } from '../../editor/projectController';
import { createSession, isDirty } from '../../editor/session';
import { DEFAULT_UNITS, notify, sceneOf, store, type AppState } from './store';

/** Projects and background images share this database; the old tool's `shipyard-map-projects` is never touched. */
export const projectStore = new IndexedDBProjectStore('shipyard-map-studio');
/** Owns what is stored and the confirmed baselines (kernel, as in ../map); this module decides when to save. */
export const projects = new ProjectController(projectStore);

const TAB_KEY = 'shipyard-map-studio:activeProject';
const AUTOSAVE_MS = 600;
const newId = (prefix: string) => prefix + '_' + crypto.randomUUID();
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

// The controller's state is a fresh object per read: cache it per change for React.
let snapshot: ProjectControllerState | null = null;
projects.subscribe(() => { snapshot = null; });
const readState = () => snapshot ??= projects.state;
export function useProjectState(): ProjectControllerState { return useSyncExternalStore(listener => projects.subscribe(listener), readState); }

/** Map and view settings as the project stores them. */
export function editorStateOf(state: Pick<AppState, 'session' | 'camera' | 'drawing' | 'units' | 'backgroundView'>): EditorStateInput | null {
  const map = state.session?.map; if (!map || !state.camera) return null;
  const { hidden, opacity, comparison } = state.backgroundView;
  return {
    camera: state.camera, drawing: state.drawing, propertyUnits: { mass: state.units.mass, speed: state.units.speed },
    backgrounds: { comparisonMode: comparison, layers: Object.fromEntries(Object.keys(map.backgroundLayers).map(id =>
      [id, { visible: !hidden.includes(id), opacity: opacity[id] ?? 1, locked: true }])) },
  };
}
/** The page state a stored view restores (defaults where the project has none). */
export function viewOf(view: EditorState | null, comparison: boolean): Pick<AppState, 'drawing' | 'units' | 'backgroundView'> {
  const layers = Object.entries(view?.backgrounds?.layers ?? {});
  return {
    drawing: view ? view.drawing : { ...DEFAULT_DRAWING_CONFIG },
    units: view?.propertyUnits ? { mass: view.propertyUnits.mass, speed: view.propertyUnits.speed } : DEFAULT_UNITS,
    backgroundView: {
      comparison: view?.backgrounds?.comparisonMode ?? comparison,
      hidden: layers.filter(([, layer]) => !layer.visible).map(([id]) => id),
      opacity: Object.fromEntries(layers.filter(([, layer]) => layer.opacity !== 1).map(([id, layer]) => [id, layer.opacity])),
    },
  };
}

// The last view written (or restored): nothing is written until it changes.
let savedView = '';
let rasterLoader: (map: YardMap) => Promise<void> = async () => {};
/** Background images load after a map is adopted; set by the backgrounds module (it depends on this one for its store). */
export function onAdopt(load: (map: YardMap) => Promise<void>): void { rasterLoader = load; }
/** Whether a local-file operation is running: switching projects meanwhile could hand its result to the wrong project. */
let fileBusy: () => boolean = () => false;
export function onFileBusy(check: () => boolean): void { fileBusy = check; }
const FILE_BUSY = '正在读写本地文件（也许在等待浏览器询问权限），稍候再切换。';
/** Told which project the page now shows (null: a map in memory only); the local-file link follows it. */
const projectListeners = new Set<(projectId: string | null) => void>();
export function onProjectChange(listener: (projectId: string | null) => void): void { projectListeners.add(listener); }

/** Shows a recovered, opened or new project: its map, camera and view settings. Undo history is not stored.
 *  Resolves when the map's stored background images are loaded. */
function adopt(recovery: ProjectRecovery, label?: string): Promise<void> {
  const name = projects.state.active?.name ?? recovery.map.metadata.name;
  store.set(({ mapEpoch, backgroundView }) => ({
    ...viewOf(recovery.editorState, backgroundView.comparison),
    session: createSession(recovery.map, true), fileName: label ?? name, selection: [], tool: 'select', entranceFor: null, mapEpoch: mapEpoch + 1,
    // A drawing tool of the previous map would skip this map's upgrade or read-only checks.
    frameRequest: recovery.editorState ? { camera: recovery.editorState.camera } : { keys: [] },
    camera: recovery.editorState?.camera ?? null, project: { phase: 'open', failure: null }, overlay: null, switching: false,
  }));
  savedView = recovery.editorState ? JSON.stringify(editorStateOf(store.get())) : '';
  try { sessionStorage.setItem(TAB_KEY, recovery.projectId); } catch { /* the last project is remembered in the database too */ }
  if (recovery.warnings.length) notify(recovery.warnings.map(issue => issue.message).join(' '), 'error');
  projectListeners.forEach(listener => listener(recovery.projectId));
  return rasterLoader(recovery.map);
}
/** Without browser storage: the map lives in this page only. */
function adoptInMemory(map: YardMap, label: string): Promise<void> {
  store.set(({ mapEpoch, backgroundView }) => ({
    ...viewOf(null, backgroundView.comparison),
    session: createSession(map, true), fileName: label, selection: [], tool: 'select', entranceFor: null, mapEpoch: mapEpoch + 1,
    frameRequest: { keys: [] }, project: { phase: 'memory', failure: null }, switching: false,
  }));
  projectListeners.forEach(listener => listener(null));
  return rasterLoader(map);
}

/** At page load: this tab's project, else the last one (or `chosen`, after a failed recovery); nothing is written before it is
 *  shown. A map opened while recovery runs replaces the recovered one right after (its continuation runs later). */
export async function startProjects(chosen?: string): Promise<void> {
  store.set({ project: { phase: 'starting', failure: null } });
  let preferred = chosen;
  if (!preferred) try { preferred = sessionStorage.getItem(TAB_KEY) ?? undefined; } catch { preferred = undefined; }
  try {
    const recovery = await projects.initialize(preferred);
    if (recovery) void adopt(recovery); else store.set({ project: { phase: 'none', failure: null } });
  } catch (error) { store.set({ project: { phase: 'failed', failure: message(error) } }); }
}
/** After a failed recovery the user may go on without browser storage (until the page is reloaded). */
export function continueInMemory(): void { store.set({ project: { phase: 'memory', failure: null } }); }

/** Edits made since the last stored draft. */
export function unsavedMap(state: Pick<AppState, 'session' | 'project'> = store.get(), project: ProjectControllerState = projects.state): boolean {
  const map = state.session?.map, active = project.active;
  if (!map) return false;
  if (state.project.phase !== 'open' || !active) return state.session!.past.length > 0 && isDirty(state.session!);
  return sceneOf(map).mapContentHash !== active.draftHash;
}
/** Automatic saving stops after a conflict or a storage failure until the user saves explicitly or reloads. */
const blocking = (state = projects.state) => !!state.error && state.error !== failedOpen && !['EDITOR_STATE_SAVE_FAILED', 'EDITOR_STATE_INVALID', 'PROJECT_AUX_SAVE_FAILED'].includes(state.error.code);
/** The controller records a failed attempt to open another project as its error; that error says nothing about the open one.
 *  Any later failure is a new error object and blocks as usual. */
let failedOpen: unknown = null;

// Plain timers: the module is also loaded by unit tests outside a browser.
let mapTimer: ReturnType<typeof setTimeout> | undefined, viewTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleMap(): void {
  clearTimeout(mapTimer);
  if (store.get().project.phase !== 'open' || !unsavedMap() || blocking() || projects.state.saving) return;
  mapTimer = setTimeout(() => { if (unsavedMap() && !blocking() && !projects.state.saving) void save('draft'); }, AUTOSAVE_MS);
}
function scheduleView(): void {
  clearTimeout(viewTimer);
  if (store.get().project.phase !== 'open' || !projects.state.active || projects.state.error?.code === 'PROJECT_CONFLICT') return;
  const input = editorStateOf(store.get()); if (!input || JSON.stringify(input) === savedView) return;
  viewTimer = setTimeout(() => {
    const now = editorStateOf(store.get()); if (!now) return;
    const key = JSON.stringify(now); if (key === savedView) return;
    savedView = key;
    projects.saveEditorState(now).catch(() => { savedView = ''; });
  }, AUTOSAVE_MS);
}

/** Saves the open map: `draft` automatically, `checkpoint` when the user saves. Resolves false (and says why) on failure. */
export async function save(kind: 'draft' | 'checkpoint'): Promise<boolean> {
  const state = store.get(), map = state.session?.map; if (!map) return false;
  if (state.project.phase !== 'open') {
    if (kind === 'checkpoint') notify(state.project.phase === 'memory' ? '当前地图只在本页内存中，没有浏览器工程；请用「导出副本」保存 JSON。' : '浏览器工程尚未就绪。', 'error');
    return false;
  }
  clearTimeout(mapTimer);
  try {
    await projects.save(map, kind);
    if (kind === 'checkpoint') notify('已保存到浏览器工程。');
    return true;
  } catch (error) {
    // Autosave failures show in the status bar; an explicit save also says so.
    if (kind === 'checkpoint') notify(`保存失败：${message(error)}`, 'error');
    return false;
  }
}
/** Writes what is not yet stored before the page leaves this project. Callers refuse edits first (`switching`), so one write
 *  normally suffices; a few more cover a save that was already queued. It never loops without end. */
async function flush(): Promise<boolean> {
  clearTimeout(mapTimer);
  for (let attempt = 0; store.get().project.phase === 'open' && unsavedMap(); attempt++) {
    if (attempt === 3 || blocking() || !(await save('draft'))) return false;
  }
  return true;
}
/** Runs a switch to another map with edits refused throughout, so nothing typed meanwhile can be left behind. */
async function switchingTo<T>(run: () => Promise<T>): Promise<T> {
  store.set({ switching: true });
  try { return await run(); } finally { if (store.get().switching) store.set({ switching: false }); }
}
/** In memory only, edits not exported would be lost: ask first (cancel, export a copy, or discard). */
let decide: ((choice: 'cancel' | 'export' | 'discard') => void) | null = null;
export function answerDiscard(choice: 'cancel' | 'export' | 'discard'): void { const resolve = decide; decide = null; store.set({ overlay: null }); resolve?.(choice); }
async function keepMemoryEdits(): Promise<boolean> {
  const state = store.get(), map = state.session?.map;
  if (state.project.phase === 'open' || !map || !unsavedMap()) return true;
  const choice = await new Promise<'cancel' | 'export' | 'discard'>(resolve => { decide = resolve; store.set({ overlay: 'discardMemory' }); });
  if (choice === 'export') notify(`已下载 ${downloadMap(map)}。`);
  return choice !== 'cancel';
}

/** Opens a map as a new browser project (or in memory, without storage). From the start of the switch edits are refused;
 *  the current map is written completely before it is replaced. */
export async function importMap(map: YardMap, label: string): Promise<boolean> {
  if (fileBusy()) { notify(FILE_BUSY, 'error'); return false; }
  if (!(await keepMemoryEdits())) return false;
  return switchingTo(async () => {
    if (!(await flush())) {
      notify('当前工程还有修改没能写入浏览器（见状态栏），没有打开新地图；请先处理保存状态或导出副本。', 'error');
      return false;
    }
    if (store.get().project.phase === 'memory') { notify(`已打开 ${label}（只在本页内存中）`); await adoptInMemory(map, label); return true; }
    let recovery: ProjectRecovery;
    try { recovery = await projects.create(newId('project'), map); }
    catch (error) {
      notify(`已打开 ${label}，但浏览器工程不可用（${message(error)}）；修改只保留在本页，可导出 JSON。`, 'error');
      await adoptInMemory(map, label); return true;
    }
    notify(`已打开 ${label}`);
    await adopt(recovery, label);
    return true;
  });
}
export async function createMap(name: string): Promise<boolean> { return importMap(newMap(newId('map'), name, '0.3.0'), name); }

/** The stored projects; the current map's pending save is written first, so a map just opened is listed too.
 *  After a failed recovery the list is read straight from the store, so other projects stay reachable. */
export async function listProjects(): Promise<ProjectSummary[]> {
  if (!projects.state.ready) return (await projectStore.list()).sort((a, b) => b.updatedAt - a.updatedAt || a.projectId.localeCompare(b.projectId));
  await flush(); return projects.list();
}
/** Switches to another stored project; the current one is written first, and a click on the current one keeps its history. */
export async function openProject(projectId: string): Promise<boolean> {
  if (projects.state.active?.projectId === projectId && store.get().project.phase === 'open') { store.set({ overlay: null }); return true; }
  // A recovery in progress would ignore another choice (the kernel reuses it): wait for it.
  if (store.get().project.phase === 'starting') { notify('正在恢复浏览器工程，请稍候再切换。'); return false; }
  if (fileBusy()) { notify(FILE_BUSY, 'error'); return false; }
  if (!(await keepMemoryEdits())) return false;
  // After a failed recovery: recover the chosen project instead, and make it the one new tabs open.
  if (!projects.state.ready) {
    await startProjects(projectId);
    if (store.get().project.phase !== 'open') { notify(`无法打开浏览器工程：${store.get().project.failure ?? ''}`, 'error'); return false; }
    projectStore.setLastProject(projectId).catch(() => {});
    return true;
  }
  return switchingTo(async () => {
    if (!(await flush())) { notify('当前工程还有修改没能写入浏览器（见状态栏），没有切换；请先处理保存状态。', 'error'); return false; }
    try { void adopt(await projects.open(projectId)); return true; }
    catch (error) {
      // The current project stays open and keeps saving; the failure belongs to the one that did not open.
      failedOpen = projects.state.error;
      // The controller already told its listeners; show the corrected status at once.
      store.set(({ project }) => ({ project: { ...project } }));
      notify(`无法打开浏览器工程：${message(error)}`, 'error'); return false;
    }
  });
}
/** Keeps a map (this page's, or a file's) as a separate recovery copy; the open project stays as it is. */
export async function keepCopy(map: YardMap, what: string): Promise<boolean> {
  try { const copy = await projects.backup(newId('project'), map); notify(`${what}已另存为「${copy.name}」。`); return true; }
  catch (error) { notify(`${what}未能另存（${message(error)}）。`, 'error'); return false; }
}
/** Shows another version of the open project's map (a file's, after the user chose it); saved as its next draft. */
export function replaceMap(map: YardMap): void {
  store.set(({ mapEpoch }) => ({ session: createSession(map, true), selection: [], tool: 'select', entranceFor: null, mapEpoch: mapEpoch + 1, frameRequest: { keys: [] } }));
  void rasterLoader(map);
}
/** The open browser project, if any. */
export const activeProjectId = () => store.get().project.phase === 'open' ? projects.state.active?.projectId ?? null : null;
/** Before an upgrade: the original map is kept as a separate recovery copy (a new map may have no checkpoint yet). */
export async function backupBeforeUpgrade(): Promise<boolean> {
  const state = store.get(), map = state.session?.map; if (!map || state.project.phase !== 'open') return true;
  try { const copy = await projects.backup(newId('project'), map, editorStateOf(state) ?? undefined); notify(`升级前的原图已另存为「${copy.name}」。`); return true; }
  catch (error) { notify(`没有升级：升级前的原图未能另存（${message(error)}）。`, 'error'); return false; }
}
/** After another tab saved this project: keep this page's map as a separate recovery copy. */
export async function backupCurrent(): Promise<void> {
  const state = store.get(), map = state.session?.map; if (!map) return;
  try {
    const copy = await projects.backup(newId('project'), map, editorStateOf(state) ?? undefined);
    notify(`已另存为「${copy.name}」，可在「浏览器工程」中打开。`);
  } catch (error) { notify(`另存恢复副本失败：${message(error)}`, 'error'); }
}
/** After another tab saved this project: drop this page's edits and show the stored version. */
export async function reloadStored(): Promise<void> {
  const id = projects.state.active?.projectId; if (!id) return;
  try { void adopt(await projects.open(id)); notify('已载入浏览器中保存的版本。'); }
  catch (error) { notify(`载入失败：${message(error)}`, 'error'); }
}
/** Another tab may have saved this project while this one was in the background. */
export function checkOtherTabs(): void {
  if (store.get().project.phase === 'open' && projects.state.ready && projects.state.active) projects.checkExternalVersion().catch(() => {});
}

/** One line for the status bar. */
export function saveStatus(state: Pick<AppState, 'session' | 'project'>, project: ProjectControllerState): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error' } | null {
  if (state.project.phase === 'starting') return { text: '正在恢复浏览器工程…', tone: 'busy' };
  if (state.project.phase === 'failed') return { text: '浏览器工程恢复失败', tone: 'error' };
  if (!state.session) return null;
  if (state.project.phase === 'memory') return { text: '只在本页内存中（未存入浏览器）', tone: 'warn' };
  if (project.error?.code === 'PROJECT_CONFLICT') return { text: '冲突：另一标签页已保存此工程', tone: 'error' };
  if (project.error && blocking(project)) return { text: '保存失败：' + project.error.message, tone: 'error' };
  if (project.saving) return { text: '保存中…', tone: 'busy' };
  if (unsavedMap(state, project)) return { text: '有修改待保存', tone: 'busy' };
  if (project.error && project.error !== failedOpen) return { text: '视图设置未保存（地图已保存）', tone: 'warn' };
  return project.active?.checkpointHash === sceneOf(state.session.map).mapContentHash ? { text: '已保存', tone: 'ok' } : { text: '已自动保存（草稿）', tone: 'ok' };
}

// Saving follows the map and the view settings; a conflict or failure stops it (see `blocking`).
let previous = store.get();
store.subscribe(() => {
  const next = store.get(), last = previous; previous = next;
  if (next.session !== last.session || next.project !== last.project) scheduleMap();
  if (next.session !== last.session || next.camera !== last.camera || next.drawing !== last.drawing || next.units !== last.units || next.backgroundView !== last.backgroundView) scheduleView();
});
// A finished save may leave newer edits behind; a cleared error lets saving resume.
projects.subscribe(() => { if (!projects.state.saving) scheduleMap(); });
