import { beforeAll, describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, normalizeSelection, type MapCommand, type Selection } from '../../src/domain/commands';
import { mapCapabilities } from '../../src/domain/capabilities';
import { inspectPlanning } from '../../src/domain/planning';
import { validateMap } from '../../src/validation/validate';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { loadMap } from '../../src/domain/load';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { newMap, newNode, newZone } from '../../src/domain/factory';
import { associatedFixture, testFacility } from '../helpers/M2A_fixtures';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

const NS = 'sr02.planning';
const select = (partial: Partial<Selection>): Selection => ({ nodes: [], roads: [], ...partial });
let original: YardMap;
beforeAll(async () => { original = (await readP1Target(P1_TARGETS.find(target => target.id === 'SR03_A')!)).map; });
const fixture = () => structuredClone(original);
const move = (partial: Partial<Selection>, delta: Vec3 = [1, 2, 0]): MapCommand => ({ type: 'translateSelection', selection: select(partial), delta, facilityMovePolicy: 'withStaticContents', zoneMovePolicy: 'withStaticContents' });
const translate = (p: Vec3): Vec3 => [p[0] + 1, p[1] + 2, p[2]];
function polygonMoved(before: Polygon, after: Polygon, transform: (p: Vec3) => Vec3) {
  for (const [ring, points] of [before.outer, ...before.holes].entries()) for (const [index, point] of points.entries()) {
    const actual = [after.outer, ...after.holes][ring]![index]!;
    transform(point).forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value, 9));
  }
}
function slots(map: YardMap, kind: 'facilities' | 'zones', id: string) { return (map[kind][id]!.extensions![NS] as { slots: { id: string; boundary: Polygon }[] }).slots; }
function run(map: YardMap, command: MapCommand): YardMap {
  const result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result.ok ? {} : result.issues)).toBe(true);
  if (!result.ok) throw new Error('Expected accepted operation');
  return result.map;
}
function reject(map: YardMap, command: MapCommand, code?: string) {
  const before = contentHash(map), session = createSession(map, true);
  const result = editSession(session, command);
  expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(contentHash(map)).toBe(before);
  if (code) expect(result.issues.some(issue => issue.code === code)).toBe(true);
}

describe('P1 explicit operation protection and real SR03 rigid contents', () => {
  it('opens known static SR03 for local inspection without claiming execution or all commands', () => {
    const map = fixture(), capabilities = mapCapabilities(map);
    expect(capabilities.editable).toBe(true); expect(capabilities.unchecked).toContain('resource_execution');
    expect(commandSupport(map, { type: 'updateFacility', id: 'F_001', patch: { name: 'Edited name' } }).allowed).toBe(true);
    expect(commandSupport(map, { type: 'deleteSelection', selection: select({ facilities: ['F_001'] }) }).allowed).toBe(false);
  });
  it('derives an exact facility closure, preserving both public anchors and neighboring owner', () => {
    const support = commandSupport(fixture(), move({ facilities: ['F_001'] }));
    expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
    expect(support.impact?.selection.nodes).toEqual(['N_0012', 'N_0013', 'N_0014']);
    expect(support.impact?.fixedAnchorNodeIds).toEqual(['N_0011', 'N_0015']);
    expect(support.impact?.rigidRoadIds).toEqual(['R_0009', 'R_0010']);
    expect(support.impact?.connectorRoadIds).toEqual(['R_0008', 'R_0011']);
    expect(support.impact?.slots).toHaveLength(12);
    expect(support.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'resources', id: 'RES_STORE_001' }, { kind: 'junctions', id: 'J_N_0011' }]));
  });
  it('translates the facility, all slots and point nodes once; declaration references and capacities stay exact', () => {
    const map = fixture(), before = structuredClone(map), after = run(map, move({ facilities: ['F_001'] }));
    expect(map).toEqual(before); expect(after.revision).toBe(map.revision + 1);
    polygonMoved(map.facilities.F_001!.boundary, after.facilities.F_001!.boundary, translate);
    slots(map, 'facilities', 'F_001').forEach((slot, i) => polygonMoved(slot.boundary, slots(after, 'facilities', 'F_001')[i]!.boundary, translate));
    for (const id of ['N_0012', 'N_0013', 'N_0014']) expect(after.nodes[id]!.position).toEqual(translate(map.nodes[id]!.position));
    for (const id of ['N_0011', 'N_0015', 'N_0016']) expect(after.nodes[id]).toEqual(map.nodes[id]);
    for (const key of ['roads', 'resources', 'movements', 'accessPoints', 'servicePoints', 'metadata', 'extensions', 'extensionNamespaces', 'siteBoundary'] as const) expect(after[key]).toEqual(map[key]);
    expect(after.sources).toEqual({ ...map.sources, source_editor_geometry: {
      name: '编辑器人工几何设计假设', category: 'design_assumption',
      description: '用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。',
    } });
    expect(after.facilities.F_001!.provenance.category).toBe(map.facilities.F_001!.provenance.category);
    expect(after.facilities.F_001!.provenance.fieldSources?.boundary).toBe('source_editor_geometry');
    for (const id of ['N_0012', 'N_0013', 'N_0014']) expect(after.nodes[id]!.provenance.fieldSources?.position).toBe('source_editor_geometry');
    expect(after.facilities.F_002).toEqual(map.facilities.F_002);
  });
  it('rotates parking slots, entry nodes, service nodes and internal turn reserves in one closure', () => {
    const map = fixture();
    const command: MapCommand = { type: 'rotateSelection', selection: select({ zones: ['Z_005'] }), pivot: [0, 0, 0], angleRad: Math.PI / 2, zoneMovePolicy: 'withStaticContents' };
    const support = commandSupport(map, command);
    expect(support.impact?.selection.nodes).toEqual(['N_0031', 'N_0032', 'N_0033', 'N_0035', 'N_0036', 'N_0037', 'N_0038', 'N_0039']);
    expect(support.impact?.junctionIds).toEqual(['J_N_0031', 'J_N_0032', 'J_N_0033', 'J_N_0035', 'J_N_0038']);
    const after = run(map, command), rotate = ([x, y, z]: Vec3): Vec3 => [-y, x, z];
    polygonMoved(map.zones.Z_005!.boundary, after.zones.Z_005!.boundary, rotate);
    slots(map, 'zones', 'Z_005').forEach((slot, i) => polygonMoved(slot.boundary, slots(after, 'zones', 'Z_005')[i]!.boundary, rotate));
    for (const id of ['J_N_0035', 'J_N_0038']) polygonMoved(map.junctions[id]!.boundary!, after.junctions[id]!.boundary!, rotate);
    for (const id of ['J_N_0030', 'J_N_0034']) expect(after.junctions[id]).toEqual(map.junctions[id]);
    expect(after.resources).toEqual(map.resources); expect(after.servicePoints).toEqual(map.servicePoints);
    expect(after.movements).toEqual(map.movements);
  });
  it('undo, redo, and JSON reload restore whole static content transactions', () => {
    const map = fixture(), session = createSession(map, true), edit = editSession(session, move({ zones: ['Z_005'] }));
    expect(edit.ok).toBe(true); expect(edit.session.past).toHaveLength(1);
    const undone = undoSession(edit.session); expect(undone.map).toEqual(map);
    const redone = redoSession(undone); expect(redone.map).toEqual(edit.session.map);
    const loaded = loadMap(serializeMap(redone.map)); expect(loaded.ok && loaded.map).toEqual(redone.map);
  });
  it.each(['boundaryOnly', 'withAssociatedNodes'] as const)('does not silently reinterpret legacy policy %s for slots', policy => {
    reject(fixture(), { type: 'translateSelection', selection: select({ facilities: ['F_001'] }), delta: [1, 0, 0], facilityMovePolicy: policy }, 'STATIC_CONTENTS_REQUIRED');
  });
  it('rejects direct geometry patches and point operations that bypass a slot owner', () => {
    const map = fixture(), boundary = structuredClone(map.facilities.F_001!.boundary); boundary.outer[0][0] += 1;
    reject(map, { type: 'updateFacility', id: 'F_001', patch: { boundary } }, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
    reject(map, { type: 'updateNode', id: 'N_0013', patch: { position: [1, 2, 0] } }, 'LOCAL_OWNER_DEPENDENCY');
    reject(map, { type: 'translateSelection', selection: select({ servicePoints: ['SP_001'] }), delta: [1, 0, 0] }, 'OPERATION_DEPENDENCIES_UNSUPPORTED');
  });
  it('rejects unknown global behavior and unknown fields inside the known behavior', () => {
    const unknown = fixture(); unknown.extensionNamespaces['example.unknown'] = { category: 'behavior', version: '1' }; unknown.extensions['example.unknown'] = { preserve: true };
    reject(unknown, { type: 'updateFacility', id: 'F_001', patch: { name: 'Blocked' } }, 'READ_ONLY_MAP');
    const nested = fixture(); (nested.facilities.F_001!.extensions![NS] as Record<string, unknown>).overhang = [[1, 2, 0]];
    reject(nested, move({ facilities: ['F_001'] }), 'READ_ONLY_MAP');
  });
  it.each(['shapePoints', 'corridorPolygon', 'observedLengthM'] as const)('rejects connector %s instead of guessing how to move it', field => {
    const map = fixture(), road = map.roads.R_0008!;
    if (field === 'shapePoints') road.shapePoints = [[30, 130, 0]];
    else if (field === 'corridorPolygon') road.corridorPolygon = structuredClone(map.facilities.F_001!.boundary);
    else road.observedLengthM = { state: 'known', value: 22 };
    expect(commandSupport(map, move({ facilities: ['F_001'] })).allowed).toBe(false);
  });
  it('rejects a junction with only some nodes moving', () => {
    const map = fixture(); map.junctions.J_N_0012!.nodeIds.push('N_0011');
    expect(commandSupport(map, move({ facilities: ['F_001'] })).issues.some(issue => issue.code === 'STATIC_PARTIAL_JUNCTION')).toBe(true);
  });
  it('rejects an explicitly located movement path rather than leave it stale', () => {
    const map = fixture(), movement = Object.values(map.movements).find(item => item.incomingArc.roadId === 'R_0009')!;
    movement.internalPath = [[48, 132, 0], [65.5, 132, 0]];
    expect(commandSupport(map, move({ facilities: ['F_001'] })).issues.some(issue => issue.code === 'STATIC_MOVEMENT_PATH_UNSUPPORTED')).toBe(true);
  });
  it('rejects foreign service usage of a moving private node', () => {
    const map = fixture(); map.servicePoints.SP_002!.nodeId = 'N_0013';
    expect(commandSupport(map, move({ facilities: ['F_001'] })).issues.some(issue => issue.code === 'STATIC_SHARED_NODE')).toBe(true);
  });
  it('does not silently drop inspect-only selection kinds', () => {
    expect(() => normalizeSelection({ nodes: [], roads: [], resources: ['x'] } as Selection)).toThrow('选择包含未知对象类型');
  });
  it('preserves legacy plain-map commands and no-op revisions', () => {
    const map = newMap('legacy', 'Before', '0.1.0');
    expect(run(map, { type: 'renameMap', name: 'Before' })).toBe(map);
    const changed = run(map, { type: 'renameMap', name: 'After' });
    expect(changed.schemaVersion).toBe('0.1.0'); expect(changed.revision).toBe(1);
  });
  it('reports legacy membership, new-node, orphan-cleanup and source writes for layer locks', () => {
    const map = associatedFixture(); map.facilities.fB = testFacility('Other');
    const moved = commandSupport(map, { type: 'updateAccessPoint', id: 'aA', patch: { facilityId: 'fB', nodeId: 'nNew' }, newNode: { id: 'nNew', node: newNode([1, 2, 0]) } });
    expect(moved.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'accessPoints', id: 'aA' }, { kind: 'facilities', id: 'fA' }, { kind: 'facilities', id: 'fB' }, { kind: 'nodes', id: 'nNew' }]));
    const nodeMove = commandSupport(map, { type: 'updateNode', id: 'nS', patch: { position: [2, 3, 0] } });
    expect(nodeMove.affectedRefs).toContainEqual({ kind: 'servicePoints', id: 'sA' });
    const named = commandSupport(map, { type: 'updateAccessPoint', id: 'aA', patch: { name: 'Name only' } });
    expect(named.affectedRefs).toEqual([{ kind: 'accessPoints', id: 'aA' }]);
    const deletion = commandSupport(map, { type: 'deleteSelection', selection: select({ facilities: ['fA'] }), facilityPolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' });
    expect(deletion.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'nodes', id: 'nA' }, { kind: 'nodes', id: 'nS' }, { kind: 'facilities', id: 'fA' }, { kind: 'accessPoints', id: 'aA' }, { kind: 'servicePoints', id: 'sA' }]));
    const roadId = Object.keys(map.roads)[0]!;
    const physical = commandSupport(map, { type: 'updateRoad', id: roadId, patch: { widthM: { state: 'known', value: 12 } }, designAssumption: { id: 'newSource' } });
    expect(physical.affectedRefs).toContainEqual({ kind: 'sources', id: 'newSource' });
    expect(commandSupport(map, { type: 'addNode', id: 'nNew', node: newNode([1, 2, 0]) }).affectedRefs).toContainEqual({ kind: 'nodes', id: 'nNew' });
  });

  it('keeps frozen transaction impact through undo/redo without adding it to map JSON', () => {
    const session = createSession(fixture(), true), edited = editSession(session, move({ zones: ['Z_005'] }));
    expect(edited.ok).toBe(true);
    const transaction = edited.session.past[0]!;
    expect(Object.isFrozen(transaction.affectedRefs)).toBe(true);
    expect(transaction.affectedRefs.every(Object.isFrozen)).toBe(true);
    expect(transaction.affectedRefs).toEqual(expect.arrayContaining([{ kind: 'zones', id: 'Z_005' }, { kind: 'junctions', id: 'J_N_0035' }, { kind: 'resources', id: 'RES_SP_005_P1' }]));
    expect(transaction.affectedRefs.some(ref => ref.kind === 'slots' && ref.ownerId === 'Z_005')).toBe(true);
    const undone = undoSession(edited.session); expect(undone.future[0]!.affectedRefs).toBe(transaction.affectedRefs);
    expect(redoSession(undone).past[0]!.affectedRefs).toBe(transaction.affectedRefs);
    expect(serializeMap(edited.session.map)).not.toContain('affectedRefs');
  });
  it('includes node-only junctions in preview and locks even when no movements are declared', () => {
    const map = fixture(); map.movements = {};
    expect(validateMap(map).ok).toBe(true);
    const support = commandSupport(map, move({ facilities: ['F_001'] }));
    expect(support.allowed).toBe(true);
    expect(support.impact?.junctionIds).toEqual(['J_N_0012', 'J_N_0013', 'J_N_0014']);
    for (const id of ['J_N_0012', 'J_N_0013', 'J_N_0014']) expect(support.affectedRefs).toContainEqual({ kind: 'junctions', id });
    const after = run(map, move({ facilities: ['F_001'] }));
    expect(after.junctions).toEqual(map.junctions);
    expect(after.nodes.N_0012!.position).toEqual(translate(map.nodes.N_0012!.position));
  });
  it('refuses a supported inverse overlay rather than leave its geometry behind', () => {
    const map = fixture(); map.zones.overlay = { ...newZone(map.facilities.F_001!.boundary), kind: 'forbidden', passability: 'forbidden',
      extensions: { [NS]: { role: 'dock_exclusion', overlayOf: 'F_001', waterSurface: false } } };
    expect(inspectPlanning(map).supported).toBe(true);
    reject(map, move({ facilities: ['F_001'] }), 'STATIC_OVERLAY_DEPENDENCY');
  });
  it('retains the specific planning issue and JSON pointer in the shared import report', () => {
    const map = fixture(); (map.facilities.F_001!.extensions![NS] as Record<string, unknown>).overhang = [[1, 2, 0]];
    const loaded = loadMap(JSON.stringify(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Unsupported extension must remain inspectable');
    expect(loaded.capabilities.editable).toBe(false); expect(loaded.map).toEqual(map);
    expect(loaded.report.issues).toContainEqual(expect.objectContaining({ code: 'PLANNING_UNKNOWN_FIELD', severity: 'warning', entityType: 'facilities', entityId: 'F_001', jsonPath: '/facilities/F_001/extensions/sr02.planning/overhang' }));
  });

});
