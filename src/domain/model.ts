export type * from './model.generated';

export const SCHEMA_VERSION = '0.1.0' as const;
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
