import type { Issue, YardMap } from '../domain/model';
import { loadMap } from '../domain/load';
import { serializeMap } from '../domain/serialization';
import type { Camera } from '../geometry/coordinates';

export type SaveKind = 'draft' | 'checkpoint';
export interface EditorState { camera: Camera }
export interface ProjectSnapshot { mapJson: string; contentHash: string; savedAt: number }
export interface StoredProject {
  formatVersion: 1;
  projectId: string;
  name: string;
  storageVersion: number;
  createdAt: number;
  updatedAt: number;
  draft: ProjectSnapshot | null;
  checkpoint: ProjectSnapshot | null;
  previousCheckpoint: ProjectSnapshot | null;
}
export interface ProjectSummary {
  projectId: string; name: string; storageVersion: number; updatedAt: number;
  hasDraft: boolean; hasCheckpoint: boolean;
}
export interface ProjectRecovery {
  projectId: string; map: YardMap; editorState: EditorState | null;
  source: 'draft' | 'checkpoint' | 'previousCheckpoint' | 'new'; warnings: Issue[];
}
export interface SaveReceipt {
  projectId: string; storageVersion: number; contentHash: string; kind: SaveKind; savedAt: number;
}
/** This port has no browser dependencies. A successful commit means storage transaction completion. */
export interface ProjectStorePort {
  list(): Promise<ProjectSummary[]>;
  get(projectId: string): Promise<StoredProject | null>;
  commit(project: StoredProject, expectedVersion: number | null): Promise<void>;
  getLastProject(): Promise<string | null>;
  setLastProject(projectId: string): Promise<void>;
  readEditorState(projectId: string): Promise<EditorState | null>;
  writeEditorState(projectId: string, state: EditorState): Promise<void>;
}
export class ProjectPersistenceError extends Error {
  constructor(readonly code: string, message: string, readonly issues: Issue[] = []) {
    super(message); this.name = 'ProjectPersistenceError';
  }
}
export function persistenceError(error: unknown): ProjectPersistenceError {
  if (error instanceof ProjectPersistenceError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'QuotaExceededError') return new ProjectPersistenceError('PROJECT_STORAGE_QUOTA', '浏览器存储空间不足；上次成功保存的版本仍然保留，请导出当前地图备份。');
  if (name === 'SecurityError' || name === 'InvalidStateError') return new ProjectPersistenceError('PROJECT_STORAGE_UNAVAILABLE', '浏览器存储不可用；当前地图仍在内存中，可导出 JSON 备份。');
  return new ProjectPersistenceError('PROJECT_STORAGE_ERROR', error instanceof Error ? error.message : '工程存储失败，未确认保存成功。');
}
export function validateEditorState(value: unknown): EditorState {
  if (!value || typeof value !== 'object' || !('camera' in value) || !value.camera || typeof value.camera !== 'object') {
    throw new ProjectPersistenceError('EDITOR_STATE_INVALID', '视窗状态缺少 camera。');
  }
  const camera = value.camera;
  if (!('offsetX' in camera) || !('offsetY' in camera) || !('scale' in camera)
    || typeof camera.offsetX !== 'number' || !Number.isFinite(camera.offsetX)
    || typeof camera.offsetY !== 'number' || !Number.isFinite(camera.offsetY)
    || typeof camera.scale !== 'number' || !Number.isFinite(camera.scale) || camera.scale <= 0
    || Object.keys(value).some(key => key !== 'camera') || Object.keys(camera).some(key => !['offsetX', 'offsetY', 'scale'].includes(key))) {
    throw new ProjectPersistenceError('EDITOR_STATE_INVALID', '视窗偏移必须有限，比例必须为正的有限值；不能混入领域数据。');
  }
  return { camera: { offsetX: camera.offsetX, offsetY: camera.offsetY, scale: camera.scale } };
}

export interface ActiveProject {
  projectId: string; name: string; storageVersion: number | null;
  draftHash: string | null; checkpointHash: string | null;
}
export interface ProjectControllerState {
  ready: boolean; active: ActiveProject | null; saving: boolean; error: ProjectPersistenceError | null;
}
interface Context {
  projectId: string; name: string; mapName: string; record: StoredProject | null;
  draftHash: string | null; checkpointHash: string | null; pending: number;
  editorState: EditorState | null;
}
function warning(code: string, message: string): Issue {
  return { code, severity: 'warning', jsonPath: '', message, suggestedAction: '保留恢复副本并检查浏览器工程数据；需要时重新导入有效 JSON。' };
}
function checkedMap(text: string): Extract<ReturnType<typeof loadMap>, { ok: true }> {
  const loaded = loadMap(text);
  if (!loaded.ok) throw new ProjectPersistenceError('PROJECT_INVALID_SNAPSHOT', '工程中的地图未通过共同导入/校验管线。', loaded.report.issues);
  return loaded;
}
function checkedSnapshot(snapshot: ProjectSnapshot): ReturnType<typeof checkedMap> {
  if (!snapshot || typeof snapshot.mapJson !== 'string' || typeof snapshot.contentHash !== 'string'
    || !Number.isFinite(snapshot.savedAt) || snapshot.savedAt < 0) {
    throw new ProjectPersistenceError('PROJECT_INVALID_SNAPSHOT', '工程快照格式损坏。');
  }
  const loaded = checkedMap(snapshot.mapJson);
  if (loaded.contentHash !== snapshot.contentHash) throw new ProjectPersistenceError('PROJECT_HASH_MISMATCH', '工程快照摘要与地图正文不一致。');
  return loaded;
}
function checkRecord(record: StoredProject, projectId: string): void {
  if (record.formatVersion !== 1) throw new ProjectPersistenceError('PROJECT_VERSION_UNSUPPORTED', '不支持此浏览器工程存储版本；原记录未改变。');
  if (record.projectId !== projectId || typeof record.name !== 'string' || !Number.isSafeInteger(record.storageVersion) || record.storageVersion < 1
    || !Number.isFinite(record.createdAt) || !Number.isFinite(record.updatedAt)
    || !Object.hasOwn(record, 'draft') || !Object.hasOwn(record, 'checkpoint') || !Object.hasOwn(record, 'previousCheckpoint')) {
    throw new ProjectPersistenceError('PROJECT_RECORD_INVALID', '浏览器工程记录格式损坏；原记录未改变。');
  }
}

/** Owns storage identities and confirmed baselines, never editor commands, history or renderer state. */
export class ProjectController {
  private ready = false;
  private active: Context | null = null;
  private error: ProjectPersistenceError | null = null;
  private initializePromise: Promise<ProjectRecovery | null> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<() => void>();
  private navigation = 0;
  private startupWarnings: Issue[] = [];

  constructor(private readonly store: ProjectStorePort, private readonly now: () => number = Date.now) {}

  get state(): ProjectControllerState {
    const active = this.active;
    return {
      ready: this.ready, saving: (active?.pending ?? 0) > 0, error: this.error,
      active: active ? { projectId: active.projectId, name: active.name, storageVersion: active.record?.storageVersion ?? null, draftHash: active.draftHash, checkpointHash: active.checkpointHash } : null,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  private emit(): void { this.listeners.forEach(listener => listener()); }
  private required(): Context {
    if (!this.ready) throw new ProjectPersistenceError('PROJECT_NOT_READY', '恢复尚未完成，禁止保存以避免空地图覆盖已有工程。');
    if (!this.active) throw new ProjectPersistenceError('PROJECT_NOT_OPEN', '请先新建或打开浏览器工程。');
    return this.active;
  }
  private fail(error: unknown, context?: Context): ProjectPersistenceError {
    const failure = persistenceError(error);
    if (!context || this.active === context) { this.error = failure; this.emit(); }
    return failure;
  }

  /** A single shared promise makes StrictMode/repeated mounting unable to race empty initial data. */
  initialize(preferredProjectId?: string): Promise<ProjectRecovery | null> {
    if (!this.initializePromise) this.initializePromise = (async () => {
      try {
        this.startupWarnings = [];
        let recovered: Awaited<ReturnType<ProjectController['recover']>> | null = null;
        if (preferredProjectId) {
          try { recovered = await this.recover(preferredProjectId); }
          catch (error) {
            if (!(error instanceof ProjectPersistenceError) || error.code !== 'PROJECT_NOT_FOUND') throw error;
            this.startupWarnings.push(warning('PROJECT_RECENT_NOT_FOUND', '本标签页上次工程不存在，尝试恢复最近工程；未修改任何旧记录。'));
          }
        }
        if (!recovered) {
          const projectId = await this.store.getLastProject();
          recovered = projectId && projectId !== preferredProjectId ? await this.recover(projectId) : null;
        }
        if (recovered) {
          this.active = recovered.context;
          recovered.recovery.warnings.unshift(...this.startupWarnings);
          this.startupWarnings = [];
        }
        this.ready = true; this.error = null; this.emit();
        return recovered?.recovery ?? null;
      } catch (error) { this.initializePromise = null; throw this.fail(error); }
    })();
    return this.initializePromise;
  }

  private async recover(projectId: string): Promise<{ context: Context; recovery: ProjectRecovery }> {
    const record = await this.store.get(projectId);
    if (!record) throw new ProjectPersistenceError('PROJECT_NOT_FOUND', '浏览器中找不到该工程；当前编辑未替换。');
    checkRecord(record, projectId);
    const warnings: Issue[] = [];
    const snapshots: Partial<Record<'draft' | 'checkpoint' | 'previousCheckpoint', ReturnType<typeof checkedMap>>> = {};
    for (const key of ['draft', 'checkpoint', 'previousCheckpoint'] as const) {
      const snapshot = record[key];
      if (snapshot) {
        try { snapshots[key] = checkedSnapshot(snapshot); }
        catch (error) {
          const failure = persistenceError(error);
          warnings.push(warning(failure.code, `${key} 无法恢复：${failure.message} 原记录已保留。`));
        }
      }
    }
    const source = (['draft', 'checkpoint', 'previousCheckpoint'] as const).find(key => snapshots[key]);
    if (!source) throw new ProjectPersistenceError('PROJECT_NO_VALID_SNAPSHOT', '工程没有可用地图快照；不会写入空地图。', warnings);
    const loaded = snapshots[source]!;
    let editorState: EditorState | null = null;
    try {
      const state = await this.store.readEditorState(projectId);
      if (state) editorState = validateEditorState(state);
    } catch (error) { warnings.push(warning('EDITOR_STATE_RECOVERY_FAILED', `地图已恢复，但视窗状态未恢复：${persistenceError(error).message}`)); }
    return {
      context: { projectId, name: record.name, mapName: loaded.map.metadata.name, record: structuredClone(record), draftHash: loaded.contentHash, checkpointHash: snapshots.checkpoint?.contentHash ?? null, pending: 0, editorState },
      recovery: { projectId, map: loaded.map, editorState: editorState ? structuredClone(editorState) : null, source, warnings },
    };
  }

  async open(projectId: string): Promise<ProjectRecovery> {
    await this.initialize();
    const navigation = ++this.navigation;
    try {
      const recovered = await this.recover(projectId);
      if (navigation !== this.navigation) throw new ProjectPersistenceError('PROJECT_CHANGED', '已启动另一项工程打开操作，请保留最新选择。');
      await this.store.setLastProject(projectId);
      if (navigation !== this.navigation) throw new ProjectPersistenceError('PROJECT_CHANGED', '工程已切换，忽略过期的打开结果。');
      this.active = recovered.context; this.error = null; this.emit();
      return recovered.recovery;
    } catch (error) { throw navigation === this.navigation ? this.fail(error) : persistenceError(error); }
  }

  async create(projectId: string, map: YardMap, editorState?: EditorState): Promise<ProjectRecovery> {
    await this.initialize();
    try {
      if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(projectId)) throw new ProjectPersistenceError('PROJECT_ID_INVALID', '浏览器工程 ID 格式无效。');
      const loaded = checkedMap(serializeMap(map));
      const view = editorState ? validateEditorState(editorState) : null;
      // No writes here: creation, recovery and persistence are separate operations.
      ++this.navigation;
      this.active = { projectId, name: loaded.map.metadata.name, mapName: loaded.map.metadata.name, record: null, draftHash: null, checkpointHash: null, pending: 0, editorState: view };
      this.error = null; this.emit();
      const warnings = this.startupWarnings; this.startupWarnings = [];
      return { projectId, map: loaded.map, editorState: view ? structuredClone(view) : null, source: 'new', warnings };
    } catch (error) { throw this.fail(error); }
  }

  async list(): Promise<ProjectSummary[]> {
    await this.initialize();
    try { return (await this.store.list()).sort((a, b) => b.updatedAt - a.updatedAt || a.projectId.localeCompare(b.projectId)); }
    catch (error) { throw this.fail(error); }
  }

  /** Save an isolated recovery copy without selecting it or changing the last-open project. */
  async backup(projectId: string, map: YardMap): Promise<ProjectSummary> {
    await this.initialize();
    if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(projectId)) throw this.fail(new ProjectPersistenceError('PROJECT_ID_INVALID', '恢复副本 ID 格式无效。'));
    try {
      const mapJson = serializeMap(map);
      const loaded = checkedMap(mapJson);
      const savedAt = this.now();
      const snapshot: ProjectSnapshot = { mapJson, contentHash: loaded.contentHash, savedAt };
      const record: StoredProject = { formatVersion: 1, projectId, name: `${loaded.map.metadata.name}（恢复副本）`, storageVersion: 1, createdAt: savedAt, updatedAt: savedAt, draft: snapshot, checkpoint: snapshot, previousCheckpoint: null };
      await this.store.commit(record, null);
      return { projectId, name: record.name, storageVersion: 1, updatedAt: savedAt, hasDraft: true, hasCheckpoint: true };
    } catch (error) { throw this.fail(error); }
  }
  /** Capture A before queuing. Receipts/baselines refer to A even if the UI now contains B. */
  save(map: YardMap, kind: SaveKind = 'draft'): Promise<SaveReceipt> {
    let context: Context; let mapJson: string; let loaded: ReturnType<typeof checkedMap>;
    try {
      context = this.required(); mapJson = serializeMap(map); loaded = checkedMap(mapJson);
      if (kind !== 'draft' && kind !== 'checkpoint') throw new ProjectPersistenceError('PROJECT_SAVE_KIND_INVALID', '未知保存类型。');
    } catch (error) { return Promise.reject(this.fail(error)); }
    context.pending += 1; this.error = null; this.emit();
    const task = this.queue.then(async (): Promise<SaveReceipt> => {
      if (this.active !== context) throw new ProjectPersistenceError('PROJECT_CHANGED', '排队保存尚未开始时工程已切换；未写入过期地图。');
      const old = context.record;
      const savedAt = this.now();
      const snapshot: ProjectSnapshot = { mapJson, contentHash: loaded.contentHash, savedAt };
      const record: StoredProject = {
        formatVersion: 1, projectId: context.projectId, name: loaded.map.metadata.name === context.mapName ? context.name : loaded.map.metadata.name,
        storageVersion: (old?.storageVersion ?? 0) + 1, createdAt: old?.createdAt ?? savedAt, updatedAt: savedAt,
        draft: snapshot, checkpoint: kind === 'checkpoint' ? snapshot : old?.checkpoint ?? null,
        previousCheckpoint: kind === 'checkpoint' ? old?.checkpoint ?? old?.previousCheckpoint ?? null : old?.previousCheckpoint ?? null,
      };
      await this.store.commit(record, old?.storageVersion ?? null);
      // The adapter resolves only after oncomplete, so this is a confirmed storage baseline.
      context.record = record; context.name = record.name; context.mapName = loaded.map.metadata.name; context.draftHash = snapshot.contentHash;
      if (kind === 'checkpoint') context.checkpointHash = snapshot.contentHash;
      if (this.active === context) {
        this.error = null;
        try {
          await this.store.setLastProject(context.projectId);
          if (context.editorState) await this.store.writeEditorState(context.projectId, context.editorState);
        } catch (error) {
          // The map is already committed; do not roll its confirmed baseline back over auxiliary failure.
          this.error = new ProjectPersistenceError('PROJECT_AUX_SAVE_FAILED', `地图已保存，但最近工程或视窗状态未保存：${persistenceError(error).message}`);
        }
      }
      return { projectId: context.projectId, storageVersion: record.storageVersion, contentHash: snapshot.contentHash, kind, savedAt };
    }).catch(error => { throw this.fail(error, context); }).finally(() => { context.pending -= 1; this.emit(); });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  async saveEditorState(value: EditorState): Promise<void> {
    const context = this.required();
    try {
      context.editorState = validateEditorState(value);
      if (!context.record) return; // First map commit writes its pending view; no orphan recovery records.
      await this.store.writeEditorState(context.projectId, context.editorState);
    } catch (error) { throw this.fail(error, context); }
  }

  /** Detect changes on focus without ever replacing the user's in-memory map. */
  async checkExternalVersion(): Promise<boolean> {
    const context = this.required();
    // A local transaction may have committed before its completion acknowledgement reaches us.
    // The queued save still performs CAS; a focus event must not call that our own write a conflict.
    if (context.pending > 0) return false;
    const expectedVersion = context.record?.storageVersion ?? null;
    try {
      const record = await this.store.get(context.projectId);
      if (this.active !== context || context.pending > 0 || (context.record?.storageVersion ?? null) !== expectedVersion) return false;
      const changed = (record?.storageVersion ?? null) !== expectedVersion;
      if (changed) {
        this.error = new ProjectPersistenceError('PROJECT_CONFLICT', '另一标签页已保存此工程。当前编辑未替换；请重载或另存恢复副本。'); this.emit();
      }
      return changed;
    } catch (error) { throw this.fail(error, context); }
  }
}
