import { useEffect, useRef, useState } from 'react';
import type { YardMap } from '../domain/model';
import { contentHash } from '../domain/serialization';
import { IndexedDBProjectStore } from '../adapters/projectStore';
import { DEFAULT_DRAWING_CONFIG, ProjectController, type EditorState, type ProjectRecovery, type ProjectSummary } from '../editor/projectController';

interface Inputs {
  map: YardMap;
  editorState: EditorState;
  onRestore: (recovery: ProjectRecovery) => void;
  onAcknowledged: (hash: string) => void;
}

function freshEditorState(): EditorState { return { camera: { offsetX: 80, offsetY: 460, scale: 4 }, drawing: { ...DEFAULT_DRAWING_CONFIG } }; }

/** Browser lifecycle stays outside the domain; the editing session owns the current map. */
export function useProjectWorkspace(inputs: Inputs) {
  const latest = useRef(inputs);
  latest.current = inputs;
  const [controller] = useState(() => new ProjectController(new IndexedDBProjectStore()));
  const [state, setState] = useState(controller.state);
  const [ready, setReady] = useState(false);
  const [temporary, setTemporary] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [recent, setRecent] = useState<ProjectSummary[]>([]);
  const [transitioning, setTransitioning] = useState(false);
  const navigating = useRef(false);
  const generation = useRef(0);
  const [retry, setRetry] = useState(0);
  const persistenceReady = useRef(false);
  const quarantined = useRef(false);
  const temporaryMode = useRef(false);
  const pendingRecovery = useRef<ProjectRecovery | null>(null);
  const [savedEditor, setSavedEditor] = useState<{ projectId: string; key: string } | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState('');
  const editorSaveSequence = useRef(0);

  function assertPersistenceReady() {
    if (quarantined.current) throw new Error('工程恢复回调未完成；浏览器保存和工程切换已暂停，请重试恢复或仅内存继续。');
    if (!persistenceReady.current || temporaryMode.current) throw new Error('浏览器工程尚未恢复或已切为仅内存模式；当前地图可以导出，不能写入工程槽位。');
  }
  function restoreUi(recovery: ProjectRecovery) {
    const restored = { ...recovery, editorState: recovery.editorState ?? freshEditorState() };
    pendingRecovery.current = restored; persistenceReady.current = false; setReady(false);
    ++editorSaveSequence.current; setEditorSaving(false);
    try {
      latest.current.onRestore(restored);
      quarantined.current = false; temporaryMode.current = false;
      setSavedEditor(recovery.editorState ? { projectId: recovery.projectId, key: JSON.stringify(recovery.editorState) } : null);
      setEditorError(''); setTemporary(false);
      try { sessionStorage.setItem('shipyard.activeProjectId', recovery.projectId); } catch { /* A disabled tab preference never changes the map storage target. */ }
      setWarning(recovery.warnings.map(issue => issue.message).join(' ')); setError('');
    } catch (reason) {
      // Controller selection may already have changed. Never let the stale visible map save there.
      quarantined.current = true; persistenceReady.current = false;
      setReady(false);
      const failure = new Error('工程界面恢复失败；所有浏览器保存与导航已暂停，原记录保留。' + message(reason));
      setError(failure.message); throw failure;
    }
  }

  useEffect(() => controller.subscribe(() => setState(controller.state)), [controller]);
  // onRestore schedules React updates. Only the rendered target may unlock writes.
  useEffect(() => {
    const recovery = pendingRecovery.current;
    if (!recovery || quarantined.current || temporaryMode.current || controller.state.active?.projectId !== recovery.projectId
      || contentHash(inputs.map) !== contentHash(recovery.map) || JSON.stringify(inputs.editorState) !== JSON.stringify(recovery.editorState)) return;
    pendingRecovery.current = null; persistenceReady.current = true; setReady(true);
  }, [controller, inputs.map, inputs.editorState, state.active?.projectId]);
  useEffect(() => {
    let active = true;
    persistenceReady.current = false; ++generation.current;
    let preferred: string | undefined;
    try { preferred = sessionStorage.getItem('shipyard.activeProjectId') ?? undefined; } catch { /* Fall back to the global recent project. */ }
    void (async () => {
      let recovery: ProjectRecovery | null;
      const current = controller.state.active;
      if (retry > 0 && current) {
        // initialize() intentionally caches its first success. A retry must recover the *current* target.
        if (current.storageVersion !== null) recovery = await controller.open(current.projectId);
        else if (pendingRecovery.current?.projectId === current.projectId) {
          const candidate = pendingRecovery.current;
          recovery = await controller.create(current.projectId, candidate.map, candidate.editorState ?? undefined);
        } else throw new Error('当前工程尚未落盘且没有可重试候选；请仅内存继续并导出当前地图。');
      } else recovery = await controller.initialize(preferred);
      if (!active) return;
      if (!recovery) recovery = await controller.create('project_' + crypto.randomUUID(), latest.current.map, latest.current.editorState);
      if (!active) return;
      restoreUi(recovery);
    })().catch(reason => { if (active) { persistenceReady.current = false; setError(message(reason)); } });
    return () => { active = false; };
  }, [controller, retry]);

  function owns(projectId: string, token: number) {
    return generation.current === token && controller.state.active?.projectId === projectId && persistenceReady.current && !quarantined.current && !temporaryMode.current;
  }
  async function persistEditor(snapshot: EditorState, projectId: string, token: number) {
    assertPersistenceReady();
    if (!owns(projectId, token)) throw new Error('工程已切换，未保存过期绘图配置。');
    if (controller.state.error?.code === 'PROJECT_CONFLICT') throw controller.state.error;
    const sequence = ++editorSaveSequence.current;
    setEditorSaving(true);
    try {
      await controller.saveEditorState(snapshot);
      if (owns(projectId, token) && sequence === editorSaveSequence.current) {
        if (controller.state.active?.storageVersion !== null) setSavedEditor({ projectId, key: JSON.stringify(snapshot) });
        setEditorError('');
      }
    } catch (reason) {
      if (owns(projectId, token) && sequence === editorSaveSequence.current) setEditorError(message(reason));
      throw reason;
    } finally { if (sequence === editorSaveSequence.current) setEditorSaving(false); }
  }
  async function persist(kind: 'draft' | 'checkpoint') {
    assertPersistenceReady();
    const current = latest.current;
    const projectId = controller.state.active!.projectId; const token = generation.current;
    // Capture the complete configuration before any await, using the existing controller queue.
    await persistEditor(current.editorState, projectId, token);
    if (!owns(projectId, token)) throw new Error('工程已切换，未保存过期地图。');
    try {
      const receipt = await controller.save(current.map, kind);
      if (owns(projectId, token)) {
        latest.current.onAcknowledged(receipt.contentHash);
        if (controller.state.error) throw controller.state.error;
        if (JSON.stringify(latest.current.editorState) === JSON.stringify(current.editorState))
          setSavedEditor({ projectId, key: JSON.stringify(current.editorState) });
        setError('');
      }
      return receipt;
    } catch (reason) { if (owns(projectId, token)) setError(message(reason)); throw reason; }
  }
  const hash = contentHash(inputs.map);
  const editorKey = JSON.stringify(inputs.editorState);
  const editorDirty = savedEditor?.projectId !== state.active?.projectId || savedEditor?.key !== editorKey;
  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || quarantined.current || state.saving || state.error || !state.active || state.active.draftHash === hash) return;
    const projectId = state.active.projectId; const token = generation.current;
    const timer = setTimeout(() => {
      if (!navigating.current && owns(projectId, token)) void persist('draft').catch(() => { /* persist reports failures for its owning project. */ });
    }, 600);
    return () => clearTimeout(timer);
  }, [ready, temporary, transitioning, state.active?.projectId, state.active?.draftHash, state.saving, state.error, hash]);

  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || quarantined.current || !editorDirty || state.active?.storageVersion == null || state.error?.code === 'PROJECT_CONFLICT') return;
    const projectId = state.active.projectId; const token = generation.current; const snapshot = inputs.editorState;
    const timer = setTimeout(() => {
      if (!navigating.current && owns(projectId, token) && controller.state.error?.code !== 'PROJECT_CONFLICT') void persistEditor(snapshot, projectId, token).catch(() => { /* persistEditor reports failures for its owning project. */ });
    }, 600);
    return () => clearTimeout(timer);
  }, [controller, ready, temporary, transitioning, editorKey, editorDirty, state.active?.projectId, state.active?.storageVersion, state.error?.code === 'PROJECT_CONFLICT']);

  useEffect(() => {
    if (!ready || temporary) return;
    const check = () => {
      const projectId = controller.state.active?.projectId; const token = generation.current;
      if (!navigating.current && projectId && owns(projectId, token)) void controller.checkExternalVersion().catch(reason => {
        if (owns(projectId, token)) setError(message(reason));
      });
    };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [controller, ready, temporary]);

  async function protectCurrent() {
    assertPersistenceReady();
    const before = contentHash(latest.current.map); const editorBefore = JSON.stringify(latest.current.editorState);
    await persist('checkpoint');
    if (contentHash(latest.current.map) !== before || JSON.stringify(latest.current.editorState) !== editorBefore) throw new Error('保存期间又产生了编辑，请再次操作；当前工程保持打开。');
  }
  async function navigate(work: () => Promise<ProjectRecovery>, protect = true) {
    assertPersistenceReady();
    if (navigating.current) throw new Error('工程正在切换，请稍候。');
    navigating.current = true; setTransitioning(true);
    const token = ++generation.current;
    try {
      if (protect) await protectCurrent();
      const recovery = await work();
      if (token !== generation.current) throw new Error('工程切换结果已过期。');
      restoreUi(recovery);
    } catch (reason) { setError(message(reason)); throw reason; }
    finally { navigating.current = false; setTransitioning(false); }
  }
  async function create(map: YardMap) {
    await navigate(() => controller.create('project_' + crypto.randomUUID(), map, freshEditorState()));
  }
  async function open(id: string) { await navigate(() => controller.open(id)); }
  async function recoveryCopy() {
    const map = latest.current.map;
    const id = 'project_' + crypto.randomUUID(); const editorState = latest.current.editorState;
    await navigate(async () => { await controller.backup(id, map, editorState); return controller.open(id); }, false);
  }
  async function reloadStored() {
    const id = state.active?.projectId;
    if (!id) throw new Error('尚无可重新载入的工程。');
    await navigate(() => controller.open(id), false);
  }
  async function showRecent() { assertPersistenceReady(); const entries = await controller.list(); setRecent(entries); }
  async function save() {
    const projectId = controller.state.active?.projectId; const token = generation.current;
    const mapBefore = contentHash(latest.current.map); const editorBefore = JSON.stringify(latest.current.editorState);
    try {
      await persist('checkpoint');
      return !!projectId && owns(projectId, token) && contentHash(latest.current.map) === mapBefore && JSON.stringify(latest.current.editorState) === editorBefore;
    }
    catch (reason) { if (projectId && !owns(projectId, token)) return false; throw reason; }
  }
  async function backup(map: YardMap) { assertPersistenceReady(); return controller.backup('project_' + crypto.randomUUID(), map); }
  const browserStatus = !ready ? (quarantined.current ? '工程恢复失败，保存已隔离' : '正在恢复浏览器工程…') : temporary ? '浏览器保存已停用（仅内存）'
    : state.error?.code === 'PROJECT_CONFLICT' ? '浏览器工程冲突：其他标签页已修改'
    : editorError ? '绘图配置保存失败：' + editorError
    : state.saving ? '浏览器草稿保存中…'
    : error || state.error ? '浏览器草稿保存失败：' + (error || state.error?.message)
    : editorSaving ? '绘图配置保存中…'
    : editorDirty ? '绘图配置未保存'
    : state.active?.draftHash === hash ? '浏览器草稿已保存' : '浏览器草稿未保存';
  return {
    ready, state, browserStatus, error, warning, recent, transitioning, temporary, editorDirty: editorDirty || editorSaving, isNavigating: () => navigating.current,
    create, open, save, recoveryCopy, reloadStored, showRecent, backup,
    continueTemporary: () => { persistenceReady.current = false; temporaryMode.current = true; setTemporary(true); setReady(true); },
    retry: () => { persistenceReady.current = false; temporaryMode.current = false; setError(''); setReady(false); setTemporary(false); setRetry(value => value + 1); },
  };
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
