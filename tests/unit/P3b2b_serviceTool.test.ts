import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { click, preview, type DrawingContext } from '../../src/app/canvas/drawingTools';
import { nextServiceName, proxyNote, serviceAt, serviceCommand, serviceRefusal, serviceSpot, type Transfer } from '../../src/app/canvas/servicePoints';
import { OPERATIONS } from '../../src/app/ops/registry';
import { store } from '../../src/app/state/store';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { loadMap } from '../../src/domain/load';
import type { ServicePoint, YardMap } from '../../src/domain/model';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';

// The example's workshop covers 0–60 × 0–30 m with its entrance at the corner (0, 0) and its loading point's node at (15, 10);
// the waiting zone covers 70–90 × 30–50 m. `withYard` adds an open yard (62–68 × 10–20 m), where a road can reach a new node.
const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
type Json = Record<string, Record<string, unknown>>;
function example(change: (map: Json) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
const facility = (name: string, kind: string, outer: number[][], holes: number[][][] = []) => ({ name, kind, boundary: { outer, holes },
  accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } });
const yard = (json: Json) => { json.facilities!.fYard = facility('堆场', 'yard', [[62, 10, 0], [68, 10, 0], [68, 20, 0], [62, 20, 0], [62, 10, 0]]); };
const withYard = () => example(yard);
// 10 px per metre: 12 px is 1.2 m, 6 px 0.6 m.
const camera = { offsetX: 0, offsetY: 0, scale: 10 };
const workshop = { kind: 'facilities' as const, id: 'fWorkshop' }, zone = { kind: 'zones' as const, id: 'zWaiting' }, yardOwner = { kind: 'facilities' as const, id: 'fYard' };
const kiosk = (json: Json) => { json.facilities!.fKiosk = facility('岗亭', 'other', [[75, 35, 0], [85, 35, 0], [85, 45, 0], [75, 45, 0], [75, 35, 0]]); };
function applied(map: YardMap, command: ReturnType<typeof serviceCommand>['command']) {
  const result = editSession(createSession(map, true), command);
  if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('\n'));
  return result.session;
}
const place = (map: YardMap, at: [number, number], kind: ServicePoint['kind'] = 'loading', transfer: Transfer = 'included_in_service_duration', ids = { point: 'sNew', node: 'nNew' }) =>
  applied(map, serviceCommand(map, serviceSpot(map, [at[0], at[1], 0], camera)!, kind, transfer, ids).command);

describe('where a service point goes', () => {
  it('on an entrance within 12 px, else inside the smallest building, else inside a zone; nowhere outside, in a hole or on its edge', () => {
    const map = withYard();
    expect(serviceSpot(map, [0.8, 0.5, 0], camera)).toEqual({ owner: workshop, point: [0, 0, 0], entrance: 'aWorkshop', node: null });
    expect(serviceSpot(map, [64, 10, 0], camera)).toEqual({ owner: yardOwner, point: [64, 10, 0], entrance: null, node: null });
    expect(serviceSpot(map, [65, 15, 0], camera)).toEqual({ owner: yardOwner, point: [65, 15, 0], entrance: null, node: null });
    expect(serviceSpot(map, [80, 40, 0], camera)).toEqual({ owner: zone, point: [80, 40, 0], entrance: null, node: null });
    expect(serviceSpot(map, [95, 15, 0], camera)).toBeNull();
    // A building inside the zone wins over the zone; of two zones, the smaller.
    expect(serviceSpot(example(kiosk), [80, 40, 0], camera)).toMatchObject({ owner: { kind: 'facilities', id: 'fKiosk' } });
    const inner = example(json => {
      json.zones!.zInner = { name: '内区', kind: 'work', passability: 'unknown', boundary: { outer: [[76, 36, 0], [84, 36, 0], [84, 44, 0], [76, 44, 0], [76, 36, 0]], holes: [] }, provenance: { category: 'synthetic' } };
    });
    expect(serviceSpot(inner, [80, 40, 0], camera)).toMatchObject({ owner: { kind: 'zones', id: 'zInner' } });
    expect(serviceSpot(inner, [72, 32, 0], camera)).toMatchObject({ owner: zone });
    // Not in the yard's hole, nor on the hole's edge (the outer outline is fine).
    const holed = example(json => { json.facilities!.fYard = facility('堆场', 'yard', [[62, 10, 0], [68, 10, 0], [68, 20, 0], [62, 20, 0], [62, 10, 0]], [[[64, 12, 0], [64, 18, 0], [66, 18, 0], [66, 12, 0], [64, 12, 0]]]); });
    expect(serviceSpot(holed, [65, 15, 0], camera)).toBeNull();
    expect(serviceSpot(holed, [64, 15, 0], camera)).toBeNull();
    expect(serviceSpot(holed, [63, 15, 0], camera)).toMatchObject({ owner: yardOwner });
    // Hidden layers are passed over, and an entrance of a hidden building with them.
    expect(serviceSpot(map, [0.8, 0.5, 0], camera, ['accessPoints'])).toMatchObject({ owner: workshop, entrance: null });
    expect(serviceSpot(map, [0.8, 0.5, 0], camera, ['facilities'])).toBeNull();
    expect(serviceSpot(example(kiosk), [80, 40, 0], camera, ['facilities'])).toMatchObject({ owner: zone });
  });
  it('on a node already there within 6 px: that node, at its place; a node of another owner is refused', () => {
    const map = withYard();
    // The workshop's loading point's node (15, 10): the workshop's own.
    const spot = serviceSpot(map, [15.3, 10.2, 0], camera)!;
    expect(spot).toEqual({ owner: workshop, point: [15, 10, 0], entrance: null, node: 'nLoading' });
    expect(serviceRefusal(map, spot)).toBeNull();
    expect(serviceSpot(map, [15.7, 10, 0], camera)).toMatchObject({ node: null });
    // A node just outside the owner is not taken (the point gets its own node inside): the yard's west edge x = 62.
    const outside = example(json => { yard(json); json.nodes!.nWestOf = { name: '场西节点', position: [61.8, 15, 0], kind: 'ordinary', provenance: { category: 'synthetic' } }; });
    expect(serviceSpot(outside, [62.1, 15, 0], camera)).toMatchObject({ owner: yardOwner, node: null, point: [62.1, 15, 0] });
    // The zone's unloading point's node sits on the zone's edge (80, 30): the yard grown over it would not take it.
    const over = example(json => { json.facilities!.fYard = facility('堆场', 'yard', [[75, 25, 0], [85, 25, 0], [85, 32, 0], [75, 32, 0], [75, 25, 0]]); });
    const shared = serviceSpot(over, [80, 30.2, 0], camera)!;
    expect(shared).toMatchObject({ owner: yardOwner, node: 'nZoneTarget' });
    expect(serviceRefusal(over, shared)).toContain('已属于「');
  });
  it("a node there whose road out bends would stop its owner moving once the point stands on it: refused; a straight one is fine", () => {
    // A road from a node inside the yard (65, 15) out to (65, 25), with a bend at (66, 22) or straight.
    const withRoad = (bent: boolean) => example(json => {
      yard(json);
      json.nodes!.nIn = { name: '场内路端', position: [65, 15, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
      json.nodes!.nOut = { name: '场外路端', position: [65, 25, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
      json.roads!.rIn = { ...(json.roads!.rMain as object), name: '进场路', fromNodeId: 'nIn', toNodeId: 'nOut', shapePoints: bent ? [[66, 22, 0]] : [] };
    });
    const bent = withRoad(true), spot = serviceSpot(bent, [65.2, 15, 0], camera)!;
    expect(spot).toMatchObject({ owner: yardOwner, node: 'nIn' });
    expect(serviceRefusal(bent, spot)).toContain('将不能移动');
    const straight = withRoad(false);
    expect(serviceRefusal(straight, serviceSpot(straight, [65.2, 15, 0], camera)!)).toBeNull();
  });
  it('a new node only where a road can reach it: not in a workshop, a building closed to vehicles, or a water or obstacle zone', () => {
    const map = withYard();
    expect(serviceRefusal(map, serviceSpot(map, [30, 15, 0], camera)!)).toContain('是厂房，新道路不能穿进厂房');
    expect(serviceRefusal(map, serviceSpot(map, [65, 15, 0], camera)!)).toBeNull();
    expect(serviceRefusal(map, serviceSpot(map, [80, 40, 0], camera)!)).toBeNull();
    // A building its planning extension closes to vehicles (the check alone, on a copy).
    const closedYard = structuredClone(map) as YardMap;
    closedYard.facilities.fYard = { ...closedYard.facilities.fYard!, extensions: { 'sr02.planning': { vehicleAccess: 'forbidden' } } };
    expect(serviceRefusal(closedYard, serviceSpot(closedYard, [65, 15, 0], camera)!)).toContain('禁止车辆通行');
    // Another object's closed space under the point counts too: a forbidden zone laid over part of the yard (the check alone).
    const overlaid = structuredClone(map) as YardMap;
    overlaid.zones.zClosed = { name: '封闭带', kind: 'work', passability: 'forbidden', boundary: { outer: [[64, 12, 0], [67, 12, 0], [67, 18, 0], [64, 18, 0], [64, 12, 0]], holes: [] }, provenance: { category: 'synthetic' } };
    expect(serviceRefusal(overlaid, serviceSpot(overlaid, [65, 15, 0], camera)!)).toContain('在「封闭带」内');
    expect(serviceRefusal(overlaid, serviceSpot(overlaid, [63, 15, 0], camera)!)).toBeNull();
    // On a workshop's outline but not at an entrance: says to add an entrance there first.
    expect(serviceRefusal(map, serviceSpot(map, [30, 0, 0], camera)!)).toContain('请先用入口工具（E）');
    for (const change of [{ kind: 'water' }, { kind: 'obstacle' }, { passability: 'forbidden' }]) {
      const closed = example(json => { Object.assign(json.zones!.zWaiting as object, change); });
      expect(serviceRefusal(closed, serviceSpot(closed, [80, 40, 0], camera)!)).toContain('水域、障碍或禁入区域');
    }
  });
  it('names 作业点001… per owner, and a second click of the same kind at the same place finds the first', () => {
    const map = withYard();
    expect(nextServiceName(map, yardOwner)).toBe('作业点001');
    const first = place(map, [65, 15], 'loading', 'included_in_service_duration', { point: 'sA', node: 'nA' }).map;
    expect(nextServiceName(first, yardOwner)).toBe('作业点002');
    expect(nextServiceName(first, zone)).toBe('作业点001');
    expect(serviceAt(first, serviceSpot(first, [65.3, 15, 0], camera)!, 'loading', camera)).toBe('sA');
    expect(serviceAt(first, serviceSpot(first, [65.3, 15, 0], camera)!, 'unloading', camera)).toBeNull();
    expect(serviceAt(first, serviceSpot(first, [66, 15, 0], camera)!, 'loading', camera)).toBeNull();
  });
  it('on an entrance: on its node, reached there with the chosen transfer and linked; on a node there or its own: a draft; one undo each', () => {
    const map = withYard(), codes = (m: YardMap) => validateMap(m).issues.map(issue => issue.severity + ':' + issue.code);
    for (const transfer of ['included_in_service_duration', 'excluded_from_model'] as const) {
      const atEntrance = place(map, [0.5, 0.5], 'unloading', transfer, { point: 'sGate', node: 'nUnused' });
      expect(atEntrance.map.servicePoints.sGate).toMatchObject({ name: '作业点001', kind: 'unloading', nodeId: 'nRoadWest', facilityId: 'fWorkshop', accessPointId: 'aWorkshop',
        arrival: { mode: 'node_proxy', transferAssumption: transfer, note: proxyNote(transfer) }, provenance: { category: 'drawing' } } satisfies Partial<ServicePoint>);
      expect(atEntrance.map.nodes.nUnused).toBeUndefined();
      expect(atEntrance.map.facilities.fWorkshop!.servicePointIds).toContain('sGate');
      expect(codes(atEntrance.map).filter(code => code.startsWith('error:'))).toEqual([]);
      expect(undoSession(atEntrance).map).toEqual(map);
    }
    expect(proxyNote('excluded_from_model')).toContain('场内转运不在模型内');
    // On the workshop's loading node: no new node, a draft on it.
    const onNode = place(map, [15.2, 10], 'unloading', 'included_in_service_duration', { point: 'sOn', node: 'nUnused' });
    expect(onNode.map.servicePoints.sOn).toMatchObject({ nodeId: 'nLoading', facilityId: 'fWorkshop' });
    expect(onNode.map.servicePoints.sOn!.arrival).toBeUndefined();
    expect(Object.keys(onNode.map.nodes)).toEqual(Object.keys(map.nodes));
    expect(undoSession(onNode).map).toEqual(map);
    const inside = place(map, [65, 15], 'loading', 'included_in_service_duration', { point: 'sIn', node: 'nIn' });
    expect(inside.map.nodes.nIn).toMatchObject({ name: '作业点001节点', position: [65, 15, 0], kind: 'service' });
    expect(inside.map.servicePoints.sIn).toMatchObject({ nodeId: 'nIn', facilityId: 'fYard' });
    expect(inside.map.servicePoints.sIn!.arrival).toBeUndefined();
    expect(inside.map.servicePoints.sIn!.accessPointId).toBeUndefined();
    // A draft: only warnings, saying it is not reached yet.
    const added = codes(inside.map).filter(code => !codes(map).includes(code));
    expect(added.every(code => code.startsWith('warning:'))).toBe(true);
    expect(added).toEqual(expect.arrayContaining(['warning:SERVICE_NODE_UNCONNECTED', 'warning:SERVICE_ARRIVAL_UNDECLARED']));
    expect(undoSession(inside).map).toEqual(map);
    const inZone = place(map, [80, 40], 'parking', 'included_in_service_duration', { point: 'sZ', node: 'nZ' });
    expect(inZone.map.servicePoints.sZ).toMatchObject({ zoneId: 'zWaiting', kind: 'parking', nodeId: 'nZ' });
    expect(inZone.map.servicePoints.sZ!.facilityId).toBeUndefined();
  });
  it('two buildings sharing an entrance node: the building under the pointer', () => {
    // The shed east of the workshop shares its wall x = 60; both have an entrance on the node (60, 15).
    const shared = example(json => {
      json.facilities!.fShed = { ...facility('棚', 'other', [[60, 5, 0], [70, 5, 0], [70, 25, 0], [60, 25, 0], [60, 5, 0]]), accessPointIds: ['aShed'] };
      json.nodes!.nWall = { name: '墙门', position: [60, 15, 0], kind: 'access', provenance: { category: 'synthetic' } };
      json.accessPoints!.aWall = { name: '厂房东门', facilityId: 'fWorkshop', nodeId: 'nWall', provenance: { category: 'synthetic' } };
      json.accessPoints!.aShed = { name: '棚西门', facilityId: 'fShed', nodeId: 'nWall', provenance: { category: 'synthetic' } };
      (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aWall');
    });
    expect(serviceSpot(shared, [59.5, 15, 0], camera)).toMatchObject({ owner: workshop, entrance: 'aWall' });
    expect(serviceSpot(shared, [60.5, 15, 0], camera)).toMatchObject({ owner: { kind: 'facilities', id: 'fShed' }, entrance: 'aShed' });
  });
});

describe('the service point tool in the menu', () => {
  const tool = OPERATIONS.find(operation => operation.id === 'tool.service')!;
  // The guard reads only the map's objects and whether it is editable: a bare session will do (no validation needed).
  const enabled = (map: YardMap, drawing: Partial<ReturnType<typeof store.get>['drawing']> = {}) => {
    store.set({ session: { map, past: [], future: [], acknowledgedHash: null, changeToken: 0 }, drawing: { ...DEFAULT_DRAWING_CONFIG, ...drawing } });
    return tool.enabled!(store.get());
  };
  afterEach(() => store.set({ session: null, drawing: { ...DEFAULT_DRAWING_CONFIG } }));
  it('is S, and needs a 0.2 map or later with a building or zone, the service point and node layers writable and the points shown', () => {
    expect(tool).toMatchObject({ keys: ['S'], tool: 'service', label: '作业点' });
    expect(enabled(example())).toBe(true);
    expect(enabled(example(), { lockedTypes: ['servicePoints'] })).toContain('已锁定');
    expect(enabled(example(), { lockedTypes: ['nodes'] })).toContain('已锁定');
    expect(enabled(example(), { hiddenTypes: ['servicePoints'] })).toContain('已隐藏');
    expect(enabled({ ...structuredClone(example()), schemaVersion: '0.1.0' } as YardMap)).toContain('请先升级地图版本');
    // Only a zone left: still usable; neither: not.
    const zoneOnly = { ...structuredClone(example()), facilities: {} } as YardMap;
    expect(enabled(zoneOnly)).toBe(true);
    expect(enabled({ ...zoneOnly, zones: {} } as YardMap)).toBe('地图中还没有建筑或区域');
  });
});

describe('the service point tool in the editor', () => {
  type Drawing = DrawingContext['drawing'];
  function start(map: YardMap, locked: Drawing['lockedTypes'] = [], hidden: Drawing['hiddenTypes'] = [], serviceKind: ServicePoint['kind'] = 'loading'): DrawingContext {
    store.set({ session: createSession(map, true), selection: [], tool: 'service', serviceKind, message: null, drawing: { ...store.get().drawing, lockedTypes: locked, hiddenTypes: hidden } });
    return { map, scene: toSceneSnapshot(map), camera, drawing: { ...DEFAULT_DRAWING_CONFIG, hiddenTypes: hidden, lockedTypes: locked }, tool: 'service', token: 0,
      shapes: { building: 'rect2', zone: 'rect2' }, entranceFor: null, serviceKind, serviceTransfer: 'included_in_service_duration' };
  }
  const at = (x: number, y: number) => ({ screen: [x * 10, -y * 10] as [number, number], world: [x, y, 0] as [number, number, number], alt: false, shift: false });
  const count = () => Object.keys(store.get().session!.map.servicePoints).length;
  const refresh = (context: DrawingContext): DrawingContext => ({ ...context, map: store.get().session!.map });
  afterEach(() => store.set({ session: null, selection: [], tool: 'select', message: null, serviceKind: 'loading' }));

  it('adds one point per click and says what it made; refuses the same kind there again, a workshop interior, and outside', () => {
    let context = start(withYard());
    const before = count();
    click(context, at(0.5, 0.5));
    expect(count()).toBe(before + 1);
    expect(store.get().message?.text).toContain('在入口「');
    context = refresh(context);
    click(context, at(0.5, 0.5));
    expect(count()).toBe(before + 1);
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('此处已有同类作业点') });
    // Another kind at the same entrance is another point.
    click({ ...context, serviceKind: 'unloading' }, at(0.5, 0.5));
    expect(count()).toBe(before + 2);
    context = refresh(context);
    click(context, at(30, 15));
    expect(count()).toBe(before + 2);
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('是厂房') });
    // The workshop's loading node already has its loading point: an unloading point joins it.
    click({ ...context, serviceKind: 'unloading' }, at(15.2, 10));
    expect(count()).toBe(before + 3);
    expect(store.get().message?.text).toContain('用的是此处已有的节点');
    click(refresh(context), at(65, 15));
    expect(count()).toBe(before + 4);
    expect(store.get().message?.text).toContain('到达方式未声明（草稿）');
    click(refresh(context), at(95, 15));
    expect(count()).toBe(before + 4);
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('请点选入口，或建筑、区域的内部') });
  });
  it("refuses a locked owner's layer (building or zone) and a hidden service point layer, with the reason; adds nothing", () => {
    let context = start(withYard(), ['facilities']);
    const before = count();
    click(context, at(65, 15));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('建筑图层已锁定') });
    click(context, at(80, 40));
    expect(count()).toBe(before + 1);
    context = start(withYard(), ['zones']);
    click(context, at(80, 40));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('区域图层已锁定') });
    context = start(withYard(), [], ['servicePoints']);
    click(context, at(65, 15));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('作业点图层已隐藏') });
    expect(count()).toBe(before);
  });
  it('previews: a ring on a node it would join, a plain mark for a node of its own, the reason where it would be refused', () => {
    const context = start(withYard());
    expect(preview(context, at(0.5, 0.5))).toMatchObject({ snap: { position: [0, 0, 0], kind: 'node' }, label: { lines: [expect.stringContaining('节点代理'), expect.any(String)] } });
    expect(preview({ ...context, serviceKind: 'unloading' }, at(15.2, 10))).toMatchObject({ snap: { position: [15, 10, 0] }, label: { lines: [expect.stringContaining('用已有节点'), expect.any(String)] } });
    expect(preview(context, at(15.2, 10))!.label?.lines[0]).toContain('已有「');
    const own = preview(context, at(65, 15))!;
    expect(own.snap).toBeUndefined();
    expect(own).toMatchObject({ vertices: [[65, 15, 0]], label: { lines: [expect.stringContaining('自己的节点，草稿'), '堆场'] } });
    const refused = preview(context, at(30, 15))!;
    expect(refused.snap).toBeUndefined();
    expect(refused.label?.lines[0]).toBe('不能放在这里');
    expect(preview(context, at(95, 15))).toBeNull();
  });
});
