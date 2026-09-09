import type { YardMap } from '../domain/model';
import type { SceneSnapshot } from '../adapters/contracts';
import { contentHash } from '../domain/serialization';
import { geometryBounds, roadLength, roadPoints } from '../geometry/roads';
import { mapCapabilities } from '../domain/capabilities';

export function toSceneSnapshot(map: YardMap): SceneSnapshot {
  const nodes = Object.entries(map.nodes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, node]) => ({ id, name: node.name, position: [...node.position] as typeof node.position }));
  const roads = Object.entries(map.roads).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([id, road]) => ({ id, name: road.name, fromNodeId: road.fromNodeId, toNodeId: road.toNodeId, points: roadPoints(map, id), lengthM: roadLength(map, id) }));
  const capabilities = mapCapabilities(map);
  return {
    schemaVersion: '0.1.0', mapId: map.mapId, mapContentHash: contentHash(map),
    coordinateFrame: structuredClone(map.coordinateFrame), nodes, roads,
    bounds: geometryBounds([...nodes.map(n => n.position), ...roads.flatMap(r => r.points)]),
    missingCapabilities: [...capabilities.unrendered, ...capabilities.unchecked],
  };
}