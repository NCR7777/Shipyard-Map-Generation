import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newZone } from '../../src/domain/factory';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { BUILTIN_SPATIAL_CLASSES, SPATIAL_CLASSIFICATION_NAMESPACE as NS } from '../../src/domain/spatialClassification';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import type { YardMap } from '../../src/domain/model';
import { spatialAppearance, spatialClassColor } from '../../src/compiler/spatialColors';
import { toSceneSnapshot } from '../../src/compiler/scene';
function fixture() {
  const map = newMap('colors', '显示配色', '0.3.0'), boundary = rectanglePolygon([0, 0, 0], 10, 10);
  map.facilities.building = { ...newFacility(boundary, '建筑', 'building'), extensions: {} };
  map.zones.zone = { ...newZone(boundary, '区域', 'unclassified'), extensions: {} };
  map.extensionNamespaces[NS] = { version: '1.0', category: 'metadata' };
  return map;
}
describe('derived spatial classification colors', () => {
  it('gives builtin classes fixed distinct hex colors, including the three dock declarations', () => {
    for (const collection of ['facilities', 'zones'] as const) {
      const colors = BUILTIN_SPATIAL_CLASSES.filter(item => item.appliesTo[0] === collection).map(item => spatialClassColor(collection, item.id));
      expect(colors.every(color => /^#[0-9a-f]{6}$/.test(color))).toBe(true);
      expect(new Set(colors).size).toBe(colors.length);
    }
    expect(spatialClassColor('zones', 'dock_unspecified')).toBe('#7a8795');
    expect(spatialClassColor('zones', 'dry_dock')).toBe('#477dc2');
    expect(spatialClassColor('zones', 'floating_dock')).toBe('#6a67a9');
  });
  it('keeps custom ID colors stable through rename, catalog additions and JSON roundtrip', () => {
    const map = fixture();
    map.extensions[NS] = { customClasses: [{ id: 'custom_class_001', label: '自定厂房', appliesTo: ['facilities'] }] };
    map.facilities.building!.extensions![NS] = { classId: 'custom_class_001' };
    const original = spatialAppearance(map, 'facilities', 'building');
    map.extensions[NS] = { customClasses: [{ id: 'custom_class_002', label: '新增', appliesTo: ['facilities'] }, { id: 'custom_class_001', label: '更名厂房', appliesTo: ['facilities'] }] };
    expect(spatialAppearance(JSON.parse(serializeMap(map)) as YardMap, 'facilities', 'building')).toEqual({ ...original, classLabel: '更名厂房' });
    expect(spatialClassColor('zones', 'custom_class_001')).not.toBe(original.color);
  });
  it('falls back to legacy kind colors without inferring a dry dock from unknown classification', () => {
    const map = fixture(); map.facilities.building!.kind = 'dock'; map.zones.zone!.kind = 'water';
    expect(spatialAppearance(map, 'facilities', 'building')).toMatchObject({ color: '#7a8795' });
    expect(spatialAppearance(map, 'facilities', 'building').classId).toBeUndefined();
    map.facilities.building!.kind = 'workshop';
    expect(spatialAppearance(map, 'facilities', 'building').color).toBe('#df7628');
    map.facilities.building!.kind = 'yard';
    expect(spatialAppearance(map, 'facilities', 'building').color).toBe('#53a890');
    map.facilities.building!.kind = 'dock';
    expect(spatialAppearance(map, 'facilities', 'building').classLabel).toContain('类型待确认');
    map.facilities.building!.extensions![NS] = { classId: 'future_unrecognized' };
    expect(spatialAppearance(map, 'facilities', 'building').classLabel).toContain('详细分类未识别');
    expect(spatialAppearance(map, 'facilities', 'building').color).toBe('#7a8795');
    map.extensionNamespaces[NS]!.version = '99.0'; map.zones.zone!.extensions![NS] = { classId: 'dry_dock' };
    expect(spatialAppearance(map, 'zones', 'zone').color).toBe('#82b7df');
    expect(spatialAppearance(map, 'zones', 'zone').classId).toBeUndefined();
  });
  it('compiles detached appearance with category-colored outlines without changing map, hash or geometry', () => {
    const map = fixture(); map.facilities.building!.extensions![NS] = { classId: 'warehouse' }; map.zones.zone!.extensions![NS] = { classId: 'yard' };
    const before = serializeMap(map), hash = contentHash(map), scene = toSceneSnapshot(map);
    expect(scene.facilities[0]!.appearance).toMatchObject({ classId: 'warehouse', classLabel: '仓库', color: '#8758b8', stroke: '#583978' });
    expect(scene.zones[0]!.appearance).toMatchObject({ classId: 'yard', color: '#53a890' });
    expect(scene.facilities[0]!.appearance!.selectedStroke).not.toBe(scene.zones[0]!.appearance!.selectedStroke);
    expect(scene.facilities[0]!.boundary).toEqual(map.facilities.building!.boundary);
    expect(scene.zones[0]!.boundary).toEqual(map.zones.zone!.boundary);
    scene.facilities[0]!.appearance!.color = '#ffffff';
    expect(serializeMap(map)).toBe(before); expect(contentHash(map)).toBe(hash);
    expect(toSceneSnapshot(map).facilities[0]!.appearance!.color).toBe('#8758b8');
  });
});
