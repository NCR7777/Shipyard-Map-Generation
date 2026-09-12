import { describe, expect, it, vi } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { mapCapabilities } from '../../src/domain/capabilities';
import { newMap, newNode, newRoad, newFacility, newAccessPoint, newServicePoint } from '../../src/domain/factory';
import { sameValue } from '../../src/domain/value';
import { recordGeometrySources } from '../../src/domain/geometrySources';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { serializeMap, parseMap } from '../../src/domain/serialization';
import { validateMap } from '../../src/validation/validate';
import { rectangle, missingBackgroundFixture } from '../helpers/M2A_fixtures';
import type { YardMap } from '../../src/domain/model';

function fixture(anchor = true): YardMap {
  const map = newMap('GA01_test', 'synthetic GA01 test');
  if (anchor) map.coordinateFrame.geographicAnchor = { crs: 'EPSG:32651', coordinateOrder: 'E,N,Z', origin: [-123.456, 987.654, 23], rotationRad: 0.37, method: 'unverified reference' };
  map.sources.image = { name: 'Synthetic image record', category: 'imagery_derived', description: 'Fixture only' };
  map.nodes.a = newNode([-4, -3, 2]); map.nodes.b = newNode([20, -3, 2]);
  map.nodes.a.provenance = { category: 'imagery_derived', sourceRefs: ['image'], fieldSources: { position: 'image' } };
  map.roads.road = newRoad('a', 'b');
  return map;
}
function apply(map: YardMap, command: MapCommand) {
  const result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Command unexpectedly failed');
  return result;
}
function staticFixture() {
  const map = fixture();
  map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
  map.facilities.owner = newFacility(rectangle(-10, -10, 40, 20));
  map.facilities.owner.extensions = { 'sr02.planning': {
    role: 'yard', dimensionBasis: 'synthetic', slotGapM: 0, slotLengthM: 2, slotWidthM: 2, transportAisleWidthM: 3,
    slots: [{ id: 'slot', boundary: rectangle(0, 0, 2, 2) }], storageResourceId: 'storage',
  } };
  map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 4 }, controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'owner' }], provenance: { category: 'synthetic' },
    extensions: { 'sr02.planning': { slotAreaM2: 4, slotIds: ['slot'], unitMeaning: 'cargo_storage_area' } } };
  map.roads.road!.extensions = { 'sr02.planning': { role: 'internal', physicalMeaning: 'design_declared_corridor_not_surveyed_clearance', ownerEntityId: 'owner' } };
  map.roads.road!.shapePoints = [[5, -3, 2]];
  map.junctions.junction = { name: 'junction', nodeIds: ['a'], model: 'unknown', boundary: rectangle(-5, -4, 2, 2), resourceIds: [], provenance: { category: 'synthetic' } };
  return map;
}

describe('GA01 fixed coordinate frame and atomic geometry provenance', () => {
  it('compares the whole JSON value exactly while ignoring object key order', () => {
    expect(sameValue({ a: [1, 2], b: 3 }, { b: 3, a: [1, 2] })).toBe(true);
    expect(sameValue({ a: [1, 2] }, { a: [2, 1] })).toBe(false);
    const frame = fixture().coordinateFrame;
    for (const change of [{ crs: 'EPSG:32652' }, { coordinateOrder: 'N,E,Z' }, { origin: [0, 0, 0] }, { rotationRad: 0 }, { method: 'changed' }]) {
      expect(sameValue(frame, { ...frame, geographicAnchor: { ...frame.geographicAnchor, ...change } })).toBe(false);
    }
  });
  it.each([false, true])('keeps supported local edits and all frame fields intact (anchor=%s)', anchor => {
    const map = fixture(anchor), original = structuredClone(map);
    expect(mapCapabilities(map).editable).toBe(true);
    if (anchor) expect(mapCapabilities(map).unchecked).toContain('geographic_reprojection');
    const result = apply(map, { type: 'updateNode', id: 'a', patch: { position: [-7, -8, 5] } });
    expect(result.map.coordinateFrame).toEqual(original.coordinateFrame); expect(map).toEqual(original);
    expect(result.map.nodes.a!.provenance).toEqual({ category: 'imagery_derived', sourceRefs: ['image', 'source_editor_geometry'], fieldSources: { position: 'source_editor_geometry' } });
    expect(result.map.roads.road).toEqual(map.roads.road);
    expect(result.transaction?.affectedRefs).toContainEqual({ kind: 'sources', id: 'source_editor_geometry' });
    expect(result.map.sources.image).toEqual(map.sources.image);
    expect(result.map.sources.source_editor_geometry?.category).toBe('design_assumption');
  });
  it('retains behavior, visual, unsupported planning, asset and background blocks with an anchor', () => {
    for (const category of ['behavior', 'visual'] as const) {
      const map = fixture(); map.extensionNamespaces.future = { category, version: '1' };
      expect(mapCapabilities(map).editable).toBe(false);
    }
    const planning = fixture(); planning.extensionNamespaces['sr02.planning'] = { category: 'behavior', version: 'unknown' };
    expect(mapCapabilities(planning).editable).toBe(false);
    const assets = missingBackgroundFixture(); assets.coordinateFrame = fixture().coordinateFrame;
    expect(mapCapabilities(assets).reasons).toEqual(expect.arrayContaining([expect.stringContaining('assets'), expect.stringContaining('backgroundLayers')]));
    expect(commandSupport(assets, { type: 'renameMap', name: 'blocked' }).allowed).toBe(false);
  });
  it('retains advanced operation protection in A', () => {
    const map = staticFixture();
    expect(commandSupport(map, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 0] } }).allowed).toBe(false);
    expect(commandSupport(map, { type: 'deleteSelection', selection: { nodes: [], roads: ['road'] } }).allowed).toBe(false);
  });
  it('rejects field injection, invalid frames and unexpected internal frame changes without committing', () => {
    const map = fixture(), original = structuredClone(map);
    const injected = { type: 'updateNode', id: 'a', patch: { position: [1, 2, 3], coordinateFrame: {} } } as unknown as MapCommand;
    expect(applyMapCommand(map, injected).ok).toBe(false);
    const invalid = structuredClone(map); invalid.coordinateFrame.geographicAnchor!.origin[0] = NaN;
    expect(applyMapCommand(invalid, { type: 'renameMap', name: 'x' }).ok).toBe(false);
    const clone = globalThis.structuredClone;
    const spy = vi.spyOn(globalThis, 'structuredClone').mockImplementationOnce(value => {
      const candidate = clone(value) as YardMap; candidate.coordinateFrame.geographicAnchor!.rotationRad += 1; return candidate;
    });
    try {
      const result = applyMapCommand(map, { type: 'renameMap', name: 'changed' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.issues[0]?.code).toBe('COORDINATE_FRAME_LOCKED');
    } finally { spy.mockRestore(); }
    expect(map).toEqual(original);
  });
  it('makes source IDs globally unique and reuses its own source across later edits', () => {
    const map = fixture(); map.nodes.source_editor_geometry = newNode([30, 30, 0]);
    map.sources.source_editor_geometry_1 = { name: 'other', category: 'synthetic', description: 'must stay unchanged' };
    const first = apply(map, { type: 'updateNode', id: 'a', patch: { position: [1, 2, 3] } });
    expect(first.map.nodes.a!.provenance.fieldSources?.position).toBe('source_editor_geometry_2');
    const second = apply(first.map, { type: 'updateRoad', id: 'road', patch: { shapePoints: [[5, 2, 3]] } });
    expect(second.map.roads.road!.provenance.fieldSources?.shapePoints).toBe('source_editor_geometry_2');
    expect(Object.keys(second.map.sources)).toEqual(Object.keys(first.map.sources));
    expect(second.map.sources.source_editor_geometry_1).toEqual(map.sources.source_editor_geometry_1);
  });
  it('attributes copied reference geometry to the mapped copies without rewriting the source entities', () => {
    const map = fixture();
    map.roads.road!.shapePoints = [[5, -2, 2]];
    map.roads.road!.provenance = { category: 'imagery_derived', sourceRefs: ['image'], fieldSources: { shapePoints: 'image' } };
    map.facilities.owner = newFacility(rectangle(0, 10, 20, 20));
    map.facilities.owner.provenance = { category: 'imagery_derived', sourceRefs: ['image'], fieldSources: { boundary: 'image' } };
    const result = apply(map, { type: 'duplicateSelection', selection: { nodes: [], roads: ['road'], facilities: ['owner'] }, idMap: { a: 'copy_a', b: 'copy_b', road: 'copy_road', owner: 'copy_owner' }, delta: [10, 20, 0] });
    expect(result.map.nodes.a).toEqual(map.nodes.a); expect(result.map.roads.road).toEqual(map.roads.road); expect(result.map.facilities.owner).toEqual(map.facilities.owner);
    expect(result.map.nodes.copy_a!.provenance.fieldSources?.position).toBe('source_editor_geometry');
    expect(result.map.roads.copy_road!.provenance.fieldSources?.shapePoints).toBe('source_editor_geometry');
    expect(result.map.facilities.copy_owner!.provenance.fieldSources?.boundary).toBe('source_editor_geometry');
    expect(result.map.facilities.copy_owner!.provenance.category).toBe('imagery_derived');
    expect(result.transaction?.affectedRefs).toContainEqual({ kind: 'facilities', id: 'copy_owner' });
    expect(result.map.coordinateFrame).toEqual(map.coordinateFrame);
  });
  it.each([0, 10])('includes copied entrance and service IDs in the complete transaction (offset=%s)', offset => {
    const map = fixture();
    map.facilities.owner = newFacility(rectangle(-10, -10, 40, 20));
    map.accessPoints.entry = newAccessPoint('owner', 'a');
    map.servicePoints.service = newServicePoint('b', 'arrival', 'loading', 'owner', 'entry');
    map.facilities.owner.accessPointIds = ['entry']; map.facilities.owner.servicePointIds = ['service'];
    const session = createSession(map, true);
    const command: MapCommand = { type: 'duplicateSelection', selection: { nodes: [], roads: ['road'], facilities: ['owner'] }, idMap: { a: 'copy_a', b: 'copy_b', road: 'copy_road', owner: 'copy_owner', entry: 'copy_entry', service: 'copy_service' }, delta: [offset, 0, 0] };
    const edited = editSession(session, command); expect(edited.ok, JSON.stringify(edited.issues)).toBe(true);
    const after = edited.session.map;
    expect(after.accessPoints.copy_entry!.facilityId).toBe('copy_owner');
    expect(after.servicePoints.copy_service!.nodeId).toBe('copy_b');
    expect(after.servicePoints.copy_service!.accessPointId).toBe('copy_entry');
    const keys = edited.session.past.at(-1)!.affectedRefs.map(ref => ref.kind + '/' + ref.id).sort();
    const expected = ['nodes/a', 'nodes/b', 'roads/road', 'facilities/owner', 'accessPoints/entry', 'servicePoints/service', 'nodes/copy_a', 'nodes/copy_b', 'roads/copy_road', 'facilities/copy_owner', 'accessPoints/copy_entry', 'servicePoints/copy_service'];
    // Existing support may list an owner once for each associated point; compare the exact affected set.
    if (offset) expected.push('sources/source_editor_geometry');
    expect([...new Set(keys)]).toEqual(expected.sort());
    if (!offset) expect(after.sources).toEqual(map.sources);
    else expect(after.nodes.copy_a!.provenance.fieldSources?.position).toBe('source_editor_geometry');
    expect(undoSession(edited.session).map).toEqual(map);
    expect(redoSession(undoSession(edited.session)).map).toEqual(after);
    expect(after.accessPoints.entry).toEqual(map.accessPoints.entry); expect(after.servicePoints.service).toEqual(map.servicePoints.service);
  });
  it('does not add provenance, revision, or history for no-ops and failed transactions', () => {
    const map = fixture(); const session = createSession(map, true);
    for (const command of [
      { type: 'updateNode', id: 'a', patch: { position: [...map.nodes.a!.position] } },
      { type: 'translateSelection', selection: { nodes: ['a'], roads: [] }, delta: [0, 0, 0] },
    ] as MapCommand[]) {
      const result = apply(map, command); expect(result.changed).toBe(false); expect(result.map).toBe(map); expect(result.transaction).toBeUndefined();
      const edited = editSession(session, command); expect(edited.session.past).toHaveLength(0); expect(edited.session.map).toBe(session.map);
    }
    const failed = editSession(session, { type: 'updateNode', id: 'a', patch: { position: [...map.nodes.b!.position] } });
    expect(failed.ok).toBe(false); expect(failed.session).toBe(session); expect(map.sources.source_editor_geometry).toBeUndefined();
  });
  it('attributes static node, road, owner, junction and slot geometry in one history transaction', () => {
    const map = staticFixture(); expect(validateMap(map).ok).toBe(true);
    const session = createSession(map, true);
    const edited = editSession(session, { type: 'translateSelection', selection: { nodes: [], roads: [], facilities: ['owner'] }, delta: [1, 2, 0], facilityMovePolicy: 'withStaticContents' });
    expect(edited.ok, JSON.stringify(edited.issues)).toBe(true);
    const after = edited.session.map;
    for (const [provenance, field] of [[after.nodes.a!.provenance, 'position'], [after.roads.road!.provenance, 'shapePoints'], [after.facilities.owner!.provenance, 'boundary'], [after.junctions.junction!.provenance, 'boundary'], [after.facilities.owner!.provenance, 'extensions/sr02.planning/slots/0/boundary']] as const) {
      expect(provenance.fieldSources?.[field]).toBe('source_editor_geometry');
    }
    expect(after.resources).toEqual(map.resources); expect(after.coordinateFrame).toEqual(map.coordinateFrame);
    expect(undoSession(edited.session).map).toEqual(map);
    expect(redoSession(undoSession(edited.session)).map).toEqual(after);
    expect(parseMap(serializeMap(after))).toEqual({ ok: true, map: after });
  });
  it('avoids planning slot IDs when allocating a source', () => {
    const before = staticFixture();
    const payload = before.facilities.owner!.extensions!['sr02.planning'] as { slots: { id: string }[] };
    payload.slots[0]!.id = 'source_editor_geometry';
    (before.resources.storage!.extensions!['sr02.planning'] as { slotIds: string[] }).slotIds = ['source_editor_geometry'];
    const after = structuredClone(before); after.nodes.a!.position[0] += 1;
    expect(recordGeometrySources(before, after, [{ kind: 'nodes', id: 'a' }])).toEqual([{ kind: 'sources', id: 'source_editor_geometry_1' }]);
  });
  it('preserves the frame and provenance through schema upgrade', () => {
    const map = fixture(); map.schemaVersion = '0.1.0';
    const result = apply(map, { type: 'upgradeSchema', targetVersion: '0.2.0' });
    expect(result.map.coordinateFrame).toEqual(map.coordinateFrame); expect(result.map.sources).toEqual(map.sources);
  });
});
