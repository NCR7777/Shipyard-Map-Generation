import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectAccessDetachment } from '../src/domain/accessDetachment';
import { commandSupport, type CommandAffectedRef, type MapCommand } from '../src/domain/commands';
import { loadMap } from '../src/domain/load';
import type { Vec3, YardMap } from '../src/domain/model';
import { nodeOwners, roadOwner } from '../src/domain/ownerEditing';
import { inspectPlanning } from '../src/domain/planning';
import { contentHash, serializeMap } from '../src/domain/serialization';
import { createSession, editSession, redoSession, undoSession } from '../src/editor/session';
import { assertRepairProtection, readProtection } from './MQ01_core';

// MQ01 originals are authoritative frozen inputs; CLI relocation never changes their expected identity.
const INPUTS = [
  {
    "yard": "cimc",
    "sha256": "98f2fe6c3bbb290ac70fb6dde19e64fa2b25dc537e8d66720b0f6e7866273a27",
    "mapId": "MAP_CR_REFERENCE_V02",
    "contentHash": "8aa49a68458244fd522577e6b59c6c300aff06b90f8be22e72b7f5007909eec3"
  },
  {
    "yard": "dalian",
    "sha256": "d0d2d2f887cd9fff16b074fc4840beb0dcdc8f92212a586e1a0dbd1a673b26e5",
    "mapId": "MAP_DL_REFERENCE_V02",
    "contentHash": "426e53625e714a656f7dae75357ec0685df66364c0bb58eee0dacd740d4d651f"
  },
  {
    "yard": "geoje",
    "sha256": "c39ebb10a02e61047fb5de0e5d19a4ddf02d19b9f6e3e67ad7fc355740b5ae27",
    "mapId": "MAP_GJ_REFERENCE_V02",
    "contentHash": "2743a340c6ec0aa539469ff6ec4a4cfc604e468e9ea80da0b8c7a86d314f3285"
  },
  {
    "yard": "hanwha",
    "sha256": "026bf0c409b151aa005fe59d50e0aeda294eca83a5fbccf9b5927b9190cb4749",
    "mapId": "MAP_HW_REFERENCE_V02",
    "contentHash": "99e32298fe1ccfcde5838edea1221d2fab6c2c4ae04aff3d68a710a4926912f6"
  },
  {
    "yard": "hudong",
    "sha256": "950d81fe16c73088d9cd82dc2dece3e3192eebc81cdf49203dcc869889e59fdb",
    "mapId": "MAP_HD_REFERENCE_V02",
    "contentHash": "468349bdbbbe441f3404807983afcc901bb3770b406815158ba2778437736a0f"
  },
  {
    "yard": "newtimes",
    "sha256": "2b91e6709cf96328a5a1866a3f88ca58bac6669f43f23d6093039112ea440787",
    "mapId": "MAP_NT_REFERENCE_V02",
    "contentHash": "b7ac634881ced9d6e6249e4b13de8dec3c115a305309169a6f01a064e34660cb"
  },
  {
    "yard": "samho",
    "sha256": "d403713aaa14aabe48a35095b1f473958d399f7bf37d2509709ff0e04dfa6fe3",
    "mapId": "MAP_SH_REFERENCE_V02",
    "contentHash": "28ef4450d0c5e0f0179e1c5bc410118fc560be2df12b728dd14d829c4a955a0c"
  },
  {
    "yard": "weihai",
    "sha256": "c36dae426b9a02a20b75eefc79f09ffa7c415bd08adc0ad2cb677d4c64585315",
    "mapId": "WH_CM_REFERENCE_V01",
    "contentHash": "662acb1a567c20fd615885f210a568bfb4d1bc1628c87c9894e5dc84af1c0517"
  },
  {
    "yard": "xinyangzi",
    "sha256": "e8f7db8ffbceb50a8963e90d5f6f27896619629274275fb8805b3256c17dde0a",
    "mapId": "MAP_XY_REFERENCE_V02",
    "contentHash": "88b501efb92e85ca74a6d16a500ee4d973357a9f509ac37fead0fddd0d8b9c14"
  }
];
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

function sourceHashes() {
  const files = ['scripts/EA01_repair_access.ts', 'scripts/MQ01_core.ts', 'src/editor/session.ts'];
  for (const directory of ['src/domain', 'src/geometry', 'src/topology', 'src/validation', 'src/compiler']) {
    for (const name of readdirSync(resolve(ROOT, directory))) if (name.endsWith('.ts')) files.push(directory + '/' + name);
  }
  return Object.fromEntries(files.sort().map(name => [name, sha(readFileSync(resolve(ROOT, name)))]));
}
function entity(map: YardMap, ref: CommandAffectedRef): unknown {
  return COLLECTIONS.some(kind => kind === ref.kind)
    ? (map[ref.kind as typeof COLLECTIONS[number]] as Record<string, unknown>)[ref.id] : undefined;
}
function roundTrip(map: YardMap): string {
  const text = serializeMap(map), loaded = loadMap(text);
  assert(loaded.ok && loaded.report.ok, 'EA01 roundtrip validation failed');
  assert.deepEqual(loaded.map, map); assert.equal(loaded.contentHash, contentHash(map));
  return text;
}
function preserveBase(original: YardMap, candidate: YardMap) {
  assert.equal(candidate.mapId, original.mapId);
  assert.deepEqual(candidate.coordinateFrame, original.coordinateFrame);
  for (const kind of ['facilities', 'zones', 'resources', 'assets', 'backgroundLayers'] as const) assert.deepEqual(candidate[kind], original[kind]);
  for (const [id, node] of Object.entries(original.nodes)) assert.deepEqual(candidate.nodes[id], node);
  for (const [id, road] of Object.entries(original.roads)) if (!roadOwner(original, id)) assert.deepEqual(candidate.roads[id], road);
  for (const [id, junction] of Object.entries(original.junctions)) assert.deepEqual(candidate.junctions[id], junction);
  for (const [id, source] of Object.entries(original.sources)) assert.deepEqual(candidate.sources[id], source);
  for (const [id, movement] of Object.entries(original.movements)) {
    const current = candidate.movements[id]; assert(current, 'Existing movement must retain its ID');
    // Only arc IDs and their explicit provenance may change; permission, resources and geometry must remain.
    assert.deepEqual(current, { ...movement, incomingArc: current.incomingArc, outgoingArc: current.outgoingArc, provenance: current.provenance });
    assert.equal(current.incomingArc.direction, movement.incomingArc.direction); assert.equal(current.outgoingArc.direction, movement.outgoingArc.direction);
  }
}
function allocatedIds(map: YardMap, accessId: string) {
  const used = new Set(COLLECTIONS.flatMap(kind => Object.keys(map[kind])));
  for (const slot of inspectPlanning(map).slots) used.add(slot.id);
  function allocate(prefix: string) {
    const stem = prefix + accessId; let id = stem, index = 0;
    while (used.has(id)) id = stem + '_' + ++index;
    used.add(id); return id;
  }
  return { nodeId: allocate('N_EA01_'), connectorRoadId: allocate('R_EA01_ACCESS_'), internalRoadId: allocate('R_EA01_INTERNAL_') };
}
function sharedAnchor(map: YardMap, id: string): boolean {
  const access = map.accessPoints[id]!, refs = nodeOwners(map, access.nodeId);
  const incident = Object.keys(map.roads).filter(roadId => {
    const road = map.roads[roadId]!; return road.fromNodeId === access.nodeId || road.toNodeId === access.nodeId;
  });
  const external = incident.filter(roadId => !roadOwner(map, roadId));
  return external.length >= 2 || external.length > 0 && (refs.owners.size !== 1 || refs.unownedPoint || incident.some(roadId => roadOwner(map, roadId) && roadOwner(map, roadId) !== access.facilityId));
}
function probeMovement(map: YardMap, id: string, kind: 'accessPoints' | 'facilities', delta: Vec3) {
  const command: MapCommand = kind === 'facilities'
    ? { type: 'translateSelection', selection: { nodes: [], roads: [], facilities: [id] }, facilityMovePolicy: 'withStaticContents', delta }
    : { type: 'movePoint', kind, id, position: map.nodes[map.accessPoints[id]!.nodeId]!.position.map((value, axis) => value + delta[axis]!) as Vec3 };
  const before = createSession(map, true), support = commandSupport(map, command), result = editSession(before, command);
  if (!result.ok) assert.equal(result.session, before, 'Failed probe must preserve map/history identity');
  else {
    assert.equal(result.session.past.length, 1);
    assert.deepEqual(result.session.map.coordinateFrame, map.coordinateFrame);
    assert.deepEqual(result.session.map.resources, map.resources);
    assert.deepEqual(result.session.map.movements, map.movements);
    for (const [roadId, road] of Object.entries(map.roads)) if (!roadOwner(map, roadId)) {
      // Access connectors derive geometry from their private endpoint; the public road record itself stays unchanged.
      assert.deepEqual(result.session.map.roads[roadId], road);
    }
    for (const [nodeId, node] of Object.entries(map.nodes)) {
      const publicRoads = Object.entries(map.roads).filter(([roadId, road]) => !roadOwner(map, roadId) && (road.fromNodeId === nodeId || road.toNodeId === nodeId));
      if (publicRoads.length >= 2) assert.deepEqual(result.session.map.nodes[nodeId], node);
    }
    assert.deepEqual(undoSession(result.session).map, before.map);
    assert.deepEqual(redoSession(undoSession(result.session)).map, result.session.map);
  }
  return { kind, id, delta, preflightAllowed: support.allowed, accepted: result.ok, issues: result.issues,
    failureKeepsSessionIdentity: !result.ok, acceptedUndoRedoExact: result.ok };
}

async function main() {
  const [inputArg, outputArg, ...extra] = process.argv.slice(2);
  if (!inputArg || !outputArg || extra.length) throw Error('Usage: tsx scripts/EA01_repair_access.ts <frozen-MQ01-root> <new-output-directory>');
  const inputRoot = resolve(inputArg), outputRoot = resolve(outputArg);
  if (existsSync(outputRoot)) throw Error('EA01_OUTPUT_EXISTS: refusing to overwrite ' + outputRoot);
  if (outputRoot === inputRoot || outputRoot.startsWith(inputRoot + sep) || inputRoot.startsWith(outputRoot + sep)) throw Error('EA01_OUTPUT_OVERLAPS_INPUT');
  const startedAt = new Date().toISOString(), sources = sourceHashes();
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const bundles: { yard: string; text: string; report: Record<string, unknown> }[] = [];
  const manifest: Record<string, unknown>[] = [];
  const protectionReceipts: { file: string; protection: Awaited<ReturnType<typeof readProtection>> }[] = [];
  for (const frozen of INPUTS) {
    const file = resolve(inputRoot, frozen.yard, 'map.json');
    let bytes: Buffer;
    try { bytes = readFileSync(file); } catch (cause) { throw new Error('blocked_input: missing frozen original ' + file, { cause }); }
    assert.equal(sha(bytes), frozen.sha256, 'blocked_input: frozen file SHA mismatch: ' + file);
    const loaded = loadMap(bytes.toString('utf8')); assert(loaded.ok && loaded.report.ok, 'blocked_input: invalid map ' + file);
    assert.equal(loaded.map.mapId, frozen.mapId); assert.equal(loaded.contentHash, frozen.contentHash);
    const original = loaded.map, protection = await readProtection(file);
    protectionReceipts.push({ file, protection });
    let map = original;
    const records: Record<string, unknown>[] = [], repairedAccessIds: string[] = [];
    for (const id of Object.keys(original.accessPoints).sort()) {
      const originalAccess = original.accessPoints[id]!;
      if (!sharedAnchor(original, id)) { records.push({ id, ownerId: originalAccess.facilityId, status: 'already_dedicated_or_not_shared', reason: 'A public-road access is not intrinsically erroneous; no relocation inferred from containment.' }); continue; }
      const info = inspectAccessDetachment(map, id);
      if (!info.supported) { records.push({ id, ownerId: originalAccess.facilityId, status: 'retained_unsupported', issues: info.issues }); continue; }
      const command: MapCommand = { type: 'detachAccessPoint', id, distanceM: info.suggestedDistanceM, ...allocatedIds(map, id) };
      const support = commandSupport(map, command);
      const locked = support.affectedRefs.filter(ref => protection.lockedTypes.includes(ref.kind) || protection.protectedRefs.some(value => value.kind === ref.kind && value.id === ref.id));
      if (locked.length) { records.push({ id, ownerId: originalAccess.facilityId, status: 'retained_locked', affectedRefs: locked }); continue; }
      const before = createSession(map, true), result = editSession(before, command);
      if (!result.ok) {
        assert.equal(result.session, before); records.push({ id, ownerId: originalAccess.facilityId, status: 'retained_command_rejected', info, command, preflightAllowed: support.allowed, issues: result.issues, unchangedSessionIdentity: true }); continue;
      }
      assert.equal(result.session.past.length, 1); assert.equal(result.session.map.revision, map.revision + 1);
      preserveBase(original, result.session.map);
      assert.deepEqual(undoSession(result.session).map, before.map);
      assert.deepEqual(redoSession(undoSession(result.session)).map, result.session.map);
      roundTrip(result.session.map);
      const transaction = result.session.past[0]!;
      const changes = transaction.affectedRefs.map(ref => ({ ...ref, before: entity(map, ref), after: entity(result.session.map, ref) }));
      records.push({ id, ownerId: originalAccess.facilityId, status: 'repaired', command, info, preflightAllowed: support.allowed,
        beforeHash: contentHash(map), afterHash: contentHash(result.session.map), issues: result.issues, affectedRefs: transaction.affectedRefs, changes,
        lineageBefore: map.extensions?.['org.shipyard.editor.lineage'], lineageAfter: result.session.map.extensions?.['org.shipyard.editor.lineage'],
        assumption: 'Entry chosen along an existing explicit owned straight approach using the core suggestion. Upstream connector becomes external access; downstream remains private. This is a design edit, not surveyed evidence.',
        verified: { oneTransaction: true, exactUndoRedo: true, exactJsonRoundtrip: true, originalNodesAndPublicRoadsUnchanged: true, capacitiesAndExistingTurnPermissionsUnchanged: true } });
      map = result.session.map; repairedAccessIds.push(id);
      console.log(json({ yard: frozen.yard, repaired: repairedAccessIds.length, accessId: id }).trim());
    }
    const movementProbes = repairedAccessIds.flatMap(id => ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as Vec3[]).flatMap(delta => [
      probeMovement(map, id, 'accessPoints', delta), probeMovement(map, map.accessPoints[id]!.facilityId, 'facilities', delta),
    ]));
    if (frozen.yard === 'hanwha') movementProbes.push(probeMovement(map, 'F_HW099', 'facilities', [20, 0, 0]));
    preserveBase(original, map); const text = roundTrip(map), finalHash = contentHash(map);
    await assertRepairProtection(file, protection); assert.equal(sha(readFileSync(file)), frozen.sha256);
    const statuses = Object.fromEntries([...new Set(records.map(record => String(record.status)))].map(status => [status, records.filter(record => record.status === status).length]));
    const entry = { ...frozen, inputPath: file, outputPath: frozen.yard + '/map.json', outputSha256: sha(text), outputContentHash: finalHash,
      originalRevision: original.revision, outputRevision: map.revision, coordinateFrame: original.coordinateFrame, statuses,
      movementProbes: { attempts: movementProbes.length, accepted: movementProbes.filter(probe => probe.accepted).length, refused: movementProbes.filter(probe => !probe.accepted).length },
      unchangedOriginalSha256: true, oldScenarioBinding: finalHash === loaded.contentHash ? 'unchanged' : 'invalidated_requires_explicit_rebinding_and_preflight' };
    manifest.push(entry); bundles.push({ yard: frozen.yard, text, report: { ...entry, protection, records, movementProbes,
      scope: 'Static reference repair; move probes are independent four-direction 1m transactions, not permission for arbitrary future movement or transport feasibility.' } });
    console.log(json({ yard: frozen.yard, statuses, probes: entry.movementProbes }).trim());
  }
  assert.deepEqual(sourceHashes(), sources, 'EA01_CORE_CHANGED_DURING_RUN: rerun with stable current source');
  for (const input of INPUTS) assert.equal(sha(readFileSync(resolve(inputRoot, input.yard, 'map.json'))), input.sha256);
  for (const receipt of protectionReceipts) await assertRepairProtection(receipt.file, receipt.protection);
  // All nine results finish in memory; mkdir without recursive and wx writes refuse existing deliverables.
  mkdirSync(outputRoot);
  for (const bundle of bundles) {
    const directory = resolve(outputRoot, bundle.yard); mkdirSync(directory);
    writeFileSync(resolve(directory, 'map.json'), bundle.text, { encoding: 'utf8', flag: 'wx' });
    writeFileSync(resolve(directory, 'repair-report.json'), json(bundle.report), { encoding: 'utf8', flag: 'wx' });
  }
  writeFileSync(resolve(outputRoot, 'manifest.json'), json({ format: 'EA01_access_repair_v1', startedAt, completedAt: new Date().toISOString(), inputRoot, outputRoot,
    command: process.argv, environment: { node: process.version, platform: process.platform, arch: process.arch }, sourceCommit, sourceFilesSha256: sources, maps: manifest,
    limitation: 'Map JSON copies only. Images/assets are not embedded. Existing scenarios, logs and external results were neither copied nor rebound. Retained cases are explicit limitations, not false passes.' }), { encoding: 'utf8', flag: 'wx' });
  console.log(json({ status: 'completed', outputRoot, maps: manifest }).trim());
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
