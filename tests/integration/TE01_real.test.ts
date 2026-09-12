import { describe, expect, it } from 'vitest';
import { previewPath } from '../../src/topology/pathPreview';
import { TE01Synthetic } from '../helpers/TE01_fixtures';
import { readonlyFixture } from '../helpers/M1_fixtures';
import { internalServiceFixture } from '../helpers/M2A1_fixtures';
import type { MapCommand } from '../../src/domain/commands';
import type { YardMap } from '../../src/domain/model';
import { loadMap } from '../../src/domain/load';
import { serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { TE01_TARGETS, TE01_NETWORK_COMMANDS, readTE01Target, TE01RoadDependencies, TE01_HANWHA, assertTE01Equal, assertTE01HanwhaDeletion } from '../helpers/TE01_targets';

function singleTransaction(map: YardMap, command: MapCommand): YardMap {
  const session = createSession(map); const result = editSession(session, command);
  expect(result.ok, JSON.stringify(result.issues.filter(issue => issue.severity === 'error'))).toBe(true);
  expect(result.session.past).toHaveLength(1);
  expect(result.session.map.revision).toBe(map.revision + 1);
  assertTE01Equal(result.session.map.coordinateFrame, map.coordinateFrame);
  const undone = undoSession(result.session); assertTE01Equal(undone.map, map);
  const redone = redoSession(undone); assertTE01Equal(redone.map, result.session.map);
  expect(redone.past).toHaveLength(1); expect(redone.future).toHaveLength(0);
  const loaded = loadMap(serializeMap(redone.map)); expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error('edited topology must reload');
  assertTE01Equal(loaded.map, redone.map);
  assertTE01Equal(session.map, map, 'original session remains immutable');
  return redone.map;
}

describe('TE01 real frozen inputs, explicit topology edits', () => {
  it.each(TE01_TARGETS)('$id splits/suppresses a real road and independently merges/connects native nodes', async target => {
    const original = await readTE01Target(target);
    const roadId = Object.keys(original.roads).find(id => [original.roads[id]!.fromNodeId, original.roads[id]!.toNodeId].includes(target.nodeId))!;
    const road = original.roads[roadId]!, deps = TE01RoadDependencies(original, roadId);
    const newRoadIds: [string, string] = ['R_TE01_left', 'R_TE01_right'];
    const split = singleTransaction(original, { type: 'splitRoad', id: roadId, distanceM: roadLength(original, roadId) / 2, nodeId: 'N_TE01_split', newRoadIds });
    expect(split.roads[roadId]).toBeUndefined(); expect(split.nodes.N_TE01_split).toBeDefined();
    expect(Object.keys(split.roads)).toHaveLength(Object.keys(original.roads).length + 1);
    expect(Object.keys(split.nodes)).toHaveLength(Object.keys(original.nodes).length + 1);
    expect(split.roads.R_TE01_left!.fromNodeId).toBe(road.fromNodeId);
    expect(split.roads.R_TE01_right!.toNodeId).toBe(road.toNodeId);
    expect(split.roads.R_TE01_left!.toNodeId).toBe('N_TE01_split');
    expect(split.roads.R_TE01_right!.fromNodeId).toBe('N_TE01_split');
    expect(Math.abs(roadLength(split, newRoadIds[0]) + roadLength(split, newRoadIds[1]) - roadLength(original, roadId))).toBeLessThanOrEqual(1e-6);
    for (const [id, turn] of Object.entries(original.movements)) {
      const expected = structuredClone(turn);
      if (turn.incomingArc.roadId === roadId) expected.incomingArc.roadId = turn.incomingArc.direction === 'forward' ? newRoadIds[1] : newRoadIds[0];
      if (turn.outgoingArc.roadId === roadId) expected.outgoingArc.roadId = turn.outgoingArc.direction === 'forward' ? newRoadIds[0] : newRoadIds[1];
      const fields = [turn.incomingArc.roadId === roadId ? 'incomingArc' : '', turn.outgoingArc.roadId === roadId ? 'outgoingArc' : ''].filter(Boolean);
      if (fields.length) expected.provenance = { ...turn.provenance, sourceRefs: [...new Set([...(turn.provenance.sourceRefs ?? []), 'source_editor_topology'])], fieldSources: { ...turn.provenance.fieldSources, ...Object.fromEntries(fields.map(field => [field, 'source_editor_topology'])) } };
      assertTE01Equal(split.movements[id], expected, 'only explicit endpoint arc references and their field attribution may change');
    }
    for (const id of deps.sharedRoads) assertTE01Equal(split.roads[id], original.roads[id]);
    for (const key of ['facilities', 'zones', 'accessPoints', 'servicePoints', 'assets', 'backgroundLayers'] as const) assertTE01Equal(split[key], original[key]);
    for (const id of deps.movementResourceIds) assertTE01Equal(split.resources[id], original.resources[id]);
    const suppressed = singleTransaction(split, { type: 'suppressDegree2Node', nodeId: 'N_TE01_split', retainedRoadId: newRoadIds[0] } as MapCommand);
    expect(suppressed.nodes.N_TE01_split).toBeUndefined(); expect(suppressed.roads.R_TE01_right).toBeUndefined();
    expect(suppressed.roads.R_TE01_left!.fromNodeId).toBe(road.fromNodeId);
    expect(suppressed.roads.R_TE01_left!.toNodeId).toBe(road.toNodeId);
    expect(Math.abs(roadLength(suppressed, newRoadIds[0]) - roadLength(original, roadId))).toBeLessThanOrEqual(1e-6);
    const points = roadPoints(suppressed, newRoadIds[0]);
    assertTE01Equal(points[0], original.nodes[road.fromNodeId]!.position);
    assertTE01Equal(points.at(-1), original.nodes[road.toNodeId]!.position);
    for (const command of Object.values(TE01_NETWORK_COMMANDS[target.id]!)) {
      const edited = singleTransaction(original, command);
      if (command.type === 'mergeNodes') {
        expect(edited.nodes[command.sourceNodeId]).toBeUndefined();
        assertTE01Equal(edited.nodes[command.targetNodeId]!.position, original.nodes[command.targetNodeId]!.position);
        expect(Object.keys(edited.nodes)).toHaveLength(Object.keys(original.nodes).length - 1);
        expect(Object.keys(edited.roads)).toHaveLength(Object.keys(original.roads).length);
        expect(Object.keys(edited.movements)).toHaveLength(Object.keys(original.movements).length);
        for (const [id, turn] of Object.entries(original.movements)) expect(edited.movements[id]!.allowed).toBe(turn.allowed);
        for (const [id, old] of Object.entries(original.roads)) {
          expect(edited.roads[id]!.fromNodeId).toBe(old.fromNodeId === command.sourceNodeId ? command.targetNodeId : old.fromNodeId);
          expect(edited.roads[id]!.toNodeId).toBe(old.toNodeId === command.sourceNodeId ? command.targetNodeId : old.toNodeId);
          assertTE01Equal(edited.roads[id]!.shapePoints, old.shapePoints);
          for (const key of ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps', 'resourceIds', 'extensions'] as const) assertTE01Equal(edited.roads[id]![key], old[key]);
        }
      } else if (command.type === 'connectNodeToRoad') {
        expect(edited.roads[command.roadId]).toBeUndefined();
        expect(Object.keys(edited.nodes)).toHaveLength(Object.keys(original.nodes).length);
        expect(Object.keys(edited.roads)).toHaveLength(Object.keys(original.roads).length + 1);
        expect(edited.roads[command.newRoadIds[0]]!.toNodeId).toBe(command.nodeId);
        expect(edited.roads[command.newRoadIds[1]]!.fromNodeId).toBe(command.nodeId);
        expect(Math.abs(roadLength(edited, command.newRoadIds[0]) - command.distanceM)).toBeLessThanOrEqual(1e-6);
        expect(Math.abs(roadLength(edited, command.newRoadIds[0]) + roadLength(edited, command.newRoadIds[1]) - roadLength(original, command.roadId))).toBeLessThanOrEqual(1e-6);
        expect(edited.junctions[command.junctionId]!.nodeIds).toContain(command.nodeId);
        expect(command.approvedMovements).toEqual([]);
        const addedTurns = Object.entries(edited.movements).filter(([id]) => !original.movements[id]);
        expect(addedTurns).toHaveLength(2); // Existing bidirectional road continuity only, no branch permission.
        for (const [, movement] of addedTurns) {
          expect(command.newRoadIds).toContain(movement.incomingArc.roadId); expect(command.newRoadIds).toContain(movement.outgoingArc.roadId);
          expect(movement.incomingArc.roadId).not.toBe(movement.outgoingArc.roadId); expect(movement.allowed).toBe(true);
        }
      }
      expect(Object.keys(edited.resources).sort()).toEqual(Object.keys(original.resources).sort());
      for (const [id, resource] of Object.entries(original.resources)) for (const field of ['name', 'kind', 'capacity', 'capacityUnit', 'controlModel', 'extensions'] as const) assertTE01Equal(edited.resources[id]![field], resource[field]);
      for (const key of ['facilities', 'zones', 'assets', 'backgroundLayers'] as const) assertTE01Equal(edited[key], original[key]);
      for (const kind of ['accessPoints', 'servicePoints'] as const) for (const [id, old] of Object.entries(original[kind])) {
        const expected = structuredClone(old);
        const changedFields: string[] = [];
        if (command.type === 'mergeNodes' && old.nodeId === command.sourceNodeId) { expected.nodeId = command.targetNodeId; changedFields.push('nodeId'); }
        if (command.type === 'mergeNodes' && kind === 'servicePoints') {
          const point = expected as YardMap['servicePoints'][string];
          if (point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === command.sourceNodeId) { point.arrival.entryNodeId = command.targetNodeId; changedFields.push('arrival'); }
        }
        if (changedFields.length) expected.provenance = { ...old.provenance, sourceRefs: [...new Set([...(old.provenance.sourceRefs ?? []), 'source_editor_topology'])], fieldSources: { ...old.provenance.fieldSources, ...Object.fromEntries(changedFields.map(field => [field, 'source_editor_topology'])) } };
        assertTE01Equal(edited[kind][id], expected, 'endpoint ID remapping retains all service and owner declarations');
      }
    }
    await readTE01Target(target);
  }, 60000);

  it('Hanwha v01 deletes the requested road and exactly eight explicit dependent turns, retaining shared resources', async () => {
    const original = await readTE01Target(TE01_TARGETS.find(target => target.id === TE01_HANWHA.id)!);
    const implicit = editSession(createSession(original), { type: 'deleteSelection', selection: { nodes: [], roads: [TE01_HANWHA.roadId] } });
    expect(implicit.ok).toBe(false); expect(implicit.session.past).toHaveLength(0); assertTE01Equal(implicit.session.map, original);
    const after = singleTransaction(original, { type: 'deleteSelection', selection: { nodes: [], roads: [TE01_HANWHA.roadId] }, topologyPolicy: 'cascade' } as MapCommand);
    assertTE01HanwhaDeletion(original, after);
  }, 60000);
});


describe('TE01 independent synthetic reference counterexamples', () => {
  it('splits and suppresses a declared service internal path without losing arc order, while cascade deletion is rejected', () => {
    const original = internalServiceFixture();
    const deletion = editSession(createSession(original), { type: 'deleteSelection', selection: { nodes: [], roads: ['rInternal'] }, topologyPolicy: 'cascade' });
    expect(deletion.ok).toBe(false); expect(deletion.issues.some(issue => issue.code === 'TOPOLOGY_SERVICE_PATH_DEPENDENCY')).toBe(true);
    expect(deletion.session.past).toHaveLength(0); assertTE01Equal(deletion.session.map, original);
    const split = singleTransaction(original, { type: 'splitRoad', id: 'rInternal', distanceM: roadLength(original, 'rInternal') / 2, nodeId: 'nMiddle', newRoadIds: ['rLeft', 'rRight'] });
    expect(split.servicePoints.sA!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'rLeft', direction: 'forward' }, { roadId: 'rRight', direction: 'forward' }] });
    const suppressed = singleTransaction(split, { type: 'suppressDegree2Node', nodeId: 'nMiddle', retainedRoadId: 'rLeft' });
    expect(suppressed.servicePoints.sA!.arrival).toEqual({ mode: 'explicit_internal', internalPath: [{ roadId: 'rLeft', direction: 'forward' }] });
    expect(suppressed.servicePoints.sA!.nodeId).toBe(original.servicePoints.sA!.nodeId);
    assertTE01Equal(suppressed.facilities, original.facilities);
  });
  it('unknown behavior refuses topology edits without mutating the frame, map or history', () => {
    const original = readonlyFixture(), before = createSession(original);
    const result = editSession(before, { type: 'splitRoad', id: 'rAB', distanceM: 50, nodeId: 'nMiddle', newRoadIds: ['rLeft', 'rRight'] });
    expect(result.ok).toBe(false); expect(result.issues.some(issue => issue.code === 'READ_ONLY_MAP')).toBe(true);
    expect(result.session).toBe(before); expect(result.session.past).toHaveLength(0); assertTE01Equal(result.session.map, original);
  });
});


it('TE01 explicit branch permission changes path preview from unconfirmed to found, and a forbidden turn stays blocked', () => {
  const base: YardMap = { ...TE01Synthetic(), schemaVersion: '0.2.0', servicePoints: {} };
  for (const [id, nodeId] of [['sBranch', 'nD'], ['sMain', 'nB']] as const) base.servicePoints[id] = { name: id, nodeId, kind: 'loading', resourceIds: [], provenance: { category: 'synthetic' }, arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'TE01 synthetic path endpoint; transfer time explicitly excluded' } };
  const command = { type: 'connectNodeToRoad', nodeId: 'nC', roadId: 'rAB', distanceM: 50, newRoadIds: ['rLeft', 'rRight'], junctionId: 'jConnect', approvedMovements: [] } as const;
  const unapproved = singleTransaction(base, { ...command, newRoadIds: [...command.newRoadIds], approvedMovements: [] });
  const from = { kind: 'servicePoints', id: 'sBranch' } as const, to = { kind: 'servicePoints', id: 'sMain' } as const;
  expect(previewPath(unapproved, from, to).status).toBe('unconfirmed');
  const turn = { id: 'mBranchToMain', incomingArc: { roadId: 'rCD', direction: 'backward' }, outgoingArc: { roadId: 'rRight', direction: 'forward' } } as const;
  const approved = singleTransaction(base, { ...command, newRoadIds: [...command.newRoadIds], approvedMovements: [turn] });
  const path = previewPath(approved, from, to); expect(path.status).toBe('found');
  expect(path.confirmed!.arcs).toEqual([turn.incomingArc, turn.outgoingArc]);
  const forbidden = structuredClone(approved); forbidden.movements.mBranchToMain!.allowed = false;
  const blocked = previewPath(forbidden, from, to); expect(blocked.confirmed).toBeNull(); expect(blocked.status).not.toBe('found');
});

it('TE01 real Hanwha node cascade deletes only incident roads, dependent turns and the emptied junction, retaining resource entities', async () => {
  const original = await readTE01Target(TE01_TARGETS.find(target => target.id === 'hanwha_v01')!);
  const nodeId = 'N_HW_be5a562998';
  const roads = Object.keys(original.roads).filter(id => [original.roads[id]!.fromNodeId, original.roads[id]!.toNodeId].includes(nodeId));
  const turns = Object.keys(original.movements).filter(id => roads.includes(original.movements[id]!.incomingArc.roadId) || roads.includes(original.movements[id]!.outgoingArc.roadId));
  const junctions = Object.keys(original.junctions).filter(id => original.junctions[id]!.nodeIds.length === 1 && original.junctions[id]!.nodeIds[0] === nodeId);
  const after = singleTransaction(original, { type: 'deleteSelection', selection: { nodes: [nodeId], roads: [] }, topologyPolicy: 'cascade' });
  const expected = structuredClone(original); expected.revision++;
  delete expected.nodes[nodeId]; for (const id of roads) delete expected.roads[id]; for (const id of turns) delete expected.movements[id]; for (const id of junctions) delete expected.junctions[id];
  const removed = new Set(['nodes/' + nodeId, ...roads.map(id => 'roads/' + id), ...turns.map(id => 'movements/' + id), ...junctions.map(id => 'junctions/' + id)]);
  let resourceChanged = false;
  for (const resource of Object.values(expected.resources)) {
    const refs = resource.appliesTo.filter(ref => !removed.has(ref.entityType + '/' + ref.entityId));
    if (refs.length === resource.appliesTo.length) continue;
    resourceChanged = true; resource.appliesTo = refs;
    resource.provenance = { ...resource.provenance, sourceRefs: [...new Set([...(resource.provenance.sourceRefs ?? []), 'source_editor_topology'])], fieldSources: { ...resource.provenance.fieldSources, appliesTo: 'source_editor_topology' } };
  }
  expect(resourceChanged).toBe(true);
  expected.sources.source_editor_topology = { name: '编辑器显式拓扑修改', category: 'design_assumption', description: '用户确认的节点、道路细分及连接引用修改；细分几何沿用原道路来源，新增通行声明为设计假设，未经现场核验。' };
  const namespace = 'org.shipyard.editor.lineage';
  const lineage = after.extensions[namespace] as { version: string; roadSplits: unknown[]; topologyEdits: { operation: string; removedNodes: string[]; removedRoads: string[]; removedMovements: string[]; removedJunctions: string[] }[] };
  expect(lineage.version).toBe('1.0.0'); expect(lineage.roadSplits).toEqual([]); expect(lineage.topologyEdits).toHaveLength(1);
  const record = lineage.topologyEdits[0]!;
  expect({ ...record, removedRoads: [...record.removedRoads].sort(), removedMovements: [...record.removedMovements].sort(), removedJunctions: [...record.removedJunctions].sort() }).toEqual({ operation: 'deleteSelection', removedNodes: [nodeId], removedRoads: [...roads].sort(), removedMovements: [...turns].sort(), removedJunctions: [...junctions].sort() });
  expect(Object.keys(lineage).sort()).toEqual(['roadSplits', 'topologyEdits', 'version']);
  expected.extensionNamespaces[namespace] = { version: '1.0.0', category: 'metadata' }; expected.extensions[namespace] = structuredClone(lineage);
  assertTE01Equal(after, expected, 'all unrelated entities, capacities, sources, frame, slots and declarations stay exact');
  expect(Object.keys(after.resources)).toHaveLength(Object.keys(original.resources).length);
}, 60000);
