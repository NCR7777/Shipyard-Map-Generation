import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadMap } from '../src/domain/load';
import { contentHash, serializeMap } from '../src/domain/serialization';
import { applyMapCommand, type MapCommand, type CommandAffectedRef } from '../src/domain/commands';
import { sameValue } from '../src/domain/value';
import { inspectPlanning } from '../src/domain/planning';
import { inspectServiceConnections } from '../src/topology/serviceConnections';
import { diagnoseMap } from '../src/validation/diagnostics';
import { MAX_JSON_BYTES, type YardMap } from '../src/domain/model';
import { validateEditorState } from '../src/editor/projectController';
import { SCENE_KINDS } from '../src/adapters/contracts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MQ_RULE_VERSION = 'MQ01-1';
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
export interface RepairProtection { lockedTypes: string[]; protectedRefs: CommandAffectedRef[]; sourceFilesSha256: Record<string, string> }
const NO_PROTECTION: RepairProtection = { lockedTypes: [], protectedRefs: [], sourceFilesSha256: {} };
function protectedImpact(refs: readonly CommandAffectedRef[], protection: RepairProtection) {
  if (!protection || !Array.isArray(protection.lockedTypes) || !Array.isArray(protection.protectedRefs) || !protection.sourceFilesSha256
    || protection.lockedTypes.some(kind => !SCENE_KINDS.includes(kind as typeof SCENE_KINDS[number]))
    || protection.protectedRefs.some(ref => !ref || !SCENE_KINDS.includes(ref.kind as typeof SCENE_KINDS[number]) || typeof ref.id !== 'string')) throw Error('MQ_INVALID_PROTECTION');
  return refs.filter(ref => protection.lockedTypes.includes(ref.kind) || protection.protectedRefs.some(value => value.kind === ref.kind && value.id === ref.id));
}
export async function readProtection(mapFile: string): Promise<RepairProtection> {
  const result = structuredClone(NO_PROTECTION);
  for (const name of ['editor-state.json', 'map-protection.json']) {
    const file = resolve(dirname(mapFile), name); let info;
    try { info = await stat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.size > MAX_JSON_BYTES) throw Error('MQ_INVALID_PROTECTION_FILE');
    const bytes = await readFile(file), value = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(bytes));
    result.sourceFilesSha256[name] = sha(bytes);
    if (name === 'editor-state.json') result.lockedTypes = validateEditorState(value).drawing.lockedTypes;
    else { if (!Array.isArray(value.protectedRefs) || Object.keys(value).some(key => key !== 'protectedRefs')) throw Error('MQ_INVALID_PROTECTION_FILE'); result.protectedRefs = value.protectedRefs; }
  }
  protectedImpact([], result); return result;
}
/** Re-read sidecar locks after candidate checks, before publishing a plan or applied copy. */
export async function assertRepairProtection(mapFile: string, expected: RepairProtection): Promise<void> {
  if (!sameValue(expected, await readProtection(mapFile))) throw Error('MQ_PROTECTION_CHANGED');
}
export interface RepairEvidence {
  rule: string; classification: 'A' | 'B'; reason: string;
  references: string[]; expectedChange: string;
}
export interface RepairPlan {
  format: 'MQ01_repair_plan_v1'; ruleVersion: typeof MQ_RULE_VERSION;
  mapId: string; baseFileSha256: string; baseContentHash: string;
  protection: RepairProtection; command: MapCommand; evidence: RepairEvidence; expectedContentHash: string;
}
export function dryRunRepair(map: YardMap, fileSha256: string, command: MapCommand, evidence: RepairEvidence, protection: RepairProtection = NO_PROTECTION) {
  const result = applyMapCommand(map, command);
  if (!result.ok) return { ok: false as const, issues: result.issues };
  if (!result.changed) return { ok: false as const, issues: [{ code: 'MQ_NO_CHANGE', message: 'No repair; no revision or source should be created.' }] };
  const locked = protectedImpact(result.transaction!.affectedRefs, protection);
  if (locked.length) return { ok: false as const, issues: [{ code: 'LOCKED_DEPENDENCY', message: JSON.stringify(locked) }] };
  const plan: RepairPlan = { format: 'MQ01_repair_plan_v1', ruleVersion: MQ_RULE_VERSION, mapId: map.mapId,
    baseFileSha256: fileSha256, baseContentHash: contentHash(map), protection: structuredClone(protection), command, evidence, expectedContentHash: contentHash(result.map) };
  return { ok: true as const, plan, transaction: result.transaction, map: result.map };
}
/** One plan is one existing domain command/transaction; neither input nor prior results are overwritten. */
export function applyRepairPlan(map: YardMap, fileSha256: string, plan: RepairPlan, protection: RepairProtection = NO_PROTECTION) {
  if (plan?.format !== 'MQ01_repair_plan_v1' || plan.ruleVersion !== MQ_RULE_VERSION ||
      !plan.evidence || !['A', 'B'].includes(plan.evidence.classification) || !plan.evidence.reason ||
      !Array.isArray(plan.evidence.references) || !plan.evidence.references.length || !plan.evidence.expectedChange)
    throw new Error('MQ_INVALID_PLAN: repair requires explicit rule, classification and evidence.');
  if (plan.mapId !== map.mapId || plan.baseFileSha256 !== fileSha256 || plan.baseContentHash !== contentHash(map))
    throw new Error('MQ_STALE_PLAN: file SHA, mapId or semantic content changed; regenerate the dry run.');
  if (!sameValue(plan.protection, protection)) throw Error('MQ_PROTECTION_CHANGED');
  const result = applyMapCommand(map, plan.command);
  if (!result.ok) return result;
  if (protectedImpact(result.transaction?.affectedRefs ?? [], protection).length) throw Error('LOCKED_DEPENDENCY');
  if (!result.changed || contentHash(result.map) !== plan.expectedContentHash || !sameValue(map.coordinateFrame, result.map.coordinateFrame))
    throw new Error('MQ_RESULT_MISMATCH: dry run and actual transaction differ.');
  return result;
}
async function sourceReceipt() {
  const files: Record<string, string> = {};
  for (const directory of ['src/domain', 'src/geometry', 'src/topology', 'src/validation', 'src/compiler', 'scripts']) {
    for (const entry of await readdir(resolve(ROOT, directory), { withFileTypes: true })) {
      if (entry.isFile() && /\.(ts|py)$/.test(entry.name)) {
        const name = directory + '/' + entry.name; files[name] = sha(await readFile(resolve(ROOT, name)));
      }
    }
  }
  return { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    sourceFilesSha256: files, note: 'Current working source hashes are authoritative; commit alone excludes uncommitted work.' };
}
export async function inspectFile(file: string) {
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_JSON_BYTES) throw Error('MQ_INPUT_SIZE_OR_TYPE');
  const bytes = await readFile(file), originalSha = sha(bytes);
  const loaded = loadMap(new TextDecoder('utf8', { fatal: true }).decode(bytes));
  if (!loaded.ok) throw new Error('MQ_INVALID_MAP: ' + JSON.stringify(loaded.report));
  return { bytes, originalSha, loaded };
}
async function main() {
  const [mode, input, output, planFile, ...extra] = process.argv.slice(2);
  if (!['scan', 'apply', 'plan'].includes(mode ?? '') || !input || !output || extra.length || (mode !== 'scan') !== !!planFile)
    throw new Error('Usage: tsx scripts/MQ01_core.ts scan <map.json> <new-directory> | plan <map.json> <new-directory> <command-evidence.json> | apply <map.json> <new-directory> <plan.json>');
  const { loaded, originalSha } = await inspectFile(resolve(input));
  let map = loaded.map;
  let repair: object | undefined;
  if (mode === 'plan') {
    const request = JSON.parse(await readFile(resolve(planFile!), 'utf8')) as { command: MapCommand; evidence: RepairEvidence };
    const dry = dryRunRepair(map, originalSha, request.command, request.evidence, await readProtection(resolve(input)));
    if (!dry.ok) throw Error('MQ_REPAIR_REJECTED: ' + JSON.stringify(dry.issues));
    map = dry.map; repair = { plan: dry.plan, status: 'dry_run_candidate_only', transaction: dry.transaction };
  }
  if (mode === 'apply') {
    const plan = JSON.parse(await readFile(resolve(planFile!), 'utf8')) as RepairPlan;
    const result = applyRepairPlan(map, originalSha, plan, await readProtection(resolve(input)));
    if (!result.ok) throw new Error('MQ_REPAIR_REJECTED: ' + JSON.stringify(result.issues));
    map = result.map;
    repair = { plan, affectedRefs: result.transaction?.affectedRefs, transaction: result.transaction,
      originalFileUnchanged: sha(await readFile(resolve(input))) === originalSha };
  }
  // All checks finish before creating the output. mkdir without recursive refuses an existing target.
  const serialized = serializeMap(map), roundTrip = loadMap(serialized);
  if (!roundTrip.ok || roundTrip.contentHash !== contentHash(map)) throw new Error('MQ_ROUNDTRIP_FAILED');
  const report = {
    format: 'MQ01_core_report_v1', ruleVersion: MQ_RULE_VERSION, generatedAt: new Date().toISOString(),
    input: { path: resolve(input), fileSha256: originalSha, contentHash: loaded.contentHash },
    mapId: map.mapId, schemaVersion: map.schemaVersion, revision: map.revision, coordinateFrame: map.coordinateFrame,
    contentHash: roundTrip.contentHash, normalizedFileSha256: sha(serialized), source: await sourceReceipt(),
    validation: roundTrip.report, capabilities: roundTrip.capabilities, planning: inspectPlanning(map),
    services: inspectServiceConnections(map), diagnostics: diagnoseMap(map),
    status: mode === 'plan' ? 'dry_run_candidate_only' : 'report_generated', boundary: 'Individual checks retain partial/not_checked; this is not a safety or full-audit pass.',
    repair,
  };
  if (repair && 'plan' in repair) await assertRepairProtection(resolve(input), (repair.plan as RepairPlan).protection);
  if (sha(await readFile(resolve(input))) !== originalSha) throw new Error('MQ_INPUT_CHANGED_DURING_CHECK');
  await mkdir(resolve(output));
  await writeFile(resolve(output, 'map.json'), serialized, { encoding: 'utf8', flag: 'wx' });
  if (repair && 'plan' in repair) await writeFile(resolve(output, 'plan.json'), JSON.stringify(repair.plan, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await writeFile(resolve(output, 'core-report.json'), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: report.status, input, output, contentHash: report.contentHash, repaired: mode === 'apply', candidate: mode === 'plan' }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; }
}
