import { writeFile } from 'node:fs/promises';
import { applyMapCommand, type MapCommand } from '../src/domain/commands';
import { newAccessPoint, newFacility, newMap, newNode, newRoad, newServicePoint, newZone } from '../src/domain/factory';
import { serializeMap } from '../src/domain/serialization';
import { loadMap } from '../src/domain/load';
import type { Polygon, YardMap } from '../src/domain/model';

// Reproducible synthetic examples, generated only through the implemented domain commands.
const rectangle = (x: number, y: number, width: number, height: number): Polygon => ({ outer: [[x, y, 0], [x + width, y, 0], [x + width, y + height, 0], [x, y + height, 0], [x, y, 0]], holes: [] });
let map = newMap('map_M2A_synthetic', 'M2A synthetic · 60m×30m厂房与运输入口', '0.1.0');
const commands: MapCommand[] = [
  { type: 'addNode', id: 'nRoadWest', node: { ...newNode([0, 0, 0], '西侧入口节点'), kind: 'access' } },
  { type: 'addNode', id: 'nRoadEast', node: newNode([100, 0, 0], '东侧道路节点') },
  { type: 'addRoad', id: 'rMain', road: newRoad('nRoadWest', 'nRoadEast', [], '100m 合成主路') },
  { type: 'addFacility', id: 'fWorkshop', facility: newFacility(rectangle(0, 0, 60, 30), '60m×30m 合成厂房') },
  { type: 'addZone', id: 'zWaiting', zone: newZone(rectangle(70, 30, 20, 20), '20m×20m 合成候停区', 'waiting') },
  { type: 'addAccessPoint', id: 'aWorkshop', accessPoint: newAccessPoint('fWorkshop', 'nRoadWest', '厂房西侧入口') },
  { type: 'addServicePoint', id: 'sLoading', servicePoint: newServicePoint('nLoading', '合成装卸点', 'loading', 'fWorkshop', 'aWorkshop'), newNode: { id: 'nLoading', node: { ...newNode([15, 10, 0], '装卸权威节点'), kind: 'service' } } },
  { type: 'addRoad', id: 'rApproach', road: newRoad('nRoadWest', 'nLoading', [[5, 10, 0]], '显式入口至装卸点道路') },
  { type: 'updateRoad', id: 'rMain', patch: { direction: 'both' } },
  { type: 'updateRoad', id: 'rApproach', patch: { direction: 'both' } },
];
for (const command of commands) {
  const result = applyMapCommand(map, command);
  if (!result.ok) throw new Error(JSON.stringify({ command, issues: result.issues }));
  map = result.map;
}
const validText = serializeMap(map);
const loaded = loadMap(validText);
if (!loaded.ok || !loaded.capabilities.editable) throw new Error('M2A synthetic example must load as an editable valid draft.');
await writeFile(new URL('../examples/M2A_synthetic.map.json', import.meta.url), validText, 'utf8');
// Intentionally corrupt a valid exported declaration as an external JSON editor might.
const invalid = JSON.parse(validText) as YardMap;
invalid.metadata.name = 'M2A synthetic INVALID · 自交厂房边界';
invalid.facilities.fWorkshop!.boundary.outer = [[0, 0, 0], [60, 30, 0], [0, 30, 0], [60, 0, 0], [0, 0, 0]];
const invalidText = JSON.stringify(invalid, null, 2) + '\n';
if (loadMap(invalidText).ok) throw new Error('Intentionally self-intersecting example unexpectedly accepted.');
await writeFile(new URL('../examples/M2A_invalid_polygon.map.json', import.meta.url), invalidText, 'utf8');
process.stdout.write(JSON.stringify({ commands: commands.length, mapContentHash: loaded.contentHash, valid: 'M2A_synthetic.map.json', invalid: 'M2A_invalid_polygon.map.json' }) + '\n');
