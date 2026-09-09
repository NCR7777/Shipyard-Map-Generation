import type { CoordinateFrame, Vec3 } from '../domain/model';

export interface SceneSnapshot {
  schemaVersion: '0.1.0';
  mapId: string;
  mapContentHash: string;
  coordinateFrame: CoordinateFrame;
  nodes: { id: string; name: string; position: Vec3 }[];
  roads: { id: string; name: string; fromNodeId: string; toNodeId: string; points: Vec3[]; lengthM: number }[];
  bounds: { min: Vec3; max: Vec3 } | null;
  missingCapabilities: string[];
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