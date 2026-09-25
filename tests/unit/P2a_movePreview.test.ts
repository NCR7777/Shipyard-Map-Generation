import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { planMove } from '../../src/app/canvas/movePreview';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { expectPreviewMatchesCommit } from '../helpers/P2a_previewCheck';

function example(): YardMap {
  const loaded = loadMap(readFileSync(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), 'utf8'));
  if (!loaded.ok) throw new Error('example did not load');
  return loaded.map;
}

describe('the drag preview draws what the commit will produce', () => {
  it('a road carries its end nodes and stretches the roads attached to them', () => {
    expect(expectPreviewMatchesCommit(example(), { nodes: [], roads: ['rMain'] }, [6.5, 0, 0])).toBeGreaterThan(3);
  });
  it('a zone carries its service point and the node under it', () => {
    expect(expectPreviewMatchesCommit(example(), { nodes: [], roads: [], zones: ['zWaiting'] }, [-12, 4, 0])).toBeGreaterThan(1);
  });
  it('the kernel refusal comes before any drawing, including its structural checks', () => {
    const map = example(), scene = toSceneSnapshot(map);
    expect(() => planMove(map, scene, { nodes: [], roads: [], facilities: ['fWorkshop'] })).toThrow('服务内部路径');
    // selectionImpact alone lets this entrance through; commandSupport knows its node is shared with a public road.
    expect(() => planMove(map, scene, { nodes: [], roads: [], accessPoints: ['aWorkshop'] })).toThrow('共用节点');
  });
  it('the plan lists what the command touches beyond the selection, for the locked-layer check', () => {
    const map = example(), plan = planMove(map, toSceneSnapshot(map), { nodes: [], roads: [], zones: ['zWaiting'] });
    expect(new Set(plan.affectedRefs.map(ref => ref.kind))).toContain('roads');
  });
  it('a copy hides nothing and draws the closure at the offset', () => {
    const map = example(), plan = planMove(map, toSceneSnapshot(map), { nodes: [], roads: [], zones: ['zWaiting'] }, 'copy');
    expect(plan.hidden.size).toBe(0);
    expect(plan.overlay([5, 0, 0]).zones[0]!.boundary.outer[0]).toEqual([75, 30, 0]);
  });
  it('a copied road previews only what the copy creates: not the entrance sitting on its end node', () => {
    const map = example(), overlay = planMove(map, toSceneSnapshot(map), { nodes: [], roads: ['rMain'] }, 'copy').overlay([0, 5, 0]);
    expect(overlay.roads.map(road => road.id)).toEqual(['rMain']);
    expect(overlay.accessPoints).toEqual([]);
  });
});
