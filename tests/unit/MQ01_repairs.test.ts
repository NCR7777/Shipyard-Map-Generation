import { describe, expect, it } from 'vitest';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import { checkMQ01AutomaticSuppression, suppressDegree2Node } from '../../src/domain/topologyEditing';
import { newMap, newNode, newRoad, newServicePoint, newFacility } from '../../src/domain/factory';
import type { Polygon, YardMap } from '../../src/domain/model';
import { roadPoints, roadLength } from '../../src/geometry/roads';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { loadMap } from '../../src/domain/load';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { previewPath } from '../../src/topology/pathPreview';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';

const ns = 'shipyard.reference';
const command: MapCommand = { type: 'suppressDegree2Node', nodeId: 'b', retainedRoadId: 'r', metadataPolicy: 'mq01_reference_corridor' };
function fixture(): YardMap {
  const map = newMap('MQ01', 'synthetic metadata contract test');
  map.extensionNamespaces[ns] = { version: '1.0', category: 'metadata' };
  map.sources.old = { name: 'original', category: 'imagery_derived', description: 'test evidence' };
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([10, 0, 0]); map.nodes.c = newNode([20, 0, 0]);
  for (const [id, from, to, ref] of [['r', 'a', 'b', 'C_HD_000_00'], ['s', 'b', 'c', 'C_HD_000_01']] as const) {
    map.roads[id] = { ...newRoad(from, to), direction: 'both', widthM: { state: 'known', value: 2 },
      extensions: { [ns]: { corridorRef: ref, roadClass: 'main', widthMeaning: 'modeled_paved_corridor_not_certified_net_clearance' } },
      provenance: { category: 'imagery_derived', fieldSources: { shapePoints: 'old' } } };
  }
  map.junctions.j = { name: 'pure continuation', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  for (const forward of [true, false]) map.movements[forward ? 'mf' : 'mb'] = { name: 'through', junctionId: 'j',
    incomingArc: { roadId: forward ? 'r' : 's', direction: forward ? 'forward' : 'backward' },
    outgoingArc: { roadId: forward ? 's' : 'r', direction: forward ? 'forward' : 'backward' },
    allowed: true, resourceIds: [], provenance: { category: 'synthetic' } };
  for (const [id, nodeId] of [['pa', 'a'], ['pc', 'c']] as const) map.servicePoints[id] = { ...newServicePoint(nodeId),
    arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'synthetic external transfer boundary' } };
  return map;
}
function success(map: YardMap, cmd = command) {
  const before = contentHash(map), result = applyMapCommand(map, cmd);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('expected successful transaction');
  expect(contentHash(map)).toBe(before);
  expect(result.map.coordinateFrame).toEqual(map.coordinateFrame);
  return result;
}
function refused(map: YardMap, code: string, cmd = command) {
  const session = createSession(map, true), hash = contentHash(map), result = editSession(session, cmd);
  expect(result.ok).toBe(false); expect(result.session).toBe(session);
  expect(result.issues.map(i => i.code)).toContain(code); expect(contentHash(map)).toBe(hash);
}

describe('MQ01 opt-in adjacent authored corridor cleanup', () => {
  it('checks waiting labels and unknown junction/movement metadata even on generic equal-extension candidates', () => {
    for (const kind of ['nodes', 'junctions', 'movements'] as const) {
      const map = fixture(); map.roads.s!.extensions = structuredClone(map.roads.r!.extensions);
      if (kind === 'nodes') map.nodes.b!.name = '等待点';
      else {
        map.extensionNamespaces['test.semantic'] = { version: '1', category: 'metadata' };
        if (kind === 'junctions') map.junctions.j!.extensions = { 'test.semantic': { requiresStop: true } };
        else map.movements.mf!.extensions = { 'test.semantic': { requiresStop: true } };
      }
      expect(() => checkMQ01AutomaticSuppression(map, 'b')).toThrow(/不能|业务或等待语义/);
      expect(applyMapCommand(map, { type: 'suppressDegree2Node', nodeId: 'b', retainedRoadId: 'r' }).ok).toBe(true);
    }
  });
  it('keeps default rejection, then preserves both directed OD, frame, complete lineage and one undo transaction', () => {
    const map = fixture(); refused(map, 'TOPOLOGY_ROAD_CONFLICT', { type: 'suppressDegree2Node', nodeId: 'b', retainedRoadId: 'r' });
    const before = contentHash(map), session = createSession(map, true), edited = editSession(session, command);
    expect(edited.ok, JSON.stringify(edited.issues)).toBe(true);
    const after = edited.session.map;
    expect(after.roads.r!.shapePoints).toEqual([]); expect(after.nodes.b).toBeUndefined();
    expect(after.roads.r!.extensions).toEqual(map.roads.r!.extensions);
    const source = after.sources.source_mq01_corridor_lineage!;
    const record = JSON.parse(source.description);
    expect(record.intervals.map((v: { extensions: unknown }) => v.extensions)).toEqual([map.roads.r!.extensions, map.roads.s!.extensions]);
    expect(record.intervals.map((v: { startM: number; endM: number }) => [v.startM, v.endM])).toEqual([[0, 10], [10, 20]]);
    expect(record.removedNode).toEqual({ id: 'b', ...map.nodes.b });
    expect(record.removedMovements).toHaveLength(2);
    expect(after.roads.r!.provenance.sourceRefs).toContain('old');
    expect(after.sources.old).toEqual(map.sources.old);
    expect(edited.session.past).toHaveLength(1);
    expect(edited.session.past[0]!.affectedRefs).toContainEqual({ kind: 'sources', id: 'source_mq01_corridor_lineage' });
    for (const [from, to] of [['pa', 'pc'], ['pc', 'pa']]) {
      const a = previewPath(map, { kind: 'servicePoints', id: from! }, { kind: 'servicePoints', id: to! });
      const b = previewPath(after, { kind: 'servicePoints', id: from! }, { kind: 'servicePoints', id: to! });
      expect(a.status).toBe('found'); expect(b.status).toBe('found'); expect(b.confirmed!.lengthM).toBe(a.confirmed!.lengthM);
    }
    expect(contentHash(undoSession(edited.session).map)).toBe(before);
    expect(contentHash(redoSession(undoSession(edited.session)).map)).toBe(contentHash(after));
    const loaded = loadMap(serializeMap(after)); expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(contentHash(loaded.map)).toBe(contentHash(after));
    refused(after, 'TOPOLOGY_NODE_MISSING');
  });
  it('retains bends and backtracking while removing exact between vertices', () => {
    const map = fixture(); map.nodes.b!.position = [10, 5, 0];
    map.roads.r!.shapePoints = [[2, 1, 0], [4, 2, 0], [2, 1, 0]];
    const length = roadLength(map, 'r') + roadLength(map, 's');
    const result = success(map);
    expect(result.map.roads.r!.shapePoints).toEqual([[4, 2, 0], [2, 1, 0], [10, 5, 0]]);
    expect(roadLength(result.map, 'r')).toBeCloseTo(length, 10);
  });
  it.each([
    ['different corridor', (m: YardMap) => { (m.roads.s!.extensions![ns] as Record<string, unknown>).corridorRef = 'C_HD_001_01'; }, 'MQ01_CORRIDOR_ADJACENCY'],
    ['different road class', (m: YardMap) => { (m.roads.s!.extensions![ns] as Record<string, unknown>).roadClass = 'service'; }, 'MQ01_CORRIDOR_ADJACENCY'],
    ['unknown metadata field', (m: YardMap) => { (m.roads.s!.extensions![ns] as Record<string, unknown>).gate = true; }, 'MQ01_REFERENCE_CONTRACT'],
    ['unknown version', (m: YardMap) => { m.extensionNamespaces[ns]!.version = '2'; }, 'MQ01_REFERENCE_CONTRACT'],
    ['labelled ordinary waiting point', (m: YardMap) => { m.nodes.b!.name = '等待点'; }, 'MQ01_NODE_SEMANTICS'],
    ['business node', (m: YardMap) => { m.nodes.b!.kind = 'access'; }, 'MQ01_NODE_SEMANTICS'],
    ['width change', (m: YardMap) => { m.roads.s!.widthM = { state: 'known', value: 3 }; }, 'TOPOLOGY_ROAD_CONFLICT'],
    ['forbidden continuation', (m: YardMap) => { m.movements.mb!.allowed = false; }, 'TOPOLOGY_MOVEMENT_CONFLICT'],
    ['unknown continuation', (m: YardMap) => { delete m.movements.mb; }, 'TOPOLOGY_CONTINUATION_UNDECLARED'],
  ] as const)('atomically rejects %s', (_, modify, code) => { const map = fixture(); modify(map); refused(map, code); });
  it('retains resource boundaries, unknown metadata references, and unchanged old band conflicts', () => {
    const map = fixture();
    map.resources.res = { name: 'junction capacity', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'j' }], provenance: { category: 'synthetic' } };
    refused(map, 'TOPOLOGY_JUNCTION_RESOURCE');
    const opaque = fixture(); opaque.extensionNamespaces['test.other'] = { version: '1', category: 'metadata' }; opaque.extensions['test.other'] = { referencedNode: 'b' };
    refused(opaque, 'TOPOLOGY_OPAQUE_REFERENCE');
    const conflict = fixture(); conflict.zones.z = { name: 'old forbidden', kind: 'forbidden', passability: 'forbidden', resourceIds: [], provenance: { category: 'synthetic' }, boundary: { outer: [[8,-2,0],[12,-2,0],[12,2,0],[8,2,0],[8,-2,0]], holes: [] } };
    const after = success(conflict).map;
    expect(after.zones).toEqual(conflict.zones); expect(roadPoints(after, 'r')).toEqual([[0,0,0],[20,0,0]]);
  });
  it('allocates lineage source past assets, backgrounds and planning slots in pure conversion', () => {
    const map = fixture(), base = 'source_mq01_corridor_lineage';
    map.assets[base] = { path: 'image.png', sha256: '0'.repeat(64), mediaType: 'image/png', sourceRef: 'old' };
    map.backgroundLayers[base + '_1'] = { name: 'reference', assetId: base, pixelConvention: 'top_left_x_right_y_down_exif_normalized', imageToWorld: [1,0,0,-1,0,0], method: 'manual', controlPoints: [], provenance: { category: 'synthetic' } };
    map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    const boundary: Polygon = { outer: [[30,30,0],[32,30,0],[32,32,0],[30,32,0],[30,30,0]], holes: [] };
    map.facilities.owner = newFacility(boundary);
    map.facilities.owner.extensions = { 'sr02.planning': { role: 'yard', dimensionBasis: 'synthetic', slotGapM: 0, slotLengthM: 2, slotWidthM: 2, transportAisleWidthM: 3, slots: [{ id: base + '_2', boundary }], storageResourceId: 'storage' } };
    map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 4 }, controlModel: 'shared_capacity', appliesTo: [{ entityType: 'facilities', entityId: 'owner' }], provenance: { category: 'synthetic' }, extensions: { 'sr02.planning': { slotAreaM2: 4, slotIds: [base + '_2'], unitMeaning: 'cargo_storage_area' } } };
    const protectedData = structuredClone({ assets: map.assets, backgrounds: map.backgroundLayers, owner: map.facilities.owner, storage: map.resources.storage });
    suppressDegree2Node(map, 'b', 'r', 'mq01_reference_corridor');
    expect(map.sources[base + '_3']?.category).toBe('design_assumption');
    expect({ assets: map.assets, backgrounds: map.backgroundLayers, owner: map.facilities.owner, storage: map.resources.storage }).toEqual(protectedData);
  });
  it('joins the real Hanwha three-segment chain after the retained label loses numeric adjacency', async () => {
    const target = GA01_TARGETS.find(t => t.id === 'hanwha_v02')!, map = await readGA01Target(target);
    const first = success(map, { type: 'suppressDegree2Node', nodeId: 'N_HW_1dd316cb26', retainedRoadId: 'R_HW_ac66bc3799', metadataPolicy: 'mq01_reference_corridor' });
    const second = success(first.map, { type: 'suppressDegree2Node', nodeId: 'N_HW_055706ff36', retainedRoadId: 'R_HW_ac66bc3799', metadataPolicy: 'mq01_reference_corridor' });
    expect(second.map.resources).toEqual(map.resources);
    const ids = ['R_HW_ac66bc3799', 'R_HW_735d4c0c8b', 'R_HW_0db2acf059'];
    expect(roadLength(second.map, ids[0]!)).toBeCloseTo(ids.reduce((sum, id) => sum + roadLength(map, id), 0), 9);
    for (const [id, source] of Object.entries(first.map.sources)) expect(second.map.sources[id]).toEqual(source);
    const historySources = Object.values(second.map.sources).filter(source => source.name === 'MQ01 同走廊相邻区间表示整理');
    expect(historySources).toHaveLength(2);
    expect(contentHash(await readGA01Target(target))).toBe(target.contentHash);
  });
  it('applies the real frozen Hudong adjacent-corridor candidate and preserves its resource declarations', async () => {
    const target = GA01_TARGETS.find(t => t.id === 'hudong_v02')!, map = await readGA01Target(target);
    const result = success(map, { type: 'suppressDegree2Node', nodeId: 'N_HD_c684c85bce', retainedRoadId: 'R_HD_b5926a655c', metadataPolicy: 'mq01_reference_corridor' });
    expect(result.map.resources).toEqual(map.resources);
    expect(result.map.roads.R_HD_3e6eee9943).toBeUndefined();
    expect(result.map.roads.R_HD_b5926a655c!.shapePoints).toContainEqual(map.nodes.N_HD_c684c85bce!.position);
    expect(roadLength(result.map, 'R_HD_b5926a655c')).toBeCloseTo(roadLength(map, 'R_HD_b5926a655c') + roadLength(map, 'R_HD_3e6eee9943'), 9);
    expect(contentHash(await readGA01Target(target))).toBe(target.contentHash);
  });
});
