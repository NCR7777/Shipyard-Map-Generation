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

  useEffect(() => controller.subscribe(() => setState(controller.state)), [controller]);
  useEffect(() => {
    let active = true;
    let preferred: string | undefined;
    try { preferred = sessionStorage.getItem('shipyard.activeProjectId') ?? undefined; } catch { /* Storage may be disabled; IDB error remains visible. */ }
    void controller.initialize(preferred).then(async recovery => {
      if (!active) return;
      if (!recovery) recovery = await controller.create('project_' + crypto.randomUUID(), latest.current.map, { camera: latest.current.camera });
      if (!active) return;
      try { sessionStorage.setItem('shipyard.activeProjectId', recovery.projectId); } catch { /* No cross-tab map writes are introduced by this view preference. */ }
      latest.current.onRestore(recovery);
      setWarning(recovery.warnings.map(issue => issue.message).join(' '));
      setError('');
      setReady(true);
    }).catch(reason => { if (active) setError(message(reason)); });
    return () => { active = false; };
  }, [controller, retry]);

  async function persist(kind: 'draft' | 'checkpoint') {
    const current = latest.current;
    const receipt = await controller.save(current.map, kind);
    if (receipt.projectId === controller.state.active?.projectId) latest.current.onAcknowledged(receipt.contentHash);
    // A view is a separate editor-state record and cannot change the map's content digest.
    if (receipt.projectId === controller.state.active?.projectId) await controller.saveEditorState({ camera: latest.current.camera });
    if (receipt.projectId === controller.state.active?.projectId) setError('');
    return receipt;
  }
  const hash = contentHash(inputs.map);
  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || state.saving || state.error || !state.active || state.active.draftHash === hash) return;
    const timer = setTimeout(() => { if (!navigating.current) void persist('draft').catch(reason => setError(message(reason))); }, 600);
    return () => clearTimeout(timer);
  }, [ready, temporary, transitioning, state.active?.projectId, state.active?.draftHash, state.saving, state.error, hash]);

  useEffect(() => {
    if (!ready || temporary || transitioning || navigating.current || state.active?.storageVersion == null) return;
    const timer = setTimeout(() => { if (!navigating.current) void controller.saveEditorState({ camera: latest.current.camera }).catch(reason => setError(message(reason))); }, 600);
    return () => clearTimeout(timer);
  }, [controller, ready, temporary, transitioning, inputs.camera, state.active?.projectId, state.active?.storageVersion]);

  useEffect(() => {
    if (!ready || temporary) return;
    const check = () => { if (!navigating.current) void controller.checkExternalVersion().catch(reason => setError(message(reason))); };
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, [controller, ready, temporary]);

  async function protectCurrent() {
    if (temporary) throw new Error('浏览器存储不可用；请先导出当前 JSON，恢复浏览器存储后再切换工程。');
    const before = contentHash(latest.current.map);
    await persist('checkpoint');
    if (contentHash(latest.current.map) !== before) throw new Error('保存期间又产生了编辑，请再次操作；当前工程保持打开。');
  }
  async function navigate(work: () => Promise<ProjectRecovery>, protect = true) {
    if (navigating.current) throw new Error('工程正在切换，请稍候。');
    navigating.current = true; setTransitioning(true);
    const token = ++generation.current;
    try {
      if (protect) await protectCurrent();
      const recovery = await work();
      if (token !== generation.current) throw new Error('工程切换结果已过期。');
      try { sessionStorage.setItem('shipyard.activeProjectId', recovery.projectId); } catch { /* No cross-tab map writes are introduced by this view preference. */ }
      latest.current.onRestore(recovery);
      setWarning(recovery.warnings.map(issue => issue.message).join(' '));
      setError('');
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
    // First commit the independent recovery record. Failure leaves the original active project intact.
    await navigate(async () => {
      await controller.backup(id, map);
      return controller.open(id);
    }, false);
  }
  async function reloadStored() {
    const id = state.active?.projectId;
    if (!id) throw new Error('尚无可重新载入的工程。');
    await navigate(() => controller.open(id), false);
  }
  async function showRecent() { const entries = await controller.list(); setRecent(entries); }
  async function save() { try { await persist('checkpoint'); } catch (reason) { setError(message(reason)); throw reason; } }
  const browserStatus = !ready ? '正在恢复浏览器工程…' : temporary ? '浏览器保存不可用（仅内存）'
    : state.error?.code === 'PROJECT_CONFLICT' ? '浏览器工程冲突：其他标签页已修改'
    : state.saving ? '浏览器草稿保存中…'
    : error || state.error ? '浏览器草稿保存失败：' + (error || state.error?.message)
    : state.active?.draftHash === hash ? '浏览器草稿已保存' : '浏览器草稿未保存';
  return {
    ready, state, browserStatus, error, warning, recent, transitioning, temporary, isNavigating: () => navigating.current,
    create, open, save, recoveryCopy, reloadStored, showRecent,
    backup: (map: YardMap) => controller.backup('project_' + crypto.randomUUID(), map),
    continueTemporary: () => { setTemporary(true); setReady(true); },
    retry: () => { setError(''); setReady(false); setTemporary(false); setRetry(value => value + 1); },
  };
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
