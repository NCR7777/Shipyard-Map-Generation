import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { click, preview, resolvePoint, type DrawingContext } from '../../src/app/canvas/drawingTools';
import { bendStopsMoving, insertAnchor } from '../../src/app/canvas/handles';
import { dropCommand, dropTarget, nodeConflict, proposedTurns, selectionTopology, splitSpot, suppressCommand, topologyRefusal, withTurns } from '../../src/app/canvas/topology';
import { availability, operation } from '../../src/app/ops/registry';
import { draftStore } from '../../src/app/state/draft';
import { store } from '../../src/app/state/store';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { applyMapCommand, commandSupport } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import type { TopologyCommand } from '../../src/domain/topologyEditing';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { createSession, undoSession } from '../../src/editor/session';
import { getRoadPath } from '../../src/geometry/roadPath';
import { validateMap } from '../../src/validation/validate';

// The example: the main road rMain from nRoadWest (0, 0) to nRoadEast (100, 0), the approach rApproach from nRoadWest to the
// loading node (15, 10), rZoneConnection from nRoadEast to the zone node (80, 30). `extra` adds a stub rStub from nS1 (50, -20)
// to nS2 (50, -5), one-way away from nS1; and a lone road rLone from nL1 (120, 0) to nL2 (140, 0).
const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
type Json = Record<string, Record<string, unknown>>;
function example(...changes: ((json: Json) => void)[]): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  for (const change of changes) change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
const node = (name: string, position: number[]) => ({ name, position, kind: 'ordinary', provenance: { category: 'synthetic' } });
const extra = (json: Json) => {
  const main = json.roads!.rMain as object;
  json.nodes!.nS1 = node('桩一', [50, -20, 0]); json.nodes!.nS2 = node('桩二', [50, -5, 0]);
  json.roads!.rStub = { ...main, name: '支路', fromNodeId: 'nS1', toNodeId: 'nS2', direction: 'forward', shapePoints: [] };
  json.nodes!.nL1 = node('孤一', [120, 0, 0]); json.nodes!.nL2 = node('孤二', [140, 0, 0]);
  json.roads!.rLone = { ...main, name: '孤路', fromNodeId: 'nL1', toNodeId: 'nL2', shapePoints: [] };
};
const camera = { offsetX: 0, offsetY: 0, scale: 10 };
const screen = (x: number, y: number): [number, number] => [x * 10, -y * 10];
const drawing = { hiddenTypes: [], lockedTypes: [], snapNodes: true };
const ok = (result: ReturnType<typeof applyMapCommand>) => { if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('\n')); return result.map; };
const errors = (map: YardMap) => validateMap(map).issues.filter(issue => issue.severity === 'error').map(issue => issue.code);

describe('where a dragged node would go', () => {
  it('onto another node or into a road interior; not a node it shares a road with, nor its own road; not on hidden or locked layers', () => {
    const map = example(extra), scene = toSceneSnapshot(map);
    expect(dropTarget(map, scene, 'nL1', screen(100.3, 0.2), camera, drawing)).toMatchObject({ connection: { kind: 'node', nodeId: 'nRoadEast' } });
    expect(dropTarget(map, scene, 'nS2', screen(50, 0.3), camera, drawing)).toMatchObject({ connection: { kind: 'road', roadId: 'rMain', distanceM: 50 }, position: [50, 0, 0] });
    // nL2 shares rLone with nL1; nS2 is an end of rStub.
    expect(dropTarget(map, scene, 'nL1', screen(140.2, 0), camera, drawing)).toBeNull();
    expect(dropTarget(map, scene, 'nS2', screen(50.3, -12), camera, drawing)).toBeNull();
    expect(dropTarget(map, scene, 'nS2', screen(50, 0.3), camera, { hiddenTypes: ['roads'], lockedTypes: [], snapNodes: true })).toBeNull();
    expect(dropTarget(map, scene, 'nL1', screen(100.3, 0.2), camera, { hiddenTypes: [], lockedTypes: ['nodes'], snapNodes: true })).toBeNull();
    // Snapping to nodes turned off: no drop targets either.
    expect(dropTarget(map, scene, 'nL1', screen(100.3, 0.2), camera, { ...drawing, snapNodes: false })).toBeNull();
    // A node at another height is not a target.
    const high = example(extra, json => { (json.nodes!.nL1 as { position: number[] }).position = [120, 0, 4]; }), highScene = toSceneSnapshot(high);
    expect(dropTarget(high, highScene, 'nL1', screen(100.3, 0.2), camera, drawing)).toBeNull();
  });
  it('a node of another kind is a target that says why it cannot be merged (either way round); the edit menu says so too', () => {
    const typed = example(extra, json => { (json.nodes!.nRoadEast as { kind: string }).kind = 'junction'; }), scene = toSceneSnapshot(typed);
    const target = dropTarget(typed, scene, 'nL1', screen(100.3, 0.2), camera, drawing)!;
    expect(target).toMatchObject({ connection: { kind: 'node', nodeId: 'nRoadEast' }, refusal: expect.stringContaining('是路口节点') });
    expect(target.refusal).toContain('请用道路工具从它画这一段');
    expect(nodeConflict(typed, 'nRoadEast', 'nL1')).toContain('不能合并');
    expect(selectionTopology(typed, ['nodes/nRoadEast', 'nodes/nL1'], 'mergeNodes')).toContain('不能合并');
    expect(dropTarget(example(extra), toSceneSnapshot(example(extra)), 'nL1', screen(100.3, 0.2), camera, drawing)).toMatchObject({ refusal: null });
    // The same kind, other extension data (every node of some real maps carries some): not merged either.
    const tagged = example(extra, json => { json.extensionNamespaces!['test.metadata'] = { category: 'metadata', version: '1' }; (json.nodes!.nRoadEast as { extensions?: object }).extensions = { 'test.metadata': { corridorRef: 'A' } }; });
    expect(nodeConflict(tagged, 'nL1', 'nRoadEast')).toContain('扩展数据不同');
    expect(commandSupport(tagged, { type: 'mergeNodes', sourceNodeId: 'nL1', targetNodeId: 'nRoadEast', approvedMovements: [] }).issues[0]?.code).toBe('TOPOLOGY_NODE_CONFLICT');
    // The kernel refuses it, and the dialog's reason is the same.
    const merge = { type: 'mergeNodes' as const, sourceNodeId: 'nL1', targetNodeId: 'nRoadEast', approvedMovements: [] }, support = commandSupport(typed, merge);
    expect(support.issues[0]?.code).toBe('TOPOLOGY_NODE_CONFLICT');
    expect(topologyRefusal(typed, merge, support.issues[0])).toBe(nodeConflict(typed, 'nL1', 'nRoadEast'));
  });
  it('a drop merges into the node there, or connects into the road keeping the node\'s own junction if it has one', () => {
    const map = example(extra), scene = toSceneSnapshot(map);
    expect(dropCommand(map, 'nL1', dropTarget(map, scene, 'nL1', screen(100, 0), camera, drawing)!)).toEqual({ type: 'mergeNodes', sourceNodeId: 'nL1', targetNodeId: 'nRoadEast', approvedMovements: [] });
    const connect = dropCommand(map, 'nS2', dropTarget(map, scene, 'nS2', screen(50, 0.3), camera, drawing)!);
    expect(connect).toMatchObject({ type: 'connectNodeToRoad', nodeId: 'nS2', roadId: 'rMain', distanceM: 50, approvedMovements: [] });
    const own = example(extra, json => { json.junctions!.jS2 = { name: '路口', nodeIds: ['nS2'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } }; });
    expect(dropCommand(own, 'nS2', dropTarget(own, toSceneSnapshot(own), 'nS2', screen(50, 0.3), camera, drawing)!)).toMatchObject({ junctionId: 'jS2' });
  });
});

describe('the edits, as the dialog commits them', () => {
  const approveAll = (map: YardMap, command: TopologyCommand) => withTurns(command, proposedTurns(map, command).map((turn, index) => ({ ...turn, id: 'mT' + index })), true);
  it('merge: the dropped node\'s road now ends at the kept node, which stays; the new turns allowed only when approved', () => {
    const map = example(extra), command = selectionTopology(map, ['nodes/nRoadEast', 'nodes/nL1'], 'mergeNodes') as TopologyCommand;
    expect(command).toMatchObject({ sourceNodeId: 'nL1', targetNodeId: 'nRoadEast' });
    const turns = proposedTurns(map, command);
    expect(turns.length).toBeGreaterThan(0);
    expect(turns.every(turn => turn.incomingArc.roadId !== turn.outgoingArc.roadId)).toBe(true);
    const merged = ok(applyMapCommand(map, approveAll(map, command)));
    expect(merged.nodes.nL1).toBeUndefined();
    expect(merged.roads.rLone).toMatchObject({ fromNodeId: 'nRoadEast', toNodeId: 'nL2' });
    expect(merged.nodes.nRoadEast!.position).toEqual([100, 0, 0]);
    expect(Object.values(merged.movements).filter(turn => turn.allowed)).toHaveLength(turns.length);
    // Unticked: the same proposed turns, none approved.
    const unticked = withTurns(command, turns.map((turn, index) => ({ ...turn, id: 'mU' + index })), false);
    expect(unticked).toMatchObject({ approvedMovements: [] });
    expect(Object.keys(ok(applyMapCommand(map, unticked)).movements)).toEqual([]);
    expect(errors(merged)).toEqual(errors(map));
  });
  it('connect: the node moves onto the road, which splits there into two roads ending at it', () => {
    const map = example(extra), command = selectionTopology(map, ['nodes/nS2', 'roads/rMain'], 'connectNodeToRoad') as TopologyCommand;
    expect(command).toMatchObject({ type: 'connectNodeToRoad', nodeId: 'nS2', roadId: 'rMain', distanceM: 50 });
    // The new turns, listed and approved: in and out of the stub at the node, both ways along the main road's halves.
    const turns = proposedTurns(map, command);
    expect(turns.length).toBeGreaterThan(0);
    const connected = ok(applyMapCommand(map, approveAll(map, command)));
    expect(Object.values(connected.movements).filter(turn => turn.allowed && (turn.incomingArc.roadId === 'rStub' || turn.outgoingArc.roadId === 'rStub'))).toHaveLength(turns.length);
    expect(connected.roads.rMain).toBeUndefined();
    expect(connected.nodes.nS2!.position).toEqual([50, 0, 0]);
    const ends = Object.values(connected.roads).filter(road => road.fromNodeId === 'nS2' || road.toNodeId === 'nS2');
    expect(ends).toHaveLength(3);
    expect(errors(connected)).toEqual(errors(map));
  });
  it('remove a node with two roads: after a split, the node goes and the roads join again (the split declared the straight-on)', () => {
    const map = example(extra), split = ok(applyMapCommand(map, { type: 'splitRoad', id: 'rLone', distanceM: 5, nodeId: 'nCut', newRoadIds: ['rL1', 'rL2'] }));
    const command = suppressCommand(split, 'nCut')!;
    expect(command).toEqual({ type: 'suppressDegree2Node', nodeId: 'nCut', retainedRoadId: 'rL1' });
    const joined = ok(applyMapCommand(split, command));
    expect(joined.nodes.nCut).toBeUndefined();
    expect(joined.roads.rL1).toMatchObject({ fromNodeId: 'nL1', toNodeId: 'nL2' });
    expect(joined.roads.rL2).toBeUndefined();
    expect(suppressCommand(map, 'nLoading')).toBeNull();
  });
  it('the edit menu says why a selection offers no edit', () => {
    const map = example(extra);
    expect(selectionTopology(map, ['nodes/nL1'], 'mergeNodes')).toContain('两个节点');
    expect(selectionTopology(map, ['nodes/nL1', 'nodes/nL2'], 'mergeNodes')).toContain('由道路直接相连');
    expect(selectionTopology(map, ['nodes/nS2', 'roads/rStub'], 'connectNodeToRoad')).toContain('已是这条道路的端点');
    // nL1 (120, 0) is nearest rMain at its end nRoadEast.
    expect(selectionTopology(map, ['nodes/nL1', 'roads/rMain'], 'connectNodeToRoad')).toContain('请改为合并两个节点');
    // Less than half a millimetre along the road from its end: to the millimetre, that is the end.
    const near = example(extra, json => { json.nodes!.nNear = node('近端', [0.0003, -3, 0]); json.nodes!.nNear2 = node('近端外', [0.0003, -9, 0]);
      json.roads!.rNear = { ...(json.roads!.rMain as object), name: '近端路', fromNodeId: 'nNear2', toNodeId: 'nNear', shapePoints: [] }; });
    expect(selectionTopology(near, ['nodes/nNear', 'roads/rMain'], 'connectNodeToRoad')).toContain('请改为合并两个节点');
    // Dropped there with the node layer hidden (no node to snap to first): said, not offered.
    expect(dropTarget(near, toSceneSnapshot(near), 'nNear', screen(0.0003, -0.05), camera, { ...drawing, hiddenTypes: ['nodes'] })).toMatchObject({ connection: { kind: 'road', roadId: 'rMain' }, refusal: expect.stringContaining('道路的端点') });
    expect(selectionTopology(map, ['nodes/nL1'], 'suppressDegree2Node')).toContain('不是恰好连着两条道路');
    store.set({ session: createSession(map, true), selection: ['nodes/nRoadEast', 'nodes/nL1'] });
    expect(availability(operation('edit.mergeNodes'))).toBe(true);
    expect(availability(operation('edit.suppressNode'))).toContain('请只选中一个节点');
    store.set({ session: null, selection: [] });
  });
  it('a refusal in plain words: which properties of the two roads differ; the straight-on not declared', () => {
    const differ = example(extra, json => {
      json.nodes!.nMid = node('中', [130, 0, 0]);
      (json.roads!.rLone as { toNodeId: string }).toNodeId = 'nMid';
      json.roads!.rLone2 = { ...(json.roads!.rLone as object), name: '孤路二', fromNodeId: 'nMid', toNodeId: 'nL2', widthM: { state: 'known', value: 6 } };
    });
    const command = suppressCommand(differ, 'nMid')!, support = commandSupport(differ, command);
    expect(support.allowed).toBe(false);
    const text = topologyRefusal(differ, command, support.issues[0]);
    // The kernel checks the straight-on first when the properties agree; here they differ in width.
    expect(text ?? '').toMatch(/宽度（未知 \/ 6 m）不同|直行许可/);
    const conflict = { code: 'TOPOLOGY_ROAD_CONFLICT', severity: 'error' as const, jsonPath: '', message: '', suggestedAction: '' };
    expect(topologyRefusal(differ, command, conflict)).toContain('宽度（未知 / 6 m）不同');
    expect(topologyRefusal(differ, command, conflict)).toContain('先在属性栏把它们改成一致');
    // The same width on a different basis; the direction read along the joined road; extensions the panel cannot change.
    const basis = structuredClone(differ) as YardMap;
    basis.roads.rLone!.widthM = { state: 'known', value: 6, sourceRef: 'a' }; basis.roads.rLone2!.widthM = { state: 'known', value: 6, sourceRef: 'b' };
    expect(topologyRefusal(basis, command, conflict)).toContain('宽度的依据不同');
    // Speeds in km/h, as the properties panel shows them.
    const speeds = structuredClone(basis) as YardMap;
    speeds.roads.rLone2!.widthM = speeds.roads.rLone!.widthM; speeds.roads.rLone!.speedLimitMps = { state: 'known', value: 5 };
    expect(topologyRefusal(speeds, command, conflict)).toContain('限速（18 km/h / 未知）');
    const turned = structuredClone(differ) as YardMap;
    turned.roads.rLone2!.widthM = turned.roads.rLone!.widthM; turned.roads.rLone!.direction = 'forward'; turned.roads.rLone2!.direction = 'backward';
    expect(topologyRefusal(turned, command, conflict)).toMatch(/^两条道路的方向不同/);
    turned.roads.rLone2!.direction = 'forward';
    expect(topologyRefusal(turned, command, conflict)).toBe('两条道路的属性不同，合成一条时工具不替你决定取哪一个：先在属性栏把它们改成一致，再删除节点。');
    const tagged = structuredClone(differ) as YardMap;
    tagged.roads.rLone2!.widthM = tagged.roads.rLone!.widthM; tagged.roads.rLone!.extensions = { 'shipyard.reference': { corridorRef: 'A' } };
    expect(topologyRefusal(tagged, command, conflict)).toContain('扩展数据（如走廊编号）在属性栏改不了');
    expect(topologyRefusal(differ, command, { code: 'TOPOLOGY_CONTINUATION_UNDECLARED', severity: 'error', jsonPath: '', message: '', suggestedAction: '' })).toContain('直行许可');
  });
});

describe('the split tool', () => {
  function start(map: YardMap, hidden: DrawingContext['drawing']['hiddenTypes'] = []): DrawingContext {
    store.set({ session: createSession(map, true), selection: [], tool: 'split', message: null });
    return { map, scene: toSceneSnapshot(map), camera, drawing: { ...DEFAULT_DRAWING_CONFIG, hiddenTypes: hidden }, tool: 'split', token: 0,
      shapes: { building: 'rect2', zone: 'rect2' }, entranceFor: null, serviceKind: 'loading', serviceTransfer: 'included_in_service_duration', serviceInside: 'internal', routeWidthM: 8 };
  }
  const at = (x: number, y: number) => ({ screen: screen(x, y), world: [x, y, 0] as [number, number, number], alt: false, shift: false });
  afterEach(() => store.set({ session: null, selection: [], tool: 'select', message: null }));
  it('a click on a road\'s interior splits it there, one undo step; on a node it does not; the preview says which', () => {
    const map = example(extra), context = start(map);
    expect(preview(context, at(30, 0.3))).toMatchObject({ snap: { position: [30, 0, 0], kind: 'road' }, label: { lines: [expect.stringContaining('距起点 30.0 m / 100.0 m'), expect.any(String)] } });
    click(context, at(30, 0.3));
    const session = store.get().session!;
    expect(session.map.roads.rMain).toBeUndefined();
    expect(Object.values(session.map.roads).filter(road => road.name === map.roads.rMain!.name)).toHaveLength(2);
    expect(store.get().message?.text).toContain('距起点 30.0 m 处拆成两段');
    expect(undoSession(session).map).toEqual(map);
    click({ ...context, map: session.map, scene: toSceneSnapshot(session.map) }, at(100.2, 0.1));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('不用拆分') });
    expect(splitSpot(toSceneSnapshot(map), screen(30, 0.3), camera, { hiddenTypes: ['roads'], lockedTypes: [] })).toBeNull();
    // Beside a junction with the node layer hidden: the node, never a sliver of road.
    expect(splitSpot(toSceneSnapshot(map), screen(99.6, 0.1), camera, { hiddenTypes: ['nodes'], lockedTypes: [] })).toMatchObject({ connection: { kind: 'node', nodeId: 'nRoadEast' } });
    // Locked roads or nodes: the preview and the click say so.
    const locked = { ...start(map), drawing: { ...DEFAULT_DRAWING_CONFIG, lockedTypes: ['nodes' as const] } };
    expect(preview(locked, at(30, 0.3))!.label?.lines[0]).toBe('节点图层已锁定');
    click(locked, at(30, 0.3));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('节点图层已锁定') });
    click(start(map, ['roads']), at(30, 0.3));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('道路图层已隐藏') });
  });
});

describe('snapping heights, and a connector\'s shape', () => {
  it('a first point snaps to a node at any height; a draft goes on at its first point\'s height', () => {
    const map = example(extra, json => { (json.nodes!.nL1 as { position: number[] }).position = [120, 0, 4]; });
    const context: DrawingContext = { map, scene: toSceneSnapshot(map), camera, drawing: { ...DEFAULT_DRAWING_CONFIG }, tool: 'road', token: 0,
      shapes: { building: 'rect2', zone: 'rect2' }, entranceFor: null, serviceKind: 'loading', serviceTransfer: 'included_in_service_duration', serviceInside: 'internal', routeWidthM: 8 };
    const input = (x: number, y: number) => ({ screen: screen(x, y), world: [x, y, 0] as [number, number, number], alt: false, shift: false });
    expect(resolvePoint(context, input(120.2, 0))).toMatchObject({ point: [120, 0, 4], snap: { connection: { kind: 'node', nodeId: 'nL1' } } });
    draftStore.set({ kind: 'road', road: { points: [[120, 0, 4]], spans: [], continuity: 'corner', startConnection: { kind: 'node', nodeId: 'nL1' } }, token: 0 });
    expect(resolvePoint(context, input(125, 10)).point).toEqual([125, 10, 4]);
    // At 4 m, the ground-level node nRoadEast is not a target, nor the ground-level main road.
    expect(resolvePoint(context, input(100.2, 0)).snap).toBeNull();
    expect(resolvePoint(context, input(60, 0.2)).snap).toBeNull();
    draftStore.set(null);
    expect(resolvePoint(context, input(60, 0.2)).snap).toMatchObject({ connection: { kind: 'road', roadId: 'rMain' } });
  });
  it('a new shape of an entrance\'s connector that would pin the building is refused, the message naming the edit', () => {
    const map = example(json => {
      json.facilities!.fYard = { name: '堆场', kind: 'yard', boundary: { outer: [[110, 10, 0], [130, 10, 0], [130, 30, 0], [110, 30, 0], [110, 10, 0]], holes: [] },
        accessPointIds: ['aYard'], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
      json.nodes!.nYardGate = { name: '堆场门', position: [110, 20, 0], kind: 'access', provenance: { category: 'synthetic' } };
      json.nodes!.nYardOut = node('堆场门外', [104, 20, 0]);
      json.accessPoints!.aYard = { name: '堆场门', facilityId: 'fYard', nodeId: 'nYardGate', provenance: { category: 'synthetic' } };
      json.roads!.rYardIn = { ...(json.roads!.rMain as object), name: '堆场接入段', fromNodeId: 'nYardOut', toNodeId: 'nYardGate', shapePoints: [] };
    });
    const target = { kind: 'roads' as const, id: 'rYardIn', path: getRoadPath(map, 'rYardIn'), widthM: null, curves: false, ends: ['nYardOut', 'nYardGate'] as [string, string] };
    const bent = insertAnchor(target, [107, 20, 0], 6)!;
    expect(bendStopsMoving(map, 'rYardIn', bent, target, '弯曲道路')).toContain('弯曲道路后「堆场」将不能移动，所以没有弯曲道路');
    expect(bendStopsMoving(map, 'rYardIn', bent, target)).toContain('先用拆分工具（X）把它拆成两段');
    // Kept straight, or already bent: no check to run, nothing refused.
    expect(bendStopsMoving(map, 'rYardIn', target.path, target)).toBeNull();
    expect(bendStopsMoving(map, 'rYardIn', insertAnchor({ ...target, path: bent }, [105, 20, 0], 6)!, { ...target, path: bent })).toBeNull();
  });
});
