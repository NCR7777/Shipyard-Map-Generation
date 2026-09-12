import { strict as assert } from 'node:assert';
import { writeFile, mkdir } from 'node:fs/promises';
import { loadMap } from '../src/domain/load';
import { inspectPlanning } from '../src/domain/planning';
import { applyMapCommand, commandSupport, selectionImpact, type MapCommand } from '../src/domain/commands';
import { roadLength } from '../src/geometry/roads';
import { GA01_TARGETS, GA01Command, readGA01Target, assertGA01Change, GA01RoadCommand, assertGA01RoadChange } from '../tests/helpers/GA01_targets';

const phase = process.env.GA01_PHASE ?? 'A';
const rows = [];
for (const target of GA01_TARGETS) {
  const map = await readGA01Target(target); const loaded = loadMap(JSON.stringify(map));
  if (!loaded.ok) throw new Error('native load failed: ' + target.id);
  assert.equal(loaded.contentHash, target.contentHash, 'frozen semantic contentHash');
  const command = GA01Command(map, target, phase); const support = commandSupport(map, command);
  const applied = applyMapCommand(map, command);
  if (applied.ok && applied.changed) assertGA01Change(map, applied.map, target, phase);
  const planning = inspectPlanning(map);
  const owners = [...new Set(planning.slots.map(slot => slot.ownerKind + '/' + slot.ownerId))];
  const staticContents = owners.map(owner => {
    const [kind, id] = owner.split('/') as ['facilities' | 'zones', string];
    try { selectionImpact(map, { nodes: [], roads: [], [kind]: [id] }, kind === 'facilities' ? 'withStaticContents' : 'boundaryOnly', kind === 'zones' ? 'withStaticContents' : 'boundaryOnly'); return { owner, status: 'candidate_only' }; }
    catch (error) { return { owner, status: 'expected_blocked', code: (error as { code?: string }).code, reason: String(error) }; }
  });
  const leaf = selectionImpact(map, { nodes: [target.nodeId], roads: [] });
  const roadId = leaf.affectedRoadIds[0]!; const road = map.roads[roadId]!;
  const from = map.nodes[road.fromNodeId]!.position;
  const facility = map.facilities[target.facilityId]!;
  const zoneId = Object.keys(map.zones)[0]!; const zone = map.zones[zoneId]!;
  const zoneBoundary = structuredClone(zone.boundary);
  const zoneVertices = zoneBoundary.outer.slice(0, -1);
  const zoneCenter = [0, 1].map(axis => zoneVertices.reduce((sum, point) => sum + point[axis]!, 0) / zoneVertices.length);
  for (const ring of [zoneBoundary.outer, ...zoneBoundary.holes]) for (const point of ring) for (const axis of [0, 1] as const) point[axis] = zoneCenter[axis]! + (point[axis] - zoneCenter[axis]!) * 0.999;
  const operations: { operation: string; command: MapCommand }[] = [
    { operation: 'name_only_not_geometry', command: { type: 'updateFacility', id: target.facilityId, patch: { name: facility.name + ' GA01 test copy' } } },
    { operation: 'node_position', command: GA01Command(map, target, 'B') },
    { operation: 'node_translate', command: { type: 'translateSelection', selection: { nodes: [target.nodeId], roads: [] }, delta: [0.01, 0, 0] } },
    { operation: 'road_translate', command: { type: 'translateSelection', selection: { nodes: [], roads: [roadId] }, delta: [0.01, 0, 0] } },
    { operation: 'road_shapePoints', command: GA01RoadCommand(map, target, 'shape') },
    { operation: 'node_rotate', command: { type: 'rotateSelection', selection: { nodes: [target.nodeId], roads: [] }, pivot: [from[0] + 1, from[1] + 1, from[2]], angleRad: 0.00001 } },
    { operation: 'road_rotate', command: { type: 'rotateSelection', selection: { nodes: [], roads: [roadId] }, pivot: from, angleRad: 0.00001 } },
    { operation: 'zone_boundary', command: { type: 'updateZone', id: zoneId, patch: { boundary: zoneBoundary } } },
    { operation: 'road_direction', command: { type: 'updateRoad', id: roadId, patch: { direction: road.direction === 'both' ? 'forward' : 'both' } } },
    { operation: 'boundary', command: GA01Command(map, target, 'A') },
    { operation: 'boundary_translate', command: { type: 'translateSelection', selection: { nodes: [], roads: [], facilities: [target.facilityId] }, delta: [0.01, 0, 0], facilityMovePolicy: 'boundaryOnly' } },
    { operation: 'boundary_rotate', command: { type: 'rotateSelection', selection: { nodes: [], roads: [], facilities: [target.facilityId] }, pivot: facility.boundary.outer[0], angleRad: 0.00001, facilityMovePolicy: 'boundaryOnly' } },
    { operation: 'add_node', command: { type: 'addNode', id: 'N_GA01_probe_add', node: { ...structuredClone(map.nodes[target.nodeId]!), name: 'GA01 isolated test copy', position: [from[0] + 1, from[1] + 1, from[2]] } } },
    { operation: 'copy_boundary', command: { type: 'duplicateSelection', selection: { nodes: [], roads: [], facilities: [target.facilityId] }, delta: [0.01, 0, 0], idMap: { [target.facilityId]: 'F_GA01_probe_copy' }, associationPolicy: 'rejectExternal' } },
    { operation: 'delete_boundary', command: { type: 'deleteSelection', selection: { nodes: [], roads: [], facilities: [target.facilityId] }, facilityPolicy: 'reject' } },
    { operation: 'split_road', command: { type: 'splitRoad', id: roadId, distanceM: roadLength(map, roadId) / 2, nodeId: 'N_GA01_probe_split', newRoadIds: ['R_GA01_probe_left', 'R_GA01_probe_right'] } },
    { operation: 'no_op_boundary', command: { type: 'updateFacility', id: target.facilityId, patch: { boundary: structuredClone(facility.boundary) } } },
  ];
  for (const field of ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps'] as const) {
    const prior = road[field]; const value = prior.state === 'known' ? prior.value + 0.01 : 1;
    operations.push({ operation: 'road_' + field + '_design_assumption', command: { type: 'updateRoad', id: roadId, patch: { [field]: { state: 'known', value } }, designAssumption: { id: 'SRC_GA01_parameter_probe', name: 'GA01 isolated parameter test', description: 'Explicit test design assumption; not a vehicle requirement or field measurement.' } } });
  }
  if (phase === 'B') operations.push({ operation: 'road_width_speed_design_assumption', command: GA01RoadCommand(map, target, 'parameters') });
  if (phase === 'B' && target.id === 'geoje_v01') {
    // Preserve the original representative's real rejection after selecting a safe leaf for the browser closure.
    const original = { ...target, nodeId: 'N_GJ_98578c20a5' };
    operations.push({ operation: 'original_leaf_node_expected_blocked', command: GA01Command(map, original, 'B') });
    operations.push({ operation: 'original_leaf_shape_expected_blocked', command: GA01RoadCommand(map, original, 'shape') });
  }
  const owner = owners[0];
  if (owner) { const [kind, id] = owner.split('/') as ['facilities' | 'zones', string]; operations.push({ operation: 'staticMove_expected_blocked', command: { type: 'translateSelection', selection: { nodes: [], roads: [], [kind]: [id] }, delta: [0.01, 0, 0], facilityMovePolicy: kind === 'facilities' ? 'withStaticContents' : 'boundaryOnly', zoneMovePolicy: kind === 'zones' ? 'withStaticContents' : 'boundaryOnly' } }); }
  const operationMatrix = operations.map(probe => {
    const before = structuredClone(map); const permission = commandSupport(before, probe.command); const result = applyMapCommand(before, probe.command);
    assert.deepEqual(before, map, 'command must not mutate input');
    if (result.ok) { assert.deepEqual(result.map.coordinateFrame, map.coordinateFrame); if (!result.changed) assert.deepEqual(result.map, map); }
    return { ...probe, support: permission, actualApply: result.ok ? { ok: true, changed: result.changed, frameEqual: true, revision: result.map.revision, affectedRefs: result.transaction?.affectedRefs } : result };
  });
  const sequentialRoadEdits = [];
  if (phase === 'B' && applied.ok && applied.changed) {
    let current = applied.map;
    for (const edit of ['shape', 'parameters'] as const) {
      const requested = GA01RoadCommand(current, target, edit); const result = applyMapCommand(current, requested);
      sequentialRoadEdits.push({ edit, requested, actualApply: result.ok ? { ok: true, changed: result.changed, revision: result.map.revision } : result });
      if (!result.ok || !result.changed) break;
      assertGA01RoadChange(current, result.map, requested, edit); current = result.map;
    }
    if (sequentialRoadEdits.length === 2 && sequentialRoadEdits.every(item => item.actualApply.ok)) {
      await mkdir('.cache/GA01/B-native-edited', { recursive: true });
      await writeFile('.cache/GA01/B-native-edited/' + target.id + '.map.json', JSON.stringify(current, null, 2) + '\n');
    }
  }
  rows.push({ id: target.id, path: target.path, sha256: target.sha256, contentHash: loaded.contentHash, mapId: map.mapId, coordinateFrame: map.coordinateFrame,
    nativeValidation: loaded.report, namespaces: map.extensionNamespaces, capabilities: loaded.ok ? loaded.capabilities : null,
    planning: { supported: planning.supported, slots: planning.slots.length, issues: planning.issues }, command, support,
    actualApply: applied.ok ? { ok: true, changed: applied.changed, revision: applied.map.revision, frameEqual: true, affectedRefs: applied.transaction?.affectedRefs } : applied,
    operationMatrix, sequentialRoadEdits, staticContentsStatus: owners.length ? 'present_expected_blocked' : 'not_applicable_no_slots', staticContents, leafDependencies: leaf.affectedRefs.map(ref => ({ ...ref, ...(ref.kind === 'junctions' ? { boundary: map.junctions[ref.id]?.boundary ?? null } : {}), ...(ref.kind === 'movements' ? { internalPath: map.movements[ref.id]?.internalPath ?? null } : {}) })) });
  await readGA01Target(target);
  console.log(target.id + ': ' + (applied.ok ? 'geometry_changed=' + applied.changed : applied.issues.map(issue => issue.code).join(',')) + '; operations=' + operationMatrix.length);
}
await mkdir('.cache/GA01', { recursive: true });
await writeFile('.cache/GA01/GA01_' + phase + '_matrix.json', JSON.stringify({ phase, interpretation: 'Independent in-memory command copies only. Parameter values are test design assumptions. Browser receipts are separate; originals unchanged.', rows }, null, 2) + '\n');
if (phase !== 'baseline') {
  const table: string[][] = [['map_version', 'operation', 'entity', 'support_allowed', 'actual_result', 'reject_codes', 'json_paths', 'affected_refs']];
  for (const row of rows) for (const operation of row.operationMatrix) {
    const command = operation.command, result = operation.actualApply;
    const issues = 'issues' in result ? result.issues.filter(issue => issue.severity === 'error') : [];
    const entity = 'id' in command ? command.id : 'selection' in command ? Object.entries(command.selection).flatMap(([kind, ids]) => (ids as string[]).map(id => kind + '/' + id)).join(';') : '';
    const refs = 'affectedRefs' in result ? result.affectedRefs ?? [] : operation.support.affectedRefs;
    table.push([row.id, operation.operation, entity, String(operation.support.allowed), 'changed' in result ? result.changed ? 'changed' : 'no_op' : 'rejected', [...new Set(issues.map(issue => issue.code))].join(';'), [...new Set(issues.map(issue => issue.jsonPath ?? ''))].join(';'), refs.map(ref => ref.kind + '/' + ref.id).join(';')]);
  }
  for (const row of rows) if (!row.staticContents.length) table.push([row.id, 'staticMove', '', 'not_applicable', 'not_applicable_no_slots', '', '', '']);
  await writeFile('docs/GA01_' + phase + '_operations.csv', table.map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\n') + '\n');
}
