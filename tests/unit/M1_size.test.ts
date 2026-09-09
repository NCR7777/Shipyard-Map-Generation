import { describe, expect, it } from 'vitest';
import { MAX_JSON_BYTES } from '../../src/domain/model';
import { parseMap, serializeMap } from '../../src/domain/serialization';
import { validateMap } from '../../src/validation/validate';
import { createSession, editSession, prepareImport, resolveImport } from '../../src/editor/session';
import { editorFixture } from '../helpers/M1_fixtures';

function oversizedCanonicalMap() {
  const map = editorFixture();
  let payload: unknown = Array.from({ length: 150_000 }, () => 0);
  for (let level = 0; level < 40; level += 1) payload = { next: payload };
  map.extensionNamespaces['example.size'] = { version: '1', category: 'metadata' };
  map.extensions['example.size'] = payload;
  return map;
}

describe('M1 import/export capacity remains a closed contract', () => {
  it('rejects compact input below 10 MiB when its required canonical JSON would exceed the limit', () => {
    const map = oversizedCanonicalMap();
    const compact = JSON.stringify(map);
    expect(Buffer.byteLength(compact, 'utf8')).toBeLessThan(MAX_JSON_BYTES);
    expect(Buffer.byteLength(JSON.stringify(map, null, 2), 'utf8')).toBeGreaterThan(MAX_JSON_BYTES);
    expect(validateMap(map).ok).toBe(true);
    const result = parseMap(compact);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Unexportable canonical map accepted.');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'JSON_SIZE_LIMIT' })]));
  });

  it('refuses an oversized canonical export rather than producing a file the importer cannot reopen', () => {
    expect(() => serializeMap(oversizedCanonicalMap())).toThrow(/JSON_SIZE_LIMIT/);
  });

  it('rejects an oversized name command atomically and preserves map, history, and saved identity', () => {
    const initial = createSession(editorFixture(), true);
    const before = serializeMap(initial.map);
    const result = editSession(initial, {
      type: 'updateNode', id: 'nB', patch: { name: 'x'.repeat(MAX_JSON_BYTES + 1) },
    });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'JSON_SIZE_LIMIT' })]));
    expect(result.session).toBe(initial);
    expect(serializeMap(result.session.map)).toBe(before);
    expect(result.session.past).toHaveLength(0);
    expect(result.session.savedHash).toBe(initial.savedHash);
  });

  it('returns a structured refusal if a prepared candidate is subsequently enlarged past the export limit', () => {
    const initial = createSession(editorFixture(), true);
    const proposal = prepareImport(initial, serializeMap(editorFixture()));
    if (proposal.status === 'invalid') throw new Error('Valid fixture rejected.');
    const oversized = oversizedCanonicalMap();
    proposal.loaded.map.extensionNamespaces = oversized.extensionNamespaces;
    proposal.loaded.map.extensions = oversized.extensions;
    const result = resolveImport(initial, proposal, 'replace');
    expect(result.ok).toBe(false);
    expect(result.session).toBe(initial);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'INVALID_IMPORT_CANDIDATE', message: expect.stringContaining('JSON_SIZE_LIMIT') }),
    ]));
  });
});
