import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { endKey, pressTarget } from '../../src/app/canvas/pressTarget';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { worldToScreen, type Camera } from '../../src/geometry/coordinates';

// The example: rMain from the corner entrance node nRoadWest (0, 0) to the plain node nRoadEast (100, 0); rApproach from the
// corner to the loading point's node nLoading (15, 10); rZoneConnection from nRoadEast to the zone service node nZoneTarget.
function example(change: (map: Record<string, Record<string, unknown>>) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error('fixture');
  return loaded.map;
}
const camera: Camera = { offsetX: 0, offsetY: 500, scale: 10 };
const at = (x: number, y: number, dx = 0) => { const [sx, sy] = worldToScreen([x, y, 0], camera); return [sx + dx, sy] as [number, number]; };

describe('what a press takes hold of', () => {
  it('on a road, its end node within 8 px, shown or not; further away the road', () => {
    const map = example();
    expect(pressTarget(map, ['roads/rMain'], at(100, 0, -7), camera)).toBe('nodes/nRoadEast');
    expect(pressTarget(map, ['roads/rMain'], at(100, 0, -9), camera)).toBe('roads/rMain');
  });
  it('the nearest end when two are within reach, whichever road comes first', () => {
    const map = example(json => {
      const node = (name: string, position: number[]) => ({ name, position, kind: 'ordinary', provenance: { category: 'synthetic' } });
      json.nodes!.nA = node('甲', [50, 40, 0]); json.nodes!.nB = node('乙', [50.6, 40, 0]); json.nodes!.nC = node('丙', [50, 60, 0]); json.nodes!.nD = node('丁', [51, 60, 0]);
      json.roads!.rA = { ...(json.roads!.rMain as object), name: '甲路', fromNodeId: 'nC', toNodeId: 'nA', shapePoints: [] };
      json.roads!.rB = { ...(json.roads!.rMain as object), name: '乙路', fromNodeId: 'nD', toNodeId: 'nB', shapePoints: [] };
    });
    // 0.5 m right of nA: nB (1 px away) beats nA (5 px), though rA is listed first.
    expect(pressTarget(map, ['roads/rA', 'roads/rB'], at(50.5, 40), camera)).toBe('nodes/nB');
  });
  it('anything else on top as it is: a building under the pointer, a point marker', () => {
    const map = example();
    expect(pressTarget(map, ['facilities/fWorkshop', 'roads/rApproach'], at(15, 10, -3), camera)).toBe('facilities/fWorkshop');
    expect(pressTarget(map, ['accessPoints/aWorkshop', 'roads/rMain'], at(0, 0), camera)).toBe('accessPoints/aWorkshop');
    expect(pressTarget(map, [], at(0, 0), camera)).toBeUndefined();
  });
  it("a road's end stands for the one entrance on its node, else the one service point, else the node", () => {
    const map = example();
    expect(endKey(map, 'nRoadWest')).toBe('accessPoints/aWorkshop');
    expect(endKey(map, 'nLoading')).toBe('servicePoints/sLoading');
    expect(endKey(map, 'nRoadEast')).toBe('nodes/nRoadEast');
    expect(pressTarget(map, ['roads/rApproach'], at(15, 10, -4), camera)).toBe('servicePoints/sLoading');
    const both = example(json => {
      json.servicePoints!.sGate = { name: '门口装卸', kind: 'loading', nodeId: 'nRoadWest', facilityId: 'fWorkshop', resourceIds: [],
        arrival: { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '测试' }, provenance: { category: 'synthetic' } };
      (json.facilities!.fWorkshop as { servicePointIds: string[] }).servicePointIds.push('sGate');
    });
    // An entrance with a service point beside it: the entrance, which keeps to its outline (the point goes along).
    expect(endKey(both, 'nRoadWest')).toBe('accessPoints/aWorkshop');
  });
});
