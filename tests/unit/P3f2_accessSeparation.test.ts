import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { entranceMovable, entranceSlide, onOutline } from '../../src/app/canvas/entrances';
import { translateCommand } from '../../src/app/canvas/movePreview';
import { separationCommand, separationSpot } from '../../src/app/canvas/separation';
import { relatedKeys } from '../../src/app/ui/relations';
import { inspectAccessSeparation, runAccessSeparation } from '../../src/domain/accessSeparation';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { inspectServiceConnections } from '../../src/topology/serviceConnections';
import { validateMap } from '../../src/validation/validate';

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
function split(map: YardMap, id = 'aGate') {
  const plan = separationCommand(map, id);
  if ('reason' in plan) throw new Error(plan.reason);
  const result = editSession(createSession(map, true), plan.command);
  if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('\n'));
  return { plan, session: result.session, after: result.session.map };
}

describe('separating an entrance from a node it shares', () => {
  it('moves it along the wall onto its own node, in one transaction; the old node keeps its roads; no road is built', () => {
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
    // The roads, as they were; none added, none at the new node (the user connects it with the road tool when wanted).
    expect(after.roads).toEqual(map.roads);
    expect(Object.values(after.roads).some(road => road.fromNodeId === plan.nodeId || road.toNodeId === plan.nodeId)).toBe(false);
    // One transaction: one undo gives the map back exactly.
    expect(session.past).toHaveLength(1);
    expect(undoSession(session).map).toEqual(map);
    // Its node change is recorded as a topology change; the old node's kind change (not a topology field) on the new node.
    expect(after.accessPoints.aGate!.provenance.fieldSources?.nodeId).toMatch(/^source_editor_topology/);
    expect(after.nodes[plan.nodeId]!.provenance.note).toContain('类型由 access 改为 ordinary');
  });
  it('works on a complex map, turns and roads untouched, and a junction of two nodes is no obstacle', () => {
    const map = complexGate();
    const plan = separationCommand(map, 'aGate') as { command: MapCommand };
    expect(commandSupport(map, plan.command).allowed).toBe(true);
    const { after } = split(map);
    expect(after.movements).toEqual(map.movements);
    expect(after.junctions).toEqual(map.junctions);
    expect(after.roads).toEqual(map.roads);
    const pair = complexGate(json => { (json.junctions!.jGate as { nodeIds: string[] }).nodeIds = ['nJunction', 'nE1']; });
    expect(code(applyMapCommand(pair, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0] }))).toBe('ok');
  });
  it('no longer holds the building back: a move refused for it goes through', () => {
    const map = gateOnJunction(), move = translateCommand({ nodes: [], roads: [], facilities: ['fWorkshop'] }, [-0.5, 0, 0]);
    const blockers = (result: ReturnType<typeof applyMapCommand>) => result.ok ? [] : result.issues.filter(issue => issue.severity === 'error').map(issue => issue.code + ' ' + issue.entityId);
    expect(blockers(applyMapCommand(map, move))).toEqual(['OWNER_ENTRANCE_REPOSITION_REQUIRED aGate']);
    expect(blockers(applyMapCommand(split(map).after, move))).toEqual([]);
  });
  it("leaves the building's service points on the old node, on their roads, no longer linked to the entrance; so is another building's; the node keeps its kind", () => {
    const service = (facilityId: string, name: string, nodeId = 'nJunction') => ({ name, kind: 'loading', nodeId, facilityId, resourceIds: [],
      arrival: { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '测试' }, provenance: { category: 'synthetic' } });
    const own = gateOnJunction(json => {
      json.servicePoints!.sGate = { ...service('fWorkshop', '门口装卸'), accessPointId: 'aGate' };
      // Another of the building's points naming the gate, reached at a node of its own further out.
      json.servicePoints!.sFar = { ...service('fWorkshop', '远处装卸', 'nE1'), accessPointId: 'aGate' };
      (json.facilities!.fWorkshop as { servicePointIds: string[] }).servicePointIds.push('sGate', 'sFar');
    });
    const { plan, session, after } = split(own);
    // Each stays where it is and lets go of the gate (the user's decision, 2026-09-26), the rest of it unchanged; every other
    // service point exactly as it was.
    const expected = structuredClone(own.servicePoints);
    delete expected.sGate!.accessPointId; delete expected.sFar!.accessPointId;
    expect(after.servicePoints).toEqual(expected);
    expect(after.nodes[plan.nodeId]!.provenance.note).toContain('作业点「门口装卸」（sGate）、「远处装卸」（sFar）不再关联这个入口');
    // What the properties panel shows: the gate no longer lists them, and they no longer name it.
    expect(relatedKeys(own, 'accessPoints', 'aGate').filter(([label]) => label === '经此入口作业点')).toHaveLength(2);
    expect(relatedKeys(after, 'accessPoints', 'aGate').filter(([label]) => label === '经此入口作业点')).toEqual([]);
    expect(relatedKeys(after, 'servicePoints', 'sGate').some(([label]) => label === '接入入口')).toBe(false);
    expect(undoSession(session).map).toEqual(own);
    expect(after.nodes.nJunction!.kind).toBe('access');
    expect(after.nodes[plan.nodeId]!.provenance.note).not.toContain('类型由');
    // Still on the road network: the same roads reach it, and no new warning says it is cut off.
    const roadsAt = (map: YardMap) => inspectServiceConnections(map).find(summary => summary.servicePointId === 'sGate')!.incidentRoadIds;
    expect(roadsAt(after)).toEqual(roadsAt(own));
    expect(roadsAt(after).length).toBe(2);
    const codes = (map: YardMap) => validateMap(map).issues.map(issue => issue.code).sort();
    expect(codes(after)).toEqual(codes(own));
    // The building still moves, and grabbed by its node or itself the entrance slides along the wall.
    expect(applyMapCommand(after, translateCommand({ nodes: [], roads: [], facilities: ['fWorkshop'] }, [-0.5, 0, 0])).ok).toBe(true);
    const start = after.nodes[plan.nodeId]!.position;
    for (const selection of [{ nodes: [plan.nodeId], roads: [] }, { nodes: [], roads: [], accessPoints: ['aGate'] }]) {
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
    // Another building's internal route entering at the old node keeps it too (the rule alone, on a copy).
    const entered = structuredClone(gateOnJunction()) as YardMap & { servicePoints: Record<string, unknown> };
    entered.servicePoints.sBehind = { name: '院内作业', kind: 'loading', nodeId: 'nE1', zoneId: 'zWaiting', resourceIds: [],
      arrival: { mode: 'explicit_internal', entryNodeId: 'nJunction', internalPath: [] }, provenance: { category: 'synthetic' } };
    runAccessSeparation(entered, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0] });
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
    // A route naming the entrance and an entry node elsewhere as well (a conflict the validator reports): the entrance is its
    // entry, so the link cannot simply be let go.
    const through = structuredClone(gateOnJunction()) as YardMap & { servicePoints: Record<string, unknown> };
    through.servicePoints.sIn = { name: '院内作业', kind: 'loading', nodeId: 'nLoading', facilityId: 'fWorkshop', accessPointId: 'aGate', resourceIds: [],
      arrival: { mode: 'explicit_internal', entryNodeId: 'nE1', internalPath: [] }, provenance: { category: 'synthetic' } };
    expect(inspectAccessSeparation(through, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_ARRIVAL' }] });
    // A draft point with no owner declared, entering through the entrance by an internal route (only warnings, a map that
    // loads): refused too, not cut off its start.
    const draft = gateOnJunction(json => {
      json.servicePoints!.sDraft = { name: '草稿作业', kind: 'loading', nodeId: 'nLoading', accessPointId: 'aGate', resourceIds: [],
        arrival: { mode: 'explicit_internal', internalPath: [] }, provenance: { category: 'synthetic' } };
    });
    expect(inspectAccessSeparation(draft, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_ARRIVAL' }] });
    expect(code(applyMapCommand(draft, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0] }))).toBe('ACCESS_SEPARATE_ARRIVAL');
    const withResource = gateOnJunction(json => {
      json.resources!.rsGate = { name: '门口停车位', kind: 'parking', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown',
        appliesTo: [{ entityType: 'nodes', entityId: 'nJunction' }], provenance: { category: 'synthetic' } };
    });
    expect(inspectAccessSeparation(withResource, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_RESOURCES' }] });
    expect(separationCommand(withResource, 'aGate')).toEqual({ reason: expect.stringContaining('门口停车位') });
  });
  it('the kernel command refuses a taken or malformed ID, a spot within 0.5 m of a node, another height', () => {
    const map = gateOnJunction(), run = (patch: Partial<Extract<MapCommand, { type: 'separateAccessPoint' }>>) =>
      code(applyMapCommand(map, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0], ...patch }));
    expect(run({ nodeId: 'nE1' })).toBe('ACCESS_SEPARATE_ID_CONFLICT');
    expect(run({ nodeId: '1bad id' })).toBe('ACCESS_SEPARATE_ID_CONFLICT');
    expect(run({ position: [60, 15, 0] })).toBe('ACCESS_SEPARATE_POSITION');
    expect(run({ position: [60, 15.3, 0] })).toBe('ACCESS_SEPARATE_POSITION');
    expect(run({ position: [60, 19, 2] })).toBe('LOCAL_NONPLANAR_EDIT');
    expect(run({ id: 'missing' })).toBe('ACCESS_SEPARATE_MISSING');
    expect(run({})).toBe('ok');
    const beside = gateOnJunction(json => { json.nodes!.nBeside = node('墙边点', [60, 19.3, 0]); });
    expect(code(applyMapCommand(beside, { type: 'separateAccessPoint', id: 'aGate', nodeId: 'nNew', position: [60, 19, 0] }))).toBe('ACCESS_SEPARATE_POSITION');
  });
  it('the kernel command refuses an entrance on a node of its own, and one whose building has its own road at the old node', () => {
    // A door on its own node with one road out: it already slides along the wall; splitting it would cut it off that road.
    const door = gateOnJunction(json => {
      json.nodes!.nDoor = node('南门节点', [30, 0, 0], 'access'); json.nodes!.nOut = node('南路端', [30, -20, 0]);
      json.roads!.rDoor = { ...(json.roads!.rMain as object), name: '南门路', fromNodeId: 'nDoor', toNodeId: 'nOut', shapePoints: [] };
      json.accessPoints!.aDoor = { name: '南门', facilityId: 'fWorkshop', nodeId: 'nDoor', provenance: { category: 'drawing' } };
      (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aDoor');
    });
    expect(entranceMovable(door, 'aDoor')).toBe(true);
    expect(inspectAccessSeparation(door, 'aDoor')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_OWN_NODE' }] });
    expect(code(applyMapCommand(door, { type: 'separateAccessPoint', id: 'aDoor', nodeId: 'nNew', position: [34, 0, 0] }))).toBe('ACCESS_SEPARATE_OWN_NODE');
    // A road of the building's own at the junction besides the two public ones (an internal branch): it would be left without
    // its entrance (the check alone). With one public road only, the node would count as the building's own, as above.
    const branch = structuredClone(gateOnJunction()) as YardMap;
    branch.roads.rIn = { ...branch.roads.rE1!, name: '厂内支路', toNodeId: 'nLoading', extensions: { 'sr02.planning': { ownerEntityId: 'fWorkshop' } } };
    expect(inspectAccessSeparation(branch, 'aGate')).toMatchObject({ supported: false, issues: [{ code: 'ACCESS_SEPARATE_BRANCH' }] });
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
  it('not on a road nor within 1 m of one', () => {
    const along = (json: Json, name: string, to: string, at: number[], reverse = false) => {
      json.nodes![to] = node(name + '端', at);
      json.roads!['r' + to] = { ...(json.roads!.rMain as object), name, fromNodeId: reverse ? to : 'nJunction', toNodeId: reverse ? 'nJunction' : to, shapePoints: [] };
    };
    // A road up the wall from the junction: the entrance would stand on it, so it goes down the wall instead.
    const up = gateOnJunction(json => along(json, '沿墙路北', 'nUp', [60, 28, 0]));
    expect(separationSpot(up, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
    // And one down the wall too: nowhere to go, and it says why.
    const both = gateOnJunction(json => { along(json, '沿墙路北', 'nUp', [60, 28, 0]); along(json, '沿墙路南', 'nDown', [60, 2, 0], true); });
    expect(separationSpot(both, 'aGate')).toEqual({ reason: expect.stringContaining('都在道路上或离道路不到 1 m') });
    // A road leaving 17° off the wall upwards passes 1.17 m from the spot up the wall: clear, so up it goes.
    const slant = gateOnJunction(json => along(json, '斜路', 'nSlant', [60 + 10 * Math.sin(17 * Math.PI / 180), 15 + 10 * Math.cos(17 * Math.PI / 180), 0]));
    expect(separationSpot(slant, 'aGate')).toEqual({ position: [60, 19, 0], distanceM: 4 });
    // Another road passing 0.55 m from the spot up the wall: it goes down instead.
    const passing = gateOnJunction(json => {
      json.nodes!.nP1 = node('过路一', [60.3, 18.5, 0]); json.nodes!.nP2 = node('过路二', [70, 30, 0]);
      json.roads!.rPass = { ...(json.roads!.rMain as object), name: '过路', fromNodeId: 'nP1', toNodeId: 'nP2', shapePoints: [] };
    });
    expect(separationSpot(passing, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
  });
  it('not within 1 m of a road at the old node, which on a short step happens well off the wall', () => {
    // A 4 m wall, the junction in its middle: 1.5 m up the wall is 0.63 m from a road leaving 25° off the wall; down the wall
    // is 0.5 m from the main road. Nowhere, and it says why.
    const crowded = gateOnJunction(json => {
      (json.facilities!.fWorkshop as { boundary: unknown }).boundary = { outer: [[0, 0, 0], [60, 0, 0], [60, 4, 0], [0, 4, 0], [0, 0, 0]], holes: [] };
      (json.nodes!.nJunction as { position: number[] }).position = [60, 2, 0]; (json.nodes!.nE1 as { position: number[] }).position = [80, 2, 0];
      (json.nodes!.nE2 as { position: number[] }).position = [60 + 10 * Math.sin(25 * Math.PI / 180), 2 + 10 * Math.cos(25 * Math.PI / 180), 0];
      (json.nodes!.nLoading as { position: number[] }).position = [15, 2, 0];
    });
    expect(separationSpot(crowded, 'aGate')).toEqual({ reason: expect.stringContaining('都在道路上或离道路不到 1 m') });
  });
  it('not within 1 m of a node: a second entrance split off the same junction, or a node already up the wall, sends it the other way', () => {
    // Two gates of the building on one junction: the first goes up the wall, the second down, never onto the same spot.
    const pair = gateOnJunction(json => {
      json.accessPoints!.aGate2 = { name: '东门二', facilityId: 'fWorkshop', nodeId: 'nJunction', provenance: { category: 'drawing' } };
      (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aGate2');
    });
    const first = split(pair), second = split(first.after, 'aGate2');
    expect(first.after.nodes[first.plan.nodeId]!.position).toEqual([60, 19, 0]);
    expect(second.after.nodes[second.plan.nodeId]!.position).toEqual([60, 11, 0]);
    expect(second.after.nodes.nJunction!.kind).toBe('ordinary');
    // An entrance node already 4 m up the wall (as the entrance tool makes): down it goes.
    const taken = gateOnJunction(json => { json.nodes!.nTaken = node('墙上入口节点', [60, 19, 0], 'access'); });
    expect(separationSpot(taken, 'aGate')).toEqual({ position: [60, 11, 0], distanceM: 4 });
    // Nodes on both spots: nowhere, and it says why.
    const both = gateOnJunction(json => { json.nodes!.nTaken = node('北侧节点', [60, 19.5, 0]); json.nodes!.nTaken2 = node('南侧节点', [60, 11.5, 0]); });
    expect(separationSpot(both, 'aGate')).toEqual({ reason: expect.stringContaining('都离已有节点不到 1 m') });
  });
  it('nowhere when the node is off the outline', () => {
    const off = gateOnJunction(json => { (json.nodes!.nJunction as { position: number[] }).position = [65, 15, 0]; });
    expect(separationSpot(off, 'aGate')).toEqual({ reason: expect.stringContaining('不在所属建筑的外边界上') });
    expect(separationCommand(off, 'aGate')).toEqual({ reason: expect.stringContaining('不在所属建筑的外边界上') });
  });
});
