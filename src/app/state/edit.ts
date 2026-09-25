import type { SceneKind } from '../../adapters/contracts';
import { mapCapabilities } from '../../domain/capabilities';
import type { MapCommand, Transaction } from '../../domain/commands';
import { editSession, isDirty, redoSession, undoSession, type EditorSession } from '../../editor/session';
import { KIND_LABELS } from '../ui/labels';
import { refusalMessage } from './properties';
import { itemOf, notify, sceneOf, store } from './store';

const COMMAND_LABELS: Record<string, string> = {
  translateSelection: '移动', rotateSelection: '旋转', duplicateSelection: '复制', deleteSelection: '删除',
  addNode: '添加节点', updateNode: '修改节点', addRoad: '添加道路', updateRoad: '修改道路', updateRoadBatch: '修改道路',
  addFacility: '添加建筑', updateFacility: '修改建筑', addZone: '添加区域', updateZone: '修改区域',
  addAccessPoint: '添加入口', updateAccessPoint: '修改入口', addServicePoint: '添加作业点', updateServicePoint: '修改作业点',
  movePoint: '移动点位', splitRoad: '拆分道路', splitRoadAndSetWidth: '拆分道路', renameMap: '修改地图名称', upgradeSchema: '升级格式',
};
/** Labels the user sees for each transaction; the kernel only records the command type. */
const labels = new WeakMap<Transaction, string>();
/** Merge key and time of transactions that later edits may fold into (consecutive nudges). */
const merges = new WeakMap<Transaction, { key: string; at: number }>();
export const MERGE_MS = 1500;
export const transactionLabel = (transaction: Transaction | undefined): string =>
  transaction ? labels.get(transaction) ?? COMMAND_LABELS[transaction.label] ?? transaction.label : '';

/** Why the open map cannot be edited, or null. */
export function editBlock(session: EditorSession | null = store.get().session): string | null {
  if (!session) return '请先打开地图';
  if (store.get().switching) return '正在打开另一张地图，稍候再编辑。';
  const capabilities = mapCapabilities(session.map);
  return capabilities.editable ? null : '地图为只读：' + capabilities.reasons.join('；');
}

/** Why these references may not change because their layer is locked, or null. */
export function lockedMessage(refs: readonly { kind: string }[]): string | null {
  const locked = new Set<SceneKind>(store.get().drawing.lockedTypes);
  const kinds = [...new Set(refs.map(ref => ref.kind as SceneKind).filter(kind => locked.has(kind)))];
  return kinds.length ? `操作会改动已锁定的图层（${kinds.map(kind => KIND_LABELS[kind] ?? kind).join('、')}），已取消；地图与历史保持不变。可在「图层」页解锁。` : null;
}

/** Replaces the session and drops selected keys that no longer exist (after undo, delete, …). */
function commit(session: EditorSession): void {
  store.set(({ selection }) => {
    const scene = sceneOf(session.map);
    return { session, selection: selection.filter(key => itemOf(scene, key)) };
  });
}

/** The one gateway for map edits. A refused command leaves map and history untouched and says why (plus `hint`, what to try).
 *  `merge` folds this edit into the previous transaction when that one carries the same merge key (consecutive nudges).
 *  `restart`: the command sets an absolute value, so a run is re-applied from where it began and leaves one change in the map,
 *  not one per step (each background change adds a lineage record to the map; a run of nudges must add one, not hundreds). */
export function apply(command: MapCommand, label?: string, merge?: string, hint?: string, restart = false): boolean {
  const session = store.get().session, blocked = editBlock(session);
  if (blocked) { notify(blocked, 'error'); return false; }
  const previous = session!.past.at(-1), run = previous && merges.get(previous);
  const continues = !!merge && !!run && run.key === merge && performance.now() - run.at < MERGE_MS;
  if (continues && restart) return restartRun(session!, command, merge, label, hint);
  const result = editSession(session!, command);
  if (!result.ok) { notify(refusalMessage(result.issues, session!.map) + (hint ? ' ' + hint : ''), 'error'); return false; }
  const transaction = result.session.past.at(-1);
  if (result.session === session || !transaction) { notify('内容没有变化，未创建撤销步骤。'); return false; }
  const locked = lockedMessage(transaction.affectedRefs);
  if (locked) { notify(locked, 'error'); return false; }
  let next = result.session;
  const now = performance.now();
  if (continues) {
    // One undo step for the whole run: the merged transaction starts where the previous one started.
    const combined: Transaction = { ...transaction, before: previous!.before };
    next = { ...next, past: [...session!.past.slice(0, -1), combined] };
    merges.set(combined, { key: merge, at: now });
    labels.set(combined, label ?? transactionLabel(previous));
  } else {
    if (merge) merges.set(transaction, { key: merge, at: now });
    if (label) labels.set(transaction, label);
  }
  commit(next);
  return true;
}

/** A run's next step, applied to the map as it was before the run: one transaction and one change for the whole run.
 *  A run that ends where it began leaves no transaction at all. */
function restartRun(session: EditorSession, command: MapCommand, merge: string, label: string | undefined, hint: string | undefined): boolean {
  const previous = session.past.at(-1)!, base = undoSession(session), result = editSession(base, command);
  if (!result.ok) { notify(refusalMessage(result.issues, base.map) + (hint ? ' ' + hint : ''), 'error'); return false; }
  if (result.session === base) { commit({ ...base, future: session.future }); return true; }
  const transaction = result.session.past.at(-1)!;
  const locked = lockedMessage(transaction.affectedRefs);
  if (locked) { notify(locked, 'error'); return false; }
  merges.set(transaction, { key: merge, at: performance.now() });
  labels.set(transaction, label ?? transactionLabel(previous));
  commit(result.session);
  return true;
}

/** Several commands as one undo step, whatever the time between them: all are applied, or none. */
export function applyAll(commands: readonly MapCommand[], label: string): boolean {
  const session = store.get().session, blocked = editBlock(session);
  if (blocked) { notify(blocked, 'error'); return false; }
  let next = session!;
  const done: Transaction[] = [];
  for (const command of commands) {
    const result = editSession(next, command);
    if (!result.ok) { notify(refusalMessage(result.issues, next.map), 'error'); return false; }
    if (result.session !== next) done.push(result.session.past.at(-1)!);
    next = result.session;
  }
  if (!done.length) { notify('内容没有变化，未创建撤销步骤。'); return false; }
  const affectedRefs = [...new Map(done.flatMap(transaction => transaction.affectedRefs).map(ref => [ref.kind + '/' + ref.id, ref])).values()];
  const locked = lockedMessage(affectedRefs);
  if (locked) { notify(locked, 'error'); return false; }
  const combined: Transaction = { ...done.at(-1)!, before: done[0]!.before, affectedRefs };
  labels.set(combined, label);
  // The session already keeps its own history limit; the steps it recorded become one.
  commit({ ...next, past: [...next.past.slice(0, -done.length), combined] });
  return true;
}

export function undo(): void {
  const session = store.get().session, transaction = session?.past.at(-1);
  if (!session || !transaction) return;
  if (store.get().switching) { notify('正在打开另一张地图，稍候再撤销。', 'error'); return; }
  const locked = lockedMessage(transaction.affectedRefs);
  if (locked) { notify(locked, 'error'); return; }
  commit(undoSession(session));
  notify(`已撤销：${transactionLabel(transaction)}`);
}
export function redo(): void {
  const session = store.get().session, transaction = session?.future.at(-1);
  if (!session || !transaction) return;
  if (store.get().switching) { notify('正在打开另一张地图，稍候再重做。', 'error'); return; }
  const locked = lockedMessage(transaction.affectedRefs);
  if (locked) { notify(locked, 'error'); return; }
  commit(redoSession(session));
  notify(`已重做：${transactionLabel(transaction)}`);
}

/** Unsaved work exists until P4 adds saving; export does not count. */
export function hasUnsavedEdits(): boolean {
  const session = store.get().session;
  return !!session && session.past.length > 0 && isDirty(session);
}
