import { sha256 } from 'js-sha256';
import { parseTree, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { MAX_JSON_BYTES, type Issue, type YardMap } from './model';
import { validateMap } from '../validation/validate';

export type ParseResult = { ok: true; map: YardMap } | { ok: false; issues: Issue[] };

function escapePointer(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1'); }

function utf8Size(text: string): number {
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    size += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (size > MAX_JSON_BYTES) break;
  }
  return size;
}

function textIssue(text: string, code: string, jsonPath: string, message: string, offset = 0): Issue {
  const prefix = text.slice(0, offset).split('\n');
  return { code, severity: 'error', jsonPath, message, suggestedAction: '修改对应 JSON 字段后重新导入。', location: { line: prefix.length, column: (prefix.at(-1)?.length ?? 0) + 1 } };
}

export function parseMap(text: string): ParseResult {
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
  return { ok: true, map: value as YardMap };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortKeys(child)]));
  return value;
}

export function serializeMap(map: YardMap): string {
  const report = validateMap(map);
  if (!report.ok) throw new Error(`Cannot serialize invalid map: ${report.issues.find(i => i.severity === 'error')?.code}`);
  return JSON.stringify(sortKeys(map), null, 2) + '\n';
}

export function contentHash(map: YardMap): string {
  const declared = { ...map } as Partial<YardMap>;
  delete declared.revision;
  return sha256(JSON.stringify(sortKeys(declared)));
}