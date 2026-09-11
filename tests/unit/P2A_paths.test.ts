import { describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { ArcRef, ServicePoint, YardMap } from '../../src/domain/model';
import { newMap } from '../../src/domain/factory';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { validateMap } from '../../src/validation/validate';
import { testFacility } from '../helpers/M2A_fixtures';
import { previewPath, type PathEndpoint } from '../../src/topology/pathPreview';
import { testNode } from '../helpers/M1_fixtures';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

const from: PathEndpoint = { kind: 'servicePoints', id: 'sFrom' };
const to: PathEndpoint = { kind: 'servicePoints', id: 'sTo' };
const ref = (roadId: string, direction: ArcRef['direction'] = 'forward'): ArcRef => ({ roadId, direction });
function service(nodeId: string): ServicePoint {
  return { name: nodeId, kind: 'other', nodeId, resourceIds: [], provenance: { category: 'synthetic' },
    arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'fault_injected synthetic graph: business completion is outside the test' } };
}
function road(map: YardMap, id: string, a: string, b: string, direction: 'forward' | 'both' | 'unknown' = 'forward'): void {
  map.roads[id] = { name: id, fromNodeId: a, toNodeId: b, shapePoints: [], direction,
    widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' }, massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' },
    resourceIds: [], provenance: { category: 'synthetic' } };
}
function turn(map: YardMap, id: string, incomingArc: ArcRef, outgoingArc: ArcRef, allowed = true): void {
  const r = map.roads[incomingArc.roadId]!;
  const node = incomingArc.direction === 'forward' ? r.toNodeId : r.fromNodeId;
  map.junctions['j' + node] = { name: node, nodeIds: [node], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements[id] = { name: id, junctionId: 'j' + node, incomingArc, outgoingArc, allowed, resourceIds: [], provenance: { category: 'synthetic' } };
}
function fixture(): YardMap {
  const map = newMap('map_fault_injected_P2A', 'fault_injected synthetic path tests');
  map.nodes.nS = testNode('S', 0); map.nodes.nJ = testNode('J', 10); map.nodes.nT = testNode('T', 20);
  road(map, 'rSJ', 'nS', 'nJ'); road(map, 'rJT', 'nJ', 'nT');
  map.servicePoints.sFrom = service('nS'); map.servicePoints.sTo = service('nT');
  turn(map, 'mST', ref('rSJ'), ref('rJT'));
  return map;
}

describe('P2A declared incoming-arc path preview (read-only)', () => {
  it('returns ordered derived geometry, stable hash, and no map mutation or shared arrays', () => {
    const map = fixture(); map.roads.rSJ!.shapePoints = [[5, 3, 0]];
    const before = JSON.stringify(map); const result = previewPath(map, from, to);
    expect(result.status).toBe('found'); expect(result.mapContentHash).toBe(contentHash(map));
    expect(result.confirmed?.arcs).toEqual([ref('rSJ'), ref('rJT')]);
    expect(result.confirmed?.lengthM).toBeCloseTo(2 * Math.hypot(5, 3) + 10, 12);
    expect(result.confirmed?.points).toEqual([[0, 0, 0], [5, 3, 0], [10, 0, 0], [20, 0, 0]]);
    expect(result.unchecked).toContain('resource_execution'); expect(result.unchecked).toContain('vehicle_swept_path');
    result.confirmed!.points[0]![0] = 999; result.confirmed!.arcs[0]!.roadId = 'changed';
    expect(JSON.stringify(map)).toBe(before);
    map.nodes.nT!.position[0] = 25;
    expect(previewPath(map, from, to).mapContentHash).not.toBe(result.mapContentHash);
  });
  it('fault_injected missing turn is candidate-only, not an implicit permission', () => {
    const map = fixture(); map.movements = {};
    const result = previewPath(map, from, to);
    expect(result.status).toBe('unconfirmed'); expect(result.confirmed).toBeNull();
    expect(result.candidate?.lengthM).toBe(20); expect(result.candidate?.assumptions.join(' ')).toContain('转向');
  });
  it('fault_injected unknown direction cannot enter the confirmed graph', () => {
    const map = fixture(); map.roads.rJT!.direction = 'unknown';
    const result = previewPath(map, from, to);
    expect(result.status).toBe('unconfirmed'); expect(result.candidate?.arcs).toEqual([ref('rSJ'), ref('rJT')]);
    expect(result.candidate?.assumptions.join(' ')).toContain('rJT');
    map.junctions.jnJ!.model = 'unknown';
    expect(previewPath(map, from, to).status).toBe('unconfirmed');
  });
  it('fault_injected explicit prohibition defeats even an unknown junction model', () => {
    const map = fixture(); map.movements.mST!.allowed = false; map.junctions.jnJ!.model = 'unknown';
    const result = previewPath(map, from, to);
    expect(result.status).toBe('disconnected'); expect(result.candidate).toBeNull();
  });
  it('fault_injected disconnected topology never connects coincident coordinates', () => {
    const map = fixture(); map.nodes.nCoincident = testNode('same xy different ID', 10);
    map.roads.rJT!.fromNodeId = 'nCoincident'; map.movements = {};
    const result = previewPath(map, from, to);
    expect(result.status).toBe('disconnected'); expect(result.confirmed).toBeNull();
  });
  it('fault_injected two incoming arcs retain the longer arrival with a permitted next turn', () => {
    const map = fixture(); map.nodes.nU = testNode('detour', 0, 10);
    road(map, 'rSU', 'nS', 'nU'); road(map, 'rUJ', 'nU', 'nJ');
    map.movements.mST!.allowed = false;
    turn(map, 'mSUJ', ref('rSU'), ref('rUJ')); turn(map, 'mUJT', ref('rUJ'), ref('rJT'));
    const result = previewPath(map, from, to);
    expect(result.status).toBe('found'); expect(result.confirmed?.arcs).toEqual([ref('rSU'), ref('rUJ'), ref('rJT')]);
    expect(result.confirmed?.lengthM).toBeCloseTo(20 + Math.hypot(10, 10), 12);
  });
  it('can report a shorter uncertain candidate alongside a longer confirmed route', () => {
    const map = fixture(); map.nodes.nU = testNode('detour', 0, 10); map.movements = {};
    road(map, 'rSU', 'nS', 'nU'); road(map, 'rUJ', 'nU', 'nJ');
    turn(map, 'mSUJ', ref('rSU'), ref('rUJ')); turn(map, 'mUJT', ref('rUJ'), ref('rJT'));
    const result = previewPath(map, from, to);
    expect(result.status).toBe('found'); expect(result.confirmed!.lengthM).toBeGreaterThan(result.candidate!.lengthM);
    expect(result.candidate?.arcs).toEqual([ref('rSJ'), ref('rJT')]);
  });
  it('fault_injected target internalPath is mandatory even when a shorter road reaches its node', () => {
    const map = fixture(); map.nodes.nI = testNode('internal target', 20, 10);
    road(map, 'rTI', 'nT', 'nI'); road(map, 'rShortcut', 'nS', 'nI');
    map.servicePoints.sTo!.nodeId = 'nI';
    map.servicePoints.sTo!.arrival = { mode: 'explicit_internal', entryNodeId: 'nT', internalPath: [ref('rTI')] };
    turn(map, 'mJTI', ref('rJT'), ref('rTI'));
    const result = previewPath(map, from, to);
    expect(result.status).toBe('found'); expect(result.confirmed?.arcs).toEqual([ref('rSJ'), ref('rJT'), ref('rTI')]);
    expect(result.confirmed?.lengthM).toBe(30);
    map.movements.mJTI!.allowed = false;
    expect(previewPath(map, from, to).status).toBe('disconnected');
  });
  it('fault_injected source departure uses actual directions and explicit turns without adding an exit', () => {
    const map = fixture(); map.nodes.nI = testNode('internal source', 0, 10);
    road(map, 'rSI', 'nS', 'nI', 'both'); map.servicePoints.sFrom!.nodeId = 'nI';
    map.servicePoints.sFrom!.arrival = { mode: 'explicit_internal', entryNodeId: 'nS', internalPath: [ref('rSI')] };
    turn(map, 'mISJ', ref('rSI', 'backward'), ref('rSJ'));
    expect(previewPath(map, from, to).confirmed?.arcs).toEqual([ref('rSI', 'backward'), ref('rSJ'), ref('rJT')]);
    map.roads.rSI!.direction = 'forward';
    expect(previewPath(map, from, to).status).toBe('disconnected');
    map.roads.rSI!.direction = 'unknown';
    expect(previewPath(map, from, to).status).toBe('unconfirmed');
  });
  it('fault_injected one-way arrival and a different explicit exit do not become a false disconnection', () => {
    const map = fixture(); map.nodes.nI = testNode('internal source', 0, 10);
    road(map, 'rSI', 'nS', 'nI'); road(map, 'rExit', 'nI', 'nJ');
    map.servicePoints.sFrom!.nodeId = 'nI';
    map.servicePoints.sFrom!.arrival = { mode: 'explicit_internal', entryNodeId: 'nS', internalPath: [ref('rSI')] };
    turn(map, 'mExit', ref('rExit'), ref('rJT'));
    expect(validateMap(map).ok).toBe(true);
    const result = previewPath(map, from, to);
    expect(result.status).toBe('found'); expect(result.confirmed?.arcs).toEqual([ref('rExit'), ref('rJT')]);
    expect(result.confirmed?.lengthM).toBeCloseTo(Math.hypot(10, 10) + 10, 12);
    expect(result.confirmed?.assumptions.join(' ')).toContain('仅声明到达');
  });
  it('fault_injected multi-arc internal suffix checks its own turn rules', () => {
    const map = fixture();
    map.servicePoints.sTo!.arrival = { mode: 'explicit_internal', entryNodeId: 'nS', internalPath: [ref('rSJ'), ref('rJT')] };
    expect(previewPath(map, from, to).confirmed?.lengthM).toBe(20);
    map.movements.mST!.allowed = false;
    expect(previewPath(map, from, to).status).toBe('disconnected');
    map.movements = {};
    expect(previewPath(map, from, to).status).toBe('unconfirmed');
  });
  it('same authoritative node is zero displacement, including explicit-internal services, not completed work', () => {
    const map = fixture(); map.servicePoints.sTo!.arrival = { mode: 'explicit_internal', entryNodeId: 'nS', internalPath: [ref('rSJ'), ref('rJT')] };
    const same = previewPath(map, to, to);
    expect(same.status).toBe('found'); expect(same.confirmed?.lengthM).toBe(0); expect(same.confirmed?.arcs).toEqual([]);
    expect(same.confirmed?.assumptions.join(' ')).toContain('不表示已完成');
    map.servicePoints.sFrom = service('nT');
    expect(previewPath(map, from, to).confirmed?.lengthM).toBe(0);
  });
  it('supports explicit access-point endpoints without guessing facility centers', () => {
    const map = fixture(); map.facilities.fA = testFacility(); map.facilities.fA.accessPointIds = ['aFrom']; map.accessPoints.aFrom = { name: 'entrance', facilityId: 'fA', nodeId: 'nS', provenance: { category: 'synthetic' } };
    expect(previewPath(map, { kind: 'accessPoints', id: 'aFrom' }, to).confirmed?.lengthM).toBe(20);
    expect(previewPath(map, { kind: 'accessPoints', id: 'missing' }, to).status).toBe('not_checked');
  });
  it('fault_injected undeclared or malformed service arrival is not silently treated as proxy', () => {
    const map = fixture(); delete map.servicePoints.sTo!.arrival;
    expect(previewPath(map, from, to).status).toBe('not_checked');
    map.servicePoints.sTo!.arrival = { mode: 'explicit_internal', entryNodeId: 'nS', internalPath: [ref('rJT')] };
    const result = previewPath(map, from, to);
    expect(result.status).toBe('not_checked'); expect(result.issues.some(i => i.jsonPath.includes('/arrival/internalPath/0'))).toBe(true);
  });
  it('fault_injected unknown behavior globally blocks preview, including a zero-distance request', () => {
    const map = fixture(); map.extensionNamespaces['future.routing'] = { category: 'behavior', version: '1' };
    map.extensions['future.routing'] = { teleporter: true };
    const result = previewPath(map, from, from);
    expect(result.status).toBe('not_checked'); expect(result.issues.at(-1)?.jsonPath).toBe('/extensionNamespaces/future.routing');
    map.extensionNamespaces['future.routing']!.category = 'metadata';
    expect(previewPath(map, from, to).status).toBe('found');
  });
  it('fault_injected movement geometry or multi-node transfer never draws a teleport', () => {
    const map = fixture(); map.movements.mST!.internalPath = [[9, 0, 0], [11, 0, 0]];
    expect(previewPath(map, from, to).status).toBe('not_checked');
    delete map.movements.mST!.internalPath; map.nodes.nOther = testNode('other node', 11);
    map.roads.rJT!.fromNodeId = 'nOther'; map.junctions.jnJ!.nodeIds.push('nOther');
    const result = previewPath(map, from, to);
    expect(result.status).toBe('not_checked'); expect(result.candidate).toBeNull();
    map.movements = {};
    expect(previewPath(map, from, to).issues.at(-1)?.code).toBe('PATH_JUNCTION_TRANSITION_UNSUPPORTED');
  });
  it('fault_injected excessive graph or nonfinite length reports not_checked, never disconnected', () => {
    const map = fixture(); map.nodes.nS!.position[0] = -Number.MAX_VALUE; map.nodes.nJ!.position[0] = Number.MAX_VALUE;
    expect(previewPath(map, from, to).issues.at(-1)?.code).toBe('PATH_GEOMETRY_UNSUPPORTED');
    const large = fixture(); for (let n = 0; n < 2000; n++) road(large, 'rExtra' + n, 'nS', 'nJ');
    expect(previewPath(large, from, to).issues.at(-1)?.code).toBe('PATH_COMPLEXITY_LIMIT');
  });
});

describe('frozen original SR03 maps, not fault-injected substitutions', () => {
  for (const original of P1_TARGETS.filter(target => target.family === 'SR03')) {
    it(`${original.id} computes the first two declared service endpoints and preserves the original`, async () => {
      const { map } = await readP1Target(original); const before = JSON.stringify(map);
      const ids = Object.keys(map.servicePoints).sort();
      const result = previewPath(map, { kind: 'servicePoints', id: ids[0]! }, { kind: 'servicePoints', id: ids[1]! });
      expect(result.status).toBe('found');
      const lengths = { A: [78.5, 78.5], B: [283.5, 283.5], C: [544.5, 544.5], D: [570, 570] }[original.yard];
      expect(result.confirmed?.lengthM).toBe(lengths[0]); expect(result.candidate?.lengthM).toBe(lengths[1]);
      expect(result.mapContentHash).toBe(contentHash(map)); expect(JSON.stringify(map)).toBe(before);
      const owners = new Set(ids.slice(0, 2).map(id => map.servicePoints[id]!.facilityId ?? map.servicePoints[id]!.zoneId));
      for (const arc of result.candidate?.arcs ?? []) {
        const payload = map.roads[arc.roadId]!.extensions?.['sr02.planning'] as { ownerEntityId?: string } | undefined;
        if (payload?.ownerEntityId) expect(owners.has(payload.ownerEntityId)).toBe(true);
      }
      console.info(JSON.stringify({ original: original.id, fileSha256: original.sha256, from: ids[0], to: ids[1], status: result.status,
        confirmedLengthM: result.confirmed?.lengthM ?? null, candidateLengthM: result.candidate?.lengthM ?? null }));
    });
  }
});


describe('named fault-injected SR03_A clones; original is never overwritten', () => {
  it('isolates real facility connectors, bans departure turns, distinguishes invalid references and writes review fixtures', async () => {
    const original = P1_TARGETS.find(t => t.id === 'SR03_A')!;
    const { map, text } = await readP1Target(original);
    const cases: Array<{ name: string; map: YardMap; valid: boolean; expected: string; description: string }> = [];
    const clone = (name: string): YardMap => {
      const value = structuredClone(map); value.mapId = 'P2A_fault_' + name; value.metadata.name = 'P2A_fault_' + name + ' synthetic test clone';
      value.extensionNamespaces['org.shipyard.p2a_fault'] = { version: '1', category: 'metadata' };
      value.extensions['org.shipyard.p2a_fault'] = { originalFileSha256: original.sha256, originalMapId: map.mapId, purpose: 'fault_injected verification only, not corrected shipyard data' };
      return value;
    };
    const cut = clone('SR03_A_disconnected');
    for (const [roadId, field, oldNode, newNode, junctionId] of [
      ['R_0008', 'fromNodeId', 'N_0011', 'N_P2A_CUT_IN', 'J_N_0011'],
      ['R_0011', 'toNodeId', 'N_0015', 'N_P2A_CUT_OUT', 'J_N_0015'],
    ] as const) {
      cut.nodes[newNode] = { ...structuredClone(cut.nodes[oldNode]!), name: 'fault_injected disconnected same-coordinate anchor' };
      cut.roads[roadId]![field] = newNode;
      // Remove only rules at the old public anchor referring to the now detached connector.
      for (const [id, movement] of Object.entries(cut.movements))
        if (movement.junctionId === junctionId && [movement.incomingArc.roadId, movement.outgoingArc.roadId].includes(roadId)) delete cut.movements[id];
    }
    cases.push({ name: 'SR03_A_disconnected', map: cut, valid: true, expected: 'disconnected', description: 'Both F_001 public connector endpoints use new IDs at identical coordinates; obsolete anchor turn rules removed. No geometry-based reconnection.' });
    const banned = clone('SR03_A_forbidden_turn');
    const suffixArc = ref('R_0013');
    let sequence = 0;
    for (const [id, r] of Object.entries(banned.roads)) {
      const incoming: ArcRef | undefined = r.toNodeId === 'N_0016' ? ref(id) : r.fromNodeId === 'N_0016' ? ref(id, 'backward') : undefined;
      if (!incoming) continue;
      const rules = Object.values(banned.movements).filter(m => m.incomingArc.roadId === incoming.roadId && m.incomingArc.direction === incoming.direction && m.outgoingArc.roadId === suffixArc.roadId && m.outgoingArc.direction === suffixArc.direction);
      if (rules.length) for (const rule of rules) rule.allowed = false;
      else banned.movements['M_P2A_BAN_' + sequence++] = { name: 'fault_injected prohibit target arrival turn', junctionId: 'J_N_0016', incomingArc: incoming,
        outgoingArc: suffixArc, allowed: false, resourceIds: [], provenance: { category: 'synthetic' } };
    }
    cases.push({ name: 'SR03_A_forbidden_turn', map: banned, valid: true, expected: 'disconnected', description: 'Every turn from an incoming arc at the destination entry into its mandatory arrival suffix is explicitly prohibited, including a reversal.' });
    const unknown = clone('SR03_A_unknown_direction'); unknown.roads.R_0009!.direction = 'unknown'; unknown.roads.R_0010!.direction = 'unknown';
    cases.push({ name: 'SR03_A_unknown_direction', map: unknown, valid: true, expected: 'unconfirmed', description: 'Both incident source roads have unknown directions, so no initial departure arc is confirmed.' });
    const invalid = clone('SR03_A_invalid_reference'); delete invalid.roads.R_0009;
    cases.push({ name: 'SR03_A_invalid_reference', map: invalid, valid: false, expected: 'not_checked', description: 'Intentional dangling movement/service/resource references; must be rejected by import, not called disconnected.' });
    const dir = fileURLToPath(new URL('../../.cache/P2A/faults/', import.meta.url)); await mkdir(dir, { recursive: true });
    const endpointFrom: PathEndpoint = { kind: 'servicePoints', id: 'SP_001' }; const endpointTo: PathEndpoint = { kind: 'servicePoints', id: 'SP_002' };
    for (const entry of cases) {
      const validation = validateMap(entry.map); const report = previewPath(entry.map, endpointFrom, endpointTo);
      expect(validation.ok, entry.name + ': ' + validation.issues.filter(i => i.severity === 'error').map(i => i.code + ' ' + i.jsonPath).join(',')).toBe(entry.valid);
      expect(report.status, entry.name).toBe(entry.expected);
      await writeFile(dir + '/P2A_fault_' + entry.name + '.map.json', entry.valid ? serializeMap(entry.map) : JSON.stringify(entry.map, null, 2) + '\n', 'utf8');
      await writeFile(dir + '/P2A_fault_' + entry.name + '.report.json', JSON.stringify({ originalFileSha256: original.sha256, faultInjected: true, description: entry.description, validation, path: report }, null, 2) + '\n', 'utf8');
    }
    expect((await readP1Target(original)).text).toBe(text);
  });
});
