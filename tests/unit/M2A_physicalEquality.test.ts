import { describe, expect, it } from 'vitest';
import { applyMapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import { serializeMap } from '../../src/domain/serialization';
import { editorFixture } from '../helpers/M1_fixtures';

describe('M2A physical value equality is semantic, independent of JSON object-key order', () => {
  it('keeps an untouched sourced value unchanged after canonical import and form reconstruction', () => {
    const input = editorFixture();
    input.sources.source_width = { name: '已声明宽度依据', category: 'drawing', description: '原文件已声明的来源。' };
    input.roads.rAB!.widthM = { state: 'known', value: 12, sourceRef: 'source_width' };
    const loaded = loadMap(serializeMap(input));
    if (!loaded.ok) throw new Error('fixture must be valid');
    expect(Object.keys(loaded.map.roads.rAB!.widthM)).toEqual(['sourceRef', 'state', 'value']);
    const result = applyMapCommand(loaded.map, { type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 12, sourceRef: 'source_width' } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(result.map).toBe(loaded.map);
    expect(result.map.roads.rAB!.provenance.fieldSources).toBeUndefined();
  });

  it('does not demand a new assumption for an unchanged legacy known value with reordered keys', () => {
    const input = editorFixture();
    input.roads.rAB!.widthM = { value: 12, state: 'known' };
    const result = applyMapCommand(input, { type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 12 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
    expect(Object.keys(result.map.sources)).toHaveLength(0);
    expect(result.map.roads.rAB!.provenance.fieldSources).toBeUndefined();
  });

  it('still requires explicit assumption when the numeric value actually changes', () => {
    const input = editorFixture(); input.roads.rAB!.widthM = { value: 12, state: 'known' };
    const result = applyMapCommand(input, { type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 13 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.code).toBe('KNOWN_SOURCE_REQUIRED');
    expect(input.roads.rAB!.widthM).toEqual({ value: 12, state: 'known' });
  });
});
