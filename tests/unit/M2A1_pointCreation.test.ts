import { describe, expect, it } from 'vitest';
import { newFacility, newMap, newNode, newZone } from '../../src/domain/factory';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { applyMapCommand } from '../../src/domain/commands';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { applyPointPick, buildPointCreationCommand, makePointCreationDraft, hasPointConnectionCandidate, setPointConnectionMode } from '../../src/ui/PointCreationPanel';
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

describe('independent business point creation before drawing a connection', () => {
  function deferred(kind: 'accessPoints' | 'servicePoints', owner: 'facility' | 'zone' = 'facility') {
    const map = fixture();
    map.sources.image = { name: '人工影像参考', category: 'imagery_derived', description: 'reference, not surveyed' };
    map.facilities.fA!.provenance = { category: 'drawing', sourceRefs: ['image'] };
    map.zones.zA!.provenance = { category: 'drawing', sourceRefs: ['image'] };
    const selection = { nodes: [], roads: [], ...(owner === 'facility' ? { facilities: ['fA'] } : { zones: ['zA'] }) };
    const draft = setPointConnectionMode({ ...makePointCreationDraft(kind, selection, map), simple: true, serviceKind: 'other' as const }, 'deferred');
    draft.position = ['0', '15', '0'];
    return { map, draft };
  }
  it('creates a default-named outer-boundary entrance and its node atomically without roads, turns or capacities', () => {
    const { map, draft } = deferred('accessPoints'); draft.name = ' ';
    const before = structuredClone(map);
    const built = buildPointCreationCommand(draft, map, prefix => prefix + '_deferred');
    if (!built.ok || built.command.type !== 'addAccessPoint') throw new Error(JSON.stringify(built));
    expect(built.command.accessPoint).toMatchObject({ name: '入口', facilityId: 'fA', nodeId: 'node_deferred', provenance: { category: 'drawing', sourceRefs: ['image'] } });
    expect(built.command.newNode!.node.provenance).toEqual(built.command.accessPoint.provenance);
    const result = editSession(createSession(map, true), built.command);
    expect(result.ok).toBe(true); expect(result.session.past).toHaveLength(1);
    expect(result.session.map.facilities.fA!.accessPointIds).toEqual(['access_deferred']);
    expect(result.session.map.nodes.node_deferred!.position).toEqual([0, 15, 0]);
    expect(result.session.map.roads).toEqual(map.roads); expect(result.session.map.movements).toEqual(map.movements);
    expect(result.session.map.junctions).toEqual(map.junctions); expect(result.session.map.resources).toEqual(map.resources);
    const undone = undoSession(result.session); expect(undone.map).toEqual(before); expect(redoSession(undone).map).toEqual(result.session.map);
    expect(map).toEqual(before);
  });
  it.each(['facility', 'zone'] as const)('creates an independent %s service position without inventing arrival or capacity', owner => {
    const { map, draft } = deferred('servicePoints', owner); draft.name = ''; draft.position = ['20', '10', '0'];
    const built = buildPointCreationCommand(draft, map, prefix => prefix + '_deferred');
    if (!built.ok || built.command.type !== 'addServicePoint') throw new Error(JSON.stringify(built));
    expect(built.command.servicePoint.name).toBe('作业点'); expect(built.command.servicePoint.kind).toBe('other');
    expect(built.command.servicePoint).not.toHaveProperty('arrival'); expect(built.command.servicePoint).not.toHaveProperty('accessPointId');
    expect(built.command.servicePoint.resourceIds).toEqual([]);
    const result = applyMapCommand(map, built.command); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.map.servicePoints.service_deferred![owner === 'facility' ? 'facilityId' : 'zoneId']).toBe(owner === 'facility' ? 'fA' : 'zA');
    expect(result.map.roads).toEqual(map.roads); expect(result.map.nodes.node_deferred!.position).toEqual([20, 10, 0]);
  });
  it('rejects malformed coordinates, interior/hole entrances, outside/hole services and foreign planes before allocating IDs', () => {
    let count = 0; const allocate = () => { count++; return 'unused'; };
    for (const position of [[], ['0','15'], ['0','15','0','1'], ['0','NaN','0'], ['10','10','0'], ['0','15','1']]) {
      const { map, draft } = deferred('accessPoints'); draft.position = position;
      expect(buildPointCreationCommand(draft, map, allocate).ok).toBe(false);
    }
    for (const kind of ['accessPoints', 'servicePoints'] as const) {
      const { map, draft } = deferred(kind); map.facilities.fA!.boundary.holes = [rectanglePolygon([10, 10, 0], 10, 10).outer];
      for (const position of [['10','15','0'], ['15','15','0'], ['70','15','0']]) {
        draft.position = position; expect(buildPointCreationCommand(draft, map, allocate).ok).toBe(false);
      }
    }
    expect(count).toBe(0);
  });
  it('never discards an advanced candidate during deferred construction; explicit mode reset clears it while preserving point geometry', () => {
    const { map, draft } = deferred('servicePoints');
    draft.connection = { kind: 'node', nodeId: 'nA' }; draft.accessPointId = 'gate'; draft.resourceIds = ['capacity'];
    draft.connectorWidth = '8'; draft.connectorDirection = 'both';
    draft.approvedMovements = [{ id: 'turn', incomingArc: { roadId: 'in', direction: 'forward' }, outgoingArc: { roadId: 'out', direction: 'forward' } }];
    draft.arrival = { mode: 'explicit_internal', note: 'retained evidence', entryNodeId: 'entry', internalPath: [{ roadId: 'inside', direction: 'forward' }], transferAssumption: 'excluded_from_model' };
    const before = structuredClone(draft);
    expect(hasPointConnectionCandidate(draft)).toBe(true);
    const result = buildPointCreationCommand(draft, map, () => { throw new Error('must not allocate'); });
    expect(result.ok).toBe(false); if (!result.ok) expect(result.issues[0]!.code).toBe('POINT_DEFERRED_CANDIDATE');
    expect(draft).toEqual(before);
    const reset = setPointConnectionMode(draft, 'deferred'); expect(hasPointConnectionCandidate(reset)).toBe(false);
    expect(reset.position).toEqual(before.position); expect(reset.name).toBe(before.name); expect(reset.facilityId).toBe(before.facilityId);
    expect(reset.resourceIds).toEqual([]); expect(reset.approvedMovements).toEqual([]); expect(reset.arrival.mode).toBe('undeclared');
    expect(setPointConnectionMode(before, 'connected')).toEqual({ ...before, connectionMode: 'connected' });
  });
  it('retains invalid owner source references for the existing domain validator to reject', () => {
    const { map, draft } = deferred('accessPoints'); map.facilities.fA!.provenance.sourceRefs = ['missing_image'];
    const built = buildPointCreationCommand(draft, map, prefix => prefix + '_invalid_source');
    if (!built.ok || built.command.type !== 'addAccessPoint') throw new Error(JSON.stringify(built));
    expect(built.command.accessPoint.provenance.sourceRefs).toEqual(['missing_image']);
    const result = applyMapCommand(map, built.command); expect(result.ok).toBe(false);
    expect(map.accessPoints).toEqual({});
  });
  it('cannot silently discard connection or internal-path candidates after switching arrival to entrance proxy', () => {
    const { map, draft } = deferred('servicePoints');
    draft.connectionMode = 'connected'; draft.accessPointId = 'gate';
    draft.arrival = { ...draft.arrival, mode: 'node_proxy', note: 'explicit transfer assumption', internalPath: [{ roadId: 'inside', direction: 'forward' }] };
    draft.connection = { kind: 'node', nodeId: 'nA' };
    const before = structuredClone(draft);
    const result = buildPointCreationCommand(draft, map, () => { throw new Error('must not allocate'); });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]!.message).toContain('不会使用接入线或内部路径候选');
    expect(draft).toEqual(before);
  });
  it('a road selection promotes the simple deferred draft to the existing connected flow', () => {
    const { draft } = deferred('accessPoints'); draft.canvasMode = 'road';
    const picked = applyPointPick(draft, { roadId: 'road', distanceM: 12, position: [0, 12, 0] });
    expect(picked.connectionMode).toBe('connected'); expect(picked.connection).toMatchObject({ kind: 'road', roadId: 'road', distanceM: 12 });
    expect(picked.canvasMode).toBeNull();
  });
});
