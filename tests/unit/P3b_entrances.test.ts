import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { click, type DrawingContext } from '../../src/app/canvas/drawingTools';
import { entranceAt, entranceCommand, entranceMovable, entranceSlide, entranceSpot, nextEntranceName, nodeAt, onOutline, projectToOutline } from '../../src/app/canvas/entrances';
import { translateCommand } from '../../src/app/canvas/movePreview';
import { replaceMap } from '../../src/app/state/project';
import { refusalMessage } from '../../src/app/state/properties';
import { store } from '../../src/app/state/store';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { pointInPolygon } from '../../src/geometry/relations';
import { applyMapCommand, commandSupport } from '../../src/domain/commands';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { createSession, editSession, undoSession } from '../../src/editor/session';

// The example's workshop covers 0–60 × 0–30 m and has one entrance, at its corner (0, 0).
const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
function example(change: (map: Record<string, Record<string, unknown>>) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
// 10 px per metre: 12 px is 1.2 m, a corner snaps within 0.8 m.
const camera = { offsetX: 0, offsetY: 0, scale: 10 };

describe('where an entrance goes', () => {
  it('on the nearest outer outline within 12 px, projected exactly onto it', () => {
    const map = example();
    expect(entranceSpot(map, [20, 31, 0], camera)).toEqual({ facilityId: 'fWorkshop', point: [20, 30, 0], corner: false, distanceM: 1 });
    expect(entranceSpot(map, [20, 28.9, 0], camera)?.point).toEqual([20, 30, 0]);
    expect(entranceSpot(map, [20, 31.3, 0], camera)).toBeNull();
    expect(entranceSpot(map, [30, 15, 0], camera)).toBeNull();
  });
  it('takes a corner within 8 px', () => {
    expect(entranceSpot(example(), [59.5, 30.4, 0], camera)).toMatchObject({ point: [60, 30, 0], corner: true });
  });
  it('between two buildings sharing a wall, the one under the pointer; `only` keeps to one building', () => {
    const map = example(json => {
      json.facilities!.fNext = { name: '相邻厂房', kind: 'workshop', boundary: { outer: [[60, 0, 0], [90, 0, 0], [90, 30, 0], [60, 30, 0], [60, 0, 0]], holes: [] },
        accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    });
    expect(entranceSpot(map, [59.5, 15, 0], camera)?.facilityId).toBe('fWorkshop');
    expect(entranceSpot(map, [60.5, 15, 0], camera)?.facilityId).toBe('fNext');
    expect(entranceSpot(map, [59.5, 15, 0], camera, 'fNext')?.facilityId).toBe('fNext');
  });
  it('takes the nearest corner within 8 px, not the first one', () => {
    // A 0.5 m wide shed at 5 px/m: both ends of its short edge are within 8 px of the pointer.
    const map = example(json => {
      json.facilities!.fShed = { name: '窄棚', kind: 'workshop', boundary: { outer: [[200, 0, 0], [200.5, 0, 0], [200.5, 30, 0], [200, 30, 0], [200, 0, 0]], holes: [] },
        accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    });
    expect(entranceSpot(map, [200.45, -0.1, 0], { offsetX: 0, offsetY: 0, scale: 5 })).toMatchObject({ point: [200.5, 0, 0], corner: true });
  });
  it('on a slanted outline far from the origin, on a raised building with a hole: on the outer outline, at its height', () => {
    const angle = 0.61, [c, s] = [Math.cos(angle), Math.sin(angle)], base = [123456.7, -98765.4];
    const corner = (x: number, y: number, z = 0): [number, number, number] => [base[0]! + c * x - s * y, base[1]! + s * x + c * y, z];
    const map = example(json => {
      json.facilities!.fSlant = { name: '斜厂房', kind: 'workshop', boundary: { outer: [corner(0, 0), corner(80, 0), corner(80, 40), corner(0, 40), corner(0, 0)], holes: [] },
        accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
      json.facilities!.fRaised = { name: '高台', kind: 'workshop', boundary: { outer: [[500, 0, 5], [540, 0, 5], [540, 40, 5], [500, 40, 5], [500, 0, 5]], holes: [[[510, 10, 5], [510, 30, 5], [530, 30, 5], [530, 10, 5], [510, 10, 5]]] },
        accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    });
    const slanted = entranceSpot(map, corner(30, -0.5), camera)!;
    expect(slanted.facilityId).toBe('fSlant');
    expect(pointInPolygon(slanted.point, map.facilities.fSlant!.boundary)).toBe('boundary');
    // Near the hole's edge nothing is offered; the outer edge keeps the building's height.
    expect(entranceSpot(map, [520, 10.5, 5], camera)).toBeNull();
    expect(entranceSpot(map, [520, -0.5, 5], camera)).toMatchObject({ facilityId: 'fRaised', point: [520, 0, 5] });
    // An entrance there is at its height: another height is not the same place.
    const { command } = entranceCommand(map, 'fRaised', [520, 0, 5], { point: 'aRaised', node: 'nRaised' });
    const result = applyMapCommand(map, command);
    if (!result.ok) throw new Error('raised entrance refused');
    expect(entranceAt(result.map, 'fRaised', [520, 0, 5])).toBe('aRaised');
    expect(entranceAt(result.map, 'fRaised', [520, 0, 0])).toBeNull();
  });
  it('a building sharing a wall may have its own entrance where the other has one', () => {
    const map = example(json => {
      json.facilities!.fNext = { name: '相邻厂房', kind: 'workshop', boundary: { outer: [[-30, 0, 0], [0, 0, 0], [0, 30, 0], [-30, 30, 0], [-30, 0, 0]], holes: [] },
        accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    });
    expect(entranceAt(map, 'fWorkshop', [0, 0, 0])).toBe('aWorkshop');
    expect(entranceAt(map, 'fNext', [0, 0, 0])).toBeNull();
  });
  it('a dragged entrance lands on the nearest point of its building outline, however far', () => {
    expect(projectToOutline(example(), 'fWorkshop', [25, 40, 0])).toEqual([25, 30, 0]);
    expect(projectToOutline(example(), 'missing', [25, 40, 0])).toBeNull();
  });
});

describe('dragging an entrance', () => {
  it('slides along the outline only for a lone entrance that lies on it and may move', () => {
    const map = example(json => {
      // A research access point 5 m outside the workshop, on its own node (as on the EA01 maps).
      json.nodes!.nOut = { name: '研究接入节点', position: [30, 35, 0], kind: 'access', provenance: { category: 'design_assumption' } };
      json.accessPoints!.aOut = { name: '研究接入', facilityId: 'fWorkshop', nodeId: 'nOut', provenance: { category: 'design_assumption' } };
      // An entrance on the right edge on its own node.
      json.nodes!.nSide = { name: '侧门节点', position: [60, 10, 0], kind: 'access', provenance: { category: 'drawing' } };
      json.accessPoints!.aSide = { name: '侧门', facilityId: 'fWorkshop', nodeId: 'nSide', provenance: { category: 'drawing' } };
      (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aOut', 'aSide');
    });
    const only = (id: string) => ({ nodes: [], roads: [], accessPoints: [id] });
    expect(onOutline(map, 'aSide')).toBe(true);
    expect(onOutline(map, 'aOut')).toBe(false);
    expect(entranceSlide(map, only('aSide'), [60, 10, 0])).toBeTypeOf('function');
    expect(entranceSlide(map, only('aOut'), [30, 35, 0])).toBeUndefined();
    expect(entranceSlide(map, { roads: [], accessPoints: ['aSide'], nodes: ['nRoadEast'] }, [60, 10, 0])).toBeUndefined();
    // Down the right edge, whatever the pointer does off the edge.
    expect(entranceSlide(map, only('aSide'), [60, 10, 0])!([67, 7, 0])).toEqual([0, -3, 0]);
    // The example's own entrance is on the outline, at the corner node where two public roads end: the kernel keeps it
    // fixed, so it does not slide (a drag is refused with the kernel's reason) and the inspector says so.
    expect(onOutline(map, 'aWorkshop')).toBe(true);
    expect([entranceMovable(map, 'aWorkshop'), entranceMovable(map, 'aSide'), entranceMovable(map, 'aOut')]).toEqual([false, true, true]);
    expect(entranceSlide(map, only('aWorkshop'), [0, 0, 0])).toBeUndefined();
    expect(commandSupport(map, translateCommand(only('aWorkshop'), [1, 0, 0])).allowed).toBe(false);
  });
});

describe('a new entrance', () => {
  it('is named with the first free number of its building', () => {
    const map = example();
    expect(nextEntranceName(map, 'fWorkshop')).toBe('入口001');
    const named = example(json => { (json.accessPoints!.aWorkshop as { name: string }).name = '入口001'; });
    expect(nextEntranceName(named, 'fWorkshop')).toBe('入口002');
  });
  it('knows an entrance of the same building already there', () => {
    const map = example();
    expect(entranceAt(map, 'fWorkshop', [0.005, 0, 0])).toBe('aWorkshop');
    expect(entranceAt(map, 'fWorkshop', [0.5, 0, 0])).toBeNull();
    // With a tolerance (6 px at the current zoom) a near miss counts as the same place.
    expect(entranceAt(map, 'fWorkshop', [0.5, 0, 0], 0.6)).toBe('aWorkshop');
    expect(entranceAt(map, 'fWorkshop', [0.5, 0, 0], 0.001)).toBeNull();
  });
  it('is one command: the entrance and its own access node, listed by the building; nothing else changes; undo is exact', () => {
    const map = example(), session = createSession(map, true);
    const { command, name } = entranceCommand(map, 'fWorkshop', [20, 30, 0], { point: 'aNew', node: 'nNew' });
    const result = editSession(session, command);
    expect(result.ok).toBe(true);
    const after = result.session.map;
    expect(after.accessPoints.aNew).toMatchObject({ name, facilityId: 'fWorkshop', nodeId: 'nNew', provenance: { category: 'drawing' } });
    expect(after.nodes.nNew).toMatchObject({ position: [20, 30, 0], kind: 'access', name: name + '节点' });
    expect(after.facilities.fWorkshop!.accessPointIds).toEqual(['aWorkshop', 'aNew']);
    for (const kind of ['roads', 'junctions', 'movements', 'resources', 'zones'] as const) expect(after[kind]).toEqual(map[kind]);
    expect(result.session.past).toHaveLength(1);
    expect(undoSession(result.session).map).toEqual(map);
  });
  it('on an existing node of the outline (a road end) uses that node: on the road at once, no second node on top', () => {
    // The example's main road ends at the workshop's corner node nRoadWest (0, 0); a node on the top edge with a road to it:
    const map = example(json => {
      json.nodes!.nGate = { name: '门口路端', position: [30, 30, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
      json.nodes!.nNorth = { name: '北路端', position: [30, 50, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
      json.roads!.rGate = { ...(json.roads!.rMain as object), name: '门口路', fromNodeId: 'nNorth', toNodeId: 'nGate', shapePoints: [] };
    });
    expect(nodeAt(map, 'fWorkshop', [30.2, 30, 0], 0.5)).toEqual({ id: 'nGate', refused: null });
    expect(nodeAt(map, 'fWorkshop', [31, 30, 0], 0.5)).toBeNull();
    const { command } = entranceCommand(map, 'fWorkshop', [30, 30, 0], { point: 'aGate', node: 'unused', existingNode: 'nGate' });
    expect('newNode' in command && command.newNode).toBeFalsy();
    const result = applyMapCommand(map, command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.map.accessPoints.aGate).toMatchObject({ nodeId: 'nGate', facilityId: 'fWorkshop' });
    expect(Object.keys(result.map.nodes)).toHaveLength(Object.keys(map.nodes).length);
    expect((result.issues ?? []).map(issue => issue.code)).not.toContain('NEAR_UNCONNECTED_NODES');
  });
  it('uses a node on the outline only if it stays the building\'s own and the building still moves as before', () => {
    const map = reuseMap(), here = (x: number, y: number, z = 0) => nodeAt(map, 'fWorkshop', [x, y, z], 1);
    // A road end on the top edge, one straight road: used, and the workshop still moves.
    expect(here(30.2, 30)).toEqual({ id: 'nGate', refused: null });
    // A public junction on the right edge (two public roads): not used; the entrance would be fixed, as would the workshop.
    expect(here(60, 15.2)).toMatchObject({ id: 'nJunction', refused: { label: '此处是公共道路节点，不能作入口' } });
    expect(here(60, 15.2)!.refused!.message).toContain('2 条道路在此相接');
    // Another building's entrance node on the shared wall: not used.
    expect(here(4.2, 30)).toMatchObject({ id: 'nShared', refused: { label: '此处节点已属于「棚」，不能共用' } });
    // A road end whose road bends: it would be the entrance's connector, which the kernel stretches only when straight.
    expect(here(45.2, 30)).toMatchObject({ id: 'nBent', refused: { label: `用此节点后「${map.facilities.fWorkshop!.name}」将不能移动` } });
    expect(here(45.2, 30)!.refused!.message).toContain('道路「弯路」');
    // 4e-7 m off the wall is rounding: used. 0.5 m off, or on the edge but 5 m up: not, whatever the pointer's tolerance.
    expect(here(10.2, 30)).toEqual({ id: 'nRounding', refused: null });
    expect(here(20.2, 30)).toBeNull();
    expect(here(40.2, 30)).toBeNull();
    expect(nodeAt(map, 'fWorkshop', [40.2, 30, 5], 1)).toBeNull();
    // What the refusals prevent, checked with the kernel on the map with the entrance.
    const move = translateCommand({ nodes: [], roads: [], facilities: ['fWorkshop'] }, [1, 0, 0]);
    expect(commandSupport(map, move).allowed).toBe(true);
    for (const [node, moves] of [['nGate', true], ['nRounding', true], ['nBent', false]] as const) {
      const { command } = entranceCommand(map, 'fWorkshop', map.nodes[node]!.position, { point: 'aTry', node: 'unused', existingNode: node });
      const result = applyMapCommand(map, command);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(commandSupport(result.map, move).allowed, node).toBe(moves);
      expect(entranceMovable(result.map, 'aTry'), node).toBe(true);
    }
    for (const node of ['nJunction', 'nShared']) {
      const { command } = entranceCommand(map, 'fWorkshop', map.nodes[node]!.position, { point: 'aTry', node: 'unused', existingNode: node });
      const result = applyMapCommand(map, command);
      if (result.ok) expect(entranceMovable(result.map, 'aTry'), node).toBe(false);
    }
  });
  it('judges a node for each building on its own: the shed may use its door node, the workshop sharing the wall may not', () => {
    const map = reuseMap();
    expect(nodeAt(map, 'fShed', [4.2, 30, 0], 1)).toEqual({ id: 'nShared', refused: null });
    expect(nodeAt(map, 'fWorkshop', [4.2, 30, 0], 1)).toMatchObject({ id: 'nShared', refused: { label: '此处节点已属于「棚」，不能共用' } });
  });
  it('is refused as a whole when its ID is taken', () => {
    const map = example();
    const { command } = entranceCommand(map, 'fWorkshop', [20, 30, 0], { point: 'aNew', node: 'nRoadWest' });
    const result = applyMapCommand(map, command);
    expect(result.ok).toBe(false);
  });
});

/** The example made movable (a straight service connector, no internal path over a public road), with nodes on or near the
 *  workshop's top and right edges. */
function reuseMap(): YardMap {
  return example(json => {
    type Json = Record<string, unknown>;
    (json.roads!.rApproach as Json).shapePoints = [];
    (json.servicePoints!.sLoading as Json).arrival = { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '测试：到达装卸点节点即开始作业。' };
    const node = (name: string, position: number[]) => ({ name, position, kind: 'ordinary', provenance: { category: 'synthetic' } });
    const road = (name: string, fromNodeId: string, toNodeId: string, shapePoints: number[][] = []) => ({ ...(json.roads!.rMain as Json), name, fromNodeId, toNodeId, shapePoints });
    json.nodes!.nGate = node('门口路端', [30, 30, 0]); json.nodes!.nNorth = node('北路端', [30, 50, 0]); json.roads!.rGate = road('门口路', 'nNorth', 'nGate');
    json.nodes!.nJunction = node('路口', [60, 15, 0]); json.nodes!.nE1 = node('东一', [80, 15, 0]); json.nodes!.nE2 = node('东二', [75, 25, 0]);
    json.roads!.rE1 = road('东路一', 'nJunction', 'nE1'); json.roads!.rE2 = road('东路二', 'nJunction', 'nE2');
    json.nodes!.nBent = node('弯路端', [45, 30, 0]); json.nodes!.nBentEnd = node('弯路另一端', [55, 45, 0]); json.roads!.rBent = road('弯路', 'nBent', 'nBentEnd', [[45, 40, 0]]);
    json.nodes!.nRounding = node('贴墙路端', [10, 30 + 4e-7, 0]); json.nodes!.nRoundingEnd = node('贴墙路另一端', [10, 45, 0]); json.roads!.rRounding = road('贴墙路', 'nRounding', 'nRoundingEnd');
    json.nodes!.nOff = node('墙外节点', [20, 30.5, 0]);
    json.nodes!.nUpper = node('楼上节点', [40, 30, 5]);
    // A shed on the workshop's top wall with its entrance on that wall.
    json.nodes!.nShared = { ...node('棚门节点', [4, 30, 0]), kind: 'access' };
    json.accessPoints!.aShed = { name: '棚门', facilityId: 'fShed', nodeId: 'nShared', provenance: { category: 'drawing' } };
    json.facilities!.fShed = { name: '棚', kind: 'workshop', boundary: { outer: [[0, 30, 0], [8, 30, 0], [8, 38, 0], [0, 38, 0], [0, 30, 0]], holes: [] },
      accessPointIds: ['aShed'], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
  });
}

describe('the entrance tool in the editor', () => {
  const camera = { offsetX: 0, offsetY: 0, scale: 10 };
  function start(map: YardMap, entranceFor: string | null = null, hiddenTypes: DrawingContext['drawing']['hiddenTypes'] = []): DrawingContext {
    store.set({ session: createSession(map, true), selection: [], tool: 'entrance', entranceFor, message: null, drawing: { ...store.get().drawing, lockedTypes: [], hiddenTypes: [] } });
    return { map, scene: toSceneSnapshot(map), camera, drawing: { ...DEFAULT_DRAWING_CONFIG, hiddenTypes, lockedTypes: [] }, tool: 'entrance', token: 0,
      shapes: { building: 'rect2', zone: 'rect2' }, entranceFor, serviceKind: 'loading', serviceTransfer: 'included_in_service_duration', serviceInside: 'internal', routeWidthM: 8 };
  }
  const at = (x: number, y: number) => ({ screen: [x * 10, -y * 10] as [number, number], world: [x, y, 0] as [number, number, number], alt: false, shift: false });
  const count = () => Object.keys(store.get().session!.map.accessPoints).length;
  afterEach(() => store.set({ session: null, selection: [], tool: 'select', entranceFor: null, message: null }));

  it('refuses a public junction, a shared node and a bent connector with the reason, and adds nothing', () => {
    const context = start(reuseMap()), before = count();
    click(context, at(60.05, 15.05));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('是公共道路的节点') });
    click(context, at(4.05, 29.95));
    expect(store.get().message?.text).toContain('已属于「棚」');
    click(context, at(45.05, 30.05));
    expect(store.get().message?.text).toContain('将不能移动');
    expect(count()).toBe(before);
    // Beside the junction, beyond the 6 px of one place: a new entrance with its own node.
    click(context, at(60.05, 16));
    expect(count()).toBe(before + 1);
    expect(store.get().message).toMatchObject({ tone: 'info', text: expect.stringContaining('从入口节点画路即可接入路网') });
  });
  it('says how many roads a used node brings', () => {
    const context = start(reuseMap());
    click(context, at(30.05, 30.05));
    expect(store.get().message?.text).toContain('用的是此处已有的节点「门口路端」，与其 1 条道路相连');
  });
  it('refuses with the entrance layer hidden, and when the building it was limited to is gone (then any building)', () => {
    const map = example(), before = Object.keys(map.accessPoints).length;
    click(start(map, null, ['accessPoints']), at(20, 30.05));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('入口图层已隐藏') });
    expect(count()).toBe(before);
    click(start(map, 'fGone'), at(20, 30.05));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('限定的建筑已不在地图中') });
    expect(store.get().entranceFor).toBeNull();
    expect(count()).toBe(before);
  });
  it('another map clears the restriction to one building', () => {
    start(example(), 'fWorkshop');
    replaceMap(example());
    expect(store.get()).toMatchObject({ entranceFor: null, tool: 'select' });
  });
});

describe('the reason for a refused edit', () => {
  it('names the entrance an outline change would leave behind, and says what to do on the canvas', () => {
    const map = reuseMap(), { command } = entranceCommand(map, 'fWorkshop', [60, 30, 0], { point: 'aCorner', node: 'nCorner' });
    const added = applyMapCommand(map, command);
    if (!added.ok) throw new Error('fixture');
    const moved = added.map.facilities.fWorkshop!.boundary.outer.map(point => point[0] === 60 && point[1] === 30 ? [65, 35, 0] : point);
    const result = applyMapCommand(added.map, { type: 'updateFacility', id: 'fWorkshop', patch: { boundary: { outer: moved as never, holes: [] } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = refusalMessage(result.issues, added.map);
    expect(text).toContain(`「${map.facilities.fWorkshop!.name}」的入口「入口001」不随这次改动移动`);
    expect(text).toContain('先点选这个入口把它移开');
    expect(text).not.toMatch(/aCorner|nCorner/);
    // Without the map, the kernel's own message.
    expect(refusalMessage(result.issues)).toContain('aCorner');
  });
  it('for a fixed entrance (on a public node) says to split it off or make the change smaller, not to move it', () => {
    const map = example(), entrance = map.accessPoints.aWorkshop!;
    const moved = map.facilities.fWorkshop!.boundary.outer.map(point => point[0] === 0 && point[1] === 0 ? [-5, -5, 0] : point);
    const result = applyMapCommand(map, { type: 'updateFacility', id: 'fWorkshop', patch: { boundary: { outer: moved as never, holes: [] } } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const text = refusalMessage(result.issues, map);
    expect(text).toContain(`的入口「${entrance.name}」不随这次改动移动`);
    expect(text).toContain('它与公共道路或其他对象共用节点，不能移动；可先在属性栏「拆出入口节点」，或缩小改动。');
    expect(text).not.toContain('先点选这个入口');
  });
});
