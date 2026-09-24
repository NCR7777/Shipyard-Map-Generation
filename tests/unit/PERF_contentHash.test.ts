import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalContent, contentHash } from '../../src/domain/serialization';
import { applyMapCommand, freezeMap } from '../../src/domain/commands';
import { newMap, newNode } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';

function legacyCanonical(map: YardMap): string {
  const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sortKeys(child)])) : value;
  const declared = { ...map } as Partial<YardMap>; delete declared.revision;
  return JSON.stringify(sortKeys(declared));
}

describe('per-edit content hash', () => {
  it('keeps the historical canonical text while reusing unchanged entities across an edit', () => {
    const base = newMap('map_hash', '哈希');
    base.nodes = { n1: newNode([0, 0, 0], 'A'), n2: newNode([10, 0, 0], 'B') };
    // Array-index-like payload keys serialize first; the canonical text must keep that order.
    base.extensionNamespaces = { 'org.example.hash': { version: '1.0.0', category: 'metadata' } } as YardMap['extensionNamespaces'];
    base.extensions = { 'org.example.hash': { '10': 1, '9': 2, b: { '2': 'x', '1': 'y' } } };
    const map = freezeMap(structuredClone(base));
    expect(canonicalContent(map)).toBe(legacyCanonical(map));
    const moved = applyMapCommand(map, { type: 'updateNode', id: 'n2', patch: { position: [12, 1, 0] } });
    if (!moved.ok) throw new Error(moved.issues[0]?.code);
    expect(moved.map.nodes.n1).toBe(map.nodes.n1);
    expect(canonicalContent(moved.map)).toBe(legacyCanonical(moved.map));
    expect(contentHash(moved.map)).toBe(createHash('sha256').update(legacyCanonical(moved.map), 'utf8').digest('hex'));
  });
});
