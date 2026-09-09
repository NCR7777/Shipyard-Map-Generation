import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newNode, newZone } from '../../src/domain/factory';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { applyMapCommand } from '../../src/domain/commands';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { applyPointPick, buildPointCreationCommand, makePointCreationDraft } from '../../src/ui/PointCreationPanel';
import { makeServiceArrivalDraft, parseServiceArrivalDraft } from '../../src/ui/ServiceSemanticsFields';

function fixture() {
  const map = newMap('map_test');
  map.nodes.nA = newNode([0, 0, 0]);
  map.facilities.fA = newFacility(rectanglePolygon([0, 0, 0], 60, 30));
  map.zones.zA = newZone(rectanglePolygon([0, 0, 0], 60, 30));
  return map;
}
describe('M2A.1 point creation draft and transaction boundary', () => {
  it('canvas picking only changes the draft; an existing node is shared without allocating a duplicate node', () => {
    const map = fixture(); const before = structuredClone(map); const allocated: string[] = [];
    let draft = makePointCreationDraft('servicePoints', { nodes: [], roads: [], facilities: ['fA'] }, map);
    draft = applyPointPick(draft, { nodeId: 'nA' });
    draft.arrival.note = 'synthetic: 场内转运计入服务时长';
    expect(map).toEqual(before); expect(draft.canvasMode).toBeNull();
    const built = buildPointCreationCommand(draft, map, prefix => { allocated.push(prefix); return prefix + '_new'; });
    expect(built.ok).toBe(true); expect(allocated).toEqual(['service']);
    if (!built.ok) throw new Error('Expected valid input');
    const result = applyMapCommand(map, built.command);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(Object.keys(result.map.nodes)).toEqual(['nA']);
    expect(result.map.servicePoints.service_new?.nodeId).toBe('nA');
    expect(result.map.facilities.fA?.servicePointIds).toEqual(['service_new']);
    expect(map).toEqual(before);
  });
  it('creates a dedicated node and zone service point in one undoable transaction with stable redo IDs', () => {
    const map = fixture();
    let draft = makePointCreationDraft('servicePoints', { nodes: [], roads: [], zones: ['zA'] }, map);
    draft = applyPointPick(draft, { position: [20, 10, 0] });
    draft.arrival.note = 'synthetic: 代理作业位';
    const built = buildPointCreationCommand(draft, map, prefix => prefix + '_new');
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    const edited = editSession(createSession(map, true), built.command);
    expect(edited.ok).toBe(true); expect(edited.session.past).toHaveLength(1);
    expect(edited.session.map.servicePoints.service_new?.zoneId).toBe('zA');
    expect(edited.session.map.nodes.node_new?.position).toEqual([20, 10, 0]);
    const undone = undoSession(edited.session);
    expect(undone.map.nodes.node_new).toBeUndefined(); expect(undone.map.servicePoints.service_new).toBeUndefined();
    expect(redoSession(undone).map).toEqual(edited.session.map);
  });
  it('rejects missing coordinates or a missing proxy explanation before allocating any ID', () => {
    const map = fixture(); let count = 0; const allocate = () => { count++; return 'unused'; };
    const draft = makePointCreationDraft('servicePoints', { nodes: [], roads: [] }, map);
    expect(buildPointCreationCommand(draft, map, allocate).ok).toBe(false);
    draft.position = ['1', '2', '0'];
    const result = buildPointCreationCommand(draft, map, allocate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('POINT_ARRIVAL_REQUIRED');
    expect(count).toBe(0);
  });
  it('does not infer a primary owner from overlapping or multiply selected areas', () => {
    const map = fixture();
    const draft = makePointCreationDraft('servicePoints', { nodes: [], roads: [], facilities: ['fA'], zones: ['zA'] }, map);
    expect(draft.ownerKind).toBe('none'); expect(draft.facilityId).toBe(''); expect(draft.zoneId).toBe('');
  });
  it('preserves legacy 0.1 creation without attaching new fields or guessing an arrival model', () => {
    const map = newMap('legacy', '旧图', '0.1.0'); map.nodes.nA = newNode([1, 2, 0]);
    let draft = makePointCreationDraft('servicePoints', { nodes: [], roads: [] }, map);
    expect(draft.arrival.mode).toBe('undeclared');
    draft = applyPointPick(draft, { nodeId: 'nA' });
    const built = buildPointCreationCommand(draft, map, () => 'service_old');
    if (!built.ok || built.command.type !== 'addServicePoint') throw new Error('Expected legacy creation command');
    expect(built.command.servicePoint).not.toHaveProperty('arrival');
    expect(built.command.servicePoint).not.toHaveProperty('zoneId');
    expect(applyMapCommand(map, built.command).ok).toBe(true);
  });
  it('allows explicit undeclared drafts and preserves supplied internal arc order and entry node', () => {
    const undeclared = makeServiceArrivalDraft(undefined);
    expect(parseServiceArrivalDraft(undeclared)).toEqual({ ok: true, arrival: undefined });
    const parsed = parseServiceArrivalDraft({ ...undeclared, mode: 'explicit_internal', entryNodeId: 'entry', internalPath: [{ roadId: 'r2', direction: 'backward' }, { roadId: 'r1', direction: 'forward' }] });
    expect(parsed).toEqual({ ok: true, arrival: { mode: 'explicit_internal', entryNodeId: 'entry', internalPath: [{ roadId: 'r2', direction: 'backward' }, { roadId: 'r1', direction: 'forward' }] } });
  });
});