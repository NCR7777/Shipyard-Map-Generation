import { expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runRoutes, candidateBoundary } from '../../scripts/MQ01_routes';
import { editorFixture, testNode } from '../helpers/M1_fixtures';
import { MAX_JSON_BYTES } from '../../src/domain/model';
import { contentHash, serializeMap } from '../../src/domain/serialization';

function fixture() {
  const map = editorFixture(); map.schemaVersion = '0.2.0'; map.roads.rAB!.direction = 'both';
  for (const [id, nodeId] of [['sA', 'nA'], ['sB', 'nB'], ['sSame', 'nA']]) map.servicePoints[id!] = { name: id!, kind: 'other', nodeId: nodeId!, resourceIds: [], provenance: { category: 'synthetic' }, arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'MQ01 fault injected route CLI fixture' } };
  return map;
}
it('MQ01 route file preserves exact binding, all directed services including shared-node pairs, and refuses overwrite/stale inventory', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'MQ01-routes-')), map = fixture(), input = join(folder, 'map.json'), output = join(folder, 'routes.json'), inventory = join(folder, 'inventory.json');
  const text = serializeMap(map); await writeFile(input, text);
  const fileSha256 = createHash('sha256').update(text).digest('hex');
  const data = { format: 'MQ01_full_geometry_inventory_v1', binding: { mapId: map.mapId, contentHash: contentHash(map), fileSha256 }, records: [{ rule: 'MQ-N01', code: 'local', ids: ['roads/rAB'] }] };
  await writeFile(inventory, JSON.stringify(data));
  const report = await runRoutes(input, output, inventory);
  expect(report.binding.fileSha256).toBe(fileSha256); expect(report.originalFileUnchanged).toBe(true); expect(await readFile(input, 'utf8')).toBe(text);
  expect(report.coverage).toMatchObject({ serviceDirectedPairsExpected: 6, serviceDirectedPairsVisited: 6, uniqueLocalNodeDirectedPairs: 2, totalDirectedPairs: 8, incompleteModeQueries: 0 });
  const same = report.rows.find(row => row.from.id === 'sA' && row.to.id === 'sSame')!;
  expect(same.euclideanM).toBe(0); expect(same.declared.confirmed?.excessDistanceM).toBe(0); expect(same.declared.confirmed?.euclideanRatio).toBeNull(); expect(same.declared.confirmed?.arcs).toEqual([]); expect(same.declared.candidateSameAsConfirmed).toBe(true); expect(same.declared.candidate).toBeNull();
  const saved = await readFile(output, 'utf8'); await expect(runRoutes(input, output, inventory)).rejects.toThrow('MQ_OUTPUT_EXISTS'); expect(await readFile(output, 'utf8')).toBe(saved);
  data.binding.fileSha256 = '0'.repeat(64); await writeFile(inventory, JSON.stringify(data));
  await expect(runRoutes(input, join(folder, 'stale.json'), inventory)).rejects.toThrow('MQ_INVENTORY_BINDING');
  await truncate(input, MAX_JSON_BYTES + 1);
  await expect(runRoutes(input, join(folder, 'oversize.json'))).rejects.toThrow('MQ_INPUT_SIZE');
});
it('MQ01 local boundaries use explicit attachment, exclude the degree-two interior, and reject missing refs', () => {
  const map = fixture(); map.nodes.nC = testNode('C', 200); map.roads.rBC = { ...structuredClone(map.roads.rAB!), fromNodeId: 'nB', toNodeId: 'nC' };
  expect(candidateBoundary(map, { rule: 'MQ-N01', code: 'degree2', ids: ['nodes/nB', 'roads/rAB', 'roads/rBC'] })).toEqual(['nA', 'nC']);
  expect(() => candidateBoundary(map, { rule: 'MQ-N01', code: 'bad', ids: ['roads/missing'] })).toThrow('MQ_INVENTORY_REFERENCE');
});
it('MQ01 resources follow road and exact movement declarations, never junction resource inheritance', async () => {
  const map = fixture(); map.nodes.nC = testNode('C', 200); map.roads.rBC = { ...structuredClone(map.roads.rAB!), fromNodeId: 'nB', toNodeId: 'nC' }; map.servicePoints.sB!.nodeId = 'nC';
  for (const id of ['rRoad', 'rTurn', 'rJunction']) map.resources[id] = { name: id, kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'unknown', appliesTo: [], provenance: { category: 'synthetic' } };
  map.roads.rAB!.resourceIds = ['rRoad']; map.junctions.jB = { name: 'B', nodeIds: ['nB'], model: 'explicit_movements', resourceIds: ['rJunction'], provenance: { category: 'synthetic' } };
  map.movements.mABC = { name: 'ABC', junctionId: 'jB', incomingArc: { roadId: 'rAB', direction: 'forward' }, outgoingArc: { roadId: 'rBC', direction: 'forward' }, allowed: false, resourceIds: ['rTurn'], provenance: { category: 'synthetic' } };
  const folder = await mkdtemp(join(tmpdir(), 'MQ01-resources-')), input = join(folder, 'map.json'); await writeFile(input, serializeMap(map));
  const report = await runRoutes(input, join(folder, 'routes.json'));
  const row = report.rows.find(row => row.from.id === 'sA' && row.to.id === 'sB')!;
  expect(row.declared.status).toBe('disconnected'); expect(row.declared.candidateSameAsConfirmed).toBe(false); expect(row.declared.candidate).toBeNull(); expect(row.directionOnly.status).toBe('found');
  const refs = row.directionOnly.confirmed!.resourceReferences;
  expect(refs.roads).toEqual([{ roadId: 'rAB', resourceIds: ['rRoad'] }]);
  expect(refs.movementDeclarations).toEqual([{ afterArcIndex: 0, movementId: 'mABC', allowed: false, resourceIds: ['rTurn'] }]);
  expect(JSON.stringify(refs)).not.toContain('rJunction'); expect(refs.meaning).toContain('ignored forbidden turns');
});
