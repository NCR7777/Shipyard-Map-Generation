/** Reproducible synthetic contract example, generated only through validated domain commands. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadMap } from '../src/domain/load';
import { applyMapCommand, type MapCommand } from '../src/domain/commands';
import { newNode } from '../src/domain/factory';
import { contentHash, serializeMap } from '../src/domain/serialization';
import type { YardMap } from '../src/domain/model';

const sourceUrl = new URL('../examples/M2A_synthetic.map.json', import.meta.url);
const sourceBytes = await readFile(sourceUrl);
const loaded = loadMap(sourceBytes.toString('utf8'));
if (!loaded.ok) throw new Error(JSON.stringify(loaded.report));
let map: YardMap = loaded.map;
const commands: MapCommand[] = [
  { type: 'upgradeSchema', targetVersion: '0.2.0' },
  { type: 'renameMap', name: 'M2A.1 synthetic · 设施内部目标与独立区域代理' },
  { type: 'updateServicePoint', id: 'sLoading', patch: { arrival: { mode: 'explicit_internal', internalPath: [{ roadId: 'rApproach', direction: 'forward' }] } } },
  { type: 'addServicePoint', id: 'sZoneUnload', servicePoint: {
    name: 'synthetic 等待区边界卸载代理', kind: 'unloading', nodeId: 'nZoneTarget', zoneId: 'zWaiting',
    arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'synthetic：该节点代表本研究中的区域边界作业位；未建模场内转运明确忽略。此图未声明服务时长、资源容量或运输可达性。' },
    resourceIds: [], provenance: { category: 'synthetic' },
  }, newNode: { id: 'nZoneTarget', node: { ...newNode([80, 30, 0], 'synthetic 区域目标权威节点'), kind: 'service' } } },
  { type: 'addRoad', id: 'rZoneConnection', road: { ...structuredClone(map.roads.rMain!), name: 'synthetic 区域显式接路', fromNodeId: 'nRoadEast', toNodeId: 'nZoneTarget', shapePoints: [], direction: 'both' } },
];
for (const command of commands) {
  const result = applyMapCommand(map, command);
  if (!result.ok) throw new Error(JSON.stringify({ command: command.type, issues: result.issues }));
  map = result.map;
}
const valid = serializeMap(map);
await writeFile(new URL('../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), valid, 'utf8');
const invalid = JSON.parse(valid) as YardMap;
invalid.servicePoints.sZoneUnload!.nodeId = 'missing_service_node';
// This deliberately external edit is not serialized with the valid-map exporter.
await writeFile(new URL('../examples/M2A1_invalid_service_node.map.json', import.meta.url), JSON.stringify(invalid, null, 2) + '\n', 'utf8');
process.stdout.write(JSON.stringify({ synthetic: true, source: 'examples/M2A_synthetic.map.json', sourceFileSha256: createHash('sha256').update(sourceBytes).digest('hex'), appliedCommands: commands.length, mapContentHash: contentHash(map) }, null, 2) + '\n');
