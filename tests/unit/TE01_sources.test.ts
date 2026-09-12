import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { applyMapCommand } from '../../src/domain/commands';
import { recordTopologySources } from '../../src/domain/geometrySources';
import { validateMap } from '../../src/validation/validate';

describe('TE01 topology field attribution', () => {
  it('attributes inserted nodes and rewired roads, preserving original evidence and physical values', () => {
    const before = newMap('synthetic_topology_sources');
    before.sources.image = { name: 'reference', category: 'imagery_derived', description: 'synthetic test reference only' };
    before.nodes.a = newNode([0, 0, 0]); before.nodes.b = newNode([100, 0, 0]);
    before.roads.ab = newRoad('a', 'b');
    before.roads.ab.provenance = { category: 'imagery_derived', sourceRefs: ['image'], fieldSources: { widthM: 'image' } };
    const after = structuredClone(before);
    after.nodes.mid = { ...newNode([50, 0, 0]), provenance: structuredClone(before.roads.ab.provenance) };
    after.roads.ab!.toNodeId = 'mid';
    const refs = recordTopologySources(before, after, [{ kind: 'nodes', id: 'mid' }, { kind: 'roads', id: 'ab' }, { kind: 'roads', id: 'ab' }]);
    expect(refs).toEqual([{ kind: 'sources', id: 'source_editor_topology' }]);
    expect(after.nodes.mid.provenance.fieldSources?.position).toBe('source_editor_topology');
    expect(after.roads.ab!.provenance).toEqual({ category: 'imagery_derived', sourceRefs: ['image', 'source_editor_topology'], fieldSources: { widthM: 'image', toNodeId: 'source_editor_topology' } });
    expect(after.roads.ab!.widthM).toEqual(before.roads.ab.widthM);
    expect(after.sources.image).toEqual(before.sources.image);
    expect(before.sources.source_editor_topology).toBeUndefined();
    expect(validateMap(after).ok).toBe(true);
  });
  it('does not manufacture a source for no-op or deletion without surviving rewrites', () => {
    const before = newMap('synthetic_noop'); before.nodes.a = newNode([0, 0, 0]);
    const same = structuredClone(before);
    expect(recordTopologySources(before, same, [{ kind: 'nodes', id: 'a' }])).toEqual([]);
    expect(same).toEqual(before);
    const deleted = structuredClone(before); delete deleted.nodes.a;
    expect(recordTopologySources(before, deleted, [{ kind: 'nodes', id: 'a' }])).toEqual([]);
    expect(deleted.sources).toEqual({});
  });
  it('resolves global ID collisions and reuses the same declared source on subsequent edits', () => {
    const before = newMap('synthetic_collisions');
    before.nodes.source_editor_topology = newNode([0, 0, 0]);
    before.sources.source_editor_topology_1 = { name: 'original', category: 'synthetic', description: 'preserve' };
    const after = structuredClone(before); after.nodes.new = newNode([1, 0, 0]);
    expect(recordTopologySources(before, after, [{ kind: 'nodes', id: 'new' }])).toEqual([{ kind: 'sources', id: 'source_editor_topology_2' }]);
    const again = structuredClone(after); again.nodes.other = newNode([2, 0, 0]);
    expect(recordTopologySources(after, again, [{ kind: 'nodes', id: 'other' }])).toEqual([]);
    expect(again.nodes.other.provenance.sourceRefs).toEqual(['source_editor_topology_2']);
    expect(again.sources).toEqual(after.sources);
  });
  it('records changed resource references without changing capacity or control semantics', () => {
    const before = newMap('synthetic_resource_refs'); before.nodes.a = newNode([0, 0, 0]); before.nodes.b = newNode([1, 0, 0]);
    before.resources.r = { name: 'r', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown', appliesTo: [{ entityType: 'nodes', entityId: 'a' }], provenance: { category: 'synthetic' } };
    const after = structuredClone(before); after.resources.r!.appliesTo[0]!.entityId = 'b';
    recordTopologySources(before, after, [{ kind: 'resources', id: 'r' }]);
    expect(after.resources.r!.capacity).toEqual(before.resources.r.capacity);
    expect(after.resources.r!.controlModel).toBe('unknown');
    expect(after.resources.r!.provenance.fieldSources?.appliesTo).toBe('source_editor_topology');
    expect(validateMap(after).ok).toBe(true);
  });
});

it('keeps field-only original evidence connected after road split and ordinary node movement', () => {
  const original = newMap('synthetic_field_only_sources');
  original.sources.original = { name: 'old field evidence', category: 'imagery_derived', description: 'synthetic regression reference' };
  original.nodes.a = newNode([0, 0, 0]); original.nodes.b = newNode([100, 0, 0]);
  original.nodes.a.provenance = { category: 'imagery_derived', fieldSources: { position: 'original' } };
  original.roads.ab = newRoad('a', 'b');
  original.roads.ab.provenance = { category: 'imagery_derived', fieldSources: { fromNodeId: 'original', toNodeId: 'original', shapePoints: 'original' } };
  expect(validateMap(original).ok).toBe(true);
  const split = applyMapCommand(original, { type: 'splitRoad', id: 'ab', distanceM: 50, nodeId: 'middle', newRoadIds: ['left', 'right'] });
  expect(split.ok).toBe(true); if (!split.ok) throw new Error(JSON.stringify(split.issues));
  for (const id of ['left', 'right']) {
    expect(split.map.roads[id]!.provenance).toEqual({ category: 'imagery_derived', sourceRefs: ['original', 'source_editor_topology'], fieldSources: { fromNodeId: 'source_editor_topology', toNodeId: 'source_editor_topology', shapePoints: 'source_editor_topology' } });
  }
  const moved = applyMapCommand(original, { type: 'updateNode', id: 'a', patch: { position: [-5, 0, 0] } });
  expect(moved.ok).toBe(true); if (!moved.ok) throw new Error(JSON.stringify(moved.issues));
  expect(moved.map.nodes.a!.provenance).toEqual({ category: 'imagery_derived', sourceRefs: ['original', 'source_editor_geometry'], fieldSources: { position: 'source_editor_geometry' } });
  expect(original.nodes.a.provenance).toEqual({ category: 'imagery_derived', fieldSources: { position: 'original' } });
  expect(split.map.sources.original).toEqual(original.sources.original);
  expect(moved.map.sources.original).toEqual(original.sources.original);
});
