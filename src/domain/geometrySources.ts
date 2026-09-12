import type { Provenance, Source, YardMap } from './model';
import type { CommandAffectedRef } from './commands';
import { inspectPlanning, PLANNING_NAMESPACE } from './planning';
import { sameValue } from './value';

const SOURCE: Source = {
  name: '编辑器人工几何设计假设', category: 'design_assumption',
  description: '用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。',
};
const FIELDS = { nodes: 'position', roads: 'shapePoints', facilities: 'boundary', zones: 'boundary', junctions: 'boundary' } as const;

/** Field-level attribution for changed declared geometry, never for derived road lengths. */
export function recordGeometrySources(before: YardMap, after: YardMap, refs: readonly CommandAffectedRef[], copiedIds: Readonly<Record<string, string>> = {}): CommandAffectedRef[] {
  const changes: { provenance: Provenance; field: string }[] = [];
  const seen = new Set<string>();
  const copiedRefs: CommandAffectedRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.kind + '/' + ref.id)) continue;
    seen.add(ref.kind + '/' + ref.id);
    const targetId = Object.hasOwn(copiedIds, ref.id) ? copiedIds[ref.id]! : ref.id;
    if (targetId !== ref.id) copiedRefs.push({ ...ref, id: targetId });
    if (!(ref.kind in FIELDS)) continue;
    const kind = ref.kind as keyof typeof FIELDS;
    const previous = before[kind][ref.id], next = after[kind][targetId];
    if (!previous || !next) continue;
    const field = FIELDS[kind];
    if (!sameValue((previous as unknown as Record<string, unknown>)[field], (next as unknown as Record<string, unknown>)[field])) changes.push({ provenance: next.provenance, field });
    if (kind === 'facilities' || kind === 'zones') {
      const oldSlots = (previous.extensions?.[PLANNING_NAMESPACE] as { slots?: { id: string; boundary: unknown }[] } | undefined)?.slots ?? [];
      const newSlots = (next.extensions?.[PLANNING_NAMESPACE] as { slots?: { id: string; boundary: unknown }[] } | undefined)?.slots ?? [];
      for (const [index, slot] of newSlots.entries()) {
        const old = oldSlots[index];
        if (old?.id === slot.id && !sameValue(old.boundary, slot.boundary)) changes.push({ provenance: next.provenance, field: 'extensions/' + PLANNING_NAMESPACE + '/slots/' + index + '/boundary' });
      }
    }
  }
  if (!changes.length) return copiedRefs;
  const used = new Set((['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const).flatMap(kind => Object.keys(after[kind])));
  for (const slot of inspectPlanning(after).slots) used.add(slot.id);
  let id = 'source_editor_geometry', suffix = 0;
  while (used.has(id) && !sameValue(after.sources[id], SOURCE)) id = 'source_editor_geometry_' + ++suffix;
  const added = !Object.hasOwn(after.sources, id);
  if (added) after.sources[id] = { ...SOURCE };
  for (const { provenance, field } of changes) {
    provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), id])];
    provenance.fieldSources = { ...provenance.fieldSources, [field]: id };
  }
  if (added) copiedRefs.push({ kind: 'sources', id });
  return copiedRefs;
}
