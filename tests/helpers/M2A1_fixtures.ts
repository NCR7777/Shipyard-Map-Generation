import type { ServiceArrival, YardMap } from '../../src/domain/model';
import { associatedFixture, rectangle, testZone } from './M2A_fixtures';
import { testNode } from './M1_fixtures';

export type CurrentMap = Extract<YardMap, { schemaVersion: '0.2.0' }>;
export function proxyArrival(note = 'synthetic：场内转运不在本研究模型中计算'): ServiceArrival {
  return { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note };
}
export function currentServiceFixture(): CurrentMap {
  const legacy = associatedFixture();
  const map: CurrentMap = { ...legacy, schemaVersion: '0.2.0', mapId: 'map_M2A1_test' };
  map.metadata.name = 'M2A.1 synthetic 独立验收';
  map.roads.rAB!.direction = 'both';
  return map;
}
export function zoneServiceFixture(): CurrentMap {
  const map = currentServiceFixture();
  map.zones.zA = { ...testZone('work'), name: 'synthetic 业务区甲', boundary: rectangle(70, 20, 20, 20) };
  map.zones.zB = { ...testZone('buffer'), name: 'synthetic 重叠区乙', boundary: rectangle(75, 25, 20, 20) };
  map.nodes.nZone = { ...testNode('区域权威节点', 80, 30), kind: 'service' };
  map.roads.rZone = { ...structuredClone(map.roads.rAB!), name: 'synthetic 区域接路', fromNodeId: 'nB', toNodeId: 'nZone', direction: 'forward' };
  map.servicePoints.sZone = { name: 'synthetic 区域卸载点', kind: 'unloading', nodeId: 'nZone', zoneId: 'zA', arrival: proxyArrival(), resourceIds: [], provenance: { category: 'synthetic' } };
  return map;
}
export function internalServiceFixture(): CurrentMap {
  const map = currentServiceFixture();
  map.roads.rInternal = { ...structuredClone(map.roads.rAB!), name: 'synthetic 显式内部接续', fromNodeId: 'nA', toNodeId: 'nS', shapePoints: [[15, 0, 0]], direction: 'forward' };
  map.servicePoints.sA!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'rInternal', direction: 'forward' }] };
  return map;
}
export function zoneInternalFixture(): CurrentMap {
  const map = zoneServiceFixture();
  map.servicePoints.sZone!.arrival = { mode: 'explicit_internal', entryNodeId: 'nB', internalPath: [{ roadId: 'rZone', direction: 'forward' }] };
  return map;
}
