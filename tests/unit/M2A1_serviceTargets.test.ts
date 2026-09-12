import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMapCommand, closureSelection, normalizeSelection, selectionImpact, type MapCommand, type Selection } from '../../src/domain/commands';
import { newMap } from '../../src/domain/factory';
import { loadMap } from '../../src/domain/load';
import { mapCapabilities } from '../../src/domain/capabilities';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, redoSession as redo, undoSession as undo } from '../../src/editor/session';
import type { ServicePoint, YardMap } from '../../src/domain/model';
import { validateMap } from '../../src/validation/validate';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { inspectServiceConnection, zoneServicePointIds } from '../../src/topology/serviceConnections';
import { associatedFixture, missingBackgroundFixture } from '../helpers/M2A_fixtures';
import { testNode } from '../helpers/M1_fixtures';
import { currentServiceFixture, internalServiceFixture, proxyArrival, zoneInternalFixture, zoneServiceFixture } from '../helpers/M2A1_fixtures';

const selection = (items: Partial<Selection>) => normalizeSelection({ nodes: [], roads: [], ...items });
function execute(map: YardMap, command: MapCommand) {
  const result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(JSON.stringify(result));
  expect(validateMap(result.map).ok).toBe(true);
  return result;
}
function reject(map: YardMap, command: MapCommand, code?: string) {
  const before = serializeMap(map);
  const session = createSession(map);
  const result = editSession(session, command);
  expect(result.ok, JSON.stringify(result)).toBe(false);
  if (result.ok) throw new Error('A forbidden command succeeded.');
  if (code) expect(result.issues.some(issue => issue.code === code)).toBe(true);
  expect(serializeMap(map)).toBe(before);
  expect(serializeMap(session.map)).toBe(before);
  expect(session.past).toEqual([]);
  expect(session.future).toEqual([]);
  return result.issues;
}
function assertInvalid(map: unknown, path: string, code?: string) {
  const loaded = loadMap(JSON.stringify(map));
  expect(loaded.ok).toBe(false);
  if (loaded.ok) throw new Error('Invalid external JSON was accepted.');
  expect(loaded.report.issues.some(issue => issue.severity === 'error' && issue.jsonPath.startsWith(path) && (!code || issue.code === code))).toBe(true);
}
const point = (nodeId: string, zoneId?: string): ServicePoint => ({ name: 'synthetic 新服务', kind: 'unloading', nodeId, ...(zoneId ? { zoneId } : {}), arrival: proxyArrival(), resourceIds: [], provenance: { category: 'synthetic' } });

describe('M2A.1 strict compatibility and explicit upgrade (1, 26)', () => {
  it.each(['M1_synthetic.map.json', 'M2A_synthetic.map.json'])('keeps legacy %s version, IDs and canonical document intact', filename => {
    const source = readFileSync(new URL('../../examples/' + filename, import.meta.url), 'utf8');
    const result = loadMap(source);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.map.schemaVersion).toBe('0.1.0');
    expect(serializeMap(result.map)).toBe(source.replaceAll('\r\n', '\n'));
    expect(Object.keys(result.map.nodes)).toEqual(Object.keys(JSON.parse(source).nodes));
  });
  it('makes the new version explicit while retaining the legacy factory option', () => {
    expect(newMap('new').schemaVersion).toBe('0.2.0');
    expect(newMap('legacy', '旧版', '0.1.0').schemaVersion).toBe('0.1.0');
  });
  it.each(['zoneId', 'arrival'])('rejects the new field %s in unchanged 0.1.0', field => {
    const legacy = associatedFixture();
    Object.assign(legacy.servicePoints.sA!, { [field]: field === 'zoneId' ? 'zA' : proxyArrival() });
    assertInvalid(legacy, '/servicePoints/sA');
  });
  it('upgrades only version/revision, preserves every declared payload, and undo restores 0.1.0', () => {
    const legacy = associatedFixture();
    delete legacy.servicePoints.sA!.facilityId;
    delete legacy.servicePoints.sA!.accessPointId;
    legacy.facilities.fA!.servicePointIds = [];
    legacy.extensionNamespaces['test.legal_metadata'] = { category: 'metadata', version: '7' };
    legacy.extensions['test.legal_metadata'] = { values: [1.23456789012345, 'preserve', { custom: true }] };
    const before = serializeMap(legacy);
    const session = createSession(legacy);
    const result = execute(legacy, { type: 'upgradeSchema', targetVersion: '0.2.0' });
    expect(result.migrationChanges).toEqual([
      { path: '/schemaVersion', before: '0.1.0', after: '0.2.0' },
      { path: '/revision', before: legacy.revision, after: legacy.revision + 1 },
    ]);
    expect(result.map).toEqual({ ...legacy, schemaVersion: '0.2.0', revision: legacy.revision + 1 });
    expect(result.map.servicePoints.sA!.zoneId).toBeUndefined();
    expect(result.map.servicePoints.sA!.arrival).toBeUndefined();
    expect(contentHash(result.map)).not.toBe(contentHash(legacy));
    expect(serializeMap(legacy)).toBe(before);
    const edited = editSession(session, { type: 'upgradeSchema', targetVersion: '0.2.0' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error('Migration failed.');
    expect(serializeMap(undo(edited.session).map)).toBe(before);
    expect(redo(undo(edited.session)).map).toEqual(result.map);
  });
  it('upgrades protected assets/behavior without dropping data or unlocking unsupported editing', () => {
    const map = missingBackgroundFixture();
    map.extensionNamespaces['test.behavior'] = { category: 'behavior', version: '3' };
    map.extensions['test.behavior'] = { customController: ['not implemented', 9] };
    const upgraded = execute(map, { type: 'upgradeSchema', targetVersion: '0.2.0' }).map;
    expect(upgraded).toEqual({ ...map, schemaVersion: '0.2.0', revision: map.revision + 1 });
    expect(mapCapabilities(upgraded).editable).toBe(false);
    reject(upgraded, { type: 'renameMap', name: '必须拒绝' });
  });
  it('does not reinterpret unsupported future versions as a new map', () => {
    assertInvalid({ ...currentServiceFixture(), schemaVersion: '99.0.0' }, '/schemaVersion');
  });
  it('retains proxy assumptions and internal declarations through ten stable JSON cycles', () => {
    let map: YardMap = zoneInternalFixture();
    map.servicePoints.sA!.arrival = proxyArrival('synthetic：未建模转运明确不计入本模型');
    const before = serializeMap(map);
    for (let index = 0; index < 10; index++) {
      const result = loadMap(serializeMap(map));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('Round-trip failed.');
      map = result.map;
    }
    expect(serializeMap(map)).toBe(before);
  });
});

describe('M2A.1 explicit service ownership and atomic creation (2–8)', () => {
  it('binds an existing ordinary node without changing its position, kind or generating another node', () => {
    const map = currentServiceFixture();
    const nodes = structuredClone(map.nodes);
    const result = execute(map, { type: 'addServicePoint', id: 'sUnload', servicePoint: { ...point('nB'), facilityId: 'fA' } }).map;
    expect(result.nodes).toEqual(nodes);
    expect(result.servicePoints.sUnload).toMatchObject({ nodeId: 'nB', kind: 'unloading', facilityId: 'fA' });
    expect(result.facilities.fA!.servicePointIds).toEqual(['sA', 'sUnload']);
    expect(toSceneSnapshot(result).servicePoints.find(service => service.id === 'sUnload')!.position).toEqual([100, 0, 0]);
  });
  it('creates a dedicated node and zone service as one undoable transaction with stable redo IDs', () => {
    const map = zoneServiceFixture();
    const before = createSession(map);
    const result = editSession(before, { type: 'addServicePoint', id: 'sNew', servicePoint: point('nNew', 'zA'), newNode: { id: 'nNew', node: testNode('新目标', 85, 35) } });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.session.past).toHaveLength(1);
    expect(result.session.map.nodes.nNew!.position).toEqual([85, 35, 0]);
    expect(zoneServicePointIds(result.session.map, 'zA')).toEqual(['sNew', 'sZone']);
    expect(undo(result.session).map).toEqual(map);
    expect(redo(undo(result.session)).map).toEqual(result.session.map);
  });
  it('rejects invalid owner plus dedicated node creation with no residual node or history', () => {
    const map = zoneServiceFixture();
    const issues = reject(map, { type: 'addServicePoint', id: 'bad', servicePoint: point('newBad', 'missingZone'), newNode: { id: 'newBad', node: testNode('不得残留', 10) } }, 'DANGLING_REFERENCE');
    expect(issues.some(issue => issue.jsonPath === '/servicePoints/bad/zoneId')).toBe(true);
    expect(map.nodes.newBad).toBeUndefined();
  });
  it('yard remains a Facility while independent and overlapping zones retain explicit single ownership', () => {
    const map = zoneServiceFixture();
    map.facilities.fA!.kind = 'yard';
    expect(validateMap(map).ok).toBe(true);
    expect(zoneServicePointIds(map, 'zA')).toEqual(['sZone']);
    expect(zoneServicePointIds(map, 'zB')).toEqual([]);
    expect(map.servicePoints.sA!.facilityId).toBe('fA');
    expect(map.servicePoints.sA!.zoneId).toBeUndefined();
    expect(Object.hasOwn(map.zones.zA!, 'servicePointIds')).toBe(false);
    expect(mapCapabilities(map).editable).toBe(true);
  });
  it.each(['dualOwner', 'zoneAndAccess'])('rejects ambiguous ownership %s at the responsible field', kind => {
    const map = zoneServiceFixture();
    Object.assign(map.servicePoints.sZone!, kind === 'dualOwner' ? { facilityId: 'fA' } : { accessPointId: 'aA' });
    if (kind === 'dualOwner') map.facilities.fA!.servicePointIds.push('sZone');
    assertInvalid(map, '/servicePoints/sZone', 'SERVICE_OWNER_CONFLICT');
  });
  it('changes zone ownership explicitly and can move to a facility without duplicate authoritative members', () => {
    const original = zoneServiceFixture();
    const changed = execute(original, { type: 'updateServicePoint', id: 'sZone', patch: { zoneId: 'zB' } }).map;
    expect(zoneServicePointIds(changed, 'zA')).toEqual([]);
    expect(zoneServicePointIds(changed, 'zB')).toEqual(['sZone']);
    const facility = execute(changed, { type: 'updateServicePoint', id: 'sZone', patch: { zoneId: null, facilityId: 'fA' } }).map;
    expect(facility.facilities.fA!.servicePointIds).toEqual(['sA', 'sZone']);
    expect(zoneServicePointIds(facility, 'zB')).toEqual([]);
    expect(facility.nodes).toEqual(original.nodes);
  });
  it('removing ownership keeps a declared draft and never assigns the nearest containing polygon', () => {
    const result = execute(zoneServiceFixture(), { type: 'updateServicePoint', id: 'sZone', patch: { zoneId: null } }).map;
    expect(zoneServicePointIds(result, 'zA')).toEqual([]);
    expect(zoneServicePointIds(result, 'zB')).toEqual([]);
    expect(inspectServiceConnection(result, 'sZone').issues.some(issue => issue.code === 'SERVICE_OWNER_UNDECLARED')).toBe(true);
  });
  it.each(['water', 'forbidden', 'obstacle', 'passabilityForbidden'])('keeps %s service targets blocked for land access without silently changing the zone', kind => {
    const map = zoneServiceFixture();
    if (kind === 'passabilityForbidden') map.zones.zA!.passability = 'forbidden';
    else map.zones.zA!.kind = kind as 'water' | 'forbidden' | 'obstacle';
    const zones = structuredClone(map.zones);
    const result = execute(map, { type: 'updateServicePoint', id: 'sZone', patch: { kind: 'berth' } }).map;
    expect(result.zones).toEqual(zones);
    const report = inspectServiceConnection(result, 'sZone');
    expect(report.status).toBe('blocked');
    expect(report.issues.some(issue => issue.code === 'SERVICE_ZONE_LAND_ACCESS_UNSUPPORTED')).toBe(true);
  });
  it('rejects missing service node at the exact JSON pointer on external import', () => {
    const map = zoneServiceFixture(); map.servicePoints.sZone!.nodeId = 'missing';
    assertInvalid(map, '/servicePoints/sZone/nodeId', 'DANGLING_REFERENCE');
  });
  it('P1 permits names while preserving resource capacity and protecting service geometry', () => {
    const map = zoneServiceFixture();
    map.resources.resourceA = { name: 'synthetic 未实现资源', kind: 'loading', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown', appliesTo: [{ entityType: 'servicePoints', entityId: 'sZone' }], provenance: { category: 'synthetic' } };
    map.servicePoints.sZone!.resourceIds = ['resourceA'];
    expect(validateMap(map).ok).toBe(true);
    expect(mapCapabilities(map).editable).toBe(true);
    const renamed = execute(map, { type: 'updateServicePoint', id: 'sZone', patch: { name: '仅修改显示名称' } }).map;
    expect(renamed.resources).toEqual(map.resources);
    expect(renamed.servicePoints.sZone!.resourceIds).toEqual(['resourceA']);
    expect(renamed.servicePoints.sZone!.nodeId).toBe(map.servicePoints.sZone!.nodeId);
    reject(map, { type: 'updateServicePoint', id: 'sZone', patch: { nodeId: 'nA' } });
    reject(map, { type: 'updateServicePoint', id: 'sZone', patch: { arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: '不得绕过资源依赖' } } });
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.report));
    expect(loaded.map.resources).toEqual(map.resources);
    expect(loaded.map.servicePoints.sZone!.resourceIds).toEqual(['resourceA']);
    expect(loaded.capabilities.editable).toBe(true);
    expect(loaded.capabilities.unchecked).toContain('resource_execution');
  });
});

describe('M2A.1 zone membership commands and dependency closure (7)', () => {
  it('requires an explicit movement policy for a zone with service points', () => {
    reject(zoneServiceFixture(), { type: 'translateSelection', selection: selection({ zones: ['zA'] }), delta: [10, 5, 0] });
  });
  it('can keep member nodes fixed by an explicit boundary-only policy', () => {
    const map = zoneServiceFixture();
    const result = execute(map, { type: 'translateSelection', selection: selection({ zones: ['zA'] }), delta: [10, 5, 0], zoneMovePolicy: 'boundaryOnly' }).map;
    expect(result.zones.zA!.boundary.outer[0]).toEqual([80, 25, 0]);
    expect(result.nodes).toEqual(map.nodes);
    expect(result.servicePoints).toEqual(map.servicePoints);
  });
  it('moves a shared member node once, exposes its external road and leaves unrelated nodes fixed', () => {
    const map = zoneServiceFixture();
    const selected = selection({ zones: ['zA'], nodes: ['nZone'] });
    const impact = selectionImpact(map, selected, 'boundaryOnly', 'withAssociatedNodes');
    expect(impact.selection.nodes).toEqual(['nZone']);
    expect(impact.affectedRoadIds).toEqual(['rZone']);
    expect(impact.sharedNodeIds).toEqual(['nZone']);
    const result = execute(map, { type: 'translateSelection', selection: selected, delta: [10, 5, 0], zoneMovePolicy: 'withAssociatedNodes' }).map;
    expect(result.nodes.nZone!.position).toEqual([90, 35, 0]);
    expect(result.nodes.nB!.position).toEqual([100, 0, 0]);
    expect(result.nodes.nS!.position).toEqual(map.nodes.nS!.position);
    expect(result.zones.zB).toEqual(map.zones.zB);
    expect(result.roads).toEqual(map.roads);
  });
  it('copies a zone with its service and dedicated nodes but without implicitly copying an external road', () => {
    const map = zoneServiceFixture();
    const selected = selection({ zones: ['zA'] });
    const closure = closureSelection(map, selected);
    expect(closure.zones).toEqual(['zA']);
    expect(closure.servicePoints).toEqual(['sZone']);
    expect(closure.nodes).toEqual(['nZone']);
    expect(closure.roads).toEqual([]);
    const result = execute(map, { type: 'duplicateSelection', selection: selected, delta: [0, 100, 0], idMap: { zA: 'zCopy', sZone: 'sCopy', nZone: 'nCopy' } }).map;
    expect(result.servicePoints.sCopy).toMatchObject({ nodeId: 'nCopy', zoneId: 'zCopy', arrival: proxyArrival() });
    expect(result.nodes.nCopy!.position).toEqual([80, 130, 0]);
    expect(result.roads).toEqual(map.roads);
    expect(zoneServicePointIds(result, 'zCopy')).toEqual(['sCopy']);
    expect(zoneServicePointIds(result, 'zA')).toEqual(['sZone']);
  });
  it('requires retainOwner when only copying a zone service; legacy retainFacility is insufficient', () => {
    const map = zoneServiceFixture();
    const command = { type: 'duplicateSelection' as const, selection: selection({ servicePoints: ['sZone'] }), delta: [1, 1, 0] as [number, number, number], idMap: { sZone: 'sCopy', nZone: 'nCopy' } };
    reject(map, command);
    reject(map, { ...command, associationPolicy: 'retainFacility' });
    const result = execute(map, { ...command, associationPolicy: 'retainOwner' }).map;
    expect(result.servicePoints.sCopy!.zoneId).toBe('zA');
    expect(zoneServicePointIds(result, 'zA')).toEqual(['sCopy', 'sZone']);
    expect(result.nodes.nCopy!.position).toEqual([81, 31, 0]);
  });
  it('rejects undeclared cascade, preserves road-shared nodes, and cleans unused nodes only explicitly', () => {
    const map = zoneServiceFixture();
    reject(map, { type: 'deleteSelection', selection: selection({ zones: ['zA'] }) });
    reject(map, { type: 'deleteSelection', selection: selection({ nodes: ['nZone'] }) }, 'TOPOLOGY_DELETE_DEPENDENCIES');
    const kept = execute(map, { type: 'deleteSelection', selection: selection({ zones: ['zA'] }), zonePolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(kept.zones.zA).toBeUndefined();
    expect(kept.servicePoints.sZone).toBeUndefined();
    expect(kept.nodes.nZone).toEqual(map.nodes.nZone);
    expect(kept.roads).toEqual(map.roads);
    const cleaned = execute(map, { type: 'deleteSelection', selection: selection({ zones: ['zA'], roads: ['rZone'] }), zonePolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(cleaned.nodes.nZone).toBeUndefined();
    expect(cleaned.nodes.nB).toEqual(map.nodes.nB);
    expect(cleaned.servicePoints.sA).toEqual(map.servicePoints.sA);
  });
});

describe('M2A.1 declared access diagnostics, never route publication (9–12)', () => {
  it('recognizes only explicit road endpoints, then updates attachment after explicit split', () => {
    const map = zoneServiceFixture();
    map.nodes.nMid = testNode('几何中部，不是道路端点', 50);
    map.servicePoints.sZone!.nodeId = 'nMid';
    const before = inspectServiceConnection(map, 'sZone');
    expect(before.incidentRoadIds).toEqual([]);
    expect(before.status).toBe('blocked');
    expect(before.issues.some(issue => issue.code === 'SERVICE_NODE_UNCONNECTED')).toBe(true);
    const split = execute(map, { type: 'splitRoad', id: 'rAB', distanceM: 50, nodeId: 'nMid', existingNode: true, newRoadIds: ['rLeft', 'rRight'] }).map;
    const after = inspectServiceConnection(split, 'sZone');
    expect(after.incidentRoadIds).toEqual(['rLeft', 'rRight']);
    expect(after.status).toBe('unchecked');
    expect(after.unchecked).toContain('network_reachability');
    expect(after.unchecked).toContain('turn_rules');
  });
  it('keeps a boundary proxy legal as a draft without manufacturing an interior route', () => {
    const map = currentServiceFixture();
    map.servicePoints.sA!.nodeId = 'nA';
    map.servicePoints.sA!.arrival = proxyArrival();
    const before = structuredClone(map);
    const result = inspectServiceConnection(map, 'sA');
    expect(result.arrivalMode).toBe('node_proxy');
    expect(result.internalPathStatus).toBe('not_required');
    expect(result.internalPathLengthM).toBeNull();
    expect(result.status).toBe('unchecked');
    expect(map).toEqual(before);
    expect(validateMap(map).ok).toBe(true);
    expect(validateMap(map, 'network_publish').status).toBe('unsupported');
  });
  it('flags a proxy placed inside a workshop instead of disguising a straight-line wall crossing', () => {
    const map = internalServiceFixture();
    map.servicePoints.sA!.arrival = proxyArrival();
    const summary = inspectServiceConnection(map, 'sA');
    expect(summary.status).toBe('blocked');
    expect(summary.issues.some(issue => issue.code === 'PROXY_INSIDE_BUILDING')).toBe(true);
  });
  it('allows an empty internal declaration as blocked draft without equating shared facility ownership with travel', () => {
    const map = currentServiceFixture();
    map.servicePoints.sA!.arrival = { mode: 'explicit_internal', internalPath: [] };
    expect(validateMap(map).ok).toBe(true);
    const summary = inspectServiceConnection(map, 'sA');
    expect(summary.status).toBe('blocked');
    expect(summary.internalPathStatus).toBe('incomplete');
    expect(summary.internalPathLengthM).toBeNull();
    expect(summary.issues.some(issue => issue.code === 'INTERNAL_PATH_UNDECLARED')).toBe(true);
  });
  it('checks a declared facility sequence using its access node and derives distance without claiming reachability', () => {
    const map = internalServiceFixture();
    const summary = inspectServiceConnection(map, 'sA');
    expect(summary.owner).toEqual({ kind: 'facility', id: 'fA' });
    expect(summary.internalPathStatus).toBe('continuous');
    expect(summary.internalPathLengthM).toBe(25);
    expect(summary.status).toBe('unchecked');
    expect(summary.unchecked).toEqual(expect.arrayContaining(['network_reachability', 'turn_rules', 'resource_execution']));
    expect(summary.issues.some(issue => issue.code === 'SERVICE_ROUTE_UNCHECKED')).toBe(true);
  });
  it('requires the explicit entry of a zone path and never infers it from the first road', () => {
    const map = zoneInternalFixture();
    const summary = inspectServiceConnection(map, 'sZone');
    expect(summary.internalPathStatus).toBe('continuous');
    expect(summary.internalPathLengthM).toBeCloseTo(Math.sqrt(1300), 12);
    expect(summary.status).toBe('unchecked');
    map.servicePoints.sZone!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'rZone', direction: 'forward' }] };
    expect(validateMap(map).ok).toBe(true);
    const incomplete = inspectServiceConnection(map, 'sZone');
    expect(incomplete.status).toBe('blocked');
    expect(incomplete.issues.some(issue => issue.code === 'INTERNAL_ENTRY_UNDECLARED')).toBe(true);
  });
  it('rejects a second entryNodeId when facility access already supplies the authoritative entry', () => {
    const map = internalServiceFixture();
    map.servicePoints.sA!.arrival = { mode: 'explicit_internal', entryNodeId: 'nA', internalPath: [{ roadId: 'rInternal', direction: 'forward' }] };
    assertInvalid(map, '/servicePoints/sA/arrival/entryNodeId', 'INTERNAL_ENTRY_CONFLICT');
  });
  it.each(['missingRoad', 'forbiddenDirection', 'wrongStart', 'wrongEnd', 'discontinuous'])('rejects %s in a declared internal arc sequence without fabricating a path', kind => {
    const map = internalServiceFixture();
    if (kind === 'missingRoad') map.servicePoints.sA!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'missing', direction: 'forward' }] };
    if (kind === 'forbiddenDirection') map.roads.rInternal!.direction = 'backward';
    if (kind === 'wrongStart') map.roads.rInternal!.fromNodeId = 'nB';
    if (kind === 'wrongEnd') map.roads.rInternal!.toNodeId = 'nB';
    if (kind === 'discontinuous') map.servicePoints.sA!.arrival = { mode: 'explicit_internal', internalPath: [{ roadId: 'rAB', direction: 'forward' }, { roadId: 'rInternal', direction: 'forward' }] };
    assertInvalid(map, '/servicePoints/sA/arrival/internalPath');
  });
  it('treats unknown road direction as incomplete access, even if the arc geometry is continuous', () => {
    const map = internalServiceFixture(); map.roads.rInternal!.direction = 'unknown';
    expect(validateMap(map).ok).toBe(true);
    const summary = inspectServiceConnection(map, 'sA');
    expect(summary.status).toBe('blocked');
    expect(summary.issues.some(issue => issue.code === 'INTERNAL_PATH_DIRECTION_UNDECLARED')).toBe(true);
  });
  it('does not treat an outward-only road as an inbound connection for a service proxy', () => {
    const map = zoneServiceFixture(); map.roads.rZone!.direction = 'backward';
    const summary = inspectServiceConnection(map, 'sZone');
    expect(summary.incidentRoadIds).toEqual(['rZone']);
    expect(summary.status).toBe('blocked');
    expect(summary.issues.some(issue => issue.code === 'SERVICE_NO_INBOUND_ARC')).toBe(true);
  });
  it('splits and rewrites a complete internal path, but still rejects deleting its road', () => {
    const map = internalServiceFixture();
    const split = execute(map, { type: 'splitRoad', id: 'rInternal', distanceM: 10, nodeId: 'newSplit', newRoadIds: ['internalA', 'internalB'] }).map;
    const arrival = split.servicePoints.sA!.arrival;
    expect(arrival?.mode).toBe('explicit_internal');
    if (arrival?.mode !== 'explicit_internal') throw new Error('Expected explicit internal path');
    expect(arrival.internalPath).toEqual([{ roadId: 'internalA', direction: 'forward' }, { roadId: 'internalB', direction: 'forward' }]);
    expect(inspectServiceConnection(split, 'sA').internalPathStatus).toBe('continuous');
    expect(split.nodes.nS).toEqual(map.nodes.nS);
    expect(split.facilities).toEqual(map.facilities);
    reject(map, { type: 'deleteSelection', selection: selection({ roads: ['rInternal'] }) });
    expect(map.roads.rInternal).toBeDefined();
    expect(map.nodes.newSplit).toBeUndefined();
  });
  it('copies an internal facility only after its referenced road is explicitly selected, remapping the arc and point IDs', () => {
    const map = internalServiceFixture();
    const withoutRoad = selection({ facilities: ['fA'] });
    const idMap = { fA: 'fCopy', aA: 'aCopy', sA: 'sCopy', nA: 'nAccessCopy', nS: 'nServiceCopy', rInternal: 'rInternalCopy' };
    reject(map, { type: 'duplicateSelection', selection: withoutRoad, delta: [0, 100, 0], idMap });
    const copied = execute(map, { type: 'duplicateSelection', selection: selection({ facilities: ['fA'], roads: ['rInternal'] }), delta: [0, 100, 0], idMap }).map;
    expect(copied.servicePoints.sCopy).toMatchObject({ facilityId: 'fCopy', accessPointId: 'aCopy', nodeId: 'nServiceCopy', arrival: { mode: 'explicit_internal', internalPath: [{ roadId: 'rInternalCopy', direction: 'forward' }] } });
    expect(copied.roads.rInternalCopy).toMatchObject({ fromNodeId: 'nAccessCopy', toNodeId: 'nServiceCopy', shapePoints: [[15, 100, 0]] });
    expect(copied.roads.rAB).toEqual(map.roads.rAB);
    expect(inspectServiceConnection(copied, 'sCopy').internalPathLengthM).toBe(25);
  });
  it('can explicitly remove an arrival declaration and reports an undeclared draft', () => {
    const map = zoneServiceFixture();
    const changed = execute(map, { type: 'updateServicePoint', id: 'sZone', patch: { arrival: null } }).map;
    expect(changed.servicePoints.sZone!.arrival).toBeUndefined();
    expect(inspectServiceConnection(changed, 'sZone').arrivalMode).toBe('undeclared');
  });
  it('rejects blank proxy assumptions and an undeclared second service-operation authority', () => {
    const map = zoneServiceFixture();
    map.servicePoints.sZone!.arrival = proxyArrival('   ');
    assertInvalid(map, '/servicePoints/sZone/arrival/note', 'PROXY_ASSUMPTION_EMPTY');
    const dual = zoneServiceFixture();
    Object.assign(dual.servicePoints.sZone!, { supportedOperations: ['loading', 'unloading'] });
    assertInvalid(dual, '/servicePoints/sZone');
  });
});

describe('M2A.1 entry references and ownership edge cases', () => {
  it('copies a zone internal path with an explicitly selected road and remaps the entry node', () => {
    const map = zoneInternalFixture();
    const copied = execute(map, { type: 'duplicateSelection', selection: selection({ zones: ['zA'], roads: ['rZone'] }), delta: [0, 100, 0], idMap: { zA: 'zCopy', sZone: 'sCopy', nZone: 'nTargetCopy', nB: 'nEntryCopy', rZone: 'rCopy' } }).map;
    expect(copied.servicePoints.sCopy).toMatchObject({ zoneId: 'zCopy', nodeId: 'nTargetCopy', arrival: { mode: 'explicit_internal', entryNodeId: 'nEntryCopy', internalPath: [{ roadId: 'rCopy', direction: 'forward' }] } });
    expect(copied.roads.rCopy).toMatchObject({ fromNodeId: 'nEntryCopy', toNodeId: 'nTargetCopy' });
    expect(copied.nodes.nEntryCopy!.position).toEqual([100, 100, 0]);
    expect(copied.roads.rAB).toEqual(map.roads.rAB);
    expect(inspectServiceConnection(copied, 'sCopy').internalPathStatus).toBe('continuous');
  });
  it('refuses direct deletion of an isolated entry referenced only by an internal declaration', () => {
    const map = zoneServiceFixture();
    map.nodes.nEntry = testNode('仅由arrival引用的入口', 120, 50);
    map.servicePoints.sZone!.arrival = { mode: 'explicit_internal', entryNodeId: 'nEntry', internalPath: [] };
    const issues = reject(map, { type: 'deleteSelection', selection: selection({ nodes: ['nEntry'] }) }, 'TOPOLOGY_SERVICE_PATH_DEPENDENCY');
    expect(issues.some(issue => issue.jsonPath.endsWith('/arrival/entryNodeId'))).toBe(true);
  });
  it('retains a zone named constructor during explicit point-only copy', () => {
    const map = zoneServiceFixture();
    Object.defineProperty(map.zones, 'constructor', { value: map.zones.zA, enumerable: true, writable: true, configurable: true });
    delete map.zones.zA; map.servicePoints.sZone!.zoneId = 'constructor';
    const copied = execute(map, { type: 'duplicateSelection', selection: selection({ servicePoints: ['sZone'] }), delta: [1, 1, 0], idMap: { sZone: 'sCopy', nZone: 'nCopy' }, associationPolicy: 'retainOwner' }).map;
    expect(copied.servicePoints.sCopy!.zoneId).toBe('constructor');
    expect(zoneServicePointIds(copied, 'constructor')).toEqual(['sCopy', 'sZone']);
  });
  it('cleans a dedicated entry and target together only when deleteUnused is explicit', () => {
    const map = zoneServiceFixture();
    map.nodes.nEntry = testNode('专用入口', 120, 50); map.nodes.nTarget = testNode('专用目标', 125, 55);
    map.servicePoints.sZone!.nodeId = 'nTarget';
    map.servicePoints.sZone!.arrival = { mode: 'explicit_internal', entryNodeId: 'nEntry', internalPath: [] };
    const kept = execute(map, { type: 'deleteSelection', selection: selection({ servicePoints: ['sZone'] }), orphanNodes: 'keep' }).map;
    expect(kept.nodes.nEntry).toBeDefined(); expect(kept.nodes.nTarget).toBeDefined();
    const cleaned = execute(map, { type: 'deleteSelection', selection: selection({ servicePoints: ['sZone'] }), orphanNodes: 'deleteUnused' }).map;
    expect(cleaned.nodes.nEntry).toBeUndefined(); expect(cleaned.nodes.nTarget).toBeUndefined();
    expect(cleaned.roads).toEqual(map.roads);
  });
  it('preserves the entry while another service still references it', () => {
    const map = zoneServiceFixture();
    map.nodes.nEntry = testNode('共享入口', 120, 50); map.nodes.nTarget = testNode('独立目标', 125, 55); map.nodes.nOther = testNode('另一目标', 130, 55);
    map.servicePoints.sZone!.nodeId = 'nTarget';
    map.servicePoints.sZone!.arrival = { mode: 'explicit_internal', entryNodeId: 'nEntry', internalPath: [] };
    map.servicePoints.sOther = { ...point('nOther', 'zB'), arrival: { mode: 'explicit_internal', entryNodeId: 'nEntry', internalPath: [] } };
    const cleaned = execute(map, { type: 'deleteSelection', selection: selection({ servicePoints: ['sZone'] }), orphanNodes: 'deleteUnused' }).map;
    expect(cleaned.nodes.nTarget).toBeUndefined();
    expect(cleaned.nodes.nEntry).toEqual(map.nodes.nEntry);
    expect(cleaned.nodes.nOther).toEqual(map.nodes.nOther);
    expect(cleaned.servicePoints.sOther).toEqual(map.servicePoints.sOther);
  });
});
