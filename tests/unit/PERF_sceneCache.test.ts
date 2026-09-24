import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMapCommand, freezeMap, type MapCommand } from '../../src/domain/commands';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { parseMap } from '../../src/domain/serialization';
import type { YardMap } from '../../src/domain/model';

// Rows reused from earlier revisions must equal a snapshot built from scratch (an unfrozen copy bypasses every cache).
describe('cached scene rows across edits', () => {
  it('match a fresh snapshot after each kind of edit', () => {
    const parsed = parseMap(readFileSync(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url), 'utf8'));
    if (!parsed.ok) throw new Error('example map invalid');
    let map = freezeMap(structuredClone(parsed.map));
    expect(toSceneSnapshot(map)).toEqual(toSceneSnapshot(structuredClone(map) as YardMap));
    const facilityId = Object.keys(map.facilities)[0]!, zoneId = Object.keys(map.zones)[0]!, roadId = Object.keys(map.roads)[0]!;
    const serviceNode = Object.values(map.servicePoints)[0]!.nodeId, start = map;
    // Any node this map lets us move: its roads, points and access rows must follow.
    const movable = Object.keys(map.nodes).find(id => applyMapCommand(start, { type: 'updateNode', id, patch: { position: [start.nodes[id]!.position[0] + 0.5, start.nodes[id]!.position[1], start.nodes[id]!.position[2]] } }).ok)!;
    expect(movable).toBeDefined();
    const commands: MapCommand[] = [
      { type: 'updateNode', id: movable, patch: { position: [map.nodes[movable]!.position[0] + 0.5, map.nodes[movable]!.position[1], map.nodes[movable]!.position[2]] } },
      { type: 'updateNode', id: serviceNode, patch: { name: '改名后的节点' } },
      { type: 'updateFacility', id: facilityId, patch: { name: '改名后的设施' } },
      { type: 'updateZone', id: zoneId, patch: { name: '改名后的区域' } },
      { type: 'updateRoad', id: roadId, patch: { name: '改名后的道路', direction: 'both' } },
      { type: 'renameMap', name: '改名后的地图' },
    ];
    for (const command of commands) {
      const result = applyMapCommand(map, command);
      if (!result.ok) throw new Error(command.type + ': ' + result.issues[0]?.code);
      map = result.map;
      expect(toSceneSnapshot(map), command.type).toEqual(toSceneSnapshot(structuredClone(map) as YardMap));
    }
  });
});
