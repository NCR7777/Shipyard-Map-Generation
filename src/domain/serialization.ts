import { sha256 } from 'js-sha256';
import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { ENTITY_RECORDS, MAX_JSON_BYTES, type Issue, type ValidationReport, type YardMap } from './model';
import { validateMap } from '../validation/validate';
import { isDeepFrozen } from './value';

export type ParseResult = { ok: true; map: YardMap } | { ok: false; issues: Issue[] };

function escapePointer(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1'); }

/** UTF-8 bytes of the code points; a lone surrogate counts as its 3-byte replacement. */
export function utf8Size(text: string): number {
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size += 1;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { size += 4; i++; }
    else size += 3;
    if (size > MAX_JSON_BYTES) break;
  }
  return size;
}

function textIssue(text: string, code: string, jsonPath: string, message: string, offset = 0): Issue {
  const prefix = text.slice(0, offset).split('\n');
  return { code, severity: 'error', jsonPath, message, suggestedAction: '修改对应 JSON 字段后重新导入。', location: { line: prefix.length, column: (prefix.at(-1)?.length ?? 0) + 1 } };
}

export function parseMap(text: string): ParseResult {
  const parsed = parseMapWithReport(text);
  return parsed.ok ? { ok: true, map: parsed.map } : parsed;
}
/** parseMap plus the draft report it computed, so loaders need not validate the same map twice. */
export function parseMapWithReport(text: string): { ok: true; map: YardMap; report: ValidationReport } | { ok: false; issues: Issue[] } {
  if (utf8Size(text) > MAX_JSON_BYTES) return { ok: false, issues: [textIssue(text, 'JSON_SIZE_LIMIT', '', 'JSON 超过 10 MiB。')] };
  // Check depth before invoking recursive JSON parsers. Braces inside strings do not count.
  let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
    else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') {
      depth++;
      if (depth > 64) return { ok: false, issues: [textIssue(text, 'JSON_DEPTH_LIMIT', '', 'JSON 嵌套超过 64 层。', i)] };
    } else if (char === '}' || char === ']') {
      depth--;
      if (depth < 0) return { ok: false, issues: [textIssue(text, 'JSON_SYNTAX', '', 'JSON 闭合符不匹配。', i)] };
    }
  }
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  if (errors.length > 0 || !tree) return { ok: false, issues: errors.length ? errors.map(e => textIssue(text, 'JSON_SYNTAX', '', printParseErrorCode(e.error), e.offset)) : [textIssue(text, 'JSON_SYNTAX', '', 'JSON 为空。')] };
  const issues: Issue[] = [];
  function inspect(node: Node, path: string): void {
    if (node.type === 'object') {
      const keys = new Set<string>();
      for (const property of node.children ?? []) {
        const key = property.children?.[0]; const value = property.children?.[1];
        if (!key || !value) continue;
        const name = String(key.value);
        const childPath = `${path}/${escapePointer(name)}`;
        if (keys.has(name)) issues.push(textIssue(text, 'DUPLICATE_KEY', childPath, `重复对象键：${name}`, key.offset));
        keys.add(name); inspect(value, childPath);
      }
    } else if (node.type === 'array') node.children?.forEach((child, index) => inspect(child, `${path}/${index}`));
    else if (node.type === 'number' && !Number.isFinite(node.value)) issues.push(textIssue(text, 'NON_FINITE_NUMBER', path, '数字必须为有限值。', node.offset));
  }
  inspect(tree, '');
  if (issues.length) return { ok: false, issues };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { ok: false, issues: [textIssue(text, 'JSON_SYNTAX', '', 'JSON 解析失败。')] }; }
  const report = validateMap(value);
  if (!report.ok) return { ok: false, issues: report.issues };
  // Sorting keys changes no byte count, so the canonical file size is measured without sorting.
  const canonical = JSON.stringify(value, null, 2) + '\n';
  if (utf8Size(canonical) > MAX_JSON_BYTES) return { ok: false, issues: [textIssue(text, 'JSON_SIZE_LIMIT', '', '规范化 JSON 超过 10 MiB，请拆分地图或减少扩展内容。')] };
  return { ok: true, map: value as YardMap, report };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortKeys(child)]));
  return value;
}

export function serializeMap(map: YardMap): string {
  const report = validateMap(map);
  if (!report.ok) throw new Error(`Cannot serialize invalid map: ${report.issues.find(i => i.severity === 'error')?.code}`);
  const text = JSON.stringify(sortKeys(map), null, 2) + '\n';
  if (utf8Size(text) > MAX_JSON_BYTES) throw new RangeError('JSON_SIZE_LIMIT: 规范化 JSON 超过 10 MiB。');
  return text;
}

// Canonical text = JSON.stringify(sortKeys(value)). Unchanged frozen entities keep theirs, so a hash after an edit
// re-serializes only what changed. Key order replays what that expression produces: array-index keys first, ascending.
const RECORDS = new Set<string>([...ENTITY_RECORDS, 'extensions', 'extensionNamespaces']);
const entityTexts = new WeakMap<object, string>();
const isArrayIndex = (key: string) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
function canonicalKeys(value: object): string[] {
  const keys = Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const indices = keys.filter(isArrayIndex);
  return indices.length ? [...indices.sort((a, b) => Number(a) - Number(b)), ...keys.filter(key => !isArrayIndex(key))] : keys;
}
function entityText(value: unknown): string {
  if (value === null || typeof value !== 'object' || !Object.isFrozen(value)) return JSON.stringify(sortKeys(value));
  let text = entityTexts.get(value);
  if (text === undefined) { text = JSON.stringify(sortKeys(value)); entityTexts.set(value, text); }
  return text;
}
function recordText(record: Record<string, unknown>): string {
  return '{' + canonicalKeys(record).map(key => JSON.stringify(key) + ':' + entityText(record[key])).join(',') + '}';
}
/** Declared content (everything except revision) as canonical JSON. */
export function canonicalContent(map: YardMap): string {
  const declared = map as unknown as Record<string, unknown>;
  return '{' + canonicalKeys(declared).filter(key => key !== 'revision').map(key => JSON.stringify(key) + ':'
    + (RECORDS.has(key) && declared[key] !== null && typeof declared[key] === 'object' && !Array.isArray(declared[key]) ? recordText(declared[key] as Record<string, unknown>) : JSON.stringify(sortKeys(declared[key])))).join(',') + '}';
}
const hashes = new WeakMap<object, string>();
export function contentHash(map: YardMap): string {
  if (!isDeepFrozen(map)) return sha256(canonicalContent(map));
  let hash = hashes.get(map);
  if (hash === undefined) { hash = sha256(canonicalContent(map)); hashes.set(map, hash); }
  return hash;
}