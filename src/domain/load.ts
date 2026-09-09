import type { CapabilityReport, ValidationReport, YardMap } from './model';
import type { SceneSnapshot } from '../adapters/contracts';
import { parseMap, contentHash } from './serialization';
import { validateMap } from '../validation/validate';
import { mapCapabilities } from './capabilities';
import { toSceneSnapshot } from '../compiler/scene';

export type LoadResult =
  | { ok: true; map: YardMap; report: ValidationReport; contentHash: string; capabilities: CapabilityReport; scene: SceneSnapshot }
  | { ok: false; report: ValidationReport };

export function loadMap(text: string): LoadResult {
  const parsed = parseMap(text);
  if (!parsed.ok) return { ok: false, report: { ok: false, profile: 'draft', status: 'invalid', issues: parsed.issues } };
  const report = validateMap(parsed.map);
  return { ok: true, map: parsed.map, report, contentHash: contentHash(parsed.map), capabilities: mapCapabilities(parsed.map), scene: toSceneSnapshot(parsed.map) };
}