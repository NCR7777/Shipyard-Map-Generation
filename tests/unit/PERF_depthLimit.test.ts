import { describe, expect, it } from 'vitest';
import { validateMap } from '../../src/validation/validate';
import { parseMap, serializeMap } from '../../src/domain/serialization';
import { newMap } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';

// A map that validates must also reopen: the saved file's bracket depth is the key depth of its deepest container plus one.
function nested(depth: number): YardMap {
  const map = newMap('map_depth', 'depth');
  let deepest: Record<string, unknown> = {};
  const payload = deepest;
  // extensions (1) → namespace (2) → payload chain; the last object sits at key depth `depth`.
  for (let level = 3; level <= depth; level++) { const next = {}; deepest.a = next; deepest = next; }
  map.extensionNamespaces = { 'org.example.depth': { version: '1.0.0', category: 'metadata' } } as YardMap['extensionNamespaces'];
  map.extensions = { 'org.example.depth': payload };
  return map;
}

describe('JSON depth limit shared by validation and parsing', () => {
  it('accepts the deepest container that still reopens and rejects one level deeper', () => {
    const ok = nested(63);
    expect(validateMap(ok).ok).toBe(true);
    expect(parseMap(serializeMap(ok)).ok).toBe(true);
    const deep = nested(64);
    expect(validateMap(deep).issues.map(issue => issue.code)).toContain('JSON_DEPTH_LIMIT');
    expect(() => serializeMap(deep)).toThrow();
  });
});
