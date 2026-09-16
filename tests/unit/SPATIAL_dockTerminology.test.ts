import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { applyMapCommand } from '../../src/domain/commands';
import { newMap, newZone } from '../../src/domain/factory';
import { getSpatialClasses, getSpatialClassification, type SpatialClassification } from '../../src/domain/spatialClassification';
import { SpatialClassificationFields, makeSpatialClassificationDraft, parseSpatialClassificationDraft } from '../../src/ui/SpatialClassificationFields';
import { rectangle } from '../helpers/M2A_fixtures';

describe('dock terminology preserves the classification and depth data contract', () => {
  it('keeps the existing dry-dock ID and adds two zone-only classes', () => {
    const map = newMap('dock_terms'), zones = getSpatialClasses(map, 'zones'), buildings = getSpatialClasses(map, 'facilities');
    for (const [id, label] of [['dock_unspecified', '船坞（类型待确认）'], ['dry_dock', '岸式干船坞'], ['floating_dock', '浮船坞（当前占位）']]) {
      expect(zones.find(item => item.id === id)).toEqual({ id, label, appliesTo: ['zones'] });
      expect(buildings.some(item => item.id === id)).toBe(false);
    }
  });
  it('keeps a previously declared unknown depth visible for a non-graving dock', () => {
    const initial: SpatialClassification = { classId: 'floating_dock', depthM: { state: 'unknown', reason: '旧记录尚无测量' } };
    const markup = renderToStaticMarkup(createElement(SpatialClassificationFields, { map: newMap('dock_terms'), collection: 'zones', draft: makeSpatialClassificationDraft(initial), initial, onChange: () => undefined, disabled: false, unsupported: false }));
    expect(markup).toContain('aria-label="干船坞深度 (m)"');
    expect(markup).toContain('当前平面占位'); expect(markup).toContain('不等于坞口水深、允许吃水');
  });
  it.each(['dock_unspecified', 'floating_dock'])('preserves existing structure depth, provenance and geometry when explicitly reclassifying to %s', classId => {
    const map = newMap('dock_terms', '术语测试', '0.3.0');
    map.zones.dock = newZone(rectangle(0, 0, 20, 10), '船坞');
    map.sources.assumption = { name: '测试假设', category: 'design_assumption', description: '测试来源，不是工程测量。' };
    const initial: SpatialClassification = { classId: 'dry_dock', depthM: { state: 'known', value: 8, sourceRef: 'assumption' }, depthReference: '测试假设参照面' };
    const created = applyMapCommand(map, { type: 'updateZone', id: 'dock', patch: {}, classification: initial });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const parsed = parseSpatialClassificationDraft(initial, { ...makeSpatialClassificationDraft(initial), classId });
    expect(parsed.ok).toBe(true); if (!parsed.ok) return;
    expect(parsed.classification).toEqual({ ...initial, classId }); expect(parsed.needsAssumption).toBe(false);
    const changed = applyMapCommand(created.map, { type: 'updateZone', id: 'dock', patch: {}, classification: parsed.classification });
    expect(changed.ok).toBe(true); if (!changed.ok) return;
    expect(getSpatialClassification(changed.map, 'zones', 'dock')).toEqual({ ...initial, classId });
    expect(changed.map.zones.dock!.boundary).toEqual(map.zones.dock!.boundary);
    expect(changed.map.zones.dock!.kind).toBe(map.zones.dock!.kind);
    expect(changed.map.zones.dock!.passability).toBe(map.zones.dock!.passability);
    expect(changed.map.zones.dock!.provenance).toEqual(created.map.zones.dock!.provenance);
    expect(changed.map.sources).toEqual(map.sources);
  });
});
