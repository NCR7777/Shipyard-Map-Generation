/** MQ01 automatic A-only pass. Full evidence-bearing command guards remain authoritative. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { inspectFile, dryRunRepair, applyRepairPlan, readProtection } from './MQ01_core';
import { serializeMap, contentHash } from '../src/domain/serialization';
import { sameValue } from '../src/domain/value';
import { roadPoints, polylineLength2D } from '../src/geometry/roads';
import type { YardMap } from '../src/domain/model';
import type { MapCommand } from '../src/domain/commands';
import { checkMQ01AutomaticSuppression, TopologyError } from '../src/domain/topologyEditing';

const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const length = (map: YardMap) => Object.keys(map.roads).reduce((sum, id) => sum + polylineLength2D(roadPoints(map, id)), 0);
function candidates(map: YardMap) {
  const incident = new Map<string, string[]>();
  for (const [id, road] of Object.entries(map.roads)) for (const node of [road.fromNodeId, road.toNodeId]) {
    const values = incident.get(node) ?? []; values.push(id); incident.set(node, values);
  }
  return [...incident].filter(([, roads]) => roads.length === 2).sort(([a], [b]) => a.localeCompare(b));
}
async function main() {
  const [input, output, selectedNode, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length) throw Error('Usage: tsx scripts/MQ01_simplify.ts <map.json> <new-directory> [trial-node-id]');
  const { loaded, originalSha } = await inspectFile(input); let map = loaded.map, currentSha = originalSha;
  const protection = await readProtection(input);
  const accepted: object[] = [], rejected: object[] = [], passes: object[] = [];
  let stablePasses = 0, pass = 0;
  while (stablePasses < (selectedNode ? 1 : 2)) {
    const available = candidates(map).filter(([node]) => !selectedNode || selectedNode === node);
    let changes = 0;
    for (const [nodeId, originalRoadIds] of available) {
      if (!map.nodes[nodeId] || originalRoadIds.some(id => !map.roads[id])) continue;
      const roads = [...originalRoadIds].sort();
      const first = map.roads[roads[0]!]!, second = map.roads[roads[1]!]!;
      // Safe automatic pass is narrower than explicit user-driven suppress: no business-node semantics disappear.
      try { checkMQ01AutomaticSuppression(map, nodeId); }
      catch (error) {
        if (!(error instanceof TopologyError)) throw error;
        rejected.push({ pass, nodeId, roadIds: roads, status: 'retained_semantics', code: error.code, jsonPath: error.path }); continue;
      }
      const policy = !sameValue(first.extensions, second.extensions) ? 'mq01_reference_corridor' as const : undefined;
      const command: MapCommand = { type: 'suppressDegree2Node', nodeId, retainedRoadId: roads[0]!, ...(policy ? { metadataPolicy: policy } : {}) };
      const evidence = { rule: 'MQ-N01', classification: 'A' as const,
        reason: 'Only an ordinary degree-two representation node; existing domain guards prove explicit resource-free continuation, compatible directional fields and protected references. Existing bend is retained as geometry.',
        references: ['MQ01_MAP_AUDIT_REPAIR_TASK.md#MQ-N01', 'original:' + resolve(input) + '#sha256=' + originalSha,
          ...(policy ? ['shipyard.reference@1.0 adjacent corridor interval contract; complete prior fields retained in map source'] : [])],
        expectedChange: 'One ordinary node and redundant interval removed; same geometric traversal, external permissions and resource capacity; stable retained IDs.' };
      const dry = dryRunRepair(map, currentSha, command, evidence, protection);
      if (!dry.ok) { rejected.push({ pass, nodeId, roadIds: roads, status: 'expected_blocked_or_unsupported', issues: dry.issues }); continue; }
      const applied = applyRepairPlan(map, currentSha, dry.plan, await readProtection(input));
      if (!applied.ok) throw Error('MQ_APPLY_DIFFERS_FROM_DRY_RUN: ' + JSON.stringify(applied.issues));
      if (Math.abs(length(map) - length(applied.map)) > 1e-6 || map.mapId !== applied.map.mapId || !sameValue(map.coordinateFrame, applied.map.coordinateFrame)) throw Error('MQ_EQUIVALENCE_CHECK_FAILED');
      for (const [id, resource] of Object.entries(map.resources)) {
        const after = applied.map.resources[id]!;
        if (!sameValue({ ...resource, appliesTo: [], provenance: undefined }, { ...after, appliesTo: [], provenance: undefined })) throw Error('MQ_RESOURCE_MODEL_CHANGED');
        const expectedRefs = resource.appliesTo.map(ref => ref.entityType === 'roads' && ref.entityId === roads[1] ? { ...ref, entityId: roads[0]! } : ref)
          .filter((ref, index, all) => all.findIndex(item => sameValue(item, ref)) === index);
        if (!sameValue(expectedRefs, after.appliesTo)) throw Error('MQ_RESOURCE_SCOPE_CHANGED');
        const retainedSources = new Set([...(after.provenance.sourceRefs ?? []), ...Object.values(after.provenance.fieldSources ?? {})]);
        if ([...(resource.provenance.sourceRefs ?? []), ...Object.values(resource.provenance.fieldSources ?? {})].some(source => !retainedSources.has(source))) throw Error('MQ_RESOURCE_SOURCE_LOST');
      }
      const transaction = applied.transaction!;
      const changedEntities = transaction.affectedRefs.map(ref => {
        const collection = ref.kind as keyof YardMap;
        return { ...ref, before: (transaction.before[collection] as Record<string, unknown> | undefined)?.[ref.id],
          after: (transaction.after[collection] as Record<string, unknown> | undefined)?.[ref.id] };
      }).filter(item => !sameValue(item.before, item.after));
      accepted.push({ pass, plan: dry.plan, beforeRevision: map.revision, afterRevision: applied.map.revision,
        removedNodeId: nodeId, retainedRoadId: roads[0], removedRoadId: roads[1],
        beforeLengthM: length(map), afterLengthM: length(applied.map), changedEntities,
        rollback: 'Restore changedEntities.before and base map snapshot; runtime uses original transaction.before in one undo.' });
      map = applied.map; currentSha = sha(serializeMap(map)); changes++;
      process.stdout.write(JSON.stringify({ mapId: map.mapId, pass, repairedNode: nodeId, accepted: accepted.length }) + '\n');
    }
    passes.push({ pass, considered: available.length, changes }); pass++;
    stablePasses = changes ? 0 : stablePasses + 1;
    if (selectedNode && changes) break;
  }
  if (!sameValue(protection, await readProtection(input))) throw Error('MQ_PROTECTION_CHANGED');
  if (sha(await readFile(input)) !== originalSha) throw Error('MQ_ORIGINAL_CHANGED');
  await mkdir(resolve(output));
  const files = { 'map.json': serializeMap(map), 'repair-ledger.json': JSON.stringify({ format: 'MQ01_A_repair_ledger_v1', input: resolve(input),
    protection, originalFileSha256: originalSha, originalContentHash: loaded.contentHash, finalFileSha256: sha(serializeMap(map)), finalContentHash: contentHash(map),
    originalCoordinateFrame: loaded.map.coordinateFrame, coordinateFrameUnchanged: sameValue(loaded.map.coordinateFrame, map.coordinateFrame),
    passes, accepted, rejected, status: selectedNode ? 'representative_trial_only' : 'A_rule_pass_only_B_C_and_full_acceptance_outstanding',
    limitation: 'Repeated corridor chains may require an explicit interval-lineage extension; a command refusal is not automatically a need for business permission.' }, null, 2) + '\n' };
  for (const [name, text] of Object.entries(files)) await writeFile(resolve(output, name), text, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(JSON.stringify({ mapId: map.mapId, output, repairs: accepted.length, remainingDegreeTwo: candidates(map).length, contentHash: contentHash(map) }) + '\n');
}
try { await main(); } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
