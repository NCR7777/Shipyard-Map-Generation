import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { loadMap } from '../src/domain/load';
import { sameValue } from '../src/domain/value';
import { MAX_JSON_BYTES, type ArcRef, type YardMap } from '../src/domain/model';
import { preparePathPreview, type PathEndpoint, type PathPreviewReport, type PathRoute } from '../src/topology/pathPreview';

const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
interface InventoryRecord { rule: string; code: string; ids: string[] }
interface Inventory { format: string; binding: { mapId: string; fileSha256: string; contentHash: string }; records: InventoryRecord[] }
interface Pair { from: PathEndpoint; to: PathEndpoint; servicePair: boolean; candidateIndices: number[] }
const pairKey = (from: PathEndpoint, to: PathEndpoint) => JSON.stringify([from.kind, from.id, to.kind, to.id]);
const turnKey = (a: ArcRef, b: ArcRef) => JSON.stringify([a.roadId, a.direction, b.roadId, b.direction]);

/** Local candidate boundary, not geometry-based connectivity or inferred business access. */
export function candidateBoundary(map: YardMap, record: InventoryRecord): string[] {
  const nodes = new Set<string>(), roads = new Set<string>();
  for (const ref of record.ids) {
    const [kind, id] = ref.split('/');
    if (kind === 'nodes') { if (!id || !Object.hasOwn(map.nodes, id)) throw new Error('MQ_INVENTORY_REFERENCE: ' + ref); nodes.add(id); }
    if (kind === 'roads') { if (!id || !Object.hasOwn(map.roads, id)) throw new Error('MQ_INVENTORY_REFERENCE: ' + ref); roads.add(id); }
  }
  for (const [id, road] of Object.entries(map.roads)) if (nodes.has(road.fromNodeId) && nodes.has(road.toNodeId)) roads.add(id);
  for (const id of roads) { const road = map.roads[id]!; nodes.add(road.fromNodeId); nodes.add(road.toNodeId); }
  return [...nodes].filter(id => {
    const incident = Object.entries(map.roads).filter(([, road]) => road.fromNodeId === id || road.toNodeId === id);
    return incident.some(([roadId]) => !roads.has(roadId)) || incident.length <= 1;
  }).sort();
}

export async function runRoutes(input: string, output: string, inventoryPath?: string) {
  const started = performance.now(); const inputPath = resolve(input), outputPath = resolve(output);
  if (inputPath === outputPath) throw new Error('MQ_OUTPUT_EXISTS: input cannot be output');
  try { await stat(outputPath); throw new Error('MQ_OUTPUT_EXISTS: refuse overwrite ' + outputPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const sourceFiles: Record<string, string> = {};
  for (const path of ['scripts/MQ01_routes.ts', 'src/topology/pathPreview.ts', 'src/topology/serviceConnections.ts', 'src/domain/planning.ts', 'src/domain/serialization.ts', 'src/domain/value.ts', 'src/domain/load.ts', 'src/geometry/roads.ts']) sourceFiles[path] = sha(await readFile(new URL('../' + path, import.meta.url)));
  const inputStat = await stat(inputPath);
  if (!inputStat.isFile() || inputStat.size > MAX_JSON_BYTES) throw new Error('MQ_INPUT_SIZE: map must be a file within the shared 10 MiB limit');
  const bytes = await readFile(inputPath), fileSha256 = sha(bytes);
  const loaded = loadMap(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!loaded.ok) throw new Error('MQ_INVALID_MAP: ' + JSON.stringify(loaded.report));
  const map = loaded.map, prepared = preparePathPreview(map);
  const pairs = new Map<string, Pair>();
  const add = (from: PathEndpoint, to: PathEndpoint, index?: number) => {
    const key = pairKey(from, to), old = pairs.get(key);
    if (old) { if (index !== undefined) old.candidateIndices.push(index); return; }
    pairs.set(key, { from, to, servicePair: index === undefined, candidateIndices: index === undefined ? [] : [index] });
  };
  const serviceIds = Object.keys(map.servicePoints).sort();
  for (const from of serviceIds) for (const to of serviceIds) if (from !== to) add({ kind: 'servicePoints', id: from }, { kind: 'servicePoints', id: to });
  const candidates: { index: number; rule: string; code: string; boundaryNodeIds: string[]; directedPairs: number; status: string }[] = [];
  let inventorySha256: string | null = null;
  if (inventoryPath) {
    const inventoryBytes = await readFile(inventoryPath); inventorySha256 = sha(inventoryBytes);
    const inventory = JSON.parse(inventoryBytes.toString('utf8')) as Inventory;
    if (inventory.format !== 'MQ01_full_geometry_inventory_v1' || !Array.isArray(inventory.records)
      || inventory.binding?.mapId !== map.mapId || inventory.binding.fileSha256 !== fileSha256 || inventory.binding.contentHash !== prepared.mapContentHash)
      throw new Error('MQ_INVENTORY_BINDING: inventory does not bind to this exact input');
    inventory.records.forEach((record, index) => {
      if (!Array.isArray(record.ids) || record.ids.some(value => typeof value !== 'string')) throw new Error('MQ_INVENTORY_INVALID: record ' + index);
      const applicable = record.ids.some(value => /^(nodes|roads)\//.test(value));
      const boundaryNodeIds = applicable ? candidateBoundary(map, record) : [];
      candidates.push({ index, rule: record.rule, code: record.code, boundaryNodeIds, directedPairs: boundaryNodeIds.length * (boundaryNodeIds.length - 1), status: !applicable ? 'not_applicable_no_node_or_road' : boundaryNodeIds.length < 2 ? 'no_distinct_boundary_pair' : 'enumerated' });
      for (const from of boundaryNodeIds) for (const to of boundaryNodeIds) if (from !== to) add({ kind: 'nodes', id: from }, { kind: 'nodes', id: to }, index);
    });
  }
  const turns = new Map<string, [string, YardMap['movements'][string]][]>();
  for (const entry of Object.entries(map.movements)) { const key = turnKey(entry[1].incomingArc, entry[1].outgoingArc); const list = turns.get(key) ?? []; list.push(entry); turns.set(key, list); }
  function route(route: PathRoute | null, euclideanM: number, mode: PathPreviewReport['mode']) {
    if (!route) return null;
    const roadResources = [...new Set(route.arcs.map(arc => arc.roadId))].filter(id => map.roads[id]!.resourceIds.length > 0).map(id => ({ roadId: id, resourceIds: [...map.roads[id]!.resourceIds] }));
    const movementDeclarations = route.arcs.slice(1).flatMap((arc, i) => (turns.get(turnKey(route.arcs[i]!, arc)) ?? []).map(([id, value]) => ({ afterArcIndex: i, movementId: id, allowed: value.allowed, resourceIds: [...value.resourceIds] })));
    return { lengthM: route.lengthM, excessDistanceM: route.lengthM - euclideanM, euclideanRatio: euclideanM === 0 ? null : route.lengthM / euclideanM, arcs: route.arcs, assumptions: route.assumptions,
      resourceReferences: { roads: roadResources, movementDeclarations, emptyRoadResourceListsOmitted: true, junctionResourcesInherited: false,
        meaning: mode === 'direction_only' ? 'Declarations along this direction-only route, including ignored forbidden turns; not actual reservations or execution.' : 'Road and exact consecutive-arc movement declarations only; not resource execution or capacity validation.' } };
  }
  const rows = [], incomplete: { pairIndex: number; mode: string; issueCodes: string[] }[] = [];
  const totals: Record<string, Record<string, number>> = { declared: {}, direction_only: {} };
  const endpointNode = (endpoint: PathEndpoint) => endpoint.kind === 'nodes' ? endpoint.id : map[endpoint.kind][endpoint.id]!.nodeId;
  process.stdout.write(JSON.stringify({ event: 'MQ_ROUTES_STARTED', mapId: map.mapId, totalPairs: pairs.size, servicePairs: serviceIds.length * (serviceIds.length - 1), preparedOnce: true }) + '\n');
  let lastProgress = performance.now();
  for (const pair of pairs.values()) {
    const from = map.nodes[endpointNode(pair.from)]!.position, to = map.nodes[endpointNode(pair.to)]!.position;
    const euclideanM = Math.hypot(from[0] - to[0], from[1] - to[1]);
    if (!Number.isFinite(euclideanM)) throw new Error('MQ_DISTANCE_OVERFLOW: endpoint Euclidean distance is not finite');
    const declared = prepared.preview(pair.from, pair.to), directionOnly = prepared.preview(pair.from, pair.to, { mode: 'direction_only' });
    const summarize = (value: PathPreviewReport) => {
      totals[value.mode]![value.status] = (totals[value.mode]![value.status] ?? 0) + 1;
      if (!value.complete) incomplete.push({ pairIndex: rows.length, mode: value.mode, issueCodes: value.issues.map(issue => issue.code) });
      const candidateSameAsConfirmed = !!value.confirmed && !!value.candidate && sameValue(value.confirmed, value.candidate);
      return { mode: value.mode, status: value.status, complete: value.complete, confirmed: route(value.confirmed, euclideanM, value.mode), candidateSameAsConfirmed, candidate: candidateSameAsConfirmed ? null : route(value.candidate, euclideanM, value.mode), issues: value.issues, assumptions: value.assumptions, unchecked: value.unchecked };
    };
    rows.push({ pairIndex: rows.length, ...pair, fromNodeId: endpointNode(pair.from), toNodeId: endpointNode(pair.to), euclideanM,
      declared: summarize(declared), directionOnly: summarize(directionOnly),
      difference: { statusDiffers: declared.status !== directionOnly.status,
        declaredMinusDirectionLengthM: declared.confirmed && directionOnly.confirmed ? declared.confirmed.lengthM - directionOnly.confirmed.lengthM : null } });
    if (rows.length % 100 === 0 || performance.now() - lastProgress >= 5000) {
      process.stdout.write(JSON.stringify({ event: 'MQ_ROUTES_PROGRESS', completedPairs: rows.length, totalPairs: pairs.size, elapsedMs: performance.now() - started }) + '\n'); lastProgress = performance.now();
    }
  }
  if (sha(await readFile(inputPath)) !== fileSha256 || inventoryPath && sha(await readFile(inventoryPath)) !== inventorySha256) throw new Error('MQ_INPUT_CHANGED: refuse report for changed input');
  for (const [path, expected] of Object.entries(sourceFiles)) if (sha(await readFile(new URL('../' + path, import.meta.url))) !== expected) throw new Error('MQ_SOURCE_CHANGED: ' + path);
  const report = { format: 'MQ01_routes_v1', generatedAt: new Date().toISOString(),
    binding: { path: inputPath, fileSha256, mapId: map.mapId, schemaVersion: map.schemaVersion, revision: map.revision, contentHash: prepared.mapContentHash, coordinateFrame: map.coordinateFrame, inventoryPath: inventoryPath ? resolve(inventoryPath) : null, inventorySha256 },
    source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFiles },
    coverage: { servicePointCount: serviceIds.length, serviceDirectedPairsExpected: serviceIds.length * (serviceIds.length - 1), serviceDirectedPairsVisited: rows.filter(row => row.servicePair).length,
      candidateCount: candidates.length, candidatePairMemberships: candidates.reduce((sum, value) => sum + value.directedPairs, 0), uniqueLocalNodeDirectedPairs: rows.filter(row => !row.servicePair).length,
      totalDirectedPairs: pairs.size, visitedDirectedPairs: rows.length, modesPerPair: 2, incompleteModeQueries: incomplete.length, incomplete, status: incomplete.length ? 'partial' : 'checked', totals },
    scope: ['Service OD skips identical service IDs, preserves zero-distance distinct services sharing a node.', 'Local boundaries are explicit references and attachment edges, not geometry-inferred connections or owner permissions.', 'direction_only uses known permitted road directions, ignores movement permissions, and preserves owner/arrival/unsupported geometry checks.', 'candidateSameAsConfirmed=true references the complete confirmed route in this same mode; null candidate then is not absence of a candidate.', 'Ratios are null at zero Euclidean distance; resources are declared references, not simulated reservations.', 'Route resource references do not prove full resource equivalence; resource.appliesTo and junction.resourceIds require separate audit.', 'All map bytes and inventory bytes checked unchanged before output; no repair or history/revision change.'],
    candidates, rows, elapsedMs: performance.now() - started, originalFileUnchanged: true };
  await writeFile(outputPath, JSON.stringify(report) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ event: 'MQ_ROUTES_COMPLETE', output: outputPath, coverage: report.coverage, elapsedMs: report.elapsedMs }) + '\n');
  return report;
}

async function main() {
  const [input, output, option, inventory, ...extra] = process.argv.slice(2);
  if (!input || !output || (option !== undefined && option !== '--inventory') || option && !inventory || extra.length) throw new Error('MQ_ARGUMENT: tsx scripts/MQ01_routes.ts <map.json> <new-output.json> [--inventory full-inventory.json]');
  await runRoutes(input, output, inventory);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => {
  process.stderr.write(JSON.stringify({ status: 'failed', message: String(error) }) + '\n'); process.exitCode = 2;
});
