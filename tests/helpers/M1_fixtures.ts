import { newMap } from '../../src/domain/factory';
import type { YardMap, MapNode } from '../../src/domain/model';

export function testNode(name: string, x: number, y = 0): MapNode {
  return { name, position: [x, y, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
}

export function editorFixture(): YardMap {
  const map = newMap('map_M1_test', 'M1 synthetic 回归地图');
  map.metadata.layoutBasis = 'synthetic';
  map.nodes.nA = testNode('A', 0);
  map.nodes.nB = testNode('B', 100);
  map.roads.rAB = {
    name: 'AB', fromNodeId: 'nA', toNodeId: 'nB', shapePoints: [], direction: 'unknown',
    widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' },
    speedLimitMps: { state: 'unknown' }, resourceIds: [], provenance: { category: 'synthetic' },
  };
  return map;
}

export function readonlyFixture(): YardMap {
  const map = editorFixture();
  // M2A implements facilities; unknown behavior must still protect the entire map.
  map.extensionNamespaces['test.future_behavior'] = { version: '1', category: 'behavior' };
  map.extensions['test.future_behavior'] = { controller: 'unsupported' };
  map.facilities.fA = {
    name: '暂不编辑的厂房', kind: 'workshop',
    boundary: { outer: [[0, 20, 0], [20, 20, 0], [20, 40, 0], [0, 40, 0], [0, 20, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  return map;
}
