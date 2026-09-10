import { sceneCatalog, itemPositions } from './catalog';
import { zoneServicePointIds } from '../topology/serviceConnections';
import type { YardMap } from '../domain/model';
import type { SceneSnapshot } from '../adapters/contracts';
import { contentHash } from '../domain/serialization';
import { geometryBounds, roadLength, roadPoints, roadWidthBounds } from '../geometry/roads';
import { mapCapabilities } from '../domain/capabilities';
function sorted<T>(values: Record<string, T>): [string, T][] { return Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }

export function toSceneSnapshot(map: YardMap): SceneSnapshot {
  const nodes: SceneSnapshot['nodes'] = sorted(map.nodes).map(([id, node]) => ({ id, name: node.name, kind: node.kind, position: [...node.position] }));
  const roads: SceneSnapshot['roads'] = sorted(map.roads).map(([id, road]) => ({ id, name: road.name, fromNodeId: road.fromNodeId, toNodeId: road.toNodeId, points: roadPoints(map, id), lengthM: roadLength(map, id), widthM: structuredClone(road.widthM) }));
  const facilities: SceneSnapshot['facilities'] = sorted(map.facilities).map(([id, facility]) => ({ id, name: facility.name, kind: facility.kind, boundary: structuredClone(facility.boundary), accessPointIds: [...facility.accessPointIds], servicePointIds: [...facility.servicePointIds], heightM: structuredClone(facility.heightM) }));
  const zones: SceneSnapshot['zones'] = sorted(map.zones).map(([id, zone]) => ({ id, servicePointIds: zoneServicePointIds(map, id), name: zone.name, kind: zone.kind, boundary: structuredClone(zone.boundary), passability: zone.passability }));
  const accessPoints: SceneSnapshot['accessPoints'] = sorted(map.accessPoints).map(([id, point]) => ({ id, name: point.name, facilityId: point.facilityId, nodeId: point.nodeId, position: [...map.nodes[point.nodeId]!.position] }));
  const servicePoints: SceneSnapshot['servicePoints'] = sorted(map.servicePoints).map(([id, point]) => ({ id, name: point.name, kind: point.kind, nodeId: point.nodeId, ...(point.facilityId ? { facilityId: point.facilityId } : {}), ...(point.accessPointId ? { accessPointId: point.accessPointId } : {}), ...(point.zoneId ? { zoneId: point.zoneId } : {}), ...(point.arrival ? { arrival: structuredClone(point.arrival) } : {}), position: [...map.nodes[point.nodeId]!.position] }));
  const capabilities = mapCapabilities(map);
  const items = sceneCatalog(map);
  const roadBounds = roads.map(road => ({ id: road.id, ...roadWidthBounds(road.points, road.widthM) }));
  return {
    schemaVersion: map.schemaVersion, mapId: map.mapId, mapContentHash: contentHash(map),
    coordinateFrame: structuredClone(map.coordinateFrame), nodes, roads, facilities, zones, accessPoints, servicePoints, items,
    bounds: geometryBounds([...items.filter(item => ['siteBoundary', 'junctions', 'slots'].includes(item.kind)).flatMap(itemPositions), ...nodes.map(n => n.position), ...roadBounds.flatMap(road => road.bounds ? [road.bounds.min, road.bounds.max] : []), ...[...facilities, ...zones].flatMap(entity => [entity.boundary.outer, ...entity.boundary.holes].flat())]),
    missingCapabilities: [...capabilities.unrendered, ...capabilities.unchecked, ...roadBounds.filter(road => road.limited).map(road => `ROAD_WIDTH_VISUAL_RANGE: 道路 ${road.id} 的宽度显示超出有限数值范围；边界已限制，无法完整适应地图。`)],
  };
}
