import type { AccessPoint, CoordinateFrame, Facility, MapNode, PhysicalValue, Polygon, ServicePoint, Vec3, YardMap, Zone } from '../domain/model';

export const SCENE_KINDS = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'siteBoundary', 'junctions', 'resources', 'slots', 'movements', 'sources', 'assets', 'backgroundLayers', 'extensions'] as const;
export type SceneKind = typeof SCENE_KINDS[number];
/** Derived directory entries, never a second editable geometry store. */
export interface SceneItem {
  key: string; kind: SceneKind; id: string; name: string; jsonPath: string;
  status: 'geometry' | 'logical' | 'unsupported'; reason: string;
  polygons: Polygon[]; points: Vec3[]; lines: Vec3[][];
  owner?: { kind: 'facilities' | 'zones'; id: string };
}
export interface SceneSnapshot {
  schemaVersion: YardMap['schemaVersion'];
  mapId: string;
  mapContentHash: string;
  coordinateFrame: CoordinateFrame;
  nodes: { id: string; name: string; kind: MapNode['kind']; position: Vec3 }[];
  roads: { id: string; name: string; fromNodeId: string; toNodeId: string; points: Vec3[]; lengthM: number; widthM: PhysicalValue }[];
  facilities: ({ id: string } & Pick<Facility, 'name' | 'kind' | 'boundary' | 'accessPointIds' | 'servicePointIds' | 'heightM'>)[];
  zones: ({ id: string; servicePointIds: string[] } & Pick<Zone, 'name' | 'kind' | 'boundary' | 'passability'>)[];
  accessPoints: ({ id: string; position: Vec3 } & Pick<AccessPoint, 'name' | 'facilityId' | 'nodeId'>)[];
  servicePoints: ({ id: string; position: Vec3 } & Pick<ServicePoint, 'name' | 'kind' | 'facilityId' | 'accessPointId' | 'nodeId' | 'zoneId' | 'arrival'>)[];
  bounds: { min: Vec3; max: Vec3 } | null;
  missingCapabilities: string[];
  items: SceneItem[];
}

export interface RuntimeStateMessage {
  protocolVersion: '0.1.0';
  mapId: string;
  mapContentHash: string;
  scenarioId: string;
  scenarioVersion: string;
  entityId: string;
  sequence: number;
  simulationTime: number;
  occurredAt: number;
  observedAt: number;
  pose: { position: Vec3; yawRad: number };
}

export interface AdapterCapabilities {
  status: 'implemented' | 'documented_interface' | 'unsupported';
  features: readonly string[];
  missingChecks: readonly string[];
}

export interface SimulationInput {
  mapId: string;
  mapContentHash: string;
  compilerVersion: string;
  compiledMap: Readonly<unknown>;
  scenarioId: string;
  scenarioVersion: string;
  scenario: Readonly<unknown>;
}

// Contract only: no implementation is exported or claimed in M1.
export interface SimulationAdapter {
  readonly capabilities: AdapterCapabilities;
  start(input: SimulationInput): AsyncIterable<RuntimeStateMessage>;
  stop(): Promise<void>;
}

export interface RenderAdapter {
  readonly capabilities: AdapterCapabilities;
  setScene(snapshot: SceneSnapshot): void;
  applyRuntimeState?(message: RuntimeStateMessage): void;
  dispose(): void;
}