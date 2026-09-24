import type { CapabilityReport, ValidationReport, YardMap } from './model';
import type { SceneSnapshot } from '../adapters/contracts';
import { parseMapWithReport, contentHash } from './serialization';
import { mapCapabilities } from './capabilities';
import { toSceneSnapshot } from '../compiler/scene';

export type LoadResult =
  | { ok: true; map: YardMap; report: ValidationReport; contentHash: string; capabilities: CapabilityReport; scene: SceneSnapshot }
  | { ok: false; report: ValidationReport };

export function loadMap(text: string): LoadResult {
  const parsed = parseMapWithReport(text);
  if (!parsed.ok) return { ok: false, report: { ok: false, profile: 'draft', status: 'invalid', issues: parsed.issues } };
  const { map, report } = parsed;
  let hash: string | undefined, capabilities: CapabilityReport | undefined, scene: SceneSnapshot | undefined;
  // Import and restore read only the map, report and hash; the derived views are built on first read.
  return {
    ok: true, map, report,
    get contentHash() { return hash ??= contentHash(map); },
    get capabilities() { return capabilities ??= mapCapabilities(map); },
    get scene() { return scene ??= toSceneSnapshot(map); },
  };
}
