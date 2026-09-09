import { describe, expect, it } from 'vitest';
import { applyMapCommand, closureSelection, type MapCommand, type Selection } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { validateMap } from '../../src/validation/validate';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { editorFixture, testNode } from '../helpers/M1_fixtures';
import { associatedFixture, missingBackgroundFixture, rectangle, spatialFixture, testFacility, testZone } from '../helpers/M2A_fixtures';

const select = (part: Partial<Selection>): Selection => ({ nodes: [], roads: [], ...part });
function execute(map: YardMap, command: MapCommand) {
  const before = serializeMap(map);
  const result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(serializeMap(map)).toBe(before);
  if (!result.ok) throw new Error('Expected successful command.');
  expect(validateMap(result.map).ok).toBe(true);
  return result;
}
function refused(map: YardMap, command: MapCommand) {
  const session = createSession(map, true);
  const result = editSession(session, command);
  expect(result.ok).toBe(false);
  expect(result.session).toBe(session);
  expect(result.session.past).toHaveLength(0);
  expect(serializeMap(result.session.map)).toBe(serializeMap(map));
  expect(result.issues.some(issue => issue.severity === 'error' && issue.code.length > 0 && issue.suggestedAction.length > 0)).toBe(true);
  return result;
}
const clockwiseHole = (x: number, y: number, size = 10): Polygon['outer'] => [[x, y, 0], [x, y + size, 0], [x + size, y + size, 0], [x + size, y, 0], [x, y, 0]];

describe('M2A independent commands, references and world geometry', () => {
  it('G01 G02 G10 imports existing Schema facilities/zones as editable with independent scene projections in Node', () => {
    expect('document' in globalThis).toBe(false);
    const map = spatialFixture();
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('M2A synthetic fixture rejected.');
    expect(loaded.capabilities.editable).toBe(true);
    expect(loaded.capabilities.unrendered).not.toContain('facilities');
    expect(loaded.capabilities.unrendered).not.toContain('zones');
    expect(loaded.scene.facilities).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fA', boundary: rectangle() })]));
    expect(loaded.scene.zones).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'zA', boundary: testZone().boundary })]));
    expect(loaded.scene.bounds).toEqual({ min: [0, 0, 0], max: [100, 70, 0] });
    loaded.scene.facilities[0]!.boundary.outer[0][0] = -999;
    expect(loaded.map.facilities.fA!.boundary.outer[0]).toEqual([0, 0, 0]);
    expect(loaded.map.accessPoints).toEqual({});
    expect(loaded.map.servicePoints).toEqual({});
  });

  it('G01 preserves all ordered polygon coordinates, identifiers and four-state data over ten JSON round trips', () => {
    const original = associatedFixture();
    const canonical = serializeMap(original);
    let map = original;
    for (let round = 0; round < 10; round++) {
      const loaded = loadMap(serializeMap(map));
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error('M2A round trip failed.');
      map = loaded.map;
      expect(serializeMap(map)).toBe(canonical);
    }
    expect(map).toEqual(original);
    expect(map.facilities.fA!.heightM).toEqual({ state: 'unknown' });
  });

  it('adds facilities and all requested zone categories through transactions without invented physical values', () => {
    let map = editorFixture();
    map = execute(map, { type: 'addFacility', id: 'fA', facility: testFacility() }).map;
    expect(map.facilities.fA!.heightM).toEqual({ state: 'unknown' });
    for (const kind of ['work', 'buffer', 'waiting', 'water', 'obstacle'] as const) {
      map = execute(map, { type: 'addZone', id: 'zone_' + kind, zone: testZone(kind) }).map;
      expect(map.zones['zone_' + kind]!.kind).toBe(kind);
      expect(map.zones['zone_' + kind]!.passability).toBe('unknown');
    }
    expect(map.revision).toBe(6);
  });

  it('G02 adds entrance and service nodes atomically and uses nodeId as their only authoritative position', () => {
    let map = spatialFixture();
    map = execute(map, {
      type: 'addAccessPoint', id: 'aNew',
      accessPoint: { name: '入口', facilityId: 'fA', nodeId: 'nNew', provenance: { category: 'synthetic' } },
      newNode: { id: 'nNew', node: { ...testNode('入口节点', 30), kind: 'access' } },
    }).map;
    expect(map.facilities.fA!.accessPointIds).toEqual(['aNew']);
    map = execute(map, {
      type: 'addServicePoint', id: 'sNew',
      servicePoint: { name: '装卸', kind: 'loading', facilityId: 'fA', accessPointId: 'aNew', nodeId: 'nService', resourceIds: [], provenance: { category: 'synthetic' } },
      newNode: { id: 'nService', node: { ...testNode('服务节点', 20, 10), kind: 'service' } },
    }).map;
    expect(map.facilities.fA!.servicePointIds).toEqual(['sNew']);
    expect(Object.hasOwn(map.accessPoints.aNew!, 'position')).toBe(false);
    expect(Object.hasOwn(map.servicePoints.sNew!, 'position')).toBe(false);
    map = execute(map, { type: 'updateNode', id: 'nService', patch: { position: [25, 15, 0] } }).map;
    expect(toSceneSnapshot(map).servicePoints.find(point => point.id === 'sNew')!.position).toEqual([25, 15, 0]);
    const reloaded = loadMap(serializeMap(map));
    expect(reloaded.ok && reloaded.capabilities.editable).toBe(true);
    if (reloaded.ok) expect(reloaded.map).toEqual(map);
  });

  it('G02 reassigns point ownership and reverse references in one transaction', () => {
    const map = spatialFixture();
    map.facilities.fB = testFacility('另一厂房', rectangle(100, 50));
    map.accessPoints.aA = { name: '入口', facilityId: 'fA', nodeId: 'nA', provenance: { category: 'synthetic' } };
    map.facilities.fA!.accessPointIds = ['aA'];
    const moved = execute(map, { type: 'updateAccessPoint', id: 'aA', patch: { facilityId: 'fB' } }).map;
    expect(moved.accessPoints.aA!.facilityId).toBe('fB');
    expect(moved.facilities.fA!.accessPointIds).toEqual([]);
    expect(moved.facilities.fB!.accessPointIds).toEqual(['aA']);
  });

  it('G02 refuses mismatched service/access facility ownership without partially adding a new node', () => {
    const map = associatedFixture();
    map.facilities.fB = testFacility('另一厂房', rectangle(100, 50));
    refused(map, {
      type: 'addServicePoint', id: 'badService',
      servicePoint: { name: '错误归属', kind: 'loading', facilityId: 'fB', accessPointId: 'aA', nodeId: 'newBadNode', resourceIds: [], provenance: { category: 'synthetic' } },
      newNode: { id: 'newBadNode', node: testNode('不应留下的新节点', 110, 60) },
    });
    expect(Object.hasOwn(map.nodes, 'newBadNode')).toBe(false);
  });

  it('G03 requires an explicit facility move policy before any geometry is changed', () => {
    const map = associatedFixture();
    refused(map, { type: 'translateSelection', selection: select({ facilities: ['fA'] }), delta: [10, 5, 0] });
  });

  it('G03 moves just the boundary when that explicit policy is chosen', () => {
    const map = associatedFixture();
    const result = execute(map, { type: 'translateSelection', selection: select({ facilities: ['fA'] }), delta: [10, 5, 0], facilityMovePolicy: 'boundaryOnly' }).map;
    expect(result.facilities.fA!.boundary.outer[0]).toEqual([10, 5, 0]);
    expect(result.nodes).toEqual(map.nodes);
    expect(roadPoints(result, 'rAB')).toEqual(roadPoints(map, 'rAB'));
    expect(result.accessPoints).toEqual(map.accessPoints);
    expect(result.servicePoints).toEqual(map.servicePoints);
  });

  it('G03 moves associated authoritative nodes once and derives attached road endpoints without translating the remote end', () => {
    const map = associatedFixture();
    const result = execute(map, { type: 'translateSelection', selection: select({ facilities: ['fA'], nodes: ['nA'] }), delta: [10, 5, 0], facilityMovePolicy: 'withAssociatedNodes' }).map;
    expect(result.facilities.fA!.boundary.outer[0]).toEqual([10, 5, 0]);
    expect(result.nodes.nA!.position).toEqual([10, 5, 0]);
    expect(result.nodes.nS!.position).toEqual([25, 15, 0]);
    expect(result.nodes.nB!.position).toEqual([100, 0, 0]);
    expect(roadPoints(result, 'rAB')).toEqual([[10, 5, 0], [100, 0, 0]]);
    expect(roadLength(result, 'rAB')).toBeCloseTo(Math.sqrt(90 * 90 + 5 * 5), 10);
  });

  it('G04 records an entire facility+associated-node move in one history transaction and redoes identical IDs/coordinates', () => {
    const map = associatedFixture();
    const original = createSession(map, true);
    const edited = editSession(original, { type: 'translateSelection', selection: select({ facilities: ['fA'] }), delta: [10, 5, 0], facilityMovePolicy: 'withAssociatedNodes' });
    expect(edited.ok).toBe(true);
    expect(edited.session.past).toHaveLength(1);
    const undone = undoSession(edited.session);
    expect(undone.map).toEqual(map);
    expect(undone.past).toHaveLength(0);
    expect(redoSession(undone).map).toEqual(edited.session.map);
  });

  it('rotates committed world vertices and linked nodes by rad without a second editable transform', () => {
    const map = associatedFixture();
    const rotated = execute(map, { type: 'rotateSelection', selection: select({ facilities: ['fA'] }), pivot: [0, 0, 0], angleRad: Math.PI / 2, facilityMovePolicy: 'withAssociatedNodes' }).map;
    const corner = rotated.facilities.fA!.boundary.outer[1];
    expect(corner[0]).toBeCloseTo(0, 10);
    expect(corner[1]).toBeCloseTo(60, 10);
    expect(rotated.nodes.nS!.position[0]).toBeCloseTo(-10, 10);
    expect(rotated.nodes.nS!.position[1]).toBeCloseTo(15, 10);
    expect(rotated.nodes.nB!.position).toEqual([100, 0, 0]);
    expect(Object.hasOwn(rotated.facilities.fA!, 'rotation')).toBe(false);
  });

  it('G03 copies a facility with points/nodes but never pulls an external road into the copy', () => {
    const map = associatedFixture();
    const selection = select({ facilities: ['fA'] });
    const closure = closureSelection(map, selection);
    expect(closure.facilities).toEqual(['fA']);
    expect(closure.accessPoints).toEqual(['aA']);
    expect(closure.servicePoints).toEqual(['sA']);
    expect(closure.nodes).toEqual(['nA', 'nS']);
    expect(closure.roads).toEqual([]);
    const idMap = { fA: 'fCopy', aA: 'aCopy', sA: 'sCopy', nA: 'nCopy', nS: 'nServiceCopy' };
    const initial = createSession(map, true);
    const edited = editSession(initial, { type: 'duplicateSelection', selection, delta: [0, 100, 0], idMap });
    expect(edited.ok).toBe(true);
    const copy = edited.session.map;
    expect(copy.facilities.fCopy!.accessPointIds).toEqual(['aCopy']);
    expect(copy.facilities.fCopy!.servicePointIds).toEqual(['sCopy']);
    expect(copy.accessPoints.aCopy).toMatchObject({ facilityId: 'fCopy', nodeId: 'nCopy' });
    expect(copy.servicePoints.sCopy).toMatchObject({ facilityId: 'fCopy', nodeId: 'nServiceCopy', accessPointId: 'aCopy' });
    expect(copy.nodes.nCopy!.position).toEqual([0, 100, 0]);
    expect(copy.nodes.nServiceCopy!.position).toEqual([15, 110, 0]);
    expect(copy.roads).toEqual(map.roads);
    expect(copy.nodes.nB).toEqual(map.nodes.nB);
    expect(undoSession(edited.session).map).toEqual(map);
    expect(redoSession(undoSession(edited.session)).map).toEqual(copy);
    expect(validateMap(copy).ok).toBe(true);
  });

  it('G03 rejects a point-only copy unless retaining its external facility is explicitly requested', () => {
    const map = associatedFixture();
    const selection = select({ accessPoints: ['aA'] });
    const command = { type: 'duplicateSelection' as const, selection, delta: [0, 10, 0] as Vec3, idMap: { aA: 'aCopy', nA: 'nCopy' } };
    refused(map, command);
    const result = execute(map, { ...command, associationPolicy: 'retainFacility' }).map;
    expect(result.accessPoints.aCopy).toMatchObject({ facilityId: 'fA', nodeId: 'nCopy' });
    expect(result.facilities.fA!.accessPointIds).toEqual(['aA', 'aCopy']);
    expect(result.roads).toEqual(map.roads);
  });

  it('G03 refuses accidental facility/member deletion, then explicitly removes members while retaining shared road nodes', () => {
    const map = associatedFixture();
    refused(map, { type: 'deleteSelection', selection: select({ facilities: ['fA'] }) });
    refused(map, { type: 'deleteSelection', selection: select({ nodes: ['nA'] }) });
    refused(map, { type: 'deleteSelection', selection: select({ accessPoints: ['aA'] }) });
    const result = execute(map, { type: 'deleteSelection', selection: select({ facilities: ['fA'] }), facilityPolicy: 'withAssociatedPoints', orphanNodes: 'deleteUnused' }).map;
    expect(result.facilities).toEqual({});
    expect(result.accessPoints).toEqual({});
    expect(result.servicePoints).toEqual({});
    expect(Object.hasOwn(result.nodes, 'nS')).toBe(false);
    expect(result.nodes.nA).toEqual(map.nodes.nA);
    expect(result.roads).toEqual(map.roads);
  });

  it('G05 rejects an invalid vertex edit without changing map or history', () => {
    const map = spatialFixture();
    refused(map, { type: 'updateFacility', id: 'fA', patch: { boundary: { outer: [[0, 0, 0], [60, 30, 0], [0, 30, 0], [60, 0, 0], [0, 0, 0]], holes: [] } } });
  });

  it.each([
    ['unclosed', { outer: [[0, 0, 0], [60, 0, 0], [60, 30, 0], [0, 30, 0], [0, 1, 0]], holes: [] }],
    ['duplicate/zero edge', { outer: [[0, 0, 0], [60, 0, 0], [60, 0, 0], [60, 30, 0], [0, 30, 0], [0, 0, 0]], holes: [] }],
    ['self intersection', { outer: [[0, 0, 0], [60, 30, 0], [0, 30, 0], [60, 0, 0], [0, 0, 0]], holes: [] }],
    ['clockwise outer', { outer: [[0, 0, 0], [0, 30, 0], [60, 30, 0], [60, 0, 0], [0, 0, 0]], holes: [] }],
    ['hole outside', { ...rectangle(), holes: [clockwiseHole(70, 10)] }],
    ['hole touches boundary', { ...rectangle(), holes: [clockwiseHole(0, 10)] }],
    ['holes overlap', { ...rectangle(), holes: [clockwiseHole(10, 10), clockwiseHole(15, 10)] }],
    ['holes nested', { ...rectangle(), holes: [clockwiseHole(10, 10), clockwiseHole(12, 12, 3)] }],
  ])('G05 reports structured polygon errors for %s', (_name, boundary) => {
    const map = spatialFixture();
    map.facilities.fA!.boundary = boundary as Polygon;
    const result = validateMap(map);
    expect(result.ok).toBe(false);
    const issue = result.issues.find(item => item.severity === 'error' && item.jsonPath.startsWith('/facilities/fA/boundary'));
    expect(issue, JSON.stringify(result.issues)).toMatchObject({ entityType: 'facilities', entityId: 'fA' });
    expect(issue!.suggestedAction.length).toBeGreaterThan(0);
    // Invalid external JSON must reach the shared importer; serializer correctly refuses invalid maps.
    expect(loadMap(JSON.stringify(map)).ok).toBe(false);
  });

  it('G05 accepts a correctly oriented contained simple hole and retains its coordinates', () => {
    const map = spatialFixture();
    map.facilities.fA!.boundary.holes = [clockwiseHole(10, 10)];
    expect(validateMap(map).ok).toBe(true);
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.scene.facilities[0]!.boundary.holes).toEqual([clockwiseHole(10, 10)]);
  });

  it('G07 retains unsupported behavior and rejects edits even with otherwise supported facilities', () => {
    const map = associatedFixture();
    map.extensionNamespaces['test.future'] = { category: 'behavior', version: '1' };
    map.extensions['test.future'] = { movementRule: 'unimplemented' };
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) { expect(loaded.capabilities.editable).toBe(false); expect(loaded.map).toEqual(map); }
    refused(map, { type: 'updateFacility', id: 'fA', patch: { name: '不得修改' } });
  });

  it('G08 retains every semantic vector when the referenced background binary is absent', () => {
    const map = missingBackgroundFixture();
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Missing binary must not invalidate vectors.');
    expect(loaded.map).toEqual(map);
    expect(loaded.scene.facilities).toHaveLength(1);
    expect(loaded.scene.zones).toHaveLength(1);
    expect(loaded.scene.accessPoints).toHaveLength(1);
    expect(loaded.scene.servicePoints).toHaveLength(1);
    expect(loaded.scene.roads).toHaveLength(1);
    expect(loaded.capabilities.unchecked).toContain('asset_availability');
  });

  it('G06 splits a polyline with conserved planar length, stable direction/physical/source fields and explicit lineage', () => {
    const map = editorFixture();
    map.roads.rAB!.shapePoints = [[40, 0, 0], [40, 30, 0]];
    map.roads.rAB!.direction = 'backward';
    map.roads.rAB!.widthM = { state: 'known', value: 12 };
    map.roads.rAB!.heightLimitM = { state: 'unrestricted' };
    map.roads.rAB!.massLimitKg = { state: 'not_applicable' };
    const oldLength = 70 + Math.sqrt(60 * 60 + 30 * 30);
    expect(roadLength(map, 'rAB')).toBeCloseTo(oldLength, 10);
    const split = execute(map, { type: 'splitRoad', id: 'rAB', distanceM: 55, nodeId: 'nSplit', newRoadIds: ['rFirst', 'rSecond'] });
    expect(split.mapping).toEqual({ oldRoadId: 'rAB', newRoadIds: ['rFirst', 'rSecond'], nodeId: 'nSplit' });
    expect(Object.hasOwn(split.map.roads, 'rAB')).toBe(false);
    expect(split.map.nodes.nSplit!.position).toEqual([40, 15, 0]);
    expect(split.map.roads.rFirst!.fromNodeId).toBe('nA');
    expect(split.map.roads.rFirst!.toNodeId).toBe('nSplit');
    expect(split.map.roads.rSecond!.fromNodeId).toBe('nSplit');
    expect(split.map.roads.rSecond!.toNodeId).toBe('nB');
    expect(Math.abs(roadLength(split.map, 'rFirst') + roadLength(split.map, 'rSecond') - oldLength)).toBeLessThan(1e-9);
    for (const id of ['rFirst', 'rSecond']) {
      expect(split.map.roads[id]).toMatchObject({ direction: 'backward', widthM: map.roads.rAB!.widthM, heightLimitM: map.roads.rAB!.heightLimitM, massLimitKg: map.roads.rAB!.massLimitKg, speedLimitMps: { state: 'unknown' }, provenance: map.roads.rAB!.provenance });
    }
    expect(contentHash(split.map)).not.toBe(contentHash(map));
  });

  it('G06 splits using an existing coincident node only when explicitly requested; ordinary crossing stays disconnected', () => {
    const map = editorFixture();
    map.nodes.nCross = testNode('路中节点', 50);
    expect(map.roads.rAB!.fromNodeId).toBe('nA');
    expect(map.roads.rAB!.toNodeId).toBe('nB');
    expect(Object.values(map.roads).some(road => road.fromNodeId === 'nCross' || road.toNodeId === 'nCross')).toBe(false);
    refused(map, { type: 'splitRoad', id: 'rAB', distanceM: 50, nodeId: 'nCross', newRoadIds: ['ra', 'rb'] });
    const result = execute(map, { type: 'splitRoad', id: 'rAB', distanceM: 50, nodeId: 'nCross', existingNode: true, newRoadIds: ['ra', 'rb'] }).map;
    expect(Object.keys(result.nodes)).toEqual(Object.keys(map.nodes));
    expect(result.roads.ra!.toNodeId).toBe('nCross');
    expect(result.roads.rb!.fromNodeId).toBe('nCross');
  });

  it.each([0, 100, -1, Number.NaN, Number.POSITIVE_INFINITY])('G06 refuses degenerate or out-of-range split %s without mutation', distanceM => {
    refused(editorFixture(), { type: 'splitRoad', id: 'rAB', distanceM, nodeId: 'nSplit', newRoadIds: ['ra', 'rb'] });
  });

  it('G06 rejects splitting a road carrying unrecognized entity-extension references', () => {
    const map = editorFixture();
    map.extensionNamespaces['test.metadata'] = { category: 'metadata', version: '1' };
    map.roads.rAB!.extensions = { 'test.metadata': { linkedRoad: 'rAB' } };
    refused(map, { type: 'splitRoad', id: 'rAB', distanceM: 50, nodeId: 'nSplit', newRoadIds: ['ra', 'rb'] });
  });
});

describe('M2A independent physical assumption provenance', () => {
  it('G09 requires an explicit design-assumption source for newly known values and writes provenance atomically', () => {
    const map = editorFixture();
    refused(map, { type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 12 } } });
    const result = execute(map, {
      type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 12 }, speedLimitMps: { state: 'known', value: 2 } },
      designAssumption: { id: 'srcAssumption', name: '合成设计假设', description: '仅演示设计取值，无现场核验。' },
    }).map;
    expect(result.sources.srcAssumption).toMatchObject({ category: 'design_assumption' });
    expect(result.roads.rAB!.widthM).toEqual({ state: 'known', value: 12, sourceRef: 'srcAssumption' });
    expect(result.roads.rAB!.speedLimitMps).toEqual({ state: 'known', value: 2, sourceRef: 'srcAssumption' });
    expect(result.roads.rAB!.provenance.fieldSources?.widthM).toBe('srcAssumption');
    expect(result.roads.rAB!.heightLimitM).toEqual({ state: 'unknown' });
    expect(result.metadata.layoutBasis).toBe('synthetic');
    expect(loadMap(serializeMap(result)).ok).toBe(true);
  });

  it('G09 preserves provided provenance and all four states without synthesizing zero or unrestricted limits', () => {
    const map = editorFixture();
    map.sources.srcDeclared = { name: '测试声明源', category: 'drawing', description: '仅测试引用保留，不代表实际存在图纸。' };
    const result = execute(map, {
      type: 'updateRoad', id: 'rAB', patch: {
        widthM: { state: 'known', value: 8, sourceRef: 'srcDeclared' },
        heightLimitM: { state: 'unrestricted' }, massLimitKg: { state: 'not_applicable' }, speedLimitMps: { state: 'unknown' },
      },
    }).map;
    expect(result.sources).toEqual(map.sources);
    expect(result.roads.rAB!.widthM).toEqual({ state: 'known', value: 8, sourceRef: 'srcDeclared' });
    expect(result.roads.rAB!.heightLimitM).toEqual({ state: 'unrestricted' });
    expect(result.roads.rAB!.massLimitKg).toEqual({ state: 'not_applicable' });
    expect(result.roads.rAB!.speedLimitMps).toEqual({ state: 'unknown' });
    const loaded = loadMap(serializeMap(result));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.map).toEqual(result);
  });

  it('G09 rolls back a generated assumption source when another physical field fails validation', () => {
    const map = editorFixture();
    refused(map, {
      type: 'updateRoad', id: 'rAB', patch: { widthM: { state: 'known', value: 12 }, massLimitKg: { state: 'known', value: -1 } },
      designAssumption: { id: 'srcNotCommitted' },
    });
    expect(Object.hasOwn(map.sources, 'srcNotCommitted')).toBe(false);
  });
});

describe('M2A declared geometry limits and split lineage preservation', () => {
  it('G05 refuses polygons exceeding the documented vertex or hole limit explicitly', () => {
    const manyVertices = spatialFixture();
    const points: Vec3[] = Array.from({ length: 520 }, (_, i) => [30 + 10 * Math.cos(i * 2 * Math.PI / 520), 15 + 10 * Math.sin(i * 2 * Math.PI / 520), 0]);
    points.push([...points[0]!] as Vec3);
    manyVertices.facilities.fA!.boundary.outer = points as Polygon['outer'];
    expect(validateMap(manyVertices).ok).toBe(false);
    const manyHoles = spatialFixture();
    manyHoles.facilities.fA!.boundary.holes = Array.from({ length: 17 }, (_, i) => clockwiseHole(1 + i * 3, 10, 1));
    expect(validateMap(manyHoles).ok).toBe(false);
    for (const map of [manyVertices, manyHoles]) {
      expect(validateMap(map).issues.some(issue => issue.severity === 'error' && /LIMIT|COMPLEX/i.test(issue.code))).toBe(true);
    }
  });

  it('G06 persists declared old/new split correspondence through JSON and rejects foreign lineage payloads', () => {
    const map = editorFixture();
    const split = execute(map, { type: 'splitRoad', id: 'rAB', distanceM: 40, nodeId: 'nSplit', newRoadIds: ['r1', 'r2'] });
    const namespace = 'org.shipyard.editor.lineage';
    expect(split.map.extensionNamespaces[namespace]).toEqual({ version: '1.0.0', category: 'metadata' });
    expect(split.map.extensions[namespace]).toEqual({ version: '1.0.0', roadSplits: [{ oldRoadId: 'rAB', newRoadIds: ['r1', 'r2'], nodeId: 'nSplit', distanceM: 40, originalLengthM: 100 }] });
    const loaded = loadMap(serializeMap(split.map));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.map.extensions).toEqual(split.map.extensions);
    map.extensionNamespaces[namespace] = { version: '99.0.0', category: 'metadata' };
    map.extensions[namespace] = { futureField: 'must not overwrite' };
    refused(map, { type: 'splitRoad', id: 'rAB', distanceM: 40, nodeId: 'nSplit', newRoadIds: ['r1', 'r2'] });
    expect(map.extensions[namespace]).toEqual({ futureField: 'must not overwrite' });
  });
});

describe('M2A independent reference-order and provenance edge cases', () => {
  it('preserves explicit membership order when renaming an entrance/service and treats identical patches as no-ops', () => {
    const map = associatedFixture();
    map.accessPoints.aOther = { name: '第二入口', facilityId: 'fA', nodeId: 'nB', provenance: { category: 'synthetic' } };
    map.facilities.fA!.accessPointIds = ['aA', 'aOther'];
    map.servicePoints.sOther = { name: '第二服务', kind: 'other', facilityId: 'fA', accessPointId: 'aOther', nodeId: 'nB', resourceIds: [], provenance: { category: 'synthetic' } };
    map.facilities.fA!.servicePointIds = ['sA', 'sOther'];
    const renamedAccess = execute(map, { type: 'updateAccessPoint', id: 'aA', patch: { name: '入口改名' } }).map;
    expect(renamedAccess.facilities.fA!.accessPointIds).toEqual(['aA', 'aOther']);
    const renamedService = execute(renamedAccess, { type: 'updateServicePoint', id: 'sA', patch: { name: '服务改名' } }).map;
    expect(renamedService.facilities.fA!.servicePointIds).toEqual(['sA', 'sOther']);
    const same = execute(renamedService, { type: 'updateServicePoint', id: 'sA', patch: { name: '服务改名' } });
    expect(same.changed).toBe(false);
    expect(same.map).toBe(renamedService);
  });

  it('treats a declared constructor facility ID as ordinary owned data when explicitly retaining its association on copy', () => {
    const map = associatedFixture();
    const facility = map.facilities.fA!;
    delete map.facilities.fA;
    Object.defineProperty(map.facilities, 'constructor', { value: facility, enumerable: true, writable: true, configurable: true });
    map.accessPoints.aA!.facilityId = 'constructor';
    map.servicePoints.sA!.facilityId = 'constructor';
    const copy = execute(map, { type: 'duplicateSelection', selection: select({ accessPoints: ['aA'] }), delta: [10, 0, 0], idMap: { aA: 'aCopy', nA: 'nCopy' }, associationPolicy: 'retainFacility' }).map;
    expect(copy.accessPoints.aCopy!.facilityId).toBe('constructor');
    expect(copy.facilities['constructor']!.accessPointIds).toEqual(['aA', 'aCopy']);
    expect(copy.roads).toEqual(map.roads);
  });

  it.each(['unknown', 'unrestricted', 'not_applicable'] as const)('clears only stale width provenance when its state becomes %s and retains historical sources', state => {
    const map = editorFixture();
    map.sources.srcDeclared = { name: '历史声明', category: 'drawing', description: '测试既有来源，不声称真实测量。' };
    map.roads.rAB!.widthM = { state: 'known', value: 12, sourceRef: 'srcDeclared' };
    map.roads.rAB!.heightLimitM = { state: 'known', value: 9, sourceRef: 'srcDeclared' };
    map.roads.rAB!.provenance.fieldSources = { widthM: 'srcDeclared', heightLimitM: 'srcDeclared' };
    const updated = execute(map, { type: 'updateRoad', id: 'rAB', patch: { widthM: { state } } }).map;
    expect(updated.roads.rAB!.widthM).toEqual({ state });
    expect(updated.roads.rAB!.provenance.fieldSources?.widthM).toBeUndefined();
    expect(updated.roads.rAB!.provenance.fieldSources?.heightLimitM).toBe('srcDeclared');
    expect(updated.sources).toEqual(map.sources);
  });
});
