import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { newMap } from '../../src/domain/factory';
import { loadMap } from '../../src/domain/load';
import type { Polygon, YardMap } from '../../src/domain/model';
import { contentHash, parseMap, serializeMap } from '../../src/domain/serialization';
import { roadLength, roadPoints } from '../../src/geometry/roads';
import { validateMap } from '../../src/validation/validate';

function mapFixture(): YardMap {
  const map = newMap('map_test', '独立测试地图');
  map.metadata.layoutBasis = 'synthetic';
  map.nodes.node_A = { name: 'A', kind: 'ordinary', position: [0, 0, 0], provenance: { category: 'synthetic' } };
  map.nodes.node_B = { name: 'B', kind: 'ordinary', position: [100, 0, 0], provenance: { category: 'synthetic' } };
  map.roads.road_AB = {
    name: '道路 A→B', fromNodeId: 'node_A', toNodeId: 'node_B', shapePoints: [],
    direction: 'unknown', widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' },
    massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' }, resourceIds: [],
    provenance: { category: 'synthetic' },
  };
  return map;
}

function issueAt(map: unknown, jsonPath: string) {
  const report = validateMap(map);
  expect(report.ok).toBe(false);
  expect(report.status).toBe('invalid');
  const issue = report.issues.find((item) => item.severity === 'error' && item.jsonPath === jsonPath);
  expect(issue, JSON.stringify(report.issues)).toBeDefined();
  expect(issue!.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
  expect(issue!.message.length).toBeGreaterThan(0);
  expect(issue!.suggestedAction.length).toBeGreaterThan(0);
  return issue!;
}

function withAsset(map: YardMap) {
  map.sources.source_image = { name: '合成底图', category: 'synthetic', description: '仅测试使用，不是实测证据。' };
  map.assets.asset_image = {
    path: 'assets/reference.png', sha256: 'a'.repeat(64), mediaType: 'image/png',
    sourceRef: 'source_image', widthPx: 200, heightPx: 100,
  };
}

describe('M0 core: independent domain contract', () => {
  it('A01 creates a versioned map with explicit metre/right-handed coordinates in Node', () => {
    expect('document' in globalThis).toBe(false);
    expect('window' in globalThis).toBe(false);
    const map = newMap('map_new', '新地图');
    expect(map).toMatchObject({ schemaVersion: '0.1.0', mapId: 'map_new', metadata: { name: '新地图' } });
    expect(map.coordinateFrame).toMatchObject({
      kind: 'local_cartesian', handedness: 'right', groundPlane: 'XY', upAxis: 'Z',
      lengthUnit: 'm', angleUnit: 'rad', massUnit: 'kg', timeUnit: 's',
    });
    expect(validateMap(map).ok).toBe(true);
    expect(parseMap(serializeMap(map))).toMatchObject({ ok: true, map });
  });

  it('validates the delivered synthetic example and rejects the invalid example', () => {
    const valid = loadMap(readFileSync(new URL('../../examples/M1_synthetic.map.json', import.meta.url), 'utf8'));
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.map.metadata.layoutBasis).toBe('synthetic');
    const invalid = loadMap(readFileSync(new URL('../../examples/M1_invalid.map.json', import.meta.url), 'utf8'));
    expect(invalid.ok).toBe(false);
    expect(invalid.report.issues.some((issue) => /^\/roads\/[^/]+\/toNodeId$/.test(issue.jsonPath))).toBe(true);
  });

  it('A02 derives length from endpoint references without a second geometry source', () => {
    const map = mapFixture();
    expect(roadPoints(map, 'road_AB')).toEqual([[0, 0, 0], [100, 0, 0]]);
    expect(roadLength(map, 'road_AB')).toBe(100);
    expect(serializeMap(map)).not.toContain('lengthM');
    expect(serializeMap(map)).not.toContain('centerline');
    issueAt({ ...map, roads: { road_AB: { ...map.roads.road_AB, lengthM: 999 } } }, '/roads/road_AB/lengthM');
  });

  it('A03 external edits change geometry and content hash while IDs and revision remain stable', () => {
    const map = mapFixture();
    const edited = structuredClone(map);
    edited.nodes.node_B!.position = [120, 0, 0];
    const loaded = loadMap(serializeMap(edited));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('External coordinate edit should be valid.');
    expect(roadLength(loaded.map, 'road_AB')).toBe(120);
    expect(loaded.contentHash).not.toBe(contentHash(map));
    expect(loaded.map.revision).toBe(map.revision);
    expect(Object.keys(loaded.map.nodes)).toEqual(Object.keys(map.nodes));
    expect(Object.keys(loaded.map.roads)).toEqual(Object.keys(map.roads));
    expect(loaded.map.roads.road_AB!.fromNodeId).toBe('node_A');
    expect(loaded.map.roads.road_AB!.toNodeId).toBe('node_B');
  });

  it('A04 retains exact numeric values and ordered geometry over ten round trips', () => {
    const original = mapFixture();
    original.nodes.node_A!.position = [0.1234567890123456, -0.0000000000001, 0];
    original.roads.road_AB!.shapePoints = [[42.98765432109876, 2.34567890123456, 3], [20, -4.56789012345678, 0]];
    const canonical = serializeMap(original);
    let current = original;
    for (let round = 0; round < 10; round += 1) {
      const parsed = parseMap(serializeMap(current));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) throw new Error('Canonical map should parse.');
      current = parsed.map;
      expect(current).toEqual(original);
      expect(serializeMap(current)).toBe(canonical);
    }
    expect(canonical).not.toContain('\r');
    expect(canonical.endsWith('\n')).toBe(true);
  });

  it('uses a deterministic object key order without sorting arrays', () => {
    const map = mapFixture();
    const reordered = { ...map, nodes: { node_B: map.nodes.node_B!, node_A: map.nodes.node_A! } };
    expect(serializeMap(reordered)).toBe(serializeMap(map));
    expect(contentHash(reordered)).toBe(contentHash(map));
  });

  it('preserves all declared extension payloads, including names resembling core fields', () => {
    const map = mapFixture();
    map.extensionNamespaces['example.future'] = { version: '1', category: 'metadata' };
    const payload = { nullable: null, nested: { position: [7, 3, 1], name: '未来数据' }, enabled: false };
    map.extensions['example.future'] = payload;
    map.nodes.node_A!.extensions = { 'example.future': { values: [3, 2, 1], nested: payload } };
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Metadata extensions should be preserved.');
    expect(loaded.map).toEqual(map);
    expect(loaded.capabilities.editable).toBe(true);
  });

  it('rejects undeclared extension namespaces', () => {
    const map = mapFixture();
    map.extensions['example.undeclared'] = { value: 1 };
    issueAt(map, '/extensions/example.undeclared');
  });

  it.each([
    '{',
    '{"mapId":"a","mapId":"b"}',
    '{"mapId":"a","\\u006dapId":"b"}',
    '{"nested":{"x":1,"\\u0078":2}}',
    '{"value":1e400}',
    '{"value":NaN}',
    '{"value":Infinity}',
  ])('A05 rejects malformed, duplicate or nonfinite JSON: %s', (text) => {
    const parsed = parseMap(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('Invalid input accepted.');
    expect(parsed.issues.some((issue) => issue.severity === 'error')).toBe(true);
    for (const issue of parsed.issues) {
      expect(issue.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(typeof issue.jsonPath).toBe('string');
      expect(issue.suggestedAction.length).toBeGreaterThan(0);
    }
  });

  it('reports line and column for an invalid JSON token', () => {
    const parsed = parseMap('{\n  "mapId": !\n}');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('Invalid token accepted.');
    expect(parsed.issues.some((issue) => issue.location?.line === 2 && (issue.location.column ?? 0) > 0)).toBe(true);
  });

  it.each(['mapId', '\\u006dapId'])('detects the duplicate decoded key %s in an otherwise valid map', (duplicateKey) => {
    const text = JSON.stringify(mapFixture()).replace('"mapId":"map_test"', `"mapId":"map_test","${duplicateKey}":"map_test"`);
    const parsed = parseMap(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('Duplicate key accepted.');
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUPLICATE_KEY', jsonPath: '/mapId' }),
    ]));
  });

  it('locates overflow at the coordinate inside an otherwise valid map', () => {
    const text = JSON.stringify(mapFixture()).replace('"position":[0,0,0]', '"position":[1e400,0,0]');
    const parsed = parseMap(text);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('Numeric overflow accepted.');
    expect(parsed.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NON_FINITE_NUMBER', jsonPath: '/nodes/node_A/position/0' }),
    ]));
  });

  it('rejects nonfinite values passed directly to validation', () => {
    const map = mapFixture();
    map.nodes.node_A!.position[0] = Number.POSITIVE_INFINITY;
    issueAt(map, '/nodes/node_A/position/0');
  });

  it('locates unknown top-level and nested fields rather than dropping them', () => {
    const map = mapFixture();
    issueAt({ ...map, editorState: { zoom: 2 } }, '/editorState');
    issueAt({ ...map, nodes: { ...map.nodes, node_A: { ...map.nodes.node_A, postion: [1, 2, 0] } } }, '/nodes/node_A/postion');
  });

  it('reports a dangling endpoint with its entity and JSON pointer', () => {
    const map = mapFixture();
    map.roads.road_AB!.toNodeId = 'node_missing';
    const issue = issueAt(map, '/roads/road_AB/toNodeId');
    expect(issue.entityId).toBe('road_AB');
  });

  it('rejects zero horizontal road length and does not use elevation as length', () => {
    const map = mapFixture();
    map.nodes.node_B!.position = [0, 0, 10];
    expect(roadLength(map, 'road_AB')).toBe(0);
    const report = validateMap(map);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.severity === 'error' && issue.entityId === 'road_AB')).toBe(true);
  });

  it('retains unknown physical fields as a valid draft without fabricating values', () => {
    const map = mapFixture();
    const report = validateMap(map);
    expect(report.ok).toBe(true);
    expect(report.issues.some((issue) => issue.severity === 'warning')).toBe(true);
    expect(map.roads.road_AB!.widthM).toEqual({ state: 'unknown' });
    expect(map.roads.road_AB!.direction).toBe('unknown');
  });

  it.each([0, -1, null])('rejects invalid known physical value %s', (value) => {
    const map = mapFixture();
    const candidate = { ...map, roads: { road_AB: { ...map.roads.road_AB, widthM: { state: 'known', value } } } };
    expect(validateMap(candidate).ok).toBe(false);
  });

  it.each(['0.0.1', '99.0.0'])('A08 refuses unsupported schema version %s', (schemaVersion) => {
    const map = { ...mapFixture(), schemaVersion };
    expect(validateMap(map).ok).toBe(false);
    expect(loadMap(JSON.stringify(map)).ok).toBe(false);
  });

  it('does not treat revision as content identity, but includes names and source metadata', () => {
    const map = mapFixture();
    const originalHash = contentHash(map);
    expect(originalHash).toMatch(/^[a-f0-9]{64}$/);
    map.revision += 1;
    expect(contentHash(map)).toBe(originalHash);
    map.nodes.node_A!.name = '新名称';
    expect(contentHash(map)).not.toBe(originalHash);
    const namedHash = contentHash(map);
    map.sources.source_note = { name: '说明', category: 'synthetic', description: '来源变更也必须使摘要失效' };
    expect(contentHash(map)).not.toBe(namedHash);
  });

  it('builds scene snapshots from the same content identity and isolates geometry copies', () => {
    const map = mapFixture();
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Fixture should load into a scene.');
    expect(loaded.scene.mapId).toBe(map.mapId);
    expect(loaded.scene.mapContentHash).toBe(loaded.contentHash);
    expect(loaded.scene.coordinateFrame).toEqual(map.coordinateFrame);
    expect(loaded.scene.roads).toEqual([
      { id: 'road_AB', name: map.roads.road_AB!.name, fromNodeId: 'node_A', toNodeId: 'node_B', points: [[0, 0, 0], [100, 0, 0]], lengthM: 100 },
    ]);
    loaded.scene.nodes[0]!.position[0] = -500;
    loaded.scene.roads[0]!.points[0]![0] = -700;
    expect(loaded.map.nodes.node_A!.position).toEqual([0, 0, 0]);
    expect(roadPoints(loaded.map, 'road_AB')[0]).toEqual([0, 0, 0]);
  });

  it('rejects duplicated entity identifiers across typed dictionaries', () => {
    const map = mapFixture();
    map.sources.node_A = { name: '重复 ID', category: 'synthetic', description: '测试' };
    const issue = issueAt(map, '/sources/node_A');
    expect(issue.code).toBe('DUPLICATE_ENTITY_ID');
  });

  it('A11 derives both incident roads from a moved shared node', () => {
    const map = mapFixture();
    map.nodes.node_C = { ...map.nodes.node_B!, name: 'C', position: [200, 0, 0] };
    map.roads.road_BC = { ...map.roads.road_AB!, fromNodeId: 'node_B', toNodeId: 'node_C' };
    map.nodes.node_B!.position = [120, 0, 0];
    expect(roadLength(map, 'road_AB')).toBe(120);
    expect(roadLength(map, 'road_BC')).toBe(80);
    expect(roadPoints(map, 'road_AB').at(-1)).toEqual(roadPoints(map, 'road_BC')[0]);
  });

  it('keeps facilities distinct from access/service nodes and imports advanced entities read-only', () => {
    const map = mapFixture();
    map.facilities.facility_one = {
      name: '测试厂房', kind: 'workshop',
      boundary: { outer: [[0, 10, 0], [10, 10, 0], [10, 20, 0], [0, 20, 0], [0, 10, 0]], holes: [] },
      accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
    };
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('An advanced draft should open read-only.');
    expect(loaded.capabilities.editable).toBe(false);
    expect(loaded.capabilities.unrendered.length).toBeGreaterThan(0);
    expect(loaded.capabilities.unchecked.length).toBeGreaterThan(0);
    expect(loaded.map).toEqual(map);
    expect(Object.keys(loaded.map.accessPoints)).toEqual([]);
    expect(Object.keys(loaded.map.servicePoints)).toEqual([]);
  });

  it('rejects a service point bound to another facility through its access point', () => {
    const map = mapFixture();
    const boundary: Polygon = { outer: [[0, 10, 0], [10, 10, 0], [10, 20, 0], [0, 20, 0], [0, 10, 0]], holes: [] };
    map.facilities.facility_A = {
      name: '设施 A', kind: 'workshop', boundary, accessPointIds: ['access_A'], servicePointIds: [],
      heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
    };
    map.facilities.facility_B = {
      name: '设施 B', kind: 'workshop', boundary, accessPointIds: ['access_B'], servicePointIds: ['service_B'],
      heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
    };
    map.accessPoints.access_A = { name: 'A 入口', facilityId: 'facility_A', nodeId: 'node_A', provenance: { category: 'synthetic' } };
    map.accessPoints.access_B = { name: 'B 入口', facilityId: 'facility_B', nodeId: 'node_B', provenance: { category: 'synthetic' } };
    map.servicePoints.service_B = {
      name: 'B 装卸点', kind: 'loading', nodeId: 'node_B', facilityId: 'facility_B', accessPointId: 'access_B',
      resourceIds: [], provenance: { category: 'synthetic' },
    };
    expect(validateMap(map).ok).toBe(true);
    map.servicePoints.service_B.accessPointId = 'access_A';
    const issue = issueAt(map, '/servicePoints/service_B/accessPointId');
    expect(issue).toMatchObject({ code: 'SERVICE_ACCESS_FACILITY_CONFLICT', entityType: 'servicePoints', entityId: 'service_B' });
    expect(validateMap(map).issues.filter((item) => item.severity === 'error')).toHaveLength(1);
  });

  it('preserves unsupported behavior extensions and blocks official publication', () => {
    const map = mapFixture();
    map.extensionNamespaces['example.traffic'] = { version: 'v7', category: 'behavior' };
    map.extensions['example.traffic'] = { forbiddenMovements: ['turn_future'] };
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('Behavior extension draft should remain inspectable.');
    expect(loaded.capabilities.editable).toBe(false);
    expect(loaded.map.extensions).toEqual(map.extensions);
    expect(validateMap(map, 'level2_network')).toMatchObject({ ok: false, status: 'unsupported' });
  });

  it('reports missing provenance and physical source references', () => {
    const map = mapFixture();
    map.nodes.node_A!.provenance.sourceRefs = ['source_missing'];
    issueAt(map, '/nodes/node_A/provenance/sourceRefs/0');
    map.nodes.node_A!.provenance.sourceRefs = [];
    map.roads.road_AB!.widthM = { state: 'known', value: 12, sourceRef: 'source_missing' };
    issueAt(map, '/roads/road_AB/widthM/sourceRef');
  });

  it.each(['../reference.png', 'assets/../reference.png', 'assets//reference.png', 'C:/reference.png', '/assets/reference.png', 'assets\\reference.png', 'https://example.com/reference.png'])('rejects unsafe asset path %s', (assetPath) => {
    const map = mapFixture();
    withAsset(map);
    map.assets.asset_image!.path = assetPath;
    issueAt(map, '/assets/asset_image/path');
  });

  it('retains vectors when the JSON references an unavailable background binary', () => {
    const map = mapFixture();
    withAsset(map);
    map.backgroundLayers.background_one = {
      name: '缺失的合成底图', assetId: 'asset_image', pixelConvention: 'top_left_x_right_y_down_exif_normalized',
      imageToWorld: [0.5, 0, 0, -0.5, 0, 0], method: 'manual', controlPoints: [],
      provenance: { category: 'synthetic', sourceRefs: ['source_image'] },
    };
    const loaded = loadMap(serializeMap(map));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('An unavailable binary must not discard vectors.');
    expect(loaded.capabilities.editable).toBe(false);
    expect(loaded.map.nodes).toEqual(map.nodes);
    expect(loaded.map.roads).toEqual(map.roads);
    expect(roadLength(loaded.map, 'road_AB')).toBe(100);
  });
});
