import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entranceMovable, entranceSlide, onOutline } from '../../src/app/canvas/entrances';
import { translateCommand } from '../../src/app/canvas/movePreview';
import { separationCommand, separationSpot } from '../../src/app/canvas/separation';
import { inspectAccessSeparation, runAccessSeparation } from '../../src/domain/accessSeparation';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { createSession, editSession, undoSession } from '../../src/editor/session';

const EXAMPLE = new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url);
type Json = Record<string, Record<string, unknown>>;
function example(change: (map: Json) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
const node = (name: string, position: number[], kind = 'ordinary') => ({ name, position, kind, provenance: { category: 'synthetic' } });
/** The workshop (0–60 × 0–30 m) made movable (straight service connector, no internal path over a public road), with a gate
 *  aGate on a public junction on its right wall (60, 15): two public roads, 9 m and 7 m wide, leave it eastwards. */
function gateOnJunction(change: (map: Json) => void = () => {}): YardMap {
  return example(json => {
    (json.roads!.rApproach as Json[string]).shapePoints = [];
    (json.servicePoints!.sLoading as Json[string]).arrival = { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '测试' };
    json.nodes!.nJunction = node('东墙路口', [60, 15, 0], 'access'); json.nodes!.nE1 = node('东一', [80, 15, 0]); json.nodes!.nE2 = node('东二', [75, 25, 0]);
    json.sources!.srcWidth = { name: '测试宽度', category: 'design_assumption', description: '测试用道路宽度。' };
    const road = (name: string, toNodeId: string, width: number) => ({ ...(json.roads!.rMain as object), name, fromNodeId: 'nJunction', toNodeId, shapePoints: [],
      widthM: { state: 'known', value: width, sourceRef: 'srcWidth' } });
    json.roads!.rE1 = road('东路一', 'nE1', 9); json.roads!.rE2 = road('东路二', 'nE2', 7);
    json.accessPoints!.aGate = { name: '东门', facilityId: 'fWorkshop', nodeId: 'nJunction', provenance: { category: 'drawing' } };
    (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aGate');
    change(json);
  });
}
/** The same with the junction declared and its turns explicit (east road one to two and back): a map the kernel treats as
 *  complex, as every real map is. */
function complexGate(change: (map: Json) => void = () => {}): YardMap {
  return gateOnJunction(json => {
    json.junctions!.jGate = { name: '东墙路口', nodeIds: ['nJunction'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
    const turn = (name: string, from: string, to: string) => ({ name, junctionId: 'jGate', incomingArc: { roadId: from, direction: 'backward' },
      outgoingArc: { roadId: to, direction: 'forward' }, allowed: true, resourceIds: [], provenance: { category: 'synthetic' } });
    json.movements!.mOneTwo = turn('一转二', 'rE1', 'rE2'); json.movements!.mTwoOne = turn('二转一', 'rE2', 'rE1');
    change(json);
  });
}
const code = (result: ReturnType<typeof applyMapCommand>) => result.ok ? 'ok' : result.issues.find(issue => issue.severity === 'error')?.code;
function split(map: YardMap, widthM = 12) {
  const plan = separationCommand(map, 'aGate', widthM);
  if ('reason' in plan) throw new Error(plan.reason);
  const result = editSession(createSession(map, true), plan.command);
  if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('\n'));
  return { plan, session: result.session, after: result.session.map };
}

describe('separating an entrance from a node it shares', () => {
  it('moves it along the wall onto its own node joined to the old one, in one transaction; the old node keeps its roads', () => {
    const map = gateOnJunction();
    expect(entranceMovable(map, 'aGate')).toBe(false);
    const { plan, session, after } = split(map);
    expect(plan.distanceM).toBe(4);
    const gate = after.accessPoints.aGate!;
    expect(gate.nodeId).toBe(plan.nodeId);
    expect(after.nodes[plan.nodeId]).toMatchObject({ position: [60, 19, 0], kind: 'access', name: '东门节点' });
    expect(onOutline(after, 'aGate')).toBe(true);
    expect(entranceMovable(after, 'aGate')).toBe(true);
    expect(after.nodes.nJunction).toMatchObject({ position: [60, 15, 0], kind: 'ordinary' });
    expect(after.roads.rE1).toEqual(map.roads.rE1); expect(after.roads.rE2).toEqual(map.roads.rE2);
    const added = Object.keys(after.roads).filter(id => !map.roads[id]);
    expect(added).toHaveLength(1);
    const connector = after.roads[added[0]!]!;
    expect([connector.fromNodeId, connector.toNodeId].sort()).toEqual([plan.nodeId, 'nJunction'].sort());
    // As wide as the narrowest road at the old node (7 m of 9 and 7), never wider than new roads are drawn.
    expect(connector.widthM).toMatchObject({ state: 'known', value: 7 });
    expect((separationCommand(map, 'aGate', 5) as { command: { connectorWidthM: number } }).command.connectorWidthM).toBe(5);
    // One transaction: one undo gives the map back exactly.
    expect(session.past).toHaveLength(1);
    expect(undoSession(session).map).toEqual(map);
    // Its node change is recorded as a topology change, like every drawn connection.
    expect(after.accessPoints.aGate!.provenance.fieldSources?.nodeId).toMatch(/^source_editor_topology/);
  });
  it('works on a complex map: the connector gets a turn into and out of each road at the junction, the old turns stay', () => {
    const map = complexGate();
    const plan = separationCommand(map, 'aGate', 12) as { command: MapCommand };
    expect(commandSupport(map, plan.command).allowed).toBe(true);
    const { after } = split(map);
    expect(after.movements.mOneTwo).toEqual(map.movements.mOneTwo);
    expect(after.movements.mTwoOne).toEqual(map.movements.mTwoOne);
    const added = Object.entries(after.movements).filter(([id]) => !map.movements[id]).map(([, movement]) => movement);
    const connector = Object.keys(after.roads).find(id => !map.roads[id])!;
    const pairs = added.map(movement => movement.incomingArc.roadId + '>' + movement.outgoingArc.roadId).sort();
    expect(pairs).toEqual([connector + '>rE1', connector + '>rE2', 'rE1>' + connector, 'rE2>' + connector].sort());
    expect(added.every(movement => movement.junctionId === 'jGate' && movement.allowed)).toBe(true);
  });
  it('no longer holds the building back: a move refused for it goes through', () => {
    const map = gateOnJunction(), move = translateCommand({ nodes: [], roads: [], facilities: ['fWorkshop'] }, [-0.5, 0, 0]);
    const blockers = (result: ReturnType<typeof applyMapCommand>) => result.ok ? [] : result.issues.filter(issue => issue.severity === 'error').map(issue => issue.code + ' ' + issue.entityId);
    expect(blockers(applyMapCommand(map, move))).toEqual(['OWNER_ENTRANCE_REPOSITION_REQUIRED aGate']);
    expect(blockers(applyMapCommand(split(map).after, move))).toEqual([]);
  });
  it("takes the building's own node-proxy service point on that node along; another building's stays, and so does the node's kind", () => {
    const service = (facilityId: string, name: string) => ({ name, kind: 'loading', nodeId: 'nJunction', facilityId, resourceIds: [],
      arrival: { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '测试' }, provenance: { category: 'synthetic' } });
    const own = gateOnJunction(json => {
      json.servicePoints!.sGate = { ...service('fWorkshop', '门口装卸'), accessPointId: 'aGate' };
      (json.facilities!.fWorkshop as { servicePointIds: string[] }).servicePointIds.push('sGate');
    });
    const { plan, after } = split(own);
    expect(after.servicePoints.sGate!.nodeId).toBe(plan.nodeId);
    expect(after.nodes.nJunction!.kind).toBe('ordinary');
    // Grabbed by the service point (its marker comes first on the shared node), or by the node, the entrance still slides
    // along the wall, and the kernel takes the move.
    const start = after.nodes[plan.nodeId]!.position;
    for (const selection of [{ nodes: [], roads: [], servicePoints: ['sGate'] }, { nodes: [plan.nodeId], roads: [] }, { nodes: [], roads: [], accessPoints: ['aGate'] }]) {
      const slide = entranceSlide(after, selection, start)!;
      expect(slide([63, 23, 0])).toEqual([0, 4, 0]);
      expect(applyMapCommand(after, translateCommand(selection, slide([63, 23, 0]))).ok).toBe(true);
    }
    const shared = gateOnJunction(json => {
      json.facilities!.fYard = { name: '东侧堆场', kind: 'workshop', boundary: { outer: [[62, 0, 0], [90, 0, 0], [90, 10, 0], [62, 10, 0], [62, 0, 0]], holes: [] },
        accessPointIds: [], servicePointIds: ['sYard'], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
      json.servicePoints!.sYard = service('fYard', '堆场装卸');
    });
    const other = split(shared).after;
    expect(other.servicePoints.sYard!.nodeId).toBe('nJunction');
    expect(other.nodes.nJunction!.kind).toBe('access');
    // Another building's internal route entering at the old node keeps it too (the rule alone, on a copy with a stub trace).
    const entered = structuredClone(gateOnJunction()) as YardMap & { servicePoints: Record<string, unknown> };
    entered.servicePoints.sBehind = { name: '院内作业', kind: 'loading', nodeId: 'nE1', zoneId: 'zWaiting', resourceIds: [],
      arrival: { mode: 'explicit_internal', entryNodeId: 'nJunction', internalPath: [] }, provenance: { category: 'synthetic' } };
    runAccessSeparation(entered, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], connectorWidthM: 7 }, () => ({ geometryPreservedRoadIds: [], entityId: '' }));
    expect(entered.nodes.nJunction!.kind).toBe('access');
  });
  it('refuses when an internal route enters through the entrance (implied or named), or a resource stands on the old node', () => {
    // The example as it is: the loading point's internal route starts at the corner entrance it names.
    expect(inspectAccessSeparation(example(), 'aWorkshop')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_ARRIVAL' }] });
    // The same route with its entry node named and no entrance named (the check alone: such a map needs more to load).
    const named = structuredClone(example()) as YardMap & { servicePoints: Record<string, { arrival?: { entryNodeId?: string }; accessPointId?: string }> };
    named.servicePoints.sLoading!.arrival!.entryNodeId = 'nRoadWest'; delete named.servicePoints.sLoading!.accessPointId;
    expect(inspectAccessSeparation(named, 'aWorkshop')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_ARRIVAL' }] });
    // A service point of the building standing on the old node with an internal route of its own (the check alone again).
    const standing = structuredClone(gateOnJunction()) as YardMap & { servicePoints: Record<string, unknown> };
    standing.servicePoints.sHere = { name: '门内作业', kind: 'loading', nodeId: 'nJunction', facilityId: 'fWorkshop', resourceIds: [],
      arrival: { mode: 'explicit_internal', internalPath: [] }, provenance: { category: 'synthetic' } };
    expect(inspectAccessSeparation(standing, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_ARRIVAL' }] });
    const withResource = gateOnJunction(json => {
      json.resources!.rsGate = { name: '门口停车位', kind: 'parking', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown',
        appliesTo: [{ entityType: 'nodes', entityId: 'nJunction' }], provenance: { category: 'synthetic' } };
    });
    expect(inspectAccessSeparation(withResource, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_RESOURCES' }] });
    expect(separationCommand(withResource, 'aGate', 12)).toEqual({ reason: expect.stringContaining('门口停车位') });
  });
  it('the kernel command refuses a taken or malformed ID, the same place, another height, a bad width', () => {
    const map = gateOnJunction(), run = (patch: Partial<Extract<MapCommand, { type: 'separateAccessPoint' }>>) =>
      code(applyMapCommand(map, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], connectorWidthM: 7, ...patch }));
    expect(run({ nodeId: 'nE1' })).toBe('ACCESS_SEPARATE_ID_CONFLICT');
    expect(run({ nodeId: '1bad id' })).toBe('ACCESS_SEPARATE_ID_CONFLICT');
    expect(run({ position: [60, 15, 0] })).toBe('ACCESS_SEPARATE_POSITION');
    expect(run({ position: [60, 19, 2] })).toBe('LOCAL_NONPLANAR_EDIT');
    expect(run({ connectorWidthM: 0 })).toBe('ACCESS_SEPARATE_CONNECTOR');
    // Said as a width problem, not as a connector that cannot reach the old node.
    const zero = applyMapCommand(map, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], connectorWidthM: 0 });
    expect(zero.ok ? '' : zero.issues[0]!.message).toBe('接驳路宽度必须为有限正数。');
    expect(run({ id: 'missing' })).toBe('ACCESS_SEPARATE_MISSING');
    expect(run({})).toBe('ok');
  });
  it('is refused as a whole when the connector cannot join the old node (a junction of two nodes)', () => {
    const map = complexGate(json => { (json.junctions!.jGate as { nodeIds: string[] }).nodeIds = ['nJunction', 'nE1']; });
    const result = applyMapCommand(map, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], connectorWidthM: 7 });
    expect(code(result)).toBe('ACCESS_SEPARATE_CONNECTOR');
  });
  it('does not join a road the connector meets on its way (only its two ends are connected)', () => {
    // A road drawn with the road tool (only such roads take part in joining crossings), then, as on real maps traced before
    // the band checks, its end put on the wall at (60, 17): halfway along where the connector will run from (60, 19) down.
    const base = gateOnJunction(), drawn = applyMapCommand(base, { type: 'quickTraceRoad', points: [[70, 20, 0], [66, 17, 0]], disconnect: true, defaults: { widthM: 1 } });
    if (!drawn.ok) throw new Error(drawn.issues.map(issue => issue.message).join('; '));
    const json = structuredClone(drawn.map) as unknown as { roads: Record<string, { toNodeId: string }>; nodes: Record<string, { position: number[] }> };
    const met = Object.keys(json.roads).find(id => !Object.hasOwn(base.roads, id))!;
    json.nodes[json.roads[met]!.toNodeId]!.position = [60, 17, 0];
    const loaded = loadMap(JSON.stringify(json));
    if (!loaded.ok) throw new Error('fixture');
    const map = loaded.map;
    const result = applyMapCommand(map, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], connectorWidthM: 1 });
    if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('; '));
    expect(result.map.roads[met]).toEqual(map.roads[met]);
    expect(Object.keys(result.map.roads).length).toBe(Object.keys(map.roads).length + 1);
  });
});

describe('where a separated entrance goes', () => {
  it('along the edge with more room, at most 4 m, keeping 0.5 m from the corner', () => {
    const near = gateOnJunction(json => { (json.nodes!.nJunction as { position: number[] }).position = [60, 2, 0]; (json.nodes!.nE1 as { position: number[] }).position = [80, 2, 0]; });
    expect(separationSpot(near, 'aGate')).toEqual({ position: [60, 6, 0], distanceM: 4 });
    // Both sides usable (10 m down, 20 m up): the longer one.
    const middle = gateOnJunction(json => { (json.nodes!.nJunction as { position: number[] }).position = [60, 10, 0]; (json.nodes!.nE1 as { position: number[] }).position = [80, 10, 0]; });
    expect(separationSpot(middle, 'aGate')).toEqual({ position: [60, 14, 0], distanceM: 4 });
    // A 4 m wall with the junction in its middle and one road straight out: 2 m each way, 1.5 m of it usable.
    const short = gateOnJunction(json => {
      (json.facilities!.fWorkshop as { boundary: unknown }).boundary = { outer: [[0, 0, 0], [60, 0, 0], [60, 4, 0], [0, 4, 0], [0, 0, 0]], holes: [] };
      (json.nodes!.nJunction as { position: number[] }).position = [60, 2, 0]; (json.nodes!.nE1 as { position: number[] }).position = [80, 2, 0];
      delete json.roads!.rE2; delete json.nodes!.nE2;
      (json.nodes!.nLoading as { position: number[] }).position = [15, 2, 0];
    });
    expect(separationSpot(short, 'aGate')).toEqual({ position: [60, 3.5, 0], distanceM: 1.5 });
  });
  it('not along a road that runs along the wall from the old node, nor near another road', () => {
    const along = (json: Json, name: string, to: string, at: number[], reverse = false) => {
      json.nodes![to] = node(name + '端', at);
      json.roads!['r' + to] = { ...(json.roads!.rMain as object), name, fromNodeId: reverse ? to : 'nJunction', toNodeId: reverse ? 'nJunction' : to, shapePoints: [] };
    };
    // A road up the wall from the junction: the entrance goes down the wall instead.
    const up = gateOnJunction(json => along(json, '沿墙路北', 'nUp', [60, 28, 0]));
    expect(separationSpot(up, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
    // And one down the wall too: nowhere to go, and it says why.
    const both = gateOnJunction(json => { along(json, '沿墙路北', 'nUp', [60, 28, 0]); along(json, '沿墙路南', 'nDown', [60, 2, 0], true); });
    expect(separationSpot(both, 'aGate')).toEqual({ reason: expect.stringContaining('都有道路经过或贴近') });
    // A road leaving 17° off the wall upwards: 1.17 m from where the entrance would go, clear, but running along the wall.
    const slant = gateOnJunction(json => along(json, '斜路', 'nSlant', [60 + 10 * Math.sin(17 * Math.PI / 180), 15 + 10 * Math.cos(17 * Math.PI / 180), 0]));
    expect(separationSpot(slant, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
    // Another road passing 0.5 m from where the entrance would go up the wall: it goes down instead.
    const passing = gateOnJunction(json => {
      json.nodes!.nP1 = node('过路一', [60.5, 18, 0]); json.nodes!.nP2 = node('过路二', [70, 30, 0]);
      json.roads!.rPass = { ...(json.roads!.rMain as object), name: '过路', fromNodeId: 'nP1', toNodeId: 'nP2', shapePoints: [] };
    });
    expect(separationSpot(passing, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
  });
  it('not within 1 m of a road at the old node, which on a short step happens well off the along-the-wall angle', () => {
    // A 4 m wall, the junction in its middle: 1.5 m up the wall is 0.63 m from a road leaving 25° off the wall; down the wall
    // is 0.5 m from the main road. Nowhere, and it says why.
    const crowded = gateOnJunction(json => {
      (json.facilities!.fWorkshop as { boundary: unknown }).boundary = { outer: [[0, 0, 0], [60, 0, 0], [60, 4, 0], [0, 4, 0], [0, 0, 0]], holes: [] };
      (json.nodes!.nJunction as { position: number[] }).position = [60, 2, 0]; (json.nodes!.nE1 as { position: number[] }).position = [80, 2, 0];
      (json.nodes!.nE2 as { position: number[] }).position = [60 + 10 * Math.sin(25 * Math.PI / 180), 2 + 10 * Math.cos(25 * Math.PI / 180), 0];
      (json.nodes!.nLoading as { position: number[] }).position = [15, 2, 0];
    });
    expect(separationSpot(crowded, 'aGate')).toEqual({ reason: expect.stringContaining('都有道路经过或贴近') });
  });
  it('nowhere when the node is off the outline', () => {
    const off = gateOnJunction(json => { (json.nodes!.nJunction as { position: number[] }).position = [65, 15, 0]; });
    expect(separationSpot(off, 'aGate')).toEqual({ reason: expect.stringContaining('不在所属建筑的外边界上') });
    expect(separationCommand(off, 'aGate', 12)).toEqual({ reason: expect.stringContaining('不在所属建筑的外边界上') });
  });
});
