import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { click, preview, type DrawingContext } from '../../src/app/canvas/drawingTools';
import { deleteCommand, ownRoutes, proxyNote, restatedNote, routeEntrance, routedCommand, serviceCheck, serviceRefusal, serviceSpot, type ServiceSpot } from '../../src/app/canvas/servicePoints';
import { store } from '../../src/app/state/store';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { applyMapCommand, commandSupport, serviceArrivalLock, type MapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { roadOwner } from '../../src/domain/ownerEditing';
import { DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { createSession, undoSession } from '../../src/editor/session';
import { inspectServiceConnection } from '../../src/topology/serviceConnections';
import { validateMap } from '../../src/validation/validate';

// The example's workshop covers 0–60 × 0–30 m, its entrance aWorkshop at the corner (0, 0) on the node where the main road
// and the approach to its loading point (15, 10) meet. `yard` adds a yard (62–68 × 10–20 m) with its own entrance, unconnected.
const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
type Json = Record<string, Record<string, unknown>>;
function example(...changes: ((json: Json) => void)[]): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  for (const change of changes) change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
const facility = (name: string, kind: string, outer: number[][], accessPointIds: string[] = []) => ({ name, kind, boundary: { outer, holes: [] },
  accessPointIds, servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } });
const entrance = (json: Json, id: string, facilityId: string, node: string, position: number[]) => {
  json.nodes![node] = { name: id, position, kind: 'access', provenance: { category: 'synthetic' } };
  json.accessPoints![id] = { name: id, facilityId, nodeId: node, provenance: { category: 'synthetic' } };
};
const yard = (json: Json) => {
  json.facilities!.fYard = facility('堆场', 'yard', [[62, 10, 0], [68, 10, 0], [68, 20, 0], [62, 20, 0], [62, 10, 0]], ['aYard']);
  entrance(json, 'aYard', 'fYard', 'nYardGate', [65, 10, 0]);
};
const camera = { offsetX: 0, offsetY: 0, scale: 10 };
const spotAt = (map: YardMap, x: number, y: number) => serviceSpot(map, [x, y, 0], camera)!;
const ok = (result: ReturnType<typeof applyMapCommand>) => { if (!result.ok) throw new Error(result.issues.map(issue => issue.code + ' ' + issue.message).join('\n')); return result.map; };
const errors = (map: YardMap) => validateMap(map).issues.filter(issue => issue.severity === 'error').map(issue => issue.code);
const upgraded = (map: YardMap) => ok(applyMapCommand(map, { type: 'upgradeSchema', targetVersion: '0.3.0' }));
let turnCount = 0;
const ids = (suffix = '') => ({ point: 'sIn' + suffix, node: 'nIn' + suffix, road: 'rIn' + suffix, junction: 'jIn' + suffix, source: 'srcIn' + suffix, movement: () => 'mIn' + ++turnCount });
/** The tool's command for a point with its route from the nearest usable entrance, committed. */
function placeRouted(map: YardMap, spot: ServiceSpot, widthM = 8, suffix = '') {
  const route = routeEntrance(map, spot);
  if (!('entrance' in route)) throw new Error(route.refusal);
  return ok(applyMapCommand(map, routedCommand(map, spot, route.entrance, 'loading', widthM, ids(suffix)).command));
}
const refusalOf = (map: YardMap, spot: ServiceSpot) => { const route = routeEntrance(map, spot); return 'refusal' in route ? route.refusal : null; };
const turnsOf = (map: YardMap, road: string) => Object.values(map.movements).filter(turn => turn.incomingArc.roadId === road || turn.outgoingArc.roadId === road);

describe('an internal route from the nearest usable entrance', () => {
  it('starts at the nearest entrance whose straight route stays inside; none, or none usable, is refused with the reason', () => {
    const two = example(json => { (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aEast'); entrance(json, 'aEast', 'fWorkshop', 'nEast', [60, 20, 0]); });
    expect(routeEntrance(two, spotAt(two, 50, 20))).toEqual({ entrance: 'aEast' });
    expect(routeEntrance(two, spotAt(two, 10, 5))).toEqual({ entrance: 'aWorkshop' });
    const bare = example(json => { json.facilities!.fShed = facility('棚', 'other', [[62, 10, 0], [68, 10, 0], [68, 20, 0], [62, 20, 0], [62, 10, 0]]); });
    expect(refusalOf(bare, spotAt(bare, 65, 15))).toContain('「棚」还没有入口');
    expect(serviceRefusal(bare, spotAt(bare, 65, 15), 'draft')).toBeNull();
    // An L: the entrance at the foot of the upright; a point at the end of the other arm is not in straight sight.
    const ell = example(json => {
      json.facilities!.fEll = facility('L 形', 'other', [[70, 0, 0], [90, 0, 0], [90, 5, 0], [75, 5, 0], [75, 20, 0], [70, 20, 0], [70, 0, 0]], ['aEll']);
      entrance(json, 'aEll', 'fEll', 'nEll', [72, 20, 0]);
    });
    expect(refusalOf(ell, spotAt(ell, 72, 10))).toBeNull();
    expect(refusalOf(ell, spotAt(ell, 88, 2))).toContain('进入「L 形」后会再穿出它的轮廓');
    // An entrance off the outline, above the upright (a designed access point, as on several real maps): a route through the
    // top wall once is allowed; one in through the top, out through the upright's side and in again through the foot is not.
    const outside = example(json => {
      json.facilities!.fEll = facility('L 形', 'other', [[70, 0, 0], [90, 0, 0], [90, 5, 0], [75, 5, 0], [75, 20, 0], [70, 20, 0], [70, 0, 0]], ['aOff']);
      entrance(json, 'aOff', 'fEll', 'nOff', [71, 22, 0]);
    });
    expect(routeEntrance(outside, spotAt(outside, 72, 10))).toEqual({ entrance: 'aOff' });
    expect(refusalOf(outside, spotAt(outside, 88, 2))).toContain('后会再穿出它的轮廓');
    // An entrance on a node another building's point stands on: the kernel's owner rule.
    const shared = example(yard, json => { json.servicePoints!.sOther = { name: '别家', kind: 'other', nodeId: 'nYardGate', facilityId: 'fWorkshop', resourceIds: [], provenance: { category: 'synthetic' } };
      (json.facilities!.fWorkshop as { servicePointIds: string[] }).servicePointIds.push('sOther'); });
    expect(refusalOf(shared, spotAt(shared, 65, 15))).toContain('还属于其他对象');
    // An entrance at another height than the building.
    const high = example(yard, json => { (json.nodes!.nYardGate as { position: number[] }).position = [65, 10, 1]; });
    expect(refusalOf(high, spotAt(high, 65, 15))).toContain('不在同一高度');
  });
  it('inside a workshop: allowed (the route is the building\'s own); a draft there, or a click on its outline, is still refused', () => {
    const map = example();
    expect(serviceRefusal(map, spotAt(map, 30, 15), 'internal')).toBeNull();
    expect(serviceRefusal(map, spotAt(map, 30, 15), 'draft')).toContain('是厂房');
    expect(serviceRefusal(map, spotAt(map, 30, 0), 'internal')).toContain('请先用入口工具（E）');
  });
});

describe('the point with its internal route, as the real maps have them', () => {
  for (const version of ['0.2.0', '0.3.0'] as const) it(`on a ${version} map: one owned two-way road from the entrance, both turns there approved, a continuous route`, () => {
    const base = version === '0.3.0' ? upgraded(example()) : example();
    const map = placeRouted(base, spotAt(base, 30, 15), 6), before = Object.keys(base.junctions).length;
    const point = map.servicePoints.sIn!, road = map.roads.rIn!;
    expect(point).toMatchObject({ facilityId: 'fWorkshop', accessPointId: 'aWorkshop', nodeId: 'nIn', arrival: { mode: 'explicit_internal', internalPath: [{ roadId: 'rIn', direction: 'forward' }] } });
    expect(road).toMatchObject({ fromNodeId: 'nRoadWest', toNodeId: 'nIn', direction: 'both', widthM: { state: 'known', value: 6 } });
    expect(version === '0.3.0' ? road.geometry : road.shapePoints).toBeDefined();
    expect(roadOwner(map, 'rIn')).toBe('fWorkshop');
    // The point's node typed as the real maps' are.
    expect(map.nodes.nIn).toMatchObject({ position: [30, 15, 0], kind: 'service' });
    // Into and out of the route from each of the two roads at the entrance (the main road and the old approach), all allowed.
    const turns = turnsOf(map, 'rIn');
    expect(turns).toHaveLength(4);
    expect(turns.every(turn => turn.allowed)).toBe(true);
    for (const road of ['rMain', 'rApproach']) {
      expect(turns.some(turn => turn.incomingArc.roadId === road && turn.outgoingArc.roadId === 'rIn')).toBe(true);
      expect(turns.some(turn => turn.incomingArc.roadId === 'rIn' && turn.outgoingArc.roadId === road)).toBe(true);
    }
    expect(Object.keys(map.junctions)).toHaveLength(before + 1);
    // The source says the turns were approved by the tool, as design assumptions.
    expect(map.sources.srcIn!.description).toContain('进出转向（不含掉头）由工具按内核建议全部批准');
    expect(inspectServiceConnection(map, 'sIn')).toMatchObject({ internalPathStatus: 'continuous', status: 'unchecked' });
    expect(errors(map)).toEqual(errors(base));
    // A second point from the same entrance reuses its junction (the real maps' entrances all have one), with its own turns,
    // including to and from the first route.
    const second = placeRouted(map, spotAt(map, 20, 25), 6, 'B');
    expect(Object.keys(second.junctions)).toEqual(Object.keys(map.junctions));
    expect(turnsOf(second, 'rInB')).toHaveLength(6);
    expect(turnsOf(second, 'rInB').every(turn => turn.allowed)).toBe(true);
    expect(errors(second)).toEqual(errors(base));
  });
  it('from an entrance with no road yet; a public road drawn to it later gets its turns into and out of the route (0.3)', () => {
    const base = upgraded(example(yard)), map = placeRouted(base, spotAt(base, 65, 15));
    expect(Object.values(map.movements).filter(turn => turn.incomingArc.roadId === 'rIn' || turn.outgoingArc.roadId === 'rIn')).toEqual([]);
    const road: MapCommand = { type: 'quickTraceRoad', points: [[100, 0, 0], [65, 10, 0]], geometry: { kind: 'path', anchors: [], spans: [{ kind: 'line' }] }, disconnect: false,
      defaults: { widthM: 8, direction: 'both', connectNewCrossings: false }, startConnection: { kind: 'node', nodeId: 'nRoadEast' }, endConnection: { kind: 'node', nodeId: 'nYardGate' } } as MapCommand;
    const after = ok(applyMapCommand(map, road)), drawn = Object.keys(after.roads).find(id => !map.roads[id])!;
    const turns = Object.values(after.movements).filter(turn => turn.allowed);
    expect(turns.some(turn => turn.incomingArc.roadId === drawn && turn.outgoingArc.roadId === 'rIn')).toBe(true);
    expect(turns.some(turn => turn.incomingArc.roadId === 'rIn' && turn.outgoingArc.roadId === drawn)).toBe(true);
  });
  it('the kernel\'s connected point on a 0.3 map stores path geometry (it wrote 0.2 shape points: a schema error)', () => {
    const base = upgraded(example()), spot = spotAt(base, 30, 15);
    const support = commandSupport(base, routedCommand(base, spot, 'aWorkshop', 'loading', 8, ids()).command);
    expect(support).toMatchObject({ allowed: true });
    expect(placeRouted(base, spot).roads.rIn).toMatchObject({ geometry: { kind: 'path', anchors: [], spans: [{ kind: 'line' }] } });
    expect(placeRouted(base, spot).roads.rIn!.shapePoints).toBeUndefined();
  });
});

describe('declaring how a point is reached, on a map with turns (the real maps)', () => {
  // The routed point makes the map complex (a junction with turns, and building-owned roads); a draft in the yard beside it.
  function complex() {
    const base = example(yard), routed = placeRouted(base, spotAt(base, 30, 15));
    const draft: MapCommand = { type: 'addServicePoint', id: 'sDraft', servicePoint: { name: '草稿', kind: 'loading', nodeId: 'nDraft', facilityId: 'fYard', resourceIds: [], provenance: { category: 'drawing' } },
      newNode: { id: 'nDraft', node: { name: '草稿节点', position: [65, 15, 0], kind: 'service', provenance: { category: 'drawing' } } } };
    return ok(applyMapCommand(routed, draft));
  }
  const arrival = (id: string, value: unknown): MapCommand => ({ type: 'updateServicePoint', id, patch: { arrival: value as never } });
  const proxy = (transfer: 'included_in_service_duration' | 'excluded_from_model' = 'included_in_service_duration') => ({ mode: 'node_proxy', transferAssumption: transfer, note: proxyNote(transfer, true) });
  it('a draft is declared a node proxy, its transfer assumption changed, and made a draft again; each one command', () => {
    const map = complex();
    expect(Object.keys(map.junctions).length).toBeGreaterThan(0);
    const declared = ok(applyMapCommand(map, arrival('sDraft', proxy())));
    expect(declared.servicePoints.sDraft!.arrival).toEqual(proxy());
    const changed = ok(applyMapCommand(declared, arrival('sDraft', proxy('excluded_from_model'))));
    expect(changed.servicePoints.sDraft!.arrival).toMatchObject({ transferAssumption: 'excluded_from_model' });
    expect(ok(applyMapCommand(changed, arrival('sDraft', null))).servicePoints.sDraft!.arrival).toBeUndefined();
    // The example's zone point (a node proxy) too.
    expect(ok(applyMapCommand(map, arrival('sZoneUnload', proxy()))).servicePoints.sZoneUnload!.arrival).toEqual(proxy());
  });
  it('an internal route is neither dropped nor declared here: refused with the reason; the other fields still commit', () => {
    const map = complex();
    const dropped = commandSupport(map, arrival('sIn', proxy()));
    expect(dropped).toMatchObject({ allowed: false, issues: [{ code: 'SERVICE_ARRIVAL_INTERNAL', message: expect.stringContaining('连同它的内部通道删除后重新添加') }] });
    expect(commandSupport(map, arrival('sDraft', { mode: 'explicit_internal', internalPath: [{ roadId: 'rIn', direction: 'forward' }] }))).toMatchObject({ allowed: false, issues: [{ code: 'SERVICE_ARRIVAL_INTERNAL' }] });
    expect(ok(applyMapCommand(map, { type: 'updateServicePoint', id: 'sIn', patch: { name: '改名' } })).servicePoints.sIn!.name).toBe('改名');
    // A proxy without its note is still refused by validation.
    expect(applyMapCommand(map, arrival('sDraft', { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: ' ' }))).toMatchObject({ ok: false });
  });
  it('a point a resource rests on keeps how it is reached (its occupancy rests on it), as on the real maps; the reason is given', () => {
    const map = complex(), withResource = structuredClone(map) as YardMap;
    withResource.resources.rBay = { name: '卸货位', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown',
      appliesTo: [{ entityType: 'servicePoints', entityId: 'sDraft' }], provenance: { category: 'synthetic' } };
    expect(serviceArrivalLock(map, 'sDraft')).toBeNull();
    expect(serviceArrivalLock(withResource, 'sDraft')).toMatchObject({ code: 'OPERATION_DEPENDENCIES_UNSUPPORTED', message: expect.stringContaining('关联着资源') });
    expect(commandSupport(withResource, arrival('sDraft', proxy()))).toMatchObject({ allowed: false, issues: [{ code: 'OPERATION_DEPENDENCIES_UNSUPPORTED', jsonPath: '/servicePoints/sDraft/arrival' }] });
    // Listed on the point only, as well.
    const listed = structuredClone(map) as YardMap; listed.servicePoints.sDraft!.resourceIds = ['rAny'];
    expect(serviceArrivalLock(listed, 'sDraft')).toMatchObject({ code: 'OPERATION_DEPENDENCIES_UNSUPPORTED' });
    expect(serviceArrivalLock(map, 'sIn')).toMatchObject({ code: 'SERVICE_ARRIVAL_INTERNAL' });
    // A planning declaration of the in-site transfer says the same thing as the arrival: locked too.
    const planned = structuredClone(map) as YardMap;
    planned.servicePoints.sDraft!.extensions = { 'sr02.planning': { capability: 'loading_and_unloading', handling: 'reserved_slot_transfer_in_service_time' } };
    expect(serviceArrivalLock(planned, 'sDraft')).toMatchObject({ code: 'OPERATION_DEPENDENCIES_UNSUPPORTED', message: expect.stringContaining('规划扩展') });
  });
  it('a node inside a workshop cannot be a node proxy (no route through its walls): a draft there stays a draft, with the reason', () => {
    const map = ok(applyMapCommand(complex(), { type: 'addServicePoint', id: 'sStray', servicePoint: { name: '孤点', kind: 'other', nodeId: 'nStray', facilityId: 'fWorkshop', resourceIds: [], provenance: { category: 'drawing' } },
      newNode: { id: 'nStray', node: { name: '孤点节点', position: [40, 20, 0], kind: 'service', provenance: { category: 'drawing' } } } }));
    expect(serviceArrivalLock(map, 'sStray')).toMatchObject({ code: 'SERVICE_ARRIVAL_INSIDE_BUILDING', message: expect.stringContaining('经内部通道添加') });
    expect(commandSupport(map, arrival('sStray', proxy()))).toMatchObject({ allowed: false, issues: [{ code: 'SERVICE_ARRIVAL_INSIDE_BUILDING' }] });
    // One already a node proxy there (an old map's) may still be edited or made a draft.
    const old = structuredClone(map) as YardMap; old.servicePoints.sStray!.arrival = { ...proxy(), mode: 'node_proxy' };
    expect(serviceArrivalLock(old, 'sStray')).toBeNull();
    expect(ok(applyMapCommand(old, arrival('sStray', proxy('excluded_from_model')))).servicePoints.sStray!.arrival).toMatchObject({ transferAssumption: 'excluded_from_model' });
    expect(ok(applyMapCommand(old, arrival('sStray', null))).servicePoints.sStray!.arrival).toBeUndefined();
  });
  it('a generated note follows the transfer assumption; one someone wrote stays', () => {
    expect(restatedNote(proxyNote('included_in_service_duration'), 'included_in_service_duration', 'excluded_from_model')).toBe(proxyNote('excluded_from_model'));
    expect(restatedNote(proxyNote('excluded_from_model', true), 'excluded_from_model', 'included_in_service_duration')).toBe(proxyNote('included_in_service_duration', true));
    expect(restatedNote('现场确认：门内 5 m 交接', 'excluded_from_model', 'included_in_service_duration')).toBe('现场确认：门内 5 m 交接');
    // The note the tool wrote at entrances since P3b2b, and a written note ending with the same sentence, are restated too.
    expect(restatedNote('在入口节点作业（作业点工具放置）；场内转运计入作业时长。', 'included_in_service_duration', 'excluded_from_model')).toBe('在入口节点作业（作业点工具放置）；场内转运不在模型内。');
    expect(proxyNote('included_in_service_duration')).not.toContain('作业点工具');
  });
});

describe('the connection check, and the routes a delete takes along', () => {
  it('an internal route whose entrance has no public road is flagged, also when other points\' routes share that entrance', () => {
    const base = example(yard), one = placeRouted(base, spotAt(base, 64, 15)), two = placeRouted(one, spotAt(one, 66, 18), 8, 'B');
    for (const id of ['sIn', 'sInB']) expect(serviceCheck(two, id)).toMatchObject({ summary: '需要处理 1 项', lines: [expect.stringContaining('入口「aYard」的节点还没有接公共道路')] });
    // A 0.2 map: roads need the upgrade first, and the hint says so.
    expect(serviceCheck(two, 'sIn').lines[0]).toContain('先升级到 0.3');
    // On the workshop's entrance, which has public roads: nothing to do.
    const fine = placeRouted(base, spotAt(base, 30, 15), 8, 'C');
    expect(serviceCheck(fine, 'sInC')).toEqual({ summary: '内部通道连续，长 33.5 m', lines: [] });
    // A draft on a node of its own: not connected and not declared, in plain words.
    const draft = ok(applyMapCommand(base, { type: 'addServicePoint', id: 'sDraft', servicePoint: { name: '草稿', kind: 'loading', nodeId: 'nDraft', zoneId: 'zWaiting', resourceIds: [], provenance: { category: 'drawing' } },
      newNode: { id: 'nDraft', node: { name: '草稿节点', position: [80, 42, 0], kind: 'service', provenance: { category: 'drawing' } } } }));
    expect(serviceCheck(draft, 'sDraft').lines).toEqual([expect.stringContaining('节点还没有接路'), expect.stringContaining('到达方式未声明')]);
  });
  it('deleting a point takes its own route along (roads, turns, its node), in one command; a route another point uses stays', () => {
    const base = example(), map = placeRouted(base, spotAt(base, 30, 15));
    const selection = { nodes: [], roads: [], servicePoints: ['sIn'] };
    expect(ownRoutes(map, selection, false)).toEqual({ roads: ['rIn'], nodes: ['nIn'] });
    const own = ownRoutes(map, selection, false);
    const gone = ok(applyMapCommand(map, { type: 'deleteSelection', selection: { ...selection, roads: own.roads, nodes: own.nodes }, topologyPolicy: 'cascade', orphanNodes: 'keep', facilityPolicy: 'reject', zonePolicy: 'reject' }));
    expect(gone.roads.rIn).toBeUndefined(); expect(gone.nodes.nIn).toBeUndefined(); expect(turnsOf(gone, 'rIn')).toEqual([]);
    expect(Object.keys(gone.roads).sort()).toEqual(Object.keys(base.roads).sort());
    expect(errors(gone)).toEqual(errors(base));
    // Another kind on the same node, reached by the same route (the tool does this): the route stays while it is used.
    const twin = ok(applyMapCommand(map, { type: 'addServicePoint', id: 'sTwin', servicePoint: { ...map.servicePoints.sIn!, name: '同处卸载', kind: 'unloading', resourceIds: [] } }));
    expect(ownRoutes(twin, selection, false)).toEqual({ roads: [], nodes: [] });
    expect(ownRoutes(twin, { nodes: [], roads: [], servicePoints: ['sIn', 'sTwin'] }, false)).toEqual({ roads: ['rIn'], nodes: ['nIn'] });
    // Deleting the building with its points takes the routes too (the example's old approach is a public road: it stays).
    expect(ownRoutes(map, { nodes: [], roads: [], facilities: ['fWorkshop'] }, true)).toEqual({ roads: ['rIn'], nodes: ['nIn'] });
    expect(ownRoutes(map, { nodes: [], roads: [], facilities: ['fWorkshop'] }, false)).toEqual({ roads: [], nodes: [] });
  });
  it('the dialog\'s command: the cascade for the routes only where it clears no resource reference and nothing else is selected', () => {
    const map = placeRouted(example(), spotAt(example(), 30, 15)), defaults = { cascade: false, members: false, orphans: false, routes: true };
    const only = { nodes: [], roads: [], servicePoints: ['sIn'] };
    // No resource: the routes go along by the cascade, unasked.
    const plain = deleteCommand(map, only, defaults);
    expect(plain).toMatchObject({ command: { topologyPolicy: 'cascade', selection: { roads: ['rIn'], nodes: ['nIn'] } }, held: null });
    expect(commandSupport(map, plain.command).allowed).toBe(true);
    // A resource on the point (every point of the real maps): the cascade would clear its reference, so not unasked; the delete
    // is refused as for any other point until the cascade is ticked, which then clears it.
    const withResource = structuredClone(map) as YardMap;
    withResource.resources.rBay = { name: '装卸位', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'known', value: 2 }, controlModel: 'unknown',
      appliesTo: [{ entityType: 'servicePoints', entityId: 'sIn' }], provenance: { category: 'synthetic' } };
    withResource.servicePoints.sIn!.resourceIds = ['rBay'];
    const held = deleteCommand(withResource, only, defaults);
    expect(held).toMatchObject({ command: { topologyPolicy: 'reject' }, held: expect.stringContaining('关联着资源') });
    expect(commandSupport(withResource, held.command).allowed).toBe(false);
    const ticked = deleteCommand(withResource, only, { ...defaults, cascade: true });
    expect(ticked).toMatchObject({ command: { topologyPolicy: 'cascade' }, held: null });
    expect(ok(applyMapCommand(withResource, ticked.command)).resources.rBay).toMatchObject({ appliesTo: [], capacity: { state: 'known', value: 2 } });
    // Another road selected too: the cascade would act on it as well, so it stays the ticked choice, and the dialog says why.
    expect(deleteCommand(map, { ...only, roads: ['rMain'] }, defaults)).toMatchObject({ command: { topologyPolicy: 'reject' }, held: expect.stringContaining('同时选中了其他道路或节点') });
    // Unticked: the point alone, as before P3b2c.
    expect(deleteCommand(map, only, { ...defaults, routes: false })).toMatchObject({ command: { topologyPolicy: 'reject', selection: { roads: [], nodes: [] } }, held: null });
  });
});

describe('the service point tool with internal routes', () => {
  function start(map: YardMap, serviceInside: DrawingContext['serviceInside'] = 'internal', drawing: Partial<DrawingContext['drawing']> = {}): DrawingContext {
    store.set({ session: createSession(map, true), selection: [], tool: 'service', message: null, serviceInside });
    return { map, scene: toSceneSnapshot(map), camera, drawing: { ...DEFAULT_DRAWING_CONFIG, ...drawing }, tool: 'service', token: 0,
      shapes: { building: 'rect2', zone: 'rect2' }, entranceFor: null, serviceKind: 'loading', serviceTransfer: 'included_in_service_duration', serviceInside, routeWidthM: 7 };
  }
  const refresh = (context: DrawingContext): DrawingContext => ({ ...context, map: store.get().session!.map });
  const at = (x: number, y: number) => ({ screen: [x * 10, -y * 10] as [number, number], world: [x, y, 0] as [number, number, number], alt: false, shift: false });
  afterEach(() => store.set({ session: null, selection: [], tool: 'select', message: null, serviceInside: 'internal' }));

  it('a click inside the workshop adds the point with its route (road width from the options), one undo step; says so', () => {
    const context = start(example());
    click(context, at(30, 15));
    const session = store.get().session!, map = session.map;
    const added = Object.keys(map.servicePoints).find(id => !context.map.servicePoints[id])!;
    const point = map.servicePoints[added]!, routeId = (point.arrival as { internalPath: { roadId: string }[] }).internalPath[0]!.roadId, road = map.roads[routeId]!;
    expect(point).toMatchObject({ name: '作业点001', accessPointId: 'aWorkshop', arrival: { mode: 'explicit_internal' } });
    expect(road.widthM).toEqual({ state: 'known', value: 7, sourceRef: expect.any(String) });
    // The tool's own path approves the turns: into and out of the route from both roads at the entrance.
    expect(turnsOf(map, routeId)).toHaveLength(4);
    expect(store.get().message?.text).toMatch(/经入口「厂房西侧入口」的内部通道到达（33\.5 m，宽 7 m，已批准入口处进出转向 4 个）。/);
    expect(undoSession(session).map).toEqual(context.map);
    // A second click at the same entrance reuses the junction the first made.
    click(refresh(context), at(20, 25));
    expect(Object.keys(store.get().session!.map.servicePoints)).toHaveLength(Object.keys(map.servicePoints).length + 1);
    expect(Object.keys(store.get().session!.map.junctions)).toEqual(Object.keys(map.junctions));
    expect(store.get().message?.text).toContain('已批准入口处进出转向 6 个');
  });
  it('another kind on the node of a point with a route is reached by the same route; a zone gets a draft in either option', () => {
    const context = start(example());
    click(context, at(30, 15));
    const first = store.get().session!.map, added = Object.keys(first.servicePoints).find(id => !context.map.servicePoints[id])!;
    click({ ...refresh(context), serviceKind: 'unloading' }, at(30.2, 15));
    const map = store.get().session!.map, twin = Object.keys(map.servicePoints).find(id => !first.servicePoints[id])!;
    expect(map.servicePoints[twin]).toMatchObject({ kind: 'unloading', nodeId: first.servicePoints[added]!.nodeId, accessPointId: 'aWorkshop', arrival: first.servicePoints[added]!.arrival });
    expect(store.get().message?.text).toContain('经同一内部通道到达');
    expect(Object.keys(map.roads)).toEqual(Object.keys(first.roads));
    click(refresh(context), at(80, 42));
    expect(store.get().message?.text).toContain('到达方式未声明（草稿）');
  });
  it('with the road or entrance layer hidden or locked, no route: the preview and the click say why', () => {
    const cases: [Partial<DrawingContext['drawing']>, string][] = [[{ lockedTypes: ['roads'] }, '道路图层已锁定'], [{ hiddenTypes: ['roads'] }, '道路图层已隐藏'], [{ hiddenTypes: ['accessPoints'] }, '入口图层已隐藏']];
    for (const [drawing, word] of cases) {
      const context = start(example(), 'internal', drawing);
      expect(preview(context, at(30, 15))).toMatchObject({ label: { lines: ['不能放在这里', expect.any(String)] } });
      expect(preview(context, at(30, 15))!.road).toBeUndefined();
      click(context, at(30, 15));
      expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining(word) });
      expect(Object.keys(store.get().session!.map.servicePoints)).toEqual(Object.keys(context.map.servicePoints));
    }
  });
  it('from an entrance without a road it says to draw one; as a draft (the option), the workshop is refused as before', () => {
    const context = start(example(yard));
    click(context, at(65, 15));
    expect(store.get().message?.text).toContain('这个入口的节点还没有接公共道路，从它画路即可接入路网（这张地图画路前要先升级到 0.3）');
    // A second point from that entrance: still not on the public network (the first route does not count).
    click(refresh(context), at(66, 18));
    expect(store.get().message?.text).toContain('这个入口的节点还没有接公共道路');
    const drafts = start(example(), 'draft');
    click(drafts, at(30, 15));
    expect(store.get().message).toMatchObject({ tone: 'error', text: expect.stringContaining('是厂房') });
  });
  it('previews the route as a road band at the route width, from the entrance it starts at', () => {
    const shown = preview(start(example()), at(30, 15))!;
    expect(shown).toMatchObject({ vertices: [[30, 15, 0]], road: { path: { anchors: [[0, 0, 0], [30, 15, 0]], spans: [{ kind: 'line' }] }, widthM: 7 },
      label: { lines: [expect.stringContaining('经入口「厂房西侧入口」内部通道'), expect.any(String)] } });
    expect(preview(start(example(), 'draft'), at(30, 15))!.road).toBeUndefined();
  });
});
