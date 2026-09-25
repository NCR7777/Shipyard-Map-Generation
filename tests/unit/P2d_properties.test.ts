import { describe, expect, it } from 'vitest';
import { newRoad } from '../../src/domain/factory';
import type { PhysicalValue } from '../../src/domain/model';
import { serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { blockedDirections, displayNumber, fixedServiceKind, physicalDraft, physicalPatch, readNumber, refusalMessage, sourceLabels, unitFactor, type PhysicalDraft, type Unit } from '../../src/app/state/properties';
import type { YardMap } from '../../src/domain/model';
import { editorFixture } from '../helpers/M1_fixtures';

function road() {
  return { ...newRoad('a', 'b', [[1.23456789012345, 8.76543210987654, 7.1234567890123]]), direction: 'forward' as const,
    widthM: { state: 'known' as const, value: 12.3456789012345, sourceRef: 'survey_original' },
    massLimitKg: { state: 'known' as const, value: 123456.789012345, sourceRef: 'mass_source' },
    speedLimitMps: { state: 'known' as const, value: 1.23456789012345, sourceRef: 'speed_source' },
    heightLimitM: { state: 'not_applicable' as const, reason: '  original spacing  ' },
    extensions: { 'example.metadata': { fullPrecision: 1.23456789012345 } },
  };
}
const typed = (value: PhysicalValue | undefined, text: string, unit: Unit = 'm'): PhysicalDraft => ({ ...physicalDraft(value, unit), state: 'known', text, touched: true });

// ../map UX02_properties, against the per-field model that commits on Enter or blur.
describe('UX02 sparse property adapters and units', () => {
  // The inspector sends one field per command, so the sparse-patch guarantee is the kernel's: here with the map around it.
  it('a name-only edit retains every other value: hidden values, nonzero Z, full precision, extensions, untrimmed reasons', () => {
    const map = editorFixture();
    map.sources.survey_original = { name: '测量', category: 'surveyed', description: '' };
    map.sources.mass_source = { name: '承载', category: 'design_assumption', description: '' };
    map.sources.speed_source = { name: '限速', category: 'design_assumption', description: '' };
    map.extensionNamespaces['example.metadata'] = { version: '1', category: 'metadata' };
    map.nodes.nA!.position = [0, 0, 7.1234567890123]; map.nodes.nB!.position = [100, 0, 7.1234567890123];
    const { direction, widthM, massLimitKg, speedLimitMps, heightLimitM, extensions } = road();
    map.roads.rAB = { ...map.roads.rAB!, direction, widthM, massLimitKg, speedLimitMps, heightLimitM, extensions, shapePoints: [[1.23456789012345, 8.76543210987654, 7.1234567890123]] } as never;
    const before = structuredClone(map), result = editSession(createSession(map), { type: 'updateRoad', id: 'rAB', patch: { name: 'new label' } });
    if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '));
    expect(result.session.map.roads.rAB).toEqual({ ...before.roads.rAB, name: 'new label' });
    expect({ ...result.session.map, roads: {}, revision: 0 }).toEqual({ ...before, roads: {}, revision: 0 });
  });
  it('only the typed field is parsed; hidden reasons are not trimmed; a new number drops the old source and needs an assumption', () => {
    const original = road();
    expect(physicalPatch(original.widthM, typed(original.widthM, '20'), 'm')).toEqual({ ok: true, value: { state: 'known', value: 20 }, needsAssumption: true });
    expect(original.heightLimitM.reason).toBe('  original spacing  ');
    expect(physicalPatch(original.heightLimitM, physicalDraft(original.heightLimitM, 'm'), 'm')).toEqual({ ok: true, needsAssumption: false });
  });
  it('typing the stored number back yields no patch and keeps the source', () => {
    const original = road();
    expect(physicalPatch(original.widthM, typed(original.widthM, String(original.widthM.value)), 'm')).toEqual({ ok: true, needsAssumption: false });
    // As it is shown (12 significant digits) counts as the stored number too.
    expect(physicalPatch(original.widthM, typed(original.widthM, displayNumber(original.widthM.value, 'm')!), 'm')).toEqual({ ok: true, needsAssumption: false });
  });
  it.each(['unknown', 'unrestricted', 'not_applicable'] as const)('untouched %s remains distinct from a deliberately cleared known value', state => {
    const value: PhysicalValue = { state, reason: '  original  ' };
    expect(physicalPatch(value, physicalDraft(value, 'm'), 'm')).toEqual({ ok: true, needsAssumption: false });
    // Typing into it and clearing again changes nothing either.
    expect(physicalPatch(value, typed(value, ''), 'm')).toEqual({ ok: true, needsAssumption: false });
    const known = road();
    expect(physicalPatch(known.widthM, typed(known.widthM, ''), 'm')).toEqual({ ok: true, value: { state: 'unknown' }, needsAssumption: false });
    expect(known.widthM.sourceRef).toBe('survey_original');
  });
  it('unit display calculations and switches cannot create physical patches', () => {
    const original = road();
    for (const [field, units] of [['massLimitKg', ['t', 'kg']], ['speedLimitMps', ['km/h', 'm/s']]] as const) for (const unit of units) {
      const draft = physicalDraft(original[field], unit);
      expect(Number.isFinite(Number(draft.text))).toBe(true);
      expect(physicalPatch(original[field], draft, unit)).toEqual({ ok: true, needsAssumption: false });
    }
  });
  it('explicit human-unit input converts once to canonical kg and m/s with a new assumption', () => {
    const original = road();
    expect(physicalPatch(original.massLimitKg, typed(original.massLimitKg, '100.5', 't'), 't')).toEqual({ ok: true, value: { state: 'known', value: 100500 }, needsAssumption: true });
    expect(physicalPatch(original.speedLimitMps, typed(original.speedLimitMps, '36', 'km/h'), 'km/h')).toEqual({ ok: true, value: { state: 'known', value: 10 }, needsAssumption: true });
  });
  it('extreme display conversion reports overflow/underflow while preserving raw values', () => {
    expect(displayNumber(Number.MIN_VALUE, 't')).toBeNull();
    expect(displayNumber(Number.MAX_VALUE, 'km/h')).toBeNull();
    const tiny: PhysicalValue = { state: 'known', value: Number.MIN_VALUE, sourceRef: 'tiny' };
    expect(physicalPatch(tiny, physicalDraft(tiny, 't'), 't')).toEqual({ ok: true, needsAssumption: false });
  });
  it('zero/negative/blank/nonfinite values are never silently accepted as positive known limits', () => {
    const original = road();
    for (const text of ['0', '-1', '1e309', 'NaN', 'abc', 'Infinity']) expect(physicalPatch(original.widthM, typed(original.widthM, text), 'm').ok).toBe(false);
    // Choosing「已声明」on an unknown value and typing nothing is not a value.
    expect(physicalPatch({ state: 'unknown' }, { state: 'known', text: '', touched: false }, 'm').ok).toBe(false);
    expect(readNumber('')).toBeNull(); expect(readNumber('0')).toBe(0); expect(readNumber('1e308', 1000)).toBeNull();
    expect(readNumber('180', unitFactor('deg'))).toBe(Math.PI);
    expect(readNumber(String(Math.PI), unitFactor('rad'))).toBe(Math.PI);
    expect(readNumber('1e-100', unitFactor('t'))).toBe(1e-97);
  });
  it('a refusal names its first error, not the warnings listed before it', () => {
    const warning = { code: 'W', severity: 'warning' as const, jsonPath: '/roads/r/heightLimitM', message: 'heightLimitM 未知；仅作草稿。', suggestedAction: '' };
    const error = { code: 'ARC_DIRECTION_CONFLICT', severity: 'error' as const, jsonPath: '/movements/m', message: '转向引用的道路方向被道路属性禁止。', suggestedAction: '' };
    expect(refusalMessage([warning, error])).toBe(error.message);
    expect(refusalMessage([warning])).toBe(warning.message);
    expect(refusalMessage([])).toContain('地图保持不变');
  });
  it('a road can become one-way only in a direction every turn rule on it uses', () => {
    const arc = (roadId: string, direction: 'forward' | 'backward') => ({ roadId, direction });
    const map = { movements: {
      m1: { incomingArc: arc('rIn', 'forward'), outgoingArc: arc('rBoth', 'forward') },
      m2: { incomingArc: arc('rBoth', 'backward'), outgoingArc: arc('rOut', 'backward') },
    } } as unknown as YardMap;
    expect(blockedDirections(map, 'rIn')).toEqual(['backward']);
    expect(blockedDirections(map, 'rOut')).toEqual(['forward']);
    expect(blockedDirections(map, 'rBoth')).toEqual(['forward', 'backward']);
    expect(blockedDirections(map, 'rFree')).toEqual([]);
  });
  it('a service type fixed by planning data is reported; an ordinary service point is free', () => {
    const map = editorFixture();
    map.servicePoints.sPlanned = { name: '规划作业点', kind: 'other', nodeId: 'nA', extensions: { 'sr02.planning': { capability: 'loading_and_unloading', handling: 'reserved_slot_transfer_in_service_time' } } } as never;
    map.servicePoints.sFree = { name: '普通作业点', kind: 'loading', nodeId: 'nB' } as never;
    expect(fixedServiceKind(map, 'sPlanned')).toContain('须保持「其他」');
    expect(fixedServiceKind(map, 'sFree')).toBeNull();
  });
  it('sources sharing a name are told apart by id and by how many fields cite them', () => {
    const map = editorFixture();
    map.sources.s1 = { name: '道路参数设计假设', category: 'design_assumption', description: '' };
    map.sources.s2 = { name: '道路参数设计假设', category: 'design_assumption', description: '' };
    map.sources.s3 = { name: '测量', category: 'surveyed', description: '' };
    map.roads.rAB!.provenance.fieldSources = { widthM: 's2', heightLimitM: 's2' };
    expect(sourceLabels(map)).toEqual([['s1', '道路参数设计假设 · s1（0 处引用）'], ['s2', '道路参数设计假设 · s2（2 处引用）'], ['s3', '测量']]);
  });
  it('choosing an existing source for the same number patches only the source', () => {
    const original = road();
    const draft = { ...physicalDraft(original.widthM, 'm'), source: 'mass_source' };
    expect(physicalPatch(original.widthM, draft, 'm')).toEqual({ ok: true, value: { state: 'known', value: original.widthM.value, sourceRef: 'mass_source' }, needsAssumption: false });
    expect(physicalPatch(original.widthM, { ...draft, source: 'survey_original' }, 'm')).toEqual({ ok: true, needsAssumption: false });
  });
});

// ../map M2A_physicalEquality, "road width uses the shared physical form and transaction".
describe('road width uses the shared physical model and transaction', () => {
  it('preserves declared width sources and rejects invalid known width values', () => {
    const road = editorFixture().roads.rAB!;
    road.widthM = { state: 'known', value: 12, sourceRef: 'source_width' };
    expect(physicalPatch(road.widthM, physicalDraft(road.widthM, 'm'), 'm')).toEqual({ ok: true, needsAssumption: false });
    for (const text of ['0', '-1', 'Infinity', 'NaN']) expect(physicalPatch(road.widthM, typed(road.widthM, text), 'm').ok).toBe(false);
    for (const state of ['unknown', 'unrestricted', 'not_applicable'] as const) {
      expect(physicalPatch(road.widthM, { state, text: '', touched: false, reason: '原始记录说明' }, 'm')).toEqual({ ok: true, value: { state, reason: '原始记录说明' }, needsAssumption: false });
    }
  });
  it('commits width and bends once with explicit assumption, undoing and redoing geometry and source together', () => {
    const map = editorFixture(), road = map.roads.rAB!;
    const parsed = physicalPatch(road.widthM, typed(road.widthM, '14'), 'm');
    if (!parsed.ok) throw new Error(parsed.message);
    expect(parsed.needsAssumption).toBe(true);
    const initial = createSession(map);
    const result = editSession(initial, { type: 'updateRoad', id: 'rAB', patch: { widthM: parsed.value!, shapePoints: [[40, 10, 0]] }, designAssumption: { id: 'source_width_assumption', name: '宽度设计假设' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.past).toHaveLength(1);
    expect(result.session.map.roads.rAB!.widthM).toEqual({ state: 'known', value: 14, sourceRef: 'source_width_assumption' });
    expect(result.session.map.roads.rAB!.shapePoints).toEqual([[40, 10, 0]]);
    expect(undoSession(result.session).map).toEqual(map);
    expect(serializeMap(redoSession(undoSession(result.session)).map)).toBe(serializeMap(result.session.map));
  });
});
