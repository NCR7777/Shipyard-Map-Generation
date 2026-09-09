import {
  ProjectPersistenceError, persistenceError, validateEditorState,
  type EditorState, type ProjectStorePort, type ProjectSummary, type StoredProject,
} from '../editor/projectController';

const PROJECTS = 'projects';
const META = 'metadata';
const VIEWS = 'editorStates';

/** Browser-only adapter. Map JSON, viewport records and future binary assets are separate stores. */
export class IndexedDBProjectStore implements ProjectStorePort {
  private connection: Promise<IDBDatabase> | null = null;
  constructor(readonly databaseName = 'shipyard-map-projects') {}

  private database(): Promise<IDBDatabase> {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new ProjectPersistenceError('PROJECT_STORAGE_UNAVAILABLE', '当前浏览器不支持 IndexedDB；仍可编辑与导出 JSON。')); return; }
      let failed = false;
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'projectId' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(VIEWS)) db.createObjectStore(VIEWS);
        // No binary-asset support is claimed in M1.1. Future assets must get their own store/version.
      };
      request.onerror = () => { failed = true; this.connection = null; reject(persistenceError(request.error)); };
      request.onblocked = () => {
        failed = true; this.connection = null;
        reject(new ProjectPersistenceError('PROJECT_STORAGE_BLOCKED', '其他页面阻止浏览器工程库升级；请关闭旧页面后重试。'));
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) { db.close(); return; }
        db.onversionchange = () => { db.close(); this.connection = null; };
        resolve(db);
      };
    });
    return this.connection.catch(error => { this.connection = null; throw persistenceError(error); });
  }

  private async read<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      transaction.oncomplete = () => { resolve(request.result === undefined ? null : request.result as T); };
      transaction.onabort = () => { reject(persistenceError(transaction.error)); };
      transaction.onerror = () => { /* onabort is the authoritative failure event. */ };
    });
  }

  private async write(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      transaction.oncomplete = () => { resolve(); };
      transaction.onabort = () => { reject(persistenceError(transaction.error)); };
      transaction.onerror = () => { /* Do not preventDefault: failed requests must abort the transaction. */ };
      try { transaction.objectStore(storeName).put(value, key); }
      catch (error) { transaction.abort(); reject(persistenceError(error)); }
    });
  }

  async list(): Promise<ProjectSummary[]> {
    const db = await this.database();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(PROJECTS, 'readonly');
      const request = transaction.objectStore(PROJECTS).getAll();
      transaction.oncomplete = () => {
        const rows = request.result as StoredProject[];
        if (rows.some(row => !row || typeof row.projectId !== 'string' || typeof row.name !== 'string' || !Number.isFinite(row.updatedAt))) {
          reject(new ProjectPersistenceError('PROJECT_RECORD_INVALID', '最近工程列表含损坏记录；未删除任何工程。')); return;
        }
        resolve(rows.map(row => ({ projectId: row.projectId, name: row.name, storageVersion: row.storageVersion, updatedAt: row.updatedAt, hasDraft: !!row.draft, hasCheckpoint: !!row.checkpoint })));
      };
      transaction.onabort = () => { reject(persistenceError(transaction.error)); };
      transaction.onerror = () => { /* Await abort. */ };
    });
  }

  get(projectId: string): Promise<StoredProject | null> { return this.read(PROJECTS, projectId); }

  async commit(project: StoredProject, expectedVersion: number | null): Promise<void> {
    if (!Number.isSafeInteger(project.storageVersion) || project.storageVersion !== (expectedVersion ?? 0) + 1) {
      throw new ProjectPersistenceError('PROJECT_VERSION_INVALID', '存储版本必须独立递增。');
    }
    const db = await this.database();
    return new Promise((resolve, reject) => {
      // Read and compare and write run in one readwrite transaction. Competing tabs serialize here.
      const transaction = db.transaction(PROJECTS, 'readwrite');
      const store = transaction.objectStore(PROJECTS);
      let failure: ProjectPersistenceError | null = null;
      transaction.oncomplete = () => { resolve(); };
      transaction.onabort = () => { reject(failure ?? persistenceError(transaction.error)); };
      transaction.onerror = () => { /* Request failure aborts; never resolve on put.onsuccess. */ };
      const request = store.get(project.projectId);
      request.onsuccess = () => {
        const existing = request.result as StoredProject | undefined;
        if ((existing?.storageVersion ?? null) !== expectedVersion) {
          failure = new ProjectPersistenceError('PROJECT_CONFLICT', '另一标签页已保存此工程；本次写入已取消，旧版本保持不变。');
          transaction.abort(); return;
        }
        try { store.put(structuredClone(project)); }
        catch (error) { failure = persistenceError(error); transaction.abort(); }
      };
    });
  }

  getLastProject(): Promise<string | null> { return this.read(META, 'lastProjectId'); }
  setLastProject(projectId: string): Promise<void> { return this.write(META, 'lastProjectId', projectId); }
  readEditorState(projectId: string): Promise<EditorState | null> { return this.read(VIEWS, projectId); }
  writeEditorState(projectId: string, state: EditorState): Promise<void> { return this.write(VIEWS, projectId, validateEditorState(state)); }
  async close(): Promise<void> { if (this.connection) (await this.connection).close(); this.connection = null; }
}
