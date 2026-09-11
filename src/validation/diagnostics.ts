import type { Issue, YardMap } from '../domain/model';
import { contentHash } from '../domain/serialization';
import { validateMap } from './validate';
import { inspectNetwork } from '../topology/networkDiagnostics';
import { inspectSpatial } from './spatialDiagnostics';

export interface DiagnosticCheck { id: string; status: 'checked' | 'partial' | 'not_checked'; detail: string }
export interface DiagnosticSection { issues: Issue[]; checks: DiagnosticCheck[] }
export interface DiagnosticReport extends DiagnosticSection {
  mapId: string; mapContentHash: string; rulesVersion: 'P2A-1';
  status: 'complete' | 'partial' | 'invalid';
}
/** Explicit, read-only analysis; never called inside validation or a map command. */
export function diagnoseMap(map: YardMap): DiagnosticReport {
  const base = { mapId: map.mapId, mapContentHash: contentHash(map), rulesVersion: 'P2A-1' as const };
  const validation = validateMap(map);
  if (!validation.ok) return { ...base, status: 'invalid', issues: validation.issues, checks: [{ id: 'input', status: 'not_checked', detail: '输入未通过共享结构/引用校验，未运行派生诊断。' }] };
  const parts = [inspectNetwork(map), inspectSpatial(map)];
  const checks = parts.flatMap(part => part.checks);
  return { ...base, status: checks.some(check => check.status !== 'checked') ? 'partial' : 'complete', checks, issues: parts.flatMap(part => part.issues) };
}
