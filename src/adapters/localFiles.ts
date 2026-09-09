import { sha256 } from 'js-sha256';
import { loadMap, type LoadResult } from '../domain/load';
import { MAX_JSON_BYTES, type Issue, type YardMap } from '../domain/model';
import { contentHash, serializeMap } from '../domain/serialization';

/** A narrow port makes tests independent of native permission dialogs. */
export interface LocalFileData { size: number; arrayBuffer(): Promise<ArrayBuffer> }
export interface LocalWritable {
  write(text: string): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}
export interface LocalFileHandle {
  name: string;
  getFile(): Promise<LocalFileData>;
  createWritable(): Promise<LocalWritable>;
  isSameEntry?(other: LocalFileHandle): Promise<boolean>;
}
export interface FilePickerOptions {
  types: { description: string; accept: Record<string, string[]> }[];
  excludeAcceptAllOption: boolean;
  multiple?: boolean;
  suggestedName?: string;
}
export interface FilePickerPort {
  showOpenFilePicker?(options: FilePickerOptions): Promise<LocalFileHandle[]>;
  showSaveFilePicker?(options: FilePickerOptions): Promise<LocalFileHandle>;
}
export interface LocalFileFailure {
  status: 'unsupported' | 'cancelled' | 'busy' | 'unlinked' | 'stale' | 'failure';
  message: string;
  issues?: Issue[];
}
export interface LocalOpenCandidate {
  status: 'opened'; token: number; name: string; text: string; rawHash: string;
  loaded: Extract<LoadResult, { ok: true }>;
}
export interface LocalConflict {
  status: 'conflict'; token: number; name: string; text: string | null; rawHash: string;
  loaded: LoadResult | null; issues: Issue[];
}
export type LocalOpenResult = LocalOpenCandidate | LocalFileFailure;
export type LocalLinkedResult = { status: 'linked'; name: string; contentHash: string } | LocalFileFailure;
export type LocalCheckResult = { status: 'unchanged'; name: string } | LocalConflict | LocalFileFailure;
export type LocalWriteResult = { status: 'saved'; name: string; contentHash: string; rawHash: string } | LocalConflict | LocalFileFailure;
export interface LocalFileSnapshot {
  linkedName: string | null; confirmedContentHash: string | null; confirmedRawHash: string | null;
  conflict: boolean; busy: boolean;
}

interface ReadSnapshot { text: string | null; rawHash: string; loaded: LoadResult | null; issues: Issue[] }
interface Binding { handle: LocalFileHandle; contentHash: string; rawHash: string }
interface PendingOpen { token: number; binding: Binding }
const options: FilePickerOptions = {
  types: [{ description: '船厂地图 JSON', accept: { 'application/json': ['.json'] } }], excludeAcceptAllOption: false,
};
const failure = (status: LocalFileFailure['status'], message: string, issues?: Issue[]): LocalFileFailure => ({ status, message, ...(issues ? { issues } : {}) });
function errorResult(error: unknown): LocalFileFailure {
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'AbortError') return failure('cancelled', '已取消文件操作；地图与文件保存基线不变。');
  if (name === 'NotAllowedError' || name === 'SecurityError') return failure('failure', '本地文件权限未获授权；地图保留，可保存到浏览器或导出 JSON。');
  return failure('failure', error instanceof Error ? error.message : '本地文件操作失败；地图与文件保存基线不变。');
}
function fileIssue(code: string, message: string): Issue {
  return { code, severity: 'error', jsonPath: '', message, suggestedAction: '保留原文件，修正编码或 JSON 后重新载入；当前地图可另存到新文件。' };
}
async function readHandle(handle: LocalFileHandle): Promise<ReadSnapshot> {
  const file = await handle.getFile();
  if (file.size > MAX_JSON_BYTES) throw new Error('本地 JSON 文件超过 10 MiB，未读取或覆盖。');
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength > MAX_JSON_BYTES) throw new Error('本地 JSON 文件超过 10 MiB，未读取或覆盖。');
  const rawHash = sha256(bytes);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { text: null, rawHash, loaded: null, issues: [fileIssue('FILE_UTF8', '本地文件不是有效 UTF-8。')] }; }
  const loaded = loadMap(text);
  return { text, rawHash, loaded, issues: loaded.ok ? [] : loaded.report.issues };
}

/**
 * One controller belongs to one project. Handles are intentionally session-only.
 * UI calls picker/write methods only from an explicit user action. Check never asks permission.
 * This detects observed changes, not an atomic compare-and-swap with external applications.
 */
export class LocalFileController {
  private readonly port: FilePickerPort;
  private binding: Binding | null = null;
  private pending: PendingOpen | null = null;
  private observedConflict: { token: number; rawHash: string } | null = null;
  private sequence = 0;
  private busy = false;

  constructor(port?: FilePickerPort) { this.port = port ?? globalThis as unknown as FilePickerPort; }
  capabilities(): { open: boolean; saveAs: boolean } {
    return { open: typeof this.port.showOpenFilePicker === 'function', saveAs: typeof this.port.showSaveFilePicker === 'function' };
  }
  snapshot(): LocalFileSnapshot {
    return {
      linkedName: this.binding?.handle.name ?? null, confirmedContentHash: this.binding?.contentHash ?? null,
      confirmedRawHash: this.binding?.rawHash ?? null, conflict: this.observedConflict !== null, busy: this.busy,
    };
  }
  /** Switching projects while an operation is in flight is refused, rather than mis-associating a late write. */
  reset(): boolean {
    if (this.busy) return false;
    this.sequence++; this.binding = null; this.pending = null; this.observedConflict = null;
    return true;
  }
  cancelOpen(token: number): void { if (this.pending?.token === token) this.pending = null; }
  acceptOpen(token: number): LocalLinkedResult {
    if (this.busy) return failure('busy', '文件操作进行中，暂不能关联候选。');
    if (!this.pending || this.pending.token !== token) return failure('stale', '文件候选已过期，请重新打开。');
    this.binding = this.pending.binding; this.pending = null; this.observedConflict = null;
    return { status: 'linked', name: this.binding.handle.name, contentHash: this.binding.contentHash };
  }
  async open(): Promise<LocalOpenResult> {
    if (this.busy) return failure('busy', '文件操作进行中。');
    if (!this.port.showOpenFilePicker) return failure('unsupported', '浏览器没有本地文件授权接口；仍可使用普通导入、浏览器保存和 JSON 导出。');
    this.busy = true; this.pending = null;
    try {
      // Call the picker before the first await so the user gesture is still active.
      const handles = await this.port.showOpenFilePicker({ ...options, multiple: false });
      const handle = handles[0];
      if (!handle) return failure('cancelled', '未选择文件。');
      return this.prepareOpen(handle, await readHandle(handle));
    } catch (error) { return errorResult(error); }
    finally { this.busy = false; }
  }
  async readCurrent(): Promise<LocalOpenResult> {
    if (this.busy) return failure('busy', '文件操作进行中。');
    if (!this.binding) return failure('unlinked', '当前工程尚未关联本地文件。');
    this.busy = true; this.pending = null;
    try {
      const read = await readHandle(this.binding.handle);
      if (read.rawHash !== this.binding.rawHash) this.conflictResult(read);
      return this.prepareOpen(this.binding.handle, read);
    } catch (error) { return errorResult(error); }
    finally { this.busy = false; }
  }
  async check(): Promise<LocalCheckResult> {
    if (this.busy) return failure('busy', '文件操作进行中。');
    if (!this.binding) return failure('unlinked', '当前工程尚未关联本地文件。');
    this.busy = true;
    try {
      const read = await readHandle(this.binding.handle);
      if (read.rawHash !== this.binding.rawHash) return this.conflictResult(read);
      this.observedConflict = null;
      return { status: 'unchanged', name: this.binding.handle.name };
    } catch (error) { return errorResult(error); }
    finally { this.busy = false; }
  }
  async write(map: YardMap, overwriteToken?: number): Promise<LocalWriteResult> {
    if (this.busy) return failure('busy', '文件操作进行中。');
    if (!this.binding) return failure('unlinked', '当前工程尚未关联本地文件。');
    this.busy = true; this.pending = null;
    try {
      const text = serializeMap(map); const hash = contentHash(map);
      const read = await readHandle(this.binding.handle);
      if (overwriteToken !== undefined && (!this.observedConflict || overwriteToken !== this.observedConflict.token)) return failure('stale', '覆盖确认已过期，请重新检查外部文件。');
      if (read.rawHash !== this.binding.rawHash) {
        const allowed = overwriteToken !== undefined && this.observedConflict?.token === overwriteToken && this.observedConflict.rawHash === read.rawHash;
        if (!allowed) return this.conflictResult(read);
        if (!read.loaded?.ok) return failure('failure', '外部文件无效，拒绝覆盖原件。请修复外部 JSON，或把当前地图另存到新文件。', read.issues);
      }
      // Consumed before opening a writable stream. Failure needs a new explicit check/confirmation.
      this.observedConflict = null;
      return await this.commit(this.binding.handle, text, hash);
    } catch (error) { return errorResult(error); }
    finally { this.busy = false; }
  }
  async saveAs(map: YardMap): Promise<LocalWriteResult> {
    if (this.busy) return failure('busy', '文件操作进行中。');
    if (!this.port.showSaveFilePicker) return failure('unsupported', '浏览器没有本地另存接口；仍可使用浏览器保存和 JSON 导出。');
    this.busy = true; this.pending = null;
    try {
      // Capture the exact requested map before asynchronous picker/permission work.
      const text = serializeMap(map); const hash = contentHash(map);
      const handle = await this.port.showSaveFilePicker({ ...options, suggestedName: `${map.mapId}.map.json` });
      const read = await readHandle(handle);
      const same = !!this.binding && (handle === this.binding.handle || !!(handle.isSameEntry && await handle.isSameEntry(this.binding.handle)));
      if (same && this.binding && read.rawHash !== this.binding.rawHash) return this.conflictResult(read);
      // Empty newly-created files are expected. Existing invalid contents are never silently erased.
      if (read.text !== '' && !read.loaded?.ok) return failure('failure', '另存目标含无效内容，保留原件；请使用新的文件名。', read.issues);
      const latest = await readHandle(handle);
      if (latest.rawHash !== read.rawHash) return failure('stale', '另存目标在选择后发生变化，未写入；请重新选择文件。');
      return await this.commit(handle, text, hash);
    } catch (error) { return errorResult(error); }
    finally { this.busy = false; }
  }
  private prepareOpen(handle: LocalFileHandle, read: ReadSnapshot): LocalOpenResult {
    if (read.text === null || !read.loaded?.ok) return failure('failure', '文件未通过共同解析与校验，当前地图及关联保持不变。', read.issues);
    const token = ++this.sequence;
    this.pending = { token, binding: { handle, rawHash: read.rawHash, contentHash: read.loaded.contentHash } };
    return { status: 'opened', token, name: handle.name, text: read.text, rawHash: read.rawHash, loaded: read.loaded };
  }
  private conflictResult(read: ReadSnapshot): LocalConflict {
    if (!this.binding) throw new Error('Cannot create a file conflict without a linked file.');
    const token = this.observedConflict?.rawHash === read.rawHash ? this.observedConflict.token : ++this.sequence;
    this.observedConflict = { token, rawHash: read.rawHash };
    return { status: 'conflict', token, name: this.binding.handle.name, ...read };
  }
  private async commit(handle: LocalFileHandle, text: string, hash: string): Promise<LocalWriteResult> {
    const writable = await handle.createWritable();
    try { await writable.write(text); await writable.close(); }
    catch (error) {
      // Best effort cleanup; a failed close is never reported as confirmed persistence.
      try { await writable.abort?.(); } catch { /* Keep the original write/close error. */ }
      throw error;
    }
    const rawHash = sha256(text);
    this.binding = { handle, contentHash: hash, rawHash }; this.pending = null; this.observedConflict = null;
    return { status: 'saved', name: handle.name, contentHash: hash, rawHash };
  }
}
