import type { Issue, YardMap } from '../domain/model';
import { applyMapCommand, freezeMap, type MapCommand, type Transaction } from '../domain/commands';
import { contentHash, serializeMap } from '../domain/serialization';
import { loadMap, type LoadResult } from '../domain/load';
import { validateMap } from '../validation/validate';

export interface EditorSession {
  map: YardMap;
  past: Transaction[];
  future: Transaction[];
  acknowledgedHash: string | null;
  changeToken: number;
}
export interface SessionResult { ok: boolean; session: EditorSession; issues: Issue[] }
export interface ImportProposal {
  status: 'ready' | 'conflict';
  loaded: Extract<LoadResult, { ok: true }>;
  baseToken: number;
}
export type ImportPreparation = ImportProposal | { status: 'invalid'; issues: Issue[] };
const HISTORY_LIMIT = 100;

export function createSession(map: YardMap, saved = false): EditorSession {
  const result = validateMap(map);
  if (!result.ok) throw new Error('Cannot create session from invalid map.');
  return { map: freezeMap(structuredClone(map)), past: [], future: [], acknowledgedHash: saved ? contentHash(map) : null, changeToken: 0 };
}

export function isDirty(session: EditorSession): boolean {
  return session.acknowledgedHash !== contentHash(session.map);
}

export function editSession(session: EditorSession, command: MapCommand): SessionResult {
  const result = applyMapCommand(session.map, command);
  if (!result.ok) return { ok: false, session, issues: result.issues };
  if (!result.changed || !result.transaction) return { ok: true, session, issues: [] };
  return {
    ok: true, issues: [],
    session: { ...session, map: result.map, past: [...session.past, result.transaction].slice(-HISTORY_LIMIT), future: [], changeToken: session.changeToken + 1 },
  };
}

export function undoSession(session: EditorSession): EditorSession {
  const transaction = session.past.at(-1);
  if (!transaction) return session;
  return { ...session, map: transaction.before, past: session.past.slice(0, -1), future: [...session.future, transaction], changeToken: session.changeToken + 1 };
}

export function redoSession(session: EditorSession): EditorSession {
  const transaction = session.future.at(-1);
  if (!transaction) return session;
  return { ...session, map: transaction.after, future: session.future.slice(0, -1), past: [...session.past, transaction], changeToken: session.changeToken + 1 };
}

/** Import/committed persistence acknowledgement only; export never calls this. Storage targets own their separate confirmed hashes. */
export function acknowledgeMap(session: EditorSession, expectedHash = contentHash(session.map)): EditorSession {
  if (expectedHash !== contentHash(session.map)) return session;
  return { ...session, acknowledgedHash: expectedHash };
}

export function prepareImport(session: EditorSession, text: string): ImportPreparation {
  const loaded = loadMap(text);
  if (!loaded.ok) return { status: 'invalid', issues: loaded.report.issues };
  return { status: isDirty(session) ? 'conflict' : 'ready', loaded, baseToken: session.changeToken };
}

export function resolveImport(session: EditorSession, proposal: ImportProposal, action: 'cancel' | 'replace'): SessionResult {
  if (action === 'cancel') return { ok: true, session, issues: [] };
  if (proposal.baseToken !== session.changeToken) return {
    ok: false, session, issues: [{
      code: 'STALE_IMPORT', severity: 'error', jsonPath: '', message: '候选准备后当前地图已改变，请重新载入候选文件。',
      suggestedAction: '取消本次导入，保留当前编辑并重新选择 JSON。',
    }],
  };
  // Revalidate the candidate before replacement; public callers cannot bypass the shared import gate.
  const checked = validateMap(proposal.loaded.map);
  if (!checked.ok) return { ok: false, session, issues: checked.issues };
  let text: string;
  try { text = serializeMap(proposal.loaded.map); }
  catch (error) { return { ok: false, session, issues: [{ code: 'INVALID_IMPORT_CANDIDATE', severity: 'error', jsonPath: '', message: error instanceof Error ? error.message : '候选不能序列化。', suggestedAction: '减少候选内容至规范化后不超过 10 MiB，然后重新导入。' }] }; }
  const loaded = loadMap(text);
  if (!loaded.ok) return { ok: false, session, issues: loaded.report.issues };
  return { ok: true, issues: [], session: { ...createSession(loaded.map, true), changeToken: session.changeToken + 1 } };
}
