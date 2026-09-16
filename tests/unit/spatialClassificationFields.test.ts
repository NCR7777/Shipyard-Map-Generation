import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { newMap } from '../../src/domain/factory';
import type { SpatialClassification } from '../../src/domain/spatialClassification';
import { editSpatialDepthDraft, makeSpatialClassificationDraft, parseSpatialClassificationDraft, SpatialClassificationFields } from '../../src/ui/SpatialClassificationFields';

const known: SpatialClassification = { classId: 'dry_dock', depthM: { state: 'known', value: 12, sourceRef: 'design_assumption' }, depthReference: '坞口标高' };
describe('spatial classification property draft', () => {
  it('leaves an unclassified legacy entity untouched and keeps depth/source on class changes', () => {
    expect(parseSpatialClassificationDraft(undefined, makeSpatialClassificationDraft())).toEqual({ ok: true, needsAssumption: false });
    expect(parseSpatialClassificationDraft(known, { ...makeSpatialClassificationDraft(known), classId: 'yard' })).toEqual({ ok: true, needsAssumption: false, classification: { ...known, classId: 'yard' } });
  });
  it('distinguishes incomplete numeric input from a deliberate empty unknown depth', () => {
    const draft = makeSpatialClassificationDraft(known);
    const incomplete = editSpatialDepthDraft(known, draft, { depth: '', incomplete: true });
    expect(parseSpatialClassificationDraft(known, incomplete).ok).toBe(false);
    const cleared = parseSpatialClassificationDraft(known, { ...incomplete, incomplete: false });
    expect(cleared).toMatchObject({ ok: true, needsAssumption: false, classification: { depthM: { state: 'unknown' }, depthReference: known.depthReference } });
    for (const depth of ['0', '-1', 'NaN', 'Infinity']) expect(parseSpatialClassificationDraft(known, { ...draft, depth }).ok).toBe(false);
    expect(parseSpatialClassificationDraft(known, { ...draft, depth: '8', reference: '' }).ok).toBe(false);
  });
  it('uses an explicit assumption for edited depth and restores original evidence after exact reversion', () => {
    const original = makeSpatialClassificationDraft(known);
    const changed = editSpatialDepthDraft(known, original, { depth: '8' });
    expect(parseSpatialClassificationDraft(known, changed)).toMatchObject({ ok: true, needsAssumption: true, classification: { depthM: { value: 8 } } });
    expect(editSpatialDepthDraft(known, changed, { depth: '12' })).toEqual(original);
    expect(editSpatialDepthDraft(known, { ...original, reference: '另一参照面', sourceRef: '' }, { reference: '坞口标高' })).toEqual(original);
  });
  it('keeps real source ID design_assumption distinct from the empty assumption option and separates building/zone controls', () => {
    const map = newMap('ui', '分类 UI');
    map.sources.design_assumption = { name: '已有来源', category: 'design_assumption' } as typeof map.sources[string];
    const common = { map, draft: makeSpatialClassificationDraft(known), initial: known, onChange: () => {}, disabled: false, unsupported: false };
    const zone = renderToStaticMarkup(createElement(SpatialClassificationFields, { ...common, collection: 'zones' }));
    expect(zone.match(/value="design_assumption"/g)).toHaveLength(1);
    expect(zone).toContain('value=""');
    expect(zone).toContain('value="dry_dock"');
    const facility = renderToStaticMarkup(createElement(SpatialClassificationFields, { ...common, collection: 'facilities', draft: makeSpatialClassificationDraft() }));
    expect(facility).not.toContain('value="dry_dock"');
    expect(facility).not.toContain('aria-label="干船坞深度 (m)"');
    expect(facility).toContain('value="warehouse"');
  });
});
