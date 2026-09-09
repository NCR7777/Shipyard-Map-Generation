import { editorFixture, testNode } from './M1_fixtures';
import type { Facility, Polygon, YardMap, Zone } from '../../src/domain/model';

/** Independent geometry fixtures are synthetic test inputs, never measured shipyard data. */
export function rectangle(x = 0, y = 0, width = 60, height = 30): Polygon {
  return { outer: [[x, y, 0], [x + width, y, 0], [x + width, y + height, 0], [x, y + height, 0], [x, y, 0]], holes: [] };
}
export function testFacility(name = '60m×30m synthetic 厂房', boundary = rectangle()): Facility {
  return {
    name, kind: 'workshop', boundary, accessPointIds: [], servicePointIds: [],
    heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
}
export function testZone(kind: Zone['kind'] = 'waiting'): Zone {
  return {
    name: 'synthetic ' + kind, kind, boundary: rectangle(10, 50, 20, 20), passability: 'unknown',
    resourceIds: [], provenance: { category: 'synthetic' },
  };
}
export function spatialFixture(): YardMap {
  const map = editorFixture();
  map.mapId = 'map_M2A_test';
  map.metadata.name = 'M2A synthetic 回归地图';
  map.facilities.fA = testFacility();
  map.zones.zA = testZone();
  return map;
}
export function associatedFixture(): YardMap {
  const map = spatialFixture();
  map.nodes.nA!.kind = 'access';
  map.nodes.nS = { ...testNode('装卸节点', 15, 10), kind: 'service' };
  map.accessPoints.aA = { name: '厂房入口', facilityId: 'fA', nodeId: 'nA', provenance: { category: 'synthetic' } };
  map.servicePoints.sA = {
    name: '厂房装卸点', kind: 'loading', facilityId: 'fA', nodeId: 'nS', accessPointId: 'aA',
    resourceIds: [], provenance: { category: 'synthetic' },
  };
  map.facilities.fA!.accessPointIds = ['aA'];
  map.facilities.fA!.servicePointIds = ['sA'];
  return map;
}
export function missingBackgroundFixture(): YardMap {
  const map = associatedFixture();
  map.sources.srcImage = { name: '不存在的合成图测试', category: 'synthetic', description: '不提供二进制，仅验证矢量保留。' };
  map.assets.imgA = { path: 'assets/absent.png', sha256: 'a'.repeat(64), mediaType: 'image/png', sourceRef: 'srcImage', widthPx: 100, heightPx: 100 };
  map.backgroundLayers.bgA = {
    name: '缺失底图', assetId: 'imgA', pixelConvention: 'top_left_x_right_y_down_exif_normalized',
    imageToWorld: [1, 0, 0, -1, 0, 0], method: 'manual', controlPoints: [], provenance: { category: 'synthetic' },
  };
  return map;
}
