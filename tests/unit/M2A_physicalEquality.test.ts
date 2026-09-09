import { describe, expect, it } from 'vitest';
import { applyMapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import { serializeMap } from '../../src/domain/serialization';
import { editorFixture } from '../helpers/M1_fixtures';
import { makePhysicalDraft, parsePhysicalDraft } from '../../src/ui/RoadPhysicalFields';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';

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

describe('road width uses the shared physical form and transaction', () => {
  it('preserves declared width sources and rejects invalid known width values', () => {
    const road = editorFixture().roads.rAB!;
    road.widthM = { state: 'known', value: 12, sourceRef: 'source_width' };
    const draft = makePhysicalDraft(road);
    const parsed = parsePhysicalDraft(draft);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.values.widthM).toEqual(road.widthM);
    for (const value of ['', '0', '-1', 'Infinity', 'NaN']) {
      expect(parsePhysicalDraft({ ...draft, widthM: { ...draft.widthM, value } }).ok).toBe(false);
    }
    for (const state of ['unknown', 'unrestricted', 'not_applicable'] as const) {
      const result = parsePhysicalDraft({ ...draft, widthM: { ...draft.widthM, state, reason: '原始记录说明' } });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.values.widthM).toEqual({ state, reason: '原始记录说明' });
    }
  });

  it('commits width and bends once with explicit assumption, undoing and redoing geometry and source together', () => {
    const map = editorFixture();
    const draft = makePhysicalDraft(map.roads.rAB!);
    const parsed = parsePhysicalDraft({ ...draft, widthM: { state: 'known', value: '14', sourceRef: '', reason: '' } });
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.needsAssumption).toBe(true);
    const initial = createSession(map);
    const result = editSession(initial, {
      type: 'updateRoad', id: 'rAB', patch: { ...parsed.values, shapePoints: [[40, 10, 0]] },
      designAssumption: { id: 'source_width_assumption', name: '宽度设计假设' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.past).toHaveLength(1);
    expect(result.session.map.roads.rAB!.widthM).toEqual({ state: 'known', value: 14, sourceRef: 'source_width_assumption' });
    expect(result.session.map.roads.rAB!.shapePoints).toEqual([[40, 10, 0]]);
    expect(undoSession(result.session).map).toEqual(map);
    expect(serializeMap(redoSession(undoSession(result.session)).map)).toBe(serializeMap(result.session.map));
  });
});
