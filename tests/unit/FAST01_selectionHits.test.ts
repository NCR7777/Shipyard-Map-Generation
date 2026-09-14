import { describe, expect, it } from 'vitest';
import { newAccessPoint, newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../../src/domain/factory';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { roadForMap } from '../../src/geometry/roadPath';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { worldToScreen } from '../../src/geometry/coordinates';
import { selectionCandidates, cycleSelection, type SelectionHitOptions } from '../../src/geometry/selectionHits';
const camera = { offsetX: 0, offsetY: 100, scale: 10 };
function fixture() {
  const map = newMap('FAST01_SELECTION_SYNTHETIC', '合成叠放选择，非现场数据', '0.3.0');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.n = newNode([50, 75, 0]);
  const road = roadForMap(map, newRoad('a', 'b')); if (!road.geometry) throw new Error('path expected');
  road.geometry.spans = [{ kind: 'cubic', control1: [0, 100, 0], control2: [100, 100, 0] }]; road.widthM = { state: 'known', value: 12 }; map.roads.curve = road;
  map.facilities.f = newFacility(rectanglePolygon([30, 60, 0], 40, 40)); map.zones.z = newZone(rectanglePolygon([20, 50, 0], 60, 60));
  map.accessPoints.entrance = newAccessPoint('f', 'n'); map.servicePoints.service = newServicePoint('n', '服务', 'loading', 'f', 'entrance');
  const scene = toSceneSnapshot(map), options: SelectionHitOptions = { visibleKeys: new Set(scene.items.map(item => item.key)), showRoadBands: true, showRoadCenterlines: true };
  return { scene, options };
}
describe('FAST01 visible overlap candidates and view-only selection cycling', () => {
  it('hits authoritative cubic geometry and band, not the endpoint chord, while preserving point priority', () => {
    const { scene, options } = fixture();
    const hits = selectionCandidates(scene, worldToScreen([50, 75, 0], camera), camera, options);
    expect(hits.map(hit => hit.key)).toEqual(['servicePoints/service', 'accessPoints/entrance', 'nodes/n', 'roads/curve', 'facilities/f', 'zones/z']);
    expect(selectionCandidates(scene, worldToScreen([50, 0, 0], camera), camera, options).some(hit => hit.kind === 'roads')).toBe(false);
    expect(selectionCandidates(scene, worldToScreen([50, 80, 0], camera), camera, options).some(hit => hit.kind === 'roads')).toBe(true);
    expect(selectionCandidates(scene, worldToScreen([50, 80, 0], camera), camera, { ...options, showRoadBands: false }).some(hit => hit.kind === 'roads')).toBe(false);
  });
  it('honors hidden/display keys, retains locked objects for inspection, combined identities and holes', () => {
    const { scene, options } = fixture(), point = worldToScreen([50, 75, 0], camera);
    const visibleKeys = new Set(['servicePoints/service', 'roads/curve', 'facilities/f']);
    const hits = selectionCandidates(scene, point, camera, { ...options, visibleKeys, hiddenTypes: ['facilities'], lockedTypes: ['roads'] });
    expect(hits.map(hit => hit.key)).toEqual(['servicePoints/service', 'accessPoints/entrance', 'roads/curve']);
    expect(selectionCandidates(scene, point, camera, { ...options, showRoadBands: false, showRoadCenterlines: false }).some(hit => hit.kind === 'roads')).toBe(false);
    scene.facilities[0]!.boundary.holes = [rectanglePolygon([40, 65, 0], 20, 20).outer];
    expect(selectionCandidates(scene, point, camera, options).some(hit => hit.kind === 'facilities')).toBe(false);
  });
  it('cycles only stable same-place candidates, wraps with Tab/reverse and resets when the scene changes', () => {
    const { scene, options } = fixture(), point = worldToScreen([50, 75, 0], camera), candidates = selectionCandidates(scene, point, camera, options);
    const first = cycleSelection(candidates, point, 'map1', null); expect(first.hit?.key).toBe('servicePoints/service');
    const next = cycleSelection(candidates, [point[0] + 2, point[1]], 'map1', first.cycle); expect(next.hit?.key).toBe('accessPoints/entrance');
    const back = cycleSelection(candidates, point, 'map1', first.cycle, { advance: true, reverse: true }); expect(back.hit?.kind).toBe('zones');
    expect(cycleSelection(candidates, point, 'map2', next.cycle).hit?.key).toBe(first.hit?.key);
    expect(cycleSelection(candidates, [point[0] + 50, point[1]], 'map1', next.cycle).hit?.key).toBe(first.hit?.key);
    expect(cycleSelection([], point, 'map1', next.cycle)).toEqual({ hit: null, cycle: null });
    expect(next.cycle?.index).toBe(1); expect(first.cycle?.index).toBe(0);
  });
});
