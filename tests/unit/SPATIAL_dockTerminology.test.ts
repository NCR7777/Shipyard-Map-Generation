import { describe, expect, it } from 'vitest';
import { newMap } from '../../src/domain/factory';
import { getSpatialClasses } from '../../src/domain/spatialClassification';

describe('dock terminology preserves the classification and depth data contract', () => {
  it('keeps the existing dry-dock ID and adds two zone-only classes', () => {
    const map = newMap('dock_terms'), zones = getSpatialClasses(map, 'zones'), buildings = getSpatialClasses(map, 'facilities');
    for (const [id, label] of [['dock_unspecified', '船坞（类型待确认）'], ['dry_dock', '岸式干船坞'], ['floating_dock', '浮船坞（当前占位）']]) {
      expect(zones.find(item => item.id === id)).toEqual({ id, label, appliesTo: ['zones'] });
      expect(buildings.some(item => item.id === id)).toBe(false);
    }
  });
});
