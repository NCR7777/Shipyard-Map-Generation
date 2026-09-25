import { useSyncExternalStore } from 'react';
import { downloadMap } from '../../adapters/files';
import { LocalFileController, type LocalConflict, type LocalFileSnapshot } from '../../adapters/localFiles';
import { sameValue } from '../../domain/value';
import type { YardMap } from '../../domain/model';
import { activeProjectId, importMap, keepCopy, onFileBusy, onProjectChange, replaceMap, save } from './project';
import { notify, sceneOf, store } from './store';

/**
 * A browser project may be linked to a map JSON on disk: Save then also writes that file, and a change made to the file
 * elsewhere is noticed (by the hash of its bytes) instead of being overwritten.
 *
 * The file handle is kept in memory only. In an off-the-record (incognito-like) browser context, Chrome 153 crashes the whole
 * browser when a file handle stored in IndexedDB is read back — Playwright's default contexts are such, which is why ../map's
 * reload tests fail; normal profiles read handles back fine. A page cannot reliably tell which it runs in, and a crash there
 * loses every incognito tab, so handles are never stored. After a reload the project remembers the file's name and hashes;
 * one pick of the same file links it again.
 *
 * Every file operation belongs to the project that started it: switching projects is refused while one runs, and a late
 * result for a project no longer shown changes nothing.
 */
export const files = new LocalFileController();

const LINKS_KEY = 'shipyard-map-studio:links';
/** What a project remembers of its file across reloads: never the handle. */
interface LinkRecord { name: string; rawHash: string; contentHash: string }
function readLinks(): Record<string, LinkRecord> {
  try { return JSON.parse(localStorage.getItem(LINKS_KEY) ?? '{}') as Record<string, LinkRecord>; } catch { return {}; }
}
function writeLink(projectId: string, link: LinkRecord | null): void {
  const links = readLinks();
  if (link) links[projectId] = link; else delete links[projectId];
  try { localStorage.setItem(LINKS_KEY, JSON.stringify(links)); } catch { /* the link still holds for this page */ }
}

/** The link as the page shows it. `remembered`: known from an earlier page, to be picked again before it can be written. */
export interface LocalLink { name: string; remembered: boolean }
interface State { link: LocalLink | null; conflict: LocalConflict | null; busy: boolean }
let state: State = { link: null, conflict: null, busy: false };
const listeners = new Set<() => void>();
function set(patch: Partial<State>): void { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
export function useLocalFile(): State { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => state); }
export const localState = () => state;
const snapshot = (): LocalFileSnapshot => files.snapshot();

// The kernel refuses to reset while it works; the reset then waits for the operation to end.
let resetPending = false;
/** Counts link changes (another project shown, or the link dropped for an upgrade): a result of an operation started
 *  before such a change must not bring the old link back. */
let generation = 0;
interface Op { owner: string | null; generation: number }
onFileBusy(() => state.busy || snapshot().busy);
/** Another project, or a map in memory: the link (and any conflict) belongs to the one shown now. */
onProjectChange(projectId => {
  generation++;
  if (!files.reset()) resetPending = true;
  const remembered = projectId ? readLinks()[projectId] : undefined;
  set({ link: remembered ? { name: remembered.name, remembered: true } : null, conflict: null });
});
/** Runs one file operation for the project shown now. `run` gets that project's ID to check against later. */
async function fileOp<T>(run: (op: Op) => Promise<T>): Promise<T> {
  set({ busy: true });
  try { return await run({ owner: activeProjectId(), generation }); }
  finally {
    set({ busy: false });
    if (resetPending && !snapshot().busy) { resetPending = false; files.reset(); }
  }
}
const current = (op: Op) => op.owner !== null && op.owner === activeProjectId() && op.generation === generation;

const supported = () => files.capabilities();
/** After a successful write or link: remember it for that project and show it, if that project and link are still current. */
function linked(op: Op): void {
  if (!current(op)) return;
  const now = snapshot();
  if (now.linkedName && now.confirmedRawHash && now.confirmedContentHash) writeLink(op.owner!, { name: now.linkedName, rawHash: now.confirmedRawHash, contentHash: now.confirmedContentHash });
  set({ link: now.linkedName ? { name: now.linkedName, remembered: false } : null, conflict: null });
}

/** Opens a map JSON through the browser's file picker as a new project linked to that file. */
export async function openLinked(): Promise<void> {
  if (!supported().open) { notify('这个浏览器不能直接读写本地文件；请用「打开地图…」导入，用「导出副本」保存。', 'error'); return; }
  const picked = await files.open();
  if (picked.status !== 'opened') { if (picked.status !== 'cancelled') notify(picked.message, 'error'); return; }
  // The new project resets the controller: carry the accepted handle across the import (in memory only).
  const previous = files.exportBinding(), accepted = files.acceptOpen(picked.token), binding = files.exportBinding();
  if (accepted.status !== 'linked' || !binding) { notify(accepted.status === 'linked' ? '未能关联原文件。' : accepted.message, 'error'); return; }
  if (!(await importMap(picked.loaded.map, picked.name))) {
    // Still the old project: its own link, if any, is back; the file just picked is not linked to it.
    if (previous) files.restoreBinding(previous); else files.reset();
    return;
  }
  // Without a browser project the map lives in this page only: it is not linked (Save would not write it anyway).
  const owner = activeProjectId();
  if (!owner) { notify(`已打开 ${picked.name}（只在本页内存中），没有关联原文件。`); return; }
  const restored = files.restoreBinding(binding);
  if (restored.status !== 'linked') { notify(`地图已打开，但未能关联原文件：${restored.message}`, 'error'); return; }
  linked({ owner, generation });
  notify(`已打开并关联 ${picked.name}：保存（Ctrl+S）会同时写回这个文件。`);
}

/** Asks before linking a file whose map differs from this one (the next Save would write this map over it). */
let decide: ((link: boolean) => void) | null = null;
export function answerLink(link: boolean): void { const resolve = decide; decide = null; store.set({ overlay: null }); resolve?.(link); }
export const pendingLinkName = () => pendingName;
let pendingName = '';

/** Links the open project to a file on disk: the same file again after a reload, or the map's original file.
 *  The file must be this map (same map ID and coordinate frame). Its bytes decide what happens:
 *  - what was last written or read (after a reload), or the same map content: linked, nothing is written;
 *  - anything else: after a confirmation, the file's version is kept as a recovery copy, then linked; the next Save writes
 *    this map over it. */
export async function linkFile(): Promise<void> {
  const map = store.get().session?.map;
  if (!map || !activeProjectId()) { notify('请先打开浏览器工程。', 'error'); return; }
  if (!supported().open) { notify('这个浏览器不能直接读写本地文件；请用「导出副本」保存 JSON。', 'error'); return; }
  const picked = await files.open();
  if (picked.status !== 'opened') { if (picked.status !== 'cancelled') notify(picked.message, 'error'); return; }
  const file = picked.loaded.map;
  if (file.mapId !== map.mapId || !sameValue(file.coordinateFrame, map.coordinateFrame)) {
    files.cancelOpen(picked.token);
    notify(`${picked.name} 不是这张地图（地图编号或坐标框架不同），没有关联；可用「文件另存为」保存到新文件。`, 'error');
    return;
  }
  const remembered = readLinks()[activeProjectId()!];
  const known = remembered?.rawHash === picked.rawHash || picked.loaded.contentHash === sceneOf(map).mapContentHash;
  if (!known) {
    pendingName = picked.name;
    const confirmed = await new Promise<boolean>(resolve => { decide = resolve; store.set({ overlay: 'confirmLink' }); });
    if (!confirmed) { files.cancelOpen(picked.token); return; }
  }
  await fileOp(async op => {
    if (!known && !(await keepCopy(file, `${picked.name} 中的版本`))) { files.cancelOpen(picked.token); return; }
    if (!current(op)) { files.cancelOpen(picked.token); return; }
    const result = files.acceptOpen(picked.token);
    if (result.status !== 'linked') { notify(result.message, 'error'); return; }
    linked(op);
    notify(known ? `已关联 ${picked.name}。` : `已关联 ${picked.name}；文件中的版本已另存为恢复副本，下次保存会用当前地图覆盖它。`);
  });
}

/** Save: the browser checkpoint first, then the linked file. A file changed elsewhere is never overwritten silently.
 *  With a linked file the whole save is one file operation: switching projects waits for it, including while the browser
 *  asks for write access. */
export async function saveAll(): Promise<void> {
  const map = store.get().session?.map; if (!map) return;
  if (!snapshot().linkedName || state.link?.remembered) {
    if (!(await save('checkpoint'))) return;
    if (state.link?.remembered) notify(`已保存到浏览器；原文件 ${state.link.name} 需要重新选择一次才能写回（「文件 › 关联原文件…」）。`);
    return;
  }
  // Ask for write access within the key press itself (awaiting the checkpoint first would spend the gesture). The write
  // waits for that answer, so its own request is answered at once, without a second prompt.
  const permission = files.exportBinding()?.handle.requestPermission?.({ mode: 'readwrite' }).catch(() => 'denied');
  await fileOp(async op => {
    if (!(await save('checkpoint'))) return;
    await permission;
    if (current(op)) await writeWith(map, op);
  });
}
/** Writes the linked file within a file operation `op`, and shows the result if its project and link are still current. */
async function writeWith(map: YardMap, op: Op, overwriteToken?: number): Promise<boolean> {
  const result = await files.write(map, overwriteToken);
  if (!current(op)) return false;
  if (result.status === 'saved') { linked(op); notify(`已保存并写回 ${result.name}。`); return true; }
  if (result.status === 'conflict') { set({ conflict: result }); return false; }
  notify(`已保存到浏览器，但没有写回原文件：${result.message}`, 'error');
  return false;
}
/** Saves the map to a new file (or another existing one) and links the project to it. Without file access: a download. */
export async function saveAs(): Promise<void> {
  const map = store.get().session?.map; if (!map) return;
  if (!supported().saveAs) { notify(`这个浏览器不能直接写本地文件，已改为下载 ${downloadMap(map)}。`); return; }
  await fileOp(async op => {
    const result = await files.saveAs(map);
    if (op.owner === null) {
      // A map in memory only: the file is written, but not linked (Save would not write it).
      if (result.status === 'saved') { files.reset(); notify(`已另存为 ${result.name}（地图只在本页内存中，未关联该文件）。`); }
      else if (result.status !== 'cancelled' && result.status !== 'conflict') notify(result.message, 'error');
      return;
    }
    if (!current(op)) return;
    if (result.status === 'saved') { linked(op); notify(`已另存为 ${result.name} 并关联：之后保存会写回这个文件。`); return; }
    if (result.status === 'conflict') { set({ conflict: result }); return; }
    if (result.status !== 'cancelled') notify(result.message, 'error');
  });
}

/** On focus: has the linked file changed on disk? Never asks for permission, never replaces the map. */
export async function checkFile(): Promise<void> {
  if (!snapshot().linkedName || state.conflict || state.busy) return;
  await fileOp(async op => {
    const result = await files.check();
    if (current(op) && result.status === 'conflict') set({ conflict: result });
  });
}

/** The file changed on disk. Keep both versions as recovery copies first; then overwrite the file with this map. */
export async function keepBoth(): Promise<boolean> {
  const conflict = state.conflict, map = store.get().session?.map; if (!conflict || !map || !conflict.loaded?.ok) return false;
  const file = conflict.loaded.map;
  return fileOp(async () => (await keepCopy(map, '当前地图')) && (await keepCopy(file, `${conflict.name} 中的版本`)));
}
export async function overwriteFile(): Promise<void> {
  const conflict = state.conflict, map = store.get().session?.map; if (!conflict || !map) return;
  if (await fileOp(op => writeWith(map, op, conflict.token))) set({ conflict: null });
}
/** The file changed on disk: show its version instead (this page's map is kept as a recovery copy first). */
export async function loadFileVersion(): Promise<void> {
  const conflict = state.conflict, map = store.get().session?.map; if (!conflict || !map) return;
  if (!conflict.loaded?.ok) { notify('外部文件无效，不能载入；可以另存到新文件。', 'error'); return; }
  const file = conflict.loaded.map;
  if (file.mapId !== map.mapId || !sameValue(file.coordinateFrame, map.coordinateFrame)) {
    notify('外部文件已是另一张地图（地图编号或坐标框架不同），没有替换当前地图；可用「打开并关联本地 JSON…」把它作为新工程打开。', 'error'); return;
  }
  await fileOp(async op => {
    if (!(await keepCopy(map, '当前地图'))) return;
    // The file's bytes become the confirmed baseline: read it again through the link.
    const read = await files.readCurrent();
    if (!current(op)) return;
    if (read.status !== 'opened') { notify(read.message, 'error'); return; }
    const result = files.acceptOpen(read.token);
    if (result.status !== 'linked') { notify(result.message, 'error'); return; }
    replaceMap(read.loaded.map);
    linked(op);
    notify(`已载入 ${read.name} 中的版本。`);
  });
}
export function dismissConflict(): void { set({ conflict: null }); }

/** After an upgrade: the file keeps its format, so the project stops writing to it. */
export function unlinkForUpgrade(): void {
  const projectId = activeProjectId(), name = state.link?.name;
  if (!name) return;
  generation++;
  if (!files.reset()) resetPending = true;
  if (projectId) writeLink(projectId, null);
  set({ link: null, conflict: null });
  notify(`已解除与原文件 ${name} 的关联：原文件保持原格式不变；升级后的地图请用「文件另存为」保存到新文件。`);
}

/** One line for the status bar. */
export function fileStatus(map: YardMap | null, local: State): { text: string; tone: 'ok' | 'busy' | 'warn' | 'error' } | null {
  if (!local.link || !map) return null;
  if (local.conflict) return { text: `外部文件已变化：${local.link.name}`, tone: 'error' };
  if (local.busy) return { text: `正在读写 ${local.link.name}…`, tone: 'busy' };
  if (local.link.remembered) return { text: `原文件 ${local.link.name}：重新选择后才能写回`, tone: 'warn' };
  return snapshot().confirmedContentHash === sceneOf(map).mapContentHash
    ? { text: `已写回 ${local.link.name}`, tone: 'ok' } : { text: `有修改未写回 ${local.link.name}`, tone: 'warn' };
}
