import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { newRoad } from '../../src/domain/factory';
import { makePhysicalDraft, parsePhysicalPatch, editPhysicalNumber, RoadPhysicalFields } from '../../src/ui/RoadPhysicalFields';
import { changedFields, readNumber, unitFactor } from '../../src/ui/propertyFields';

function road() {
  return { ...newRoad('a', 'b', [[1.23456789012345, 8.76543210987654, 7.1234567890123]]), direction: 'forward' as const,
    widthM: { state: 'known' as const, value: 12.3456789012345, sourceRef: 'survey_original' },
    massLimitKg: { state: 'known' as const, value: 123456.789012345, sourceRef: 'mass_source' },
    speedLimitMps: { state: 'known' as const, value: 1.23456789012345, sourceRef: 'speed_source' },
    heightLimitM: { state: 'not_applicable' as const, reason: '  original spacing  ' },
    extensions: { 'example.metadata': { fullPrecision: 1.23456789012345 } },
  };
}
describe('UX02 sparse property adapters and units', () => {
  it('name-only proposals retain every original hidden value and nonzero Z', () => {
    const original = road(), frozen = structuredClone(original);
    const patch = changedFields(original, { name: 'new label' });
    expect(Object.keys(patch)).toEqual(['name']);
    expect({ ...original, ...patch }).toEqual({ ...frozen, name: 'new label' });
    expect(original).toEqual(frozen);
    expect(changedFields(original, { shapePoints: structuredClone(original.shapePoints), direction: original.direction })).toEqual({});
  });
  it('only parses touched physical fields and does not trim hidden reasons', () => {
    const original = road(), draft = makePhysicalDraft(original);
    const result = parsePhysicalPatch(original, editPhysicalNumber(original, draft, 'widthM', '20', 'm'));
    expect(result).toEqual({ ok: true, patch: { widthM: { state: 'known', value: 20 } }, needsAssumption: true });
    expect(original.heightLimitM.reason).toBe('  original spacing  ');
    expect(draft).toEqual(makePhysicalDraft(original));
  });
  it('reverting a numeric edit preserves original source and yields no patch', () => {
    const original = road();
    const dirty = editPhysicalNumber(original, makePhysicalDraft(original), 'widthM', '24', 'm');
    const reverted = editPhysicalNumber(original, dirty, 'widthM', String(original.widthM.value), 'm');
    expect(parsePhysicalPatch(original, reverted)).toEqual({ ok: true, patch: {}, needsAssumption: false });
  });
  it.each(['unknown', 'unrestricted', 'not_applicable'] as const)('untouched %s remains distinct from a deliberately cleared known value', state => {
    const original = { ...road(), widthM: { state, reason: '  original  ' } };
    expect(parsePhysicalPatch(original, makePhysicalDraft(original))).toEqual({ ok: true, patch: {}, needsAssumption: false });
    const known = road(), cleared = editPhysicalNumber(known, makePhysicalDraft(known), 'widthM', '', 'm');
    expect(parsePhysicalPatch(known, cleared)).toEqual({ ok: true, patch: { widthM: { state: 'unknown' } }, needsAssumption: false });
    expect(known.widthM.sourceRef).toBe('survey_original');
  });
  it('unit display calculations and switches cannot create physical patches', () => {
    const original = road(), draft = makePhysicalDraft(original), snapshot = structuredClone(draft);
    for (let i = 0; i < 10; i++) for (const [field, units] of [['massLimitKg', ['t', 'kg']], ['speedLimitMps', ['km/h', 'm/s']]] as const) {
      for (const unit of units) expect(Number.isFinite(Number(draft[field].value) / unitFactor(unit))).toBe(true);
    }
    expect(draft).toEqual(snapshot); expect(parsePhysicalPatch(original, draft)).toEqual({ ok: true, patch: {}, needsAssumption: false });
  });
  it('explicit human-unit input converts once to canonical kg and m/s with new assumption', () => {
    const original = road();
    const mass = editPhysicalNumber(original, makePhysicalDraft(original), 'massLimitKg', '100.5', 't');
    const speed = editPhysicalNumber(original, mass, 'speedLimitMps', '36', 'km/h');
    expect(parsePhysicalPatch(original, speed)).toEqual({ ok: true, patch: { massLimitKg: { state: 'known', value: 100500 }, speedLimitMps: { state: 'known', value: 10 } }, needsAssumption: true });
  });
  it('extreme display conversion reports overflow/underflow while preserving raw values', () => {
    const original = { ...road(), massLimitKg: { state: 'known' as const, value: Number.MIN_VALUE, sourceRef: 'tiny' }, speedLimitMps: { state: 'known' as const, value: Number.MAX_VALUE, sourceRef: 'large' } };
    const draft = makePhysicalDraft(original);
    const html = renderToStaticMarkup(createElement(RoadPhysicalFields, { original, draft, readonly: false, sources: {}, onChange: () => { throw Error('Rendering must not edit'); }, propertyUnits: { mass: 't', speed: 'km/h', angle: 'deg' } }));
    expect(html.match(/超出当前单位的有限显示范围/g)).toHaveLength(2);
    expect(parsePhysicalPatch(original, draft)).toEqual({ ok: true, patch: {}, needsAssumption: false });
  });
  it('zero/negative/blank/nonfinite values are never silently accepted as positive known limits', () => {
    const original = road();
    for (const text of ['0', '-1', '1e309', 'NaN']) expect(parsePhysicalPatch(original, editPhysicalNumber(original, makePhysicalDraft(original), 'widthM', text, 'm')).ok).toBe(false);
    const incomplete = editPhysicalNumber(original, makePhysicalDraft(original), 'widthM', '', 'm', true);
    expect(incomplete.widthM.state).toBe('known'); expect(parsePhysicalPatch(original, incomplete).ok).toBe(false);
    expect(readNumber('')).toBeNull(); expect(readNumber('0')).toBe(0); expect(readNumber('1e308', 1000)).toBeNull();
    expect(readNumber('180', unitFactor('deg'))).toBe(Math.PI);
    expect(readNumber(String(Math.PI), unitFactor('rad'))).toBe(Math.PI);
    expect(readNumber('1e-100', unitFactor('t'))).toBe(1e-97);
  });
});
