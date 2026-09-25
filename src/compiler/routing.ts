import { roadOwner } from '../domain/ownerEditing';
import { inspectPlanning, PLANNING_NAMESPACE } from '../domain/planning';
import type { ArcRef, MapRoad, YardMap } from '../domain/model';
import { contentHash } from '../domain/serialization';
import { validateMap } from '../validation/validate';
import { inspectServiceConnections } from '../topology/serviceConnections';
import { flattenPath, getRoadPath, pathLength, reversePath, GEOMETRY_TOLERANCE_VERSION, type ResolvedPath } from '../geometry/roadPath';

export const COMPILER_VERSION = 'FAST01.1';
export { GEOMETRY_TOLERANCE_VERSION } from '../geometry/roadPath';
export const COMPILE_PROFILE = 'declared-network-v1';
export interface CompiledArc {
  id: string; roadId: string; direction: ArcRef['direction']; fromNodeId: string; toNodeId: string;
  allowed: boolean | null; path: ResolvedPath; lengthM: number; lengthErrorM: number;
  samples: ReturnType<typeof flattenPath>['samples']; spatialErrorM: number;
  ownerEntityId: string | null; provenance: MapRoad['provenance']; extensions?: MapRoad['extensions']; corridorPolygon?: MapRoad['corridorPolygon'];
  widthM: MapRoad['widthM']; speedLimitMps: MapRoad['speedLimitMps'];
  heightLimitM: MapRoad['heightLimitM']; massLimitKg: MapRoad['massLimitKg']; resourceIds: string[];
}
export interface CompiledMap {
  protocolVersion: '1.0'; mapId: string; mapContentHash: string;
  compilerVersion: typeof COMPILER_VERSION; geometryToleranceVersion: typeof GEOMETRY_TOLERANCE_VERSION;
  profile: typeof COMPILE_PROFILE; units: { length: 'm'; time: 's' };
  extensionNamespaces: YardMap['extensionNamespaces']; extensions: YardMap['extensions'];
  facilities: YardMap['facilities']; zones: YardMap['zones']; sources: YardMap['sources']; routingStatus: 'declared' | 'unsupported_extensions';
  coordinateFrame: YardMap['coordinateFrame']; nodes: YardMap['nodes']; arcs: Record<string, CompiledArc>;
  movements: YardMap['movements']; junctions: YardMap['junctions']; resources: YardMap['resources'];
  servicePoints: YardMap['servicePoints']; accessPoints: YardMap['accessPoints'];
  serviceConnections: ReturnType<typeof inspectServiceConnections>; warnings: string[];
}
export const arcId = (ref: ArcRef): string => ref.roadId + ':' + ref.direction;

/** Deterministic, environment-free compilation. Samples are derived arc data, never graph nodes. */
export function compileMap(map: YardMap, profile: string = COMPILE_PROFILE): CompiledMap {
  if (profile !== COMPILE_PROFILE) throw new Error('UNSUPPORTED_COMPILE_PROFILE: ' + profile);
  const report = validateMap(map);
  if (!report.ok) throw new Error(report.issues.filter(i=>i.severity==='error').map(i=>i.code+': '+i.message).join('\n'));
  const arcs: Record<string, CompiledArc> = {};
  const planning = inspectPlanning(map);
  const unsupported = Object.entries(map.extensionNamespaces).filter(([name,declaration])=>declaration.category!=='metadata' && !(name===PLANNING_NAMESPACE&&planning.supported));
  const warnings: string[] = unsupported.map(([name])=>'UNSUPPORTED_EXTENSION: '+name+'; graph references retained but arc permission is unconfirmed');
  if(planning.present&&!planning.supported)warnings.push('UNSUPPORTED_PLANNING: declarations retained without interpreting permissions');
  const blockedExtensions = unsupported.length>0 || planning.present&&!planning.supported;
  for (const [roadId, road] of Object.entries(map.roads).sort(([a],[b])=>a.localeCompare(b))) {
    const path = getRoadPath(map, roadId), length = pathLength(path);
    if (!length.converged || !(length.lengthM > 0)) throw new Error('GEOMETRY_LENGTH_UNRESOLVED: '+roadId);
    for (const direction of ['forward','backward'] as const) {
      const oriented = direction === 'forward' ? path : reversePath(path);
      const flat = flattenPath(oriented);
      if (!flat.converged) throw new Error('GEOMETRY_FLATTEN_UNRESOLVED: '+roadId);
      const id = arcId({roadId,direction});
      arcs[id] = {
        id, roadId, direction,
        fromNodeId: direction==='forward'?road.fromNodeId:road.toNodeId,
        toNodeId: direction==='forward'?road.toNodeId:road.fromNodeId,
        allowed: blockedExtensions||road.direction==='unknown'?null:road.direction==='both'||road.direction===direction,
        ownerEntityId: roadOwner(map,roadId) ?? null, provenance: structuredClone(road.provenance), ...(road.extensions ? {extensions:structuredClone(road.extensions)} : {}), ...(road.corridorPolygon ? {corridorPolygon:structuredClone(road.corridorPolygon)} : {}),
        path: oriented, lengthM:length.lengthM,lengthErrorM:length.errorM,
        samples:flat.samples,spatialErrorM:flat.errorM,
        widthM:structuredClone(road.widthM),speedLimitMps:structuredClone(road.speedLimitMps),
        heightLimitM:structuredClone(road.heightLimitM),massLimitKg:structuredClone(road.massLimitKg),resourceIds:[...road.resourceIds],
      };
    }
    for (const key of ['widthM','speedLimitMps','heightLimitM','massLimitKg'] as const)
      if (road[key].state==='unknown') warnings.push(roadId+': '+key+' unknown');
    if (road.direction==='unknown') warnings.push(roadId+': direction unknown; arcs cannot be assumed allowed');
  }
  return {
    protocolVersion:'1.0',mapId:map.mapId,mapContentHash:contentHash(map),compilerVersion:COMPILER_VERSION,
    geometryToleranceVersion:GEOMETRY_TOLERANCE_VERSION,profile:COMPILE_PROFILE,units:{length:'m',time:'s'},
    extensionNamespaces:structuredClone(map.extensionNamespaces),extensions:structuredClone(map.extensions),
    facilities:structuredClone(map.facilities),zones:structuredClone(map.zones),sources:structuredClone(map.sources),routingStatus:blockedExtensions?'unsupported_extensions':'declared',
    coordinateFrame:structuredClone(map.coordinateFrame),nodes:structuredClone(map.nodes),arcs,
    movements:structuredClone(map.movements),junctions:structuredClone(map.junctions),resources:structuredClone(map.resources),
    servicePoints:structuredClone(map.servicePoints),accessPoints:structuredClone(map.accessPoints),
    serviceConnections:inspectServiceConnections(map),warnings,
  };
}
