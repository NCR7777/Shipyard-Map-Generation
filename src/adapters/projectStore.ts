import { rasterBytes } from './rasterFiles';
import {
  ProjectPersistenceError, persistenceError, validateEditorState,
  type EditorState, type EditorStateInput, type ProjectStorePort, type ProjectSummary, type StoredProject, type RasterAssetBytes, type RasterAssetStorePort,
} from '../editor/projectController';

const PROJECTS = 'projects';
const META = 'metadata';
const VIEWS = 'editorStates';
const ASSETS = 'assetBlobs';

/** Browser-only adapter. Map JSON, viewport records and future binary assets are separate stores. */
export class IndexedDBProjectStore implements ProjectStorePort, RasterAssetStorePort {
  private connection: Promise<IDBDatabase> | null = null;
  constructor(readonly databaseName = 'shipyard-map-projects') {}

  private database(): Promise<IDBDatabase> {
    if (!this.connection) this.connection = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new ProjectPersistenceError('PROJECT_STORAGE_UNAVAILABLE', '当前浏览器不支持 IndexedDB；仍可编辑与导出 JSON。')); return; }
      let failed = false;
      const request = indexedDB.open(this.databaseName, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'projectId' });
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
        if (!db.objectStoreNames.contains(VIEWS)) db.createObjectStore(VIEWS);
        if (!db.objectStoreNames.contains(ASSETS)) {
          const assets = db.createObjectStore(ASSETS, { keyPath: ['projectId', 'sha256'] });
          assets.createIndex('sha256', 'sha256', { unique: false });
        }
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
  readEditorState(projectId: string): Promise<EditorStateInput | null> { return this.read(VIEWS, projectId); }
  writeEditorState(projectId: string, state: EditorState): Promise<void> { return this.write(VIEWS, projectId, validateEditorState(state)); }
  async putAssetBytes(projectId: string, asset: RasterAssetBytes): Promise<void> {
    this.checkAssetKey(projectId, asset.sha256);
    const checked = await rasterBytes(asset.bytes);
    if (checked.sha256 !== asset.sha256 || checked.width !== asset.width || checked.height !== asset.height || checked.mimeType !== asset.mimeType) {
      throw new ProjectPersistenceError('ASSET_HASH_MISMATCH', '底图字节、摘要或尺寸不匹配，未保存。');
    }
    const db = await this.database();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(ASSETS, 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(persistenceError(transaction.error));
      transaction.onerror = () => { /* Completion, not request success, confirms durable bytes. */ };
      try { transaction.objectStore(ASSETS).put({ projectId, ...checked }); }
      catch (error) { transaction.abort(); reject(persistenceError(error)); }
    });
  }

  async getAssetBytes(projectId: string, sha256: string): Promise<RasterAssetBytes | null> {
    this.checkAssetKey(projectId, sha256);
    const db = await this.database();
    const found = await new Promise<(RasterAssetBytes & { projectId: string }) | null>((resolve, reject) => {
      const transaction = db.transaction(ASSETS, 'readonly'), store = transaction.objectStore(ASSETS);
      let result: (RasterAssetBytes & { projectId: string }) | null = null;
      const own = store.get([projectId, sha256]);
      own.onsuccess = () => {
        if (own.result) result = own.result;
        else {
          const shared = store.index('sha256').get(sha256);
          shared.onsuccess = () => { result = shared.result ?? null; };
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(persistenceError(transaction.error));
      transaction.onerror = () => { /* Await abort. */ };
    });
    if (!found) return null;
    const checked = await rasterBytes(found.bytes);
    if (found.sha256 !== sha256 || checked.sha256 !== sha256 || checked.width !== found.width || checked.height !== found.height || checked.mimeType !== found.mimeType) {
      throw new ProjectPersistenceError('ASSET_HASH_MISMATCH', '已存底图校验失败；未使用错误图片，可重新选择原始文件。');
    }
    // Reimport into another project reuses only bytes validated against the declared hash.
    if (found.projectId !== projectId) await this.putAssetBytes(projectId, checked);
    return checked;
  }

  private checkAssetKey(projectId: string, sha256: string): void {
    if (typeof projectId !== 'string' || !projectId || projectId.length > 200 || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new ProjectPersistenceError('ASSET_KEY_INVALID', '底图存储需要有效工程 ID 和 SHA-256 摘要。');
    }
  }

  async close(): Promise<void> { if (this.connection) (await this.connection).close(); this.connection = null; }
}
