import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { commandSupport, type MapCommand } from '../../src/domain/commands';

function fixture() {
  const map = newMap('synthetic_TE01_incoming_dependency');
  for (const [id, position] of Object.entries({ a: [0, 0, 0], b: [10, 0, 0], t: [0, 1, 0], u: [0, 10, 0] })) map.nodes[id] = newNode(position as [number, number, number]);
  map.roads.r = { ...newRoad('a', 'b'), direction: 'both' };
  map.roads.s = { ...newRoad('t', 'u'), direction: 'both', resourceIds: ['roadResource'] };
  map.junctions.j = { name: 'target', nodeIds: ['t'], model: 'explicit_movements', resourceIds: ['junctionResource'], provenance: { category: 'synthetic' } };
  map.resources.junctionResource = { name: 'target junction resource', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'j' }], provenance: { category: 'synthetic' } };
  map.resources.roadResource = { ...structuredClone(map.resources.junctionResource), name: 'target road resource', kind: 'road', appliesTo: [{ entityType: 'roads', entityId: 's' }] };
  return map;
}
describe('TE01 before and after dependency closure', () => {
  it('includes the unchanged target node, neighboring road and resources when merging an unassociated source', () => {
    const map = fixture(), original = structuredClone(map);
    const support = commandSupport(map, { type: 'mergeNodes', sourceNodeId: 'a', targetNodeId: 't' });
    expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
    expect(support.affectedRefs).toEqual(expect.arrayContaining([
      { kind: 'nodes', id: 't' }, { kind: 'roads', id: 's' }, { kind: 'junctions', id: 'j' },
      { kind: 'resources', id: 'junctionResource' }, { kind: 'resources', id: 'roadResource' },
    ]));
    expect(map).toEqual(original);
  });
  it('includes a reused split node and its existing junction/resource even without moving it', () => {
    const map = fixture(); map.nodes.t!.position = [5, 0, 0];
    const command: MapCommand = { type: 'splitRoad', id: 'r', distanceM: 5, nodeId: 't', existingNode: true, newRoadIds: ['left', 'right'] };
    const support = commandSupport(map, command);
    expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
    expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'nodes', id: 't' }, { kind: 'junctions', id: 'j' }, { kind: 'resources', id: 'roadResource' }]));
    expect(new Set(support.affectedRefs.map(ref => ref.kind + '/' + ref.id)).size).toBe(support.affectedRefs.length);
  });
});
