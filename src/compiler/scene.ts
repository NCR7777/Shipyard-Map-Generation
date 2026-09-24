import { spatialAppearance } from './spatialColors';
import { isInferredSemantic } from '../domain/semanticPatch';
import { getRoadPath, boundsOfPath } from '../geometry/roadPath';
import { sceneCatalog, itemPositions } from './catalog';
import { zoneServicePointIds } from '../topology/serviceConnections';
import type { MapRoad, YardMap } from '../domain/model';
import type { SceneSnapshot } from '../adapters/contracts';
import { contentHash } from '../domain/serialization';
import { geometryBounds, roadLength, roadPoints, roadWidthBounds } from '../geometry/roads';
import { mapCapabilities } from '../domain/capabilities';
import { freezeDeep } from '../domain/value';
import { SPATIAL_CLASSIFICATION_NAMESPACE } from '../domain/spatialClassification';
function sorted<T>(values: Record<string, T>): [string, T][] { return Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); }

const rows = new Map<string, WeakMap<object, { deps: readonly unknown[]; row: unknown }>>();
/** A derived row is a pure function of its frozen entity and the listed inputs, so unchanged rows survive edits read-only. */
export function sceneRow<T>(kind: string, entity: object, deps: readonly unknown[], build: () => T): T {
  if (!Object.isFrozen(entity)) return build();
  const cache = rows.get(kind) ?? rows.set(kind, new WeakMap()).get(kind)!;
  const hit = cache.get(entity);
  if (hit && hit.deps.length === deps.length && hit.deps.every((dep, index) => dep === deps[index])) return hit.row as T;
  const row = freezeDeep(build()); cache.set(entity, { deps, row }); return row;
}

export function toSceneSnapshot(map: YardMap): SceneSnapshot {
  const classes = [map.extensions[SPATIAL_CLASSIFICATION_NAMESPACE], map.extensionNamespaces[SPATIAL_CLASSIFICATION_NAMESPACE]];
  const nodes: SceneSnapshot['nodes'] = sorted(map.nodes).map(([id, node]) => sceneRow('node', node, [id], () => ({ id, name: node.name, kind: node.kind, position: [...node.position] })));
  const roads: SceneSnapshot['roads'] = sorted<MapRoad>(map.roads).map(([id, road]) => sceneRow('road', road, [id, map.nodes[road.fromNodeId], map.nodes[road.toNodeId]],
    () => ({ id, name: road.name, fromNodeId: road.fromNodeId, toNodeId: road.toNodeId, path: structuredClone(getRoadPath(map, id)), points: roadPoints(map, id), lengthM: roadLength(map, id), direction: road.direction, widthM: structuredClone(road.widthM) })));
  const facilities: SceneSnapshot['facilities'] = sorted(map.facilities).map(([id, facility]) => sceneRow('facility', facility, [id, ...classes],
    () => ({ id, name: facility.name, kind: facility.kind, appearance: spatialAppearance(map, 'facilities', id), ...(isInferredSemantic(facility) ? { inferred: true } : {}), boundary: structuredClone(facility.boundary), accessPointIds: [...facility.accessPointIds], servicePointIds: [...facility.servicePointIds], heightM: structuredClone(facility.heightM) })));
  const zones: SceneSnapshot['zones'] = sorted(map.zones).map(([id, zone]) => {
    const servicePointIds = zoneServicePointIds(map, id);
    return sceneRow('zone', zone, [id, ...classes, servicePointIds.join('\u0000')],
      () => ({ id, appearance: spatialAppearance(map, 'zones', id), servicePointIds, name: zone.name, kind: zone.kind, ...(isInferredSemantic(zone) ? { inferred: true } : {}), boundary: structuredClone(zone.boundary), passability: zone.passability }));
  });
  const accessPoints: SceneSnapshot['accessPoints'] = sorted(map.accessPoints).map(([id, point]) => sceneRow('access', point, [id, map.nodes[point.nodeId]],
    () => ({ id, name: point.name, facilityId: point.facilityId, nodeId: point.nodeId, position: [...map.nodes[point.nodeId]!.position] })));
  const servicePoints: SceneSnapshot['servicePoints'] = sorted(map.servicePoints).map(([id, point]) => sceneRow('service', point, [id, map.nodes[point.nodeId]],
    () => ({ id, name: point.name, kind: point.kind, nodeId: point.nodeId, ...(point.facilityId ? { facilityId: point.facilityId } : {}), ...(point.accessPointId ? { accessPointId: point.accessPointId } : {}), ...(point.zoneId ? { zoneId: point.zoneId } : {}), ...(point.arrival ? { arrival: structuredClone(point.arrival) } : {}), position: [...map.nodes[point.nodeId]!.position] })));
  const capabilities = mapCapabilities(map);
  const items = sceneCatalog(map);
  const roadBounds = roads.map(road => ({ id: road.id, ...roadWidthBounds([boundsOfPath(road.path).min, boundsOfPath(road.path).max], road.widthM) }));
  return {
    schemaVersion: map.schemaVersion, mapId: map.mapId, mapContentHash: contentHash(map),
    coordinateFrame: structuredClone(map.coordinateFrame), nodes, roads, facilities, zones, accessPoints, servicePoints, items,
    bounds: geometryBounds([...items.filter(item => ['siteBoundary', 'junctions', 'slots'].includes(item.kind)).flatMap(itemPositions), ...nodes.map(n => n.position), ...roadBounds.flatMap(road => road.bounds ? [road.bounds.min, road.bounds.max] : []), ...[...facilities, ...zones].flatMap(entity => [entity.boundary.outer, ...entity.boundary.holes].flat())]),
    missingCapabilities: [...capabilities.unrendered, ...capabilities.unchecked, ...roadBounds.filter(road => road.limited).map(road => `ROAD_WIDTH_VISUAL_RANGE: 道路 ${road.id} 的宽度显示超出有限数值范围；边界已限制，无法完整适应地图。`)],
  };
}
