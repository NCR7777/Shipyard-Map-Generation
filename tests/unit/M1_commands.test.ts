import { describe, expect, it } from 'vitest';
import { applyMapCommand, closureSelection } from '../../src/domain/commands';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { newMap } from '../../src/domain/factory';
import { serializeMap } from '../../src/domain/serialization';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { validateMap } from '../../src/validation/validate';
import { editorFixture, readonlyFixture, testNode } from '../helpers/M1_fixtures';

describe('M1 transactional domain commands', () => {
  it('adds nodes and a road without mutating prior snapshots or inventing attributes', () => {
    const empty = newMap('map_new', undefined, '0.1.0');
    const before = serializeMap(empty);
    const nodeResult = applyMapCommand(empty, { type: 'addNode', id: 'nA', node: testNode('A', 0) });
    expect(nodeResult.ok).toBe(true);
    if (!nodeResult.ok) throw new Error('Node command rejected.');
    expect(serializeMap(empty)).toBe(before);
    const second = applyMapCommand(nodeResult.map, { type: 'addNode', id: 'nB', node: testNode('B', 100) });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('Second node command rejected.');
    const road = applyMapCommand(second.map, { type: 'addRoad', id: 'rAB', road: editorFixture().roads.rAB! });
    expect(road.ok).toBe(true);
    if (!road.ok) throw new Error('Road command rejected.');
    expect(roadLength(road.map, 'rAB')).toBe(100);
    expect(road.map.roads.rAB!.widthM).toEqual({ state: 'unknown' });
    expect(road.map.roads.rAB!.resourceIds).toEqual([]);
    expect(validateMap(road.map).ok).toBe(true);
  });

  it('keeps IDs while editing names and numeric positions', () => {
    const map = editorFixture();
    const result = applyMapCommand(map, { type: 'updateNode', id: 'nB', patch: { name: 'B 改名', position: [120, 0, 0] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Node update rejected.');
    expect(result.changed).toBe(true);
    expect(Object.keys(result.map.nodes)).toEqual(['nA', 'nB']);
    expect(result.map.nodes.nB!.name).toBe('B 改名');
    expect(roadLength(result.map, 'rAB')).toBe(120);
    expect(map.nodes.nB!.position).toEqual([100, 0, 0]);
  });

  it('derives length from an ordered numerical shape edit', () => {
    const result = applyMapCommand(editorFixture(), { type: 'updateRoad', id: 'rAB', patch: { name: '折线', shapePoints: [[0, 30, 0], [100, 30, 0]] } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Road update rejected.');
    expect(roadLength(result.map, 'rAB')).toBe(160);
    expect(roadPoints(result.map, 'rAB')).toEqual([[0, 0, 0], [0, 30, 0], [100, 30, 0], [100, 0, 0]]);
  });

  it('refuses invalid atomic updates and retains the exact original map', () => {
    const map = editorFixture();
    const before = serializeMap(map);
    const result = applyMapCommand(map, { type: 'updateNode', id: 'nB', patch: { name: '不能半提交', position: [0, 0, 0] } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Zero-length road update accepted.');
    expect(result.issues.some((issue) => issue.severity === 'error')).toBe(true);
    expect(serializeMap(map)).toBe(before);
    expect(map.nodes.nB!.name).toBe('B');
  });

  it('refuses duplicate IDs instead of replacing existing entities', () => {
    const map = editorFixture();
    const before = serializeMap(map);
    const result = applyMapCommand(map, { type: 'addNode', id: 'nA', node: testNode('覆盖企图', 90) });
    expect(result.ok).toBe(false);
    expect(serializeMap(map)).toBe(before);
  });

  it('makes an unchanged edit a no-op rather than a history transaction', () => {
    const map = editorFixture();
    const result = applyMapCommand(map, { type: 'updateNode', id: 'nA', patch: { name: map.nodes.nA!.name } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('No-op rejected.');
    expect(result.changed).toBe(false);
    expect(result.map).toEqual(map);
  });

  it('includes both road endpoints in the selection closure', () => {
    const selection = closureSelection(editorFixture(), { nodes: [], roads: ['rAB'] });
    expect([...selection.nodes].sort()).toEqual(['nA', 'nB']);
    expect(selection.roads).toEqual(['rAB']);
  });

  it('copies a road atomically with fresh IDs and entirely remapped endpoint references', () => {
    const map = editorFixture();
    map.roads.rAB!.shapePoints = [[50, 15, 0]];
    const result = applyMapCommand(map, {
      type: 'duplicateSelection', selection: { nodes: [], roads: ['rAB'] }, delta: [0, 40, 0],
      idMap: { nA: 'nA_copy', nB: 'nB_copy', rAB: 'rAB_copy' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Valid closed road copy rejected.');
    expect(Object.keys(result.map.nodes).sort()).toEqual(['nA', 'nA_copy', 'nB', 'nB_copy']);
    const copy = result.map.roads.rAB_copy!;
    expect(copy.fromNodeId).toBe('nA_copy');
    expect(copy.toNodeId).toBe('nB_copy');
    expect(copy.shapePoints).toEqual([[50, 55, 0]]);
    expect(result.map.nodes.nA_copy!.position).toEqual([0, 40, 0]);
    expect(result.map.nodes.nB_copy!.position).toEqual([100, 40, 0]);
    expect(result.map.roads.rAB).toEqual(map.roads.rAB);
    expect(validateMap(result.map).ok).toBe(true);
  });

  it('rejects incomplete copy ID mappings without creating partial entities', () => {
    const map = editorFixture();
    const before = serializeMap(map);
    const result = applyMapCommand(map, {
      type: 'duplicateSelection', selection: { nodes: [], roads: ['rAB'] }, delta: [10, 10, 0], idMap: { rAB: 'rAB_copy' },
    });
    expect(result.ok).toBe(false);
    expect(serializeMap(map)).toBe(before);
  });

  it('rejects copying entities with opaque extensions that may contain unremapped IDs', () => {
    const map = editorFixture();
    map.extensionNamespaces['example.meta'] = { category: 'metadata', version: '1' };
    map.nodes.nA!.extensions = { 'example.meta': { potentiallyReferencedId: 'nB' } };
    const before = serializeMap(map);
    const result = applyMapCommand(map, {
      type: 'duplicateSelection', selection: { nodes: [], roads: ['rAB'] }, delta: [10, 10, 0],
      idMap: { nA: 'nA_copy', nB: 'nB_copy', rAB: 'rAB_copy' },
    });
    expect(result.ok).toBe(false);
    expect(serializeMap(map)).toBe(before);
  });

  it('translates a selected road and its endpoints by metres exactly once', () => {
    const map = editorFixture();
    map.roads.rAB!.shapePoints = [[50, 20, 0]];
    const result = applyMapCommand(map, { type: 'translateSelection', selection: { nodes: ['nA'], roads: ['rAB'] }, delta: [7, 11, 2] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Translation rejected.');
    expect(result.map.nodes.nA!.position).toEqual([7, 11, 2]);
    expect(result.map.nodes.nB!.position).toEqual([107, 11, 2]);
    expect(result.map.roads.rAB!.shapePoints).toEqual([[57, 31, 2]]);
    expect(roadLength(result.map, 'rAB')).toBe(roadLength(map, 'rAB'));
  });

  it('rejects a referenced-node deletion and accepts explicit road-plus-node deletion', () => {
    const map = editorFixture();
    const refused = applyMapCommand(map, { type: 'deleteSelection', selection: { nodes: ['nA'], roads: [] } });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error('Referenced endpoint deletion accepted.');
    expect(refused.issues.some((issue) => issue.entityId === 'rAB' || issue.message.includes('rAB'))).toBe(true);
    const accepted = applyMapCommand(map, { type: 'deleteSelection', selection: { nodes: ['nA'], roads: ['rAB'] } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) throw new Error('Explicit valid deletion rejected.');
    expect(Object.keys(accepted.map.nodes)).toEqual(['nB']);
    expect(accepted.map.roads).toEqual({});
    expect(validateMap(accepted.map).ok).toBe(true);
  });

  it('does not move a distinct coincident node or invent a connection by coordinate equality', () => {
    const map = editorFixture();
    map.nodes.nTwin = testNode('重合但不连接', 0);
    map.nodes.nC = testNode('C', 200);
    map.roads.rTwinC = { ...map.roads.rAB!, fromNodeId: 'nTwin', toNodeId: 'nC' };
    const result = applyMapCommand(map, { type: 'translateSelection', selection: { nodes: ['nA'], roads: [] }, delta: [0, 10, 0] });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Explicit node move rejected.');
    expect(result.map.nodes.nA!.position).toEqual([0, 10, 0]);
    expect(result.map.nodes.nTwin!.position).toEqual([0, 0, 0]);
    expect(roadPoints(result.map, 'rTwinC')).toEqual([[0, 0, 0], [200, 0, 0]]);
    const scene = toSceneSnapshot(result.map);
    expect(scene.roads.find((road) => road.id === 'rAB')!.fromNodeId).toBe('nA');
    expect(scene.roads.find((road) => road.id === 'rTwinC')!.fromNodeId).toBe('nTwin');
  });

  it('refuses every map-edit command against an unsupported advanced map', () => {
    const map = readonlyFixture();
    const before = serializeMap(map);
    const result = applyMapCommand(map, { type: 'updateNode', id: 'nB', patch: { position: [120, 0, 0] } });
    expect(result.ok).toBe(false);
    expect(serializeMap(map)).toBe(before);
  });
});
