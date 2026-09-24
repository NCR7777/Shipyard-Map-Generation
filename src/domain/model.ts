import type { YardMap as LegacyMap, ServicePoint as LegacyPoint } from './model.generated';
import type { YardMap as V02Map, MapRoad as PolylineMapRoad } from './model.v02.generated';
import type { YardMap as V03Map, MapRoad as PathMapRoad } from './model.v03.generated';
export type * from './model.v03.generated';
export type LegacyServicePoint = LegacyPoint & { zoneId?: never; arrival?: never };
export type LegacyRoad = PolylineMapRoad & { geometry?: never };
export type PathRoad = PathMapRoad & { shapePoints?: never };
export type MapRoad = LegacyRoad | PathRoad;
export type LegacyYardMap = Omit<LegacyMap, 'servicePoints' | 'roads'> & { servicePoints: Record<string, LegacyServicePoint>; roads: Record<string, LegacyRoad> };
export type YardMapV02 = Omit<V02Map, 'roads'> & { roads: Record<string, LegacyRoad> };
export type YardMapV03 = Omit<V03Map, 'roads'> & { roads: Record<string, PathRoad> };
export type YardMap = LegacyYardMap | YardMapV02 | YardMapV03;
export type SchemaVersion = YardMap['schemaVersion'];
export const SCHEMA_VERSION = '0.3.0' as const;
export const SUPPORTED_SCHEMA_VERSIONS = ['0.1.0', '0.2.0', '0.3.0'] as const;
export const MAX_JSON_BYTES = 10 * 1024 * 1024;
/** Top-level records of entities keyed by stable ID. */
export const ENTITY_RECORDS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;

export interface Issue {
  code: string;
  severity: 'error' | 'warning';
  entityType?: string;
  entityId?: string;
  jsonPath: string;
  message: string;
  suggestedAction: string;
  location?: { line?: number; column?: number; position?: [number, number, number] };
}

export interface ValidationReport {
  ok: boolean;
  profile: string;
  status: 'valid' | 'invalid' | 'unsupported';
  issues: Issue[];
}

export interface CapabilityReport {
  editable: boolean;
  unrendered: string[];
  unchecked: string[];
  reasons: string[];
}
