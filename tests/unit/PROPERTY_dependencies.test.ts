import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { newNode, newZone } from '../../src/domain/factory';
import { upgradeMapToV03 } from '../../src/domain/upgradeV03';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import { zoneServiceFixture } from '../helpers/M2A1_fixtures';
import { rectangle } from '../helpers/M2A_fixtures';

function fixture() {
  const map = upgradeMapToV03(zoneServiceFixture()).map;
  map.facilities.fA!.kind = 'building';
  map.zones.zone_trace_009 = newZone(rectangle(120, 40, 20, 20), '区域009', 'unclassified');
  map.nodes.free = newNode([300, 0, 0]);
  map.junctions.j = { name: 'junction', nodeIds: ['nB'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.m = { name: 'turn', junctionId: 'j', incomingArc: { roadId: 'rAB', direction: 'forward' }, outgoingArc: { roadId: 'rZone', direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  map.resources.r = { name: 'retained capacity', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'known', value: 7 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'zones', entityId: 'zone_trace_009' }, { entityType: 'servicePoints', entityId: 'sA' }], provenance: { category: 'synthetic' } };
  map.servicePoints.sA!.resourceIds = ['r'];
  map.extensionNamespaces['test.metadata'] = { category: 'metadata', version: '1' };
  map.zones.zone_trace_009.extensions = { 'test.metadata': { untouched: ['zone_trace_009', 3] } };
  return map;
}

const updates: MapCommand[] = [
  { type: 'updateNode', id: 'free', patch: { name: 'node edited', position: [301, 2, 0] } },
  { type: 'updateRoad', id: 'rAB', patch: { name: 'road edited', direction: 'forward', widthM: { state: 'known', value: 2 } }, designAssumption: { id: 'physical_source' } },
  { type: 'updateFacility', id: 'fA', patch: { name: 'building edited', kind: 'yard', heightM: { state: 'known', value: 8 } }, designAssumption: { id: 'physical_source' } },
  { type: 'updateFacility', id: 'fA', patch: { kind: 'yard', boundary: rectangle(0, 0, 70, 35), heightM: { state: 'unknown' } } },
  { type: 'updateZone', id: 'zone_trace_009', patch: { name: 'zone edited', kind: 'buffer', passability: 'allowed' } },
  { type: 'updateZone', id: 'zone_trace_009', patch: { kind: 'buffer', passability: 'explicit_access_only', boundary: rectangle(120, 40, 25, 25) } },
  { type: 'updateAccessPoint', id: 'aA', patch: { name: 'access edited' } },
  { type: 'updateServicePoint', id: 'sA', patch: { name: 'service edited', kind: 'other' } },
];

describe('advanced maps allow supported property combinations without dropping reference protection', () => {
  it.each(updates)('accepts $type properties in one atomic undoable transaction', command => {
    const map = fixture(), before = structuredClone(map);
    const support = commandSupport(map, command); expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
    const session = createSession(map, true), result = editSession(session, command);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    const after = result.session.map;
    expect(validateMap(after).ok).toBe(true); expect(after.revision).toBe(before.revision + 1);
    expect(after.resources).toEqual(before.resources); expect(after.movements).toEqual(before.movements); expect(after.junctions).toEqual(before.junctions);
    expect(after.zones.zone_trace_009!.extensions?.['test.metadata']).toEqual(before.zones.zone_trace_009!.extensions?.['test.metadata']);
    expect(after.accessPoints.aA!.nodeId).toBe(before.accessPoints.aA!.nodeId);
    expect(after.accessPoints.aA!.facilityId).toBe(before.accessPoints.aA!.facilityId);
    expect(after.servicePoints.sA).toMatchObject({ nodeId: before.servicePoints.sA!.nodeId, facilityId: before.servicePoints.sA!.facilityId, accessPointId: before.servicePoints.sA!.accessPointId, resourceIds: ['r'] });
    expect(after.servicePoints.sA!.arrival).toEqual(before.servicePoints.sA!.arrival);
    if (command.type === 'updateFacility' && command.designAssumption) expect(after.facilities.fA!.heightM).toEqual({ state: 'known', value: 8, sourceRef: 'physical_source' });
    expect(map).toEqual(before); expect(undoSession(result.session).map).toEqual(before); expect(redoSession(undoSession(result.session)).map).toEqual(after);
  });

  it.each([
    { type: 'updateAccessPoint', id: 'aA', patch: { name: 'must remain atomic', nodeId: 'free' } },
    { type: 'updateAccessPoint', id: 'aA', patch: { facilityId: 'missing' } },
    { type: 'updateServicePoint', id: 'sA', patch: { name: 'must remain atomic', kind: 'other', nodeId: 'free' } },
    { type: 'updateServicePoint', id: 'sA', patch: { arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'changed reference model' } } },
  ] as MapCommand[])('reports the protected field and rejects the complete $type patch', command => {
    const map = fixture(), before = structuredClone(map), support = commandSupport(map, command);
    expect(support.allowed).toBe(false);
    const field = command.type === 'updateAccessPoint' ? 'nodeId' in command.patch ? 'nodeId' : 'facilityId' : 'nodeId' in (command as Extract<MapCommand, { type: 'updateServicePoint' }>).patch ? 'nodeId' : 'arrival';
    expect(support.issues[0]).toMatchObject({ code: 'OPERATION_DEPENDENCIES_UNSUPPORTED', jsonPath: '/' + (command.type === 'updateAccessPoint' ? 'accessPoints' : 'servicePoints') + '/' + ('id' in command ? command.id : '') + '/' + field });
    const session = createSession(map, true), result = editSession(session, command);
    expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(map).toEqual(before);
  });

  it('does not use a scalar field to bypass independent boundary or entrance-adjustment protection', () => {
    const map = fixture();
    map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.zones.zone_trace_009!.extensions!['sr02.planning'] = { role: 'dock_exclusion', overlayOf: 'fA', waterSurface: false };
    const blocked = commandSupport(map, { type: 'updateZone', id: 'zone_trace_009', patch: { name: 'changed', kind: 'buffer', passability: 'allowed', boundary: rectangle(120, 40, 25, 25) } });
    expect(blocked.allowed).toBe(false); expect(blocked.issues[0]!.jsonPath).toBe('/zones/zone_trace_009/boundary');
    const plain = fixture(), bad = applyMapCommand(plain, { type: 'updateFacility', id: 'fA', patch: { name: 'changed', heightM: { state: 'unknown' } }, entranceAdjustments: [{ id: 'aA', position: [1, 0, 0] }] });
    expect(bad.ok).toBe(false); if (!bad.ok) expect(bad.issues.some(issue => issue.code === 'INVALID_COMMAND')).toBe(true);
  });

  it('explains declared handling conflicts and rolls back the whole patch while allowing a name-only edit', () => {
    const map = fixture(); map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.servicePoints.sA!.kind = 'other';
    map.servicePoints.sA!.extensions = { 'sr02.planning': { capability: 'loading_and_unloading', handling: 'reserved_slot_transfer_in_service_time' } };
    const before = structuredClone(map), session = createSession(map, true);
    const result = editSession(session, { type: 'updateServicePoint', id: 'sA', patch: { name: 'must not partly apply', kind: 'parking' } });
    expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(map).toEqual(before);
    const path = '/servicePoints/sA/extensions/sr02.planning';
    expect(result.issues[0]).toMatchObject({ code: 'STATIC_CONTENTS_INVALID', jsonPath: path, severity: 'error' });
    expect(result.issues[0]!.message).toContain(path); expect(result.issues[0]!.message).toContain('已声明装载和卸载能力'); expect(result.issues[0]!.message).toContain('kind=other');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PLANNING_VALUE', jsonPath: path, message: expect.stringContaining('kind=other') })]));
    const renamed = editSession(session, { type: 'updateServicePoint', id: 'sA', patch: { name: 'new display name' } });
    expect(renamed.ok, JSON.stringify(renamed.issues)).toBe(true); expect(renamed.session.past).toHaveLength(1);
    expect(renamed.session.map.servicePoints.sA).toEqual({ ...before.servicePoints.sA!, name: 'new display name' });
    expect(renamed.session.map.resources).toEqual(before.resources); expect(map).toEqual(before);
  });

  it('preserves finite values, physical sources, strict schema and unknown behavior protections', () => {
    for (const command of [
      { type: 'updateNode', id: 'free', patch: { position: [NaN, 0, 0] } },
      { type: 'updateFacility', id: 'fA', patch: { heightM: { state: 'known', value: 8 } } },
      { type: 'updateZone', id: 'zone_trace_009', patch: { passability: 'invalid' } },
      { type: 'updateZone', id: 'zone_trace_009', patch: { name: 'changed', resourceIds: [] } },
    ] as MapCommand[]) {
      const map = fixture(), session = createSession(map, true), result = editSession(session, command);
      expect(result.ok, JSON.stringify(command)).toBe(false); expect(result.session).toBe(session);
    }
    const map = fixture(); map.extensionNamespaces.unknown = { version: '1', category: 'behavior' }; map.extensions.unknown = { untouched: true };
    const support = commandSupport(map, { type: 'updateZone', id: 'zone_trace_009', patch: { passability: 'allowed' } });
    expect(support.allowed).toBe(false); expect(support.issues[0]!.code).toBe('READ_ONLY_MAP');
  });
});
