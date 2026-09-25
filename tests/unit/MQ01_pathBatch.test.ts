import { describe, expect, it } from 'vitest';
import type { PathEndpoint } from '../../src/topology/pathPreview';
import { preparePathPreview, previewPath } from '../../src/topology/pathPreview';
import { editorFixture, testNode } from '../helpers/M1_fixtures';
import { testFacility } from '../helpers/M2A_fixtures';
import { contentHash } from '../../src/domain/serialization';

const a: PathEndpoint = { kind: 'nodes', id: 'nA' };
const c: PathEndpoint = { kind: 'nodes', id: 'nC' };
const sa: PathEndpoint = { kind: 'servicePoints', id: 'sA' };
const sc: PathEndpoint = { kind: 'servicePoints', id: 'sC' };
const arc = (roadId: string) => ({ roadId, direction: 'forward' as const });
const direction = { mode: 'direction_only' as const };
function fixture() {
  const map = editorFixture(); map.schemaVersion = '0.2.0'; map.mapId = 'MQ01_fault_injected_batch';
  map.nodes.nC = testNode('C', 200); map.roads.rAB!.direction = 'forward';
  map.roads.rBC = { ...structuredClone(map.roads.rAB!), name: 'BC', fromNodeId: 'nB', toNodeId: 'nC' };
  map.junctions.jB = { name: 'B', nodeIds: ['nB'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.mABC = { name: 'ABC', junctionId: 'jB', incomingArc: arc('rAB'), outgoingArc: arc('rBC'), allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  for (const [id, nodeId] of [['sA', 'nA'], ['sC', 'nC']]) map.servicePoints[id!] = { name: id!, kind: 'other', nodeId: nodeId!, resourceIds: [], provenance: { category: 'synthetic' }, arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'MQ01 explicitly synthetic batch test' } };
  return map;
}

describe('MQ01 prepared existing path preview', () => {
  it('matches legacy reports and isolates prepared snapshot and returned arrays across queries', () => {
    const map = fixture(), before = structuredClone(map), batch = preparePathPreview(map);
    const expected = previewPath(map, sa, sc);
    expect(batch.preview(sa, sc)).toEqual(expected); expect(batch.mapContentHash).toBe(contentHash(map));
    const result = batch.preview(sa, sc); result.confirmed!.points[0]![0] = 999; result.issues[0]!.message = 'mutated';
    expect(batch.preview(sa, sc)).toEqual(expected); expect(map).toEqual(before);
    map.nodes.nC!.position[0] = 210; map.movements.mABC!.allowed = false;
    expect(batch.preview(sa, sc)).toEqual(expected); expect(preparePathPreview(map).mapContentHash).not.toBe(batch.mapContentHash);
  });
  it('direction-only ignores forbidden or undeclared turns, but never allows unknown or forbidden road direction', () => {
    const map = fixture(); map.movements.mABC!.allowed = false;
    let batch = preparePathPreview(map);
    expect(batch.preview(a, c).status).toBe('disconnected');
    const result = batch.preview(a, c, direction);
    expect(result.status).toBe('found'); expect(result.mode).toBe('direction_only'); expect(result.complete).toBe(true);
    expect(result.confirmed?.arcs).toEqual([arc('rAB'), arc('rBC')]); expect(result.unchecked).toContain('movement_permissions');
    expect(batch.preview(c, a, direction).status).toBe('disconnected');
    delete map.movements.mABC; batch = preparePathPreview(map);
    expect(batch.preview(a, c).status).toBe('unconfirmed'); expect(batch.preview(a, c, direction).status).toBe('found');
    map.roads.rBC!.direction = 'unknown'; batch = preparePathPreview(map);
    expect(batch.preview(a, c).status).toBe('unconfirmed');
    const unknown = batch.preview(a, c, direction); expect(unknown.status).toBe('disconnected'); expect(unknown.candidate).toBeNull();
    expect(unknown.issues.at(-1)?.code).toBe('PATH_NO_KNOWN_DIRECTION_ROUTE');
  });
  it('node endpoint never inherits the service arrival suffix or manufactures an exit', () => {
    const map = fixture(); map.roads.rAC = { ...structuredClone(map.roads.rAB!), name: 'shortcut', toNodeId: 'nC' };
    map.roads.rAB!.shapePoints = [[50, 20, 0]];
    map.servicePoints.sC!.arrival = { mode: 'explicit_internal', entryNodeId: 'nA', internalPath: [arc('rAB'), arc('rBC')] };
    map.movements.mABC!.allowed = false;
    const batch = preparePathPreview(map), service = batch.preview(sa, sc, direction), node = batch.preview(a, c, direction);
    expect(service.confirmed?.arcs).toEqual([arc('rAB'), arc('rBC')]); expect(service.confirmed!.lengthM).toBeGreaterThan(200);
    expect(service.issues.find(i => i.code === 'INTERNAL_TURN_FORBIDDEN')?.severity).toBe('warning');
    expect(node.confirmed?.arcs).toEqual([arc('rAC')]); expect(node.confirmed?.lengthM).toBe(200);
    expect(batch.preview(sc, sa, direction).status).toBe('disconnected');
    expect(batch.preview(sa, sc).status).toBe('disconnected');
  });
  it('keeps owner restrictions for services and gives node endpoints no invented owner privilege', () => {
    const map = fixture(); map.facilities.fA = testFacility(); map.facilities.fA.servicePointIds = ['sC']; map.servicePoints.sC!.facilityId = 'fA';
    map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.roads.rBC!.extensions = { 'sr02.planning': { role: 'internal', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance', ownerEntityId: 'fA' } };
    const batch = preparePathPreview(map);
    expect(batch.preview(sa, sc, direction).status).toBe('found');
    expect(batch.preview(a, c, direction).status).toBe('disconnected');
    expect(batch.preview(a, sc, direction).status).toBe('found');
  });
  it('does not leak endpoint failures or issues to a later query, and preserves zero-displacement scope', () => {
    const map = fixture(); delete map.servicePoints.sC!.arrival;
    const batch = preparePathPreview(map), missing = { kind: 'nodes', id: 'missing' } as const;
    expect(batch.preview(a, missing).complete).toBe(false);
    expect(batch.preview(sa, sc).status).toBe('not_checked');
    expect(batch.preview(a, c).status).toBe('found'); expect(batch.preview(a, c).issues).toEqual([]);
    expect(batch.preview(sa, sc)).toEqual(previewPath(map, sa, sc));
    const same = batch.preview(a, a); expect(same.complete).toBe(true); expect(same.confirmed?.lengthM).toBe(0);
  });
  it('preserves unknown behavior and unsupported transition protection in direction-only', () => {
    const map = fixture(); map.extensionNamespaces.future = { version: '1', category: 'behavior' };
    expect(preparePathPreview(map).preview(a, c, direction)).toMatchObject({ status: 'not_checked', complete: false });
    delete map.extensionNamespaces.future; map.movements.mABC!.internalPath = [[99, 0, 0], [101, 0, 0]];
    expect(preparePathPreview(map).preview(a, c, direction).issues.at(-1)?.code).toBe('PATH_MOVEMENT_GEOMETRY_UNSUPPORTED');
    delete map.movements.mABC!.internalPath; map.junctions.jB!.nodeIds.push('nA');
    expect(preparePathPreview(map).preview(a, c, direction).issues.at(-1)?.code).toBe('PATH_JUNCTION_TRANSITION_UNSUPPORTED');
  });
  it('returns not_checked for graph and per-query search budgets, never a truncated disconnected result', () => {
    const map = fixture(); map.roads = {}; map.movements = {}; map.junctions = {};
    const model = fixture().roads.rAB!;
    for (let i = 0; i < 1500; i++) { const id = 'leaf' + i; map.nodes[id] = testNode(id, 10, i); map.roads['r' + i] = { ...structuredClone(model), toNodeId: id }; }
    const batch = preparePathPreview(map), result = batch.preview(a, c, direction);
    expect(result).toMatchObject({ status: 'not_checked', complete: false, confirmed: null, candidate: null });
    expect(result.issues.at(-1)?.code).toBe('PATH_COMPLEXITY_LIMIT');
    expect(batch.preview(a, { kind: 'nodes', id: 'leaf0' }, direction).status).toBe('found');
    for (let i = 1500; i < 2001; i++) map.roads['r' + i] = structuredClone(model);
    expect(preparePathPreview(map).preview(a, c).issues.at(-1)?.code).toBe('PATH_COMPLEXITY_LIMIT');
  });
});
