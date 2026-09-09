import type { AccessPoint, Facility, MapNode, MapRoad, Polygon, SchemaVersion, ServicePoint, Vec3, YardMap, Zone } from './model';

export function newMap(mapId: string, name = '未命名地图', schemaVersion: SchemaVersion = '0.2.0'): YardMap {
  return {
    schemaVersion, mapId, revision: 0,
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
export function newFacility(boundary: Polygon, name = '厂房', kind: Facility['kind'] = 'workshop'): Facility {
  return { name, kind, boundary: structuredClone(boundary), accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
}
export function newZone(boundary: Polygon, name = '作业区', kind: Zone['kind'] = 'work'): Zone {
  return { name, kind, boundary: structuredClone(boundary), passability: 'unknown', resourceIds: [], provenance: { category: 'synthetic' } };
}
export function newAccessPoint(facilityId: string, nodeId: string, name = '入口'): AccessPoint {
  return { name, facilityId, nodeId, provenance: { category: 'synthetic' } };
}
export function newServicePoint(nodeId: string, name = '服务点', kind: ServicePoint['kind'] = 'loading', facilityId?: string, accessPointId?: string): ServicePoint {
  return { name, kind, nodeId, ...(facilityId ? { facilityId } : {}), ...(accessPointId ? { accessPointId } : {}), resourceIds: [], provenance: { category: 'synthetic' } };
}
