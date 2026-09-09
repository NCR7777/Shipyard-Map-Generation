import type { YardMap as LegacyMap, ServicePoint as LegacyPoint } from './model.generated';
import type { YardMap as CurrentMap } from './model.v02.generated';
export type * from './model.v02.generated';
export type LegacyServicePoint = LegacyPoint & { zoneId?: never; arrival?: never };
export type LegacyYardMap = Omit<LegacyMap, 'servicePoints'> & { servicePoints: Record<string, LegacyServicePoint> };
export type YardMap = LegacyYardMap | CurrentMap;
export type SchemaVersion = YardMap['schemaVersion'];
export const SCHEMA_VERSION = '0.2.0' as const;
export const SUPPORTED_SCHEMA_VERSIONS = ['0.1.0', '0.2.0'] as const;
export const MAX_JSON_BYTES = 10 * 1024 * 1024;

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
