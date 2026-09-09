import { useEffect, useRef, useState } from 'react';
import type { YardMap } from '../domain/model';
import { contentHash } from '../domain/serialization';
import type { Camera } from '../geometry/coordinates';
import { IndexedDBProjectStore } from '../adapters/projectStore';
import { ProjectController, type ProjectRecovery, type ProjectSummary } from '../editor/projectController';

interface Inputs {
  map: YardMap;
  camera: Camera;
  onRestore: (recovery: ProjectRecovery) => void;
  onAcknowledged: (hash: string) => void;
}

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

  function assertPersistenceReady() {
    if (quarantined.current) throw new Error('工程恢复回调未完成；浏览器保存和工程切换已暂停，请重试恢复或仅内存继续。');
    if (!persistenceReady.current || temporaryMode.current) throw new Error('浏览器工程尚未恢复或已切为仅内存模式；当前地图可以导出，不能写入工程槽位。');
  }
  function restoreUi(recovery: ProjectRecovery) {
    pendingRecovery.current = recovery;
    try {
      latest.current.onRestore(recovery);
      quarantined.current = false; persistenceReady.current = true; temporaryMode.current = false;
      pendingRecovery.current = null;
      setTemporary(false); setReady(true);
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
  useEffect(() => {
    let active = true;
    persistenceReady.current = false;
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
      if (!recovery) recovery = await controller.create('project_' + crypto.randomUUID(), latest.current.map, { camera: latest.current.camera });
      if (!active) return;
      restoreUi(recovery);
    })().catch(reason => { if (active) { persistenceReady.current = false; setError(message(reason)); } });
    return () => { active = false; };
  }, [controller, retry]);

  async function persist(kind: 'draft' | 'checkpoint') {
    assertPersistenceReady();
    const current = latest.current;
    const receipt = await controller.save(current.map, kind);
    assertPersistenceReady();
    if (receipt.projectId === controller.state.active?.projectId) latest.current.onAcknowledged(receipt.contentHash);
    if (receipt.projectId === controller.state.active?.projectId) await controller.saveEditorState({ camera: latest.current.camera });
    if (receipt.projectId === controller.state.active?.projectId) setError('');
    return receipt;
  }
  const hash = contentHash(inputs.map);
  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || quarantined.current || state.saving || state.error || !state.active || state.active.draftHash === hash) return;
    const timer = setTimeout(() => {
      if (!navigating.current && !quarantined.current && persistenceReady.current) void persist('draft').catch(reason => setError(message(reason)));
    }, 600);
    return () => clearTimeout(timer);
  }, [ready, temporary, transitioning, state.active?.projectId, state.active?.draftHash, state.saving, state.error, hash]);

  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || quarantined.current || state.active?.storageVersion == null) return;
    const timer = setTimeout(() => {
      if (!navigating.current && !quarantined.current && persistenceReady.current) void controller.saveEditorState({ camera: latest.current.camera }).catch(reason => setError(message(reason)));
    }, 600);
    return () => clearTimeout(timer);
  }, [controller, ready, temporary, transitioning, inputs.camera, state.active?.projectId, state.active?.storageVersion]);

  useEffect(() => {
    if (!ready || temporary) return;
    const check = () => { if (!navigating.current && !quarantined.current && persistenceReady.current) void controller.checkExternalVersion().catch(reason => setError(message(reason))); };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [controller, ready, temporary]);

  async function protectCurrent() {
    assertPersistenceReady();
    const before = contentHash(latest.current.map);
    await persist('checkpoint');
    if (contentHash(latest.current.map) !== before) throw new Error('保存期间又产生了编辑，请再次操作；当前工程保持打开。');
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
    await navigate(() => controller.create('project_' + crypto.randomUUID(), map, { camera: { offsetX: 80, offsetY: 460, scale: 4 } }));
  }
  async function open(id: string) { await navigate(() => controller.open(id)); }
  async function recoveryCopy() {
    const map = latest.current.map;
    const id = 'project_' + crypto.randomUUID();
    await navigate(async () => { await controller.backup(id, map); return controller.open(id); }, false);
  }
  async function reloadStored() {
    const id = state.active?.projectId;
    if (!id) throw new Error('尚无可重新载入的工程。');
    await navigate(() => controller.open(id), false);
  }
  async function showRecent() { assertPersistenceReady(); const entries = await controller.list(); setRecent(entries); }
  async function save() { try { await persist('checkpoint'); } catch (reason) { setError(message(reason)); throw reason; } }
  async function backup(map: YardMap) { assertPersistenceReady(); return controller.backup('project_' + crypto.randomUUID(), map); }
  const browserStatus = !ready ? (quarantined.current ? '工程恢复失败，保存已隔离' : '正在恢复浏览器工程…') : temporary ? '浏览器保存已停用（仅内存）'
    : state.error?.code === 'PROJECT_CONFLICT' ? '浏览器工程冲突：其他标签页已修改'
    : state.saving ? '浏览器草稿保存中…'
    : error || state.error ? '浏览器草稿保存失败：' + (error || state.error?.message)
    : state.active?.draftHash === hash ? '浏览器草稿已保存' : '浏览器草稿未保存';
  return {
    ready, state, browserStatus, error, warning, recent, transitioning, temporary, isNavigating: () => navigating.current,
    create, open, save, recoveryCopy, reloadStored, showRecent, backup,
    continueTemporary: () => { persistenceReady.current = false; temporaryMode.current = true; setTemporary(true); setReady(true); },
    retry: () => { persistenceReady.current = false; temporaryMode.current = false; setError(''); setReady(false); setTemporary(false); setRetry(value => value + 1); },
  };
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
