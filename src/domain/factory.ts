import type { MapNode, MapRoad, Vec3, YardMap } from './model';

export function newMap(mapId: string, name = '未命名地图'): YardMap {
  return {
    schemaVersion: '0.1.0', mapId, revision: 0,
    metadata: { name, description: '', layoutBasis: 'synthetic' },
    coordinateFrame: {
      kind: 'local_cartesian', handedness: 'right', groundPlane: 'XY', upAxis: 'Z',
      lengthUnit: 'm', angleUnit: 'rad', massUnit: 'kg', timeUnit: 's',
    },
    siteBoundary: null, nodes: {}, roads: {}, junctions: {}, movements: {},
    facilities: {}, accessPoints: {}, servicePoints: {}, zones: {}, resources: {},
    sources: {}, assets: {}, backgroundLayers: {}, extensionNamespaces: {}, extensions: {},
  };
}

export function newNode(position: Vec3, name = '节点'): MapNode {
  return { name, position: [...position], kind: 'ordinary', provenance: { category: 'synthetic' } };
}

export function newRoad(fromNodeId: string, toNodeId: string, shapePoints: Vec3[] = [], name = '道路'): MapRoad {
  return {
    name, fromNodeId, toNodeId, shapePoints: shapePoints.map(p => [...p]), direction: 'unknown',
    widthM: { state: 'unknown' }, heightLimitM: { state: 'unknown' },
    massLimitKg: { state: 'unknown' }, speedLimitMps: { state: 'unknown' },
    resourceIds: [], provenance: { category: 'synthetic' },
  };
}