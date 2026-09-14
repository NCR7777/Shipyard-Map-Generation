import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { upgradeMapToV03 } from '../../src/domain/upgradeV03';
import { contentHash } from '../../src/domain/serialization';
import { loadScenario, loadRunPlan, loadRunEvents, loadRunSummary, frameAt, compareSummaries, makeSyntheticRunFiles, type PreparedRun, type RunLoadResult, type PlanFile } from '../../src/domain/results';

function fixture() {
  const old = newMap('FAST04_synthetic_map', 'synthetic result contract', '0.2.0');
  old.nodes.a = newNode([0, 0, 0]); old.nodes.b = newNode([100, 0, 0]); old.nodes.c = newNode([500, 500, 0]);
  old.roads.r = { ...newRoad('a', 'b'), direction: 'both' };
  const map = upgradeMapToV03(old).map; map.roads.r!.geometry = { kind: 'path', anchors: [], spans: [{ kind: 'cubic', control1: [0, 100, 0], control2: [100, 100, 0] }] };
  return map;
}
function accepted(result: RunLoadResult): PreparedRun { expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) throw new Error(result.issues[0]!.message); return result.run; }
function setup() { const map = fixture(), files = makeSyntheticRunFiles(map)!; expect(files).not.toBeNull(); const scenario = loadScenario(files.scenario); if (!scenario.ok) throw new Error('scenario'); const run = accepted(loadRunPlan(map, files.plan, scenario)); return { map, files, scenario, run }; }
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((v, i) => v - b[i]!));

describe('FAST04 verified external scenario, plan, events and metrics', () => {
  it('computes reproducible scenario content hashes and validates declared units, IDs and strict JSON', () => {
    const { files, scenario } = setup();
    const reordered = loadScenario(Object.fromEntries(Object.entries(files.scenario).reverse())); expect(reordered.ok).toBe(true); if (reordered.ok) expect(reordered.scenarioHash).toBe(scenario.scenarioHash);
    expect(loadScenario({ ...files.scenario, units: { length: 'km', time: 's' } }).ok).toBe(false);
    expect(loadScenario({ ...files.scenario, vehicles: [{ id: 'same' }, { id: 'same' }] }).ok).toBe(false);
    expect(loadScenario(JSON.stringify(files.scenario).replace('"protocolVersion":"1.0"', '"protocolVersion":"1.0","protocolVersion":"1.0"')).ok).toBe(false);
    const quoted = loadScenario({ ...files.scenario, assumptions: ['quoted " [ { literal \\ string'] }); expect(quoted.ok).toBe(true);
  });

  it('rejects map/scenario/compiler mismatch and dynamic IDs are validated against fleet, never map nodes', () => {
    const { map, files, scenario, run } = setup(), original = structuredClone(map);
    expect(map.nodes.vehicle_forward).toBeUndefined(); expect(run.scenarioVerified).toBe(true);
    expect(loadRunPlan(map, { ...files.plan, mapContentHash: '0'.repeat(64) }, scenario).ok).toBe(false);
    expect(loadRunPlan(map, { ...files.plan, compilerVersion: 'unknown' }, scenario).ok).toBe(false);
    const changed = { ...files.scenario, assumptions: ['different scenario'] }, other = loadScenario(changed); if (!other.ok) throw new Error('scenario');
    expect(loadRunPlan(map, files.plan, other).ok).toBe(false);
    expect(loadRunPlan(map, { ...files.plan, activities: [{ ...files.plan.activities[0], vehicleId: 'not_in_fleet' }] }, scenario).ok).toBe(false);
    expect(loadRunPlan(map, { ...files.plan, activities: [{ ...files.plan.activities[0], roadId: 'absent' }] }, scenario).ok).toBe(false);
    expect(map).toEqual(original); expect(contentHash(map)).toBe(files.plan.mapContentHash);
  });

  it('reconstructs deterministic near-uniform curve motion, reverse yaw, stationary wait and filters', () => {
    const { files, run } = setup(), travel = files.plan.activities[0]!, duration = travel.t1;
    const points = Array.from({ length: 21 }, (_, i) => frameAt(run, i * duration / 20, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!);
    const steps = points.slice(1).map((point, i) => distance(point.position, points[i]!.position)); expect(Math.max(...steps) - Math.min(...steps)).toBeLessThan(0.05);
    const forward = frameAt(run, duration / 2, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!, backward = frameAt(run, duration / 2 + 10, { vehicleIds: ['vehicle_backward'] }).vehicles[0]!;
    expect(distance(forward.position, backward.position)).toBeLessThan(1e-6); expect(Math.cos(forward.yawRad - backward.yawRad)).toBeCloseTo(-1, 10);
    const waiting = frameAt(run, duration + 5, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!; expect(waiting.state).toBe('wait'); expect(waiting.position).toEqual([100, 0, 0]); expect(waiting.yawRad).toBeCloseTo(-Math.PI / 2, 10);
    expect(frameAt(run, duration + 20, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!.position).toEqual(waiting.position);
    expect(frameAt(run, 40)).toEqual(frameAt(run, 40)); expect(frameAt(run, 40, { taskIds: ['task_backward'] }).vehicles.map(vehicle => vehicle.vehicleId)).toEqual(['vehicle_backward']);
  });

  it('holds the last known position during missing activity time and never invents a spatial connector', () => {
    const { map, files, scenario } = setup(), plan = structuredClone(files.plan);
    plan.activities[1]!.t0 += 5; const run = accepted(loadRunPlan(map, plan, scenario));
    expect(run.issues.some(issue => issue.code === 'RUN_TIME_GAP')).toBe(true);
    const gap = frameAt(run, plan.activities[0]!.t1 + 2, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!;
    expect(gap.state).toBe('gap'); expect(gap.position).toEqual([100, 0, 0]); expect(gap.route).toBeNull();
    const broken = structuredClone(files.plan); if (broken.activities[1]!.kind !== 'travel') broken.activities[1]!.nodeId = 'c';
    const loaded = accepted(loadRunPlan(map, broken, scenario)); expect(loaded.issues.some(issue => issue.code === 'RUN_SPATIAL_GAP')).toBe(true);
    expect(frameAt(loaded, broken.activities[0]!.t1 + 1, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!.route).toBeNull();
  });

  it('rejects forbidden turns even with an intervening wait and rejects unconsumed internal turn geometry', () => {
    const map = fixture(); map.junctions.j = { name: 'synthetic turn', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
    map.movements.turn = { name: 'declared turn', junctionId: 'j', incomingArc: { roadId: 'r', direction: 'forward' }, outgoingArc: { roadId: 'r', direction: 'backward' }, allowed: false, resourceIds: [], provenance: { category: 'synthetic' } };
    const files = makeSyntheticRunFiles(map)!, first = files.plan.activities[0]!;
    const plan: PlanFile = { ...files.plan, activities: [first, { kind: 'wait', vehicleId: 'vehicle_forward', t0: first.t1, t1: first.t1 + 10, nodeId: 'b' }, { kind: 'travel', vehicleId: 'vehicle_forward', t0: first.t1 + 10, t1: first.t1 * 2 + 10, roadId: 'r', direction: 'backward', s0M: 0, s1M: first.kind === 'travel' ? first.s1M : 0 }] };
    const forbidden = loadRunPlan(map, plan); expect(forbidden.ok).toBe(false); if (!forbidden.ok) expect(forbidden.issues[0]!.code).toBe('RUN_FORBIDDEN_TURN');
    map.movements.turn!.allowed = true; map.movements.turn!.internalPath = [[100, 0, 0], [101, 0, 0], [100, 0, 0]];
    const unsupported = loadRunPlan(map, { ...plan, mapContentHash: contentHash(map) }); expect(unsupported.ok).toBe(false); if (!unsupported.ok) expect(unsupported.issues[0]!.code).toBe('RUN_MOVEMENT_GEOMETRY_UNSUPPORTED');
  });

  it('deduplicates and reorders events, exposes sequence gaps, rejects conflicts, and holds sparse samples', () => {
    const { files, run } = setup(), forward = files.events.filter(event => event.entityId === 'vehicle_forward');
    const rows = [forward[2]!, forward[0]!, forward[2]!, forward[4]!], loaded = accepted(loadRunEvents(run, jsonl(rows)));
    expect(loaded.events).toHaveLength(3); expect(loaded.issues.some(issue => issue.code === 'RUN_EVENT_REORDERED')).toBe(true); expect(loaded.issues.some(issue => issue.code === 'RUN_EVENT_GAP')).toBe(true);
    const sample = frameAt(loaded, forward[2]!.simTimeS, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!;
    const held = frameAt(loaded, forward[3]!.simTimeS, { vehicleIds: ['vehicle_forward'] }).vehicles[0]!;
    expect(held.position).toEqual(sample.position); expect(held.source).toBe('event');
    expect(loadRunEvents(loaded, jsonl([{ ...forward[2], sM: 0 }])).ok).toBe(false); expect(loaded.events).toHaveLength(3);
    expect(loadRunEvents(run, jsonl([{ ...forward[0], scenarioHash: '0'.repeat(64) }])).ok).toBe(false);
    expect(loadRunEvents(run, jsonl([{ ...forward[0], position: [0, 0, 0] }])).ok).toBe(false);
    expect(loadRunEvents(run, jsonl([{ ...forward[0], position: [0, 0, 0], poseAuthority: 'road' }])).ok).toBe(true);
  });

  it('keeps unverified scenarios visibly unverified and compares only compatible verified metrics, preserving null', () => {
    const { map, files, run } = setup(), a = accepted(loadRunSummary(run, files.summary)), unverified = accepted(loadRunSummary(accepted(loadRunPlan(map, files.plan)), files.summary));
    expect(unverified.scenarioVerified).toBe(false); expect(unverified.issues.some(issue => issue.code === 'SCENARIO_CONTENT_UNVERIFIED')).toBe(true);
    const blocked = compareSummaries(a.summary!, unverified.summary!); expect(blocked.comparable).toBe(false); expect(blocked.metrics.every(metric => metric.delta === null)).toBe(true);
    const changed = structuredClone(files.summary); changed.metrics[0]!.value = Number(changed.metrics[0]!.value) - 10;
    const b = accepted(loadRunSummary(run, changed)), compared = compareSummaries(a.summary!, b.summary!); expect(compared.comparable).toBe(true); expect(compared.metrics[0]!.delta).toBe(-10); expect(compared.metrics.find(metric => metric.key === 'lateness')!.delta).toBeNull();
    const incompatible = structuredClone(changed); incompatible.metrics[0]!.window.endS += 1; const other = accepted(loadRunSummary(run, incompatible)); expect(compareSummaries(a.summary!, other.summary!).comparable).toBe(false);
    expect(loadRunSummary(run, { ...changed, runId: 'other_run' }).ok).toBe(false);
    expect(loadRunSummary(run, { ...changed, scenarioVerified: true }).ok).toBe(false);
    const verified = loadScenario(files.scenario); if (!verified.ok) throw new Error('scenario');
    const partial = accepted(loadRunPlan(map, { ...files.plan, activities: files.plan.activities.filter(activity => activity.vehicleId === 'vehicle_forward') }, verified));
    expect(partial.issues.some(issue => issue.code === 'RUN_TASKS_UNSCHEDULED')).toBe(true);
    const partialSummary = accepted(loadRunSummary(partial, files.summary)); expect(compareSummaries(a.summary!, partialSummary.summary!).comparable).toBe(false);
  });

  it('rejects unsupported behavior, unprovided internal-owner authorization and incompatible run evidence classes', () => {
    const { map, files, run, scenario } = setup();
    const external = accepted(loadRunSummary(accepted(loadRunPlan(map, { ...files.plan, source: 'external' }, scenario)), files.summary));
    map.extensionNamespaces['org.example.unknown_rules'] = { version: '1.0', category: 'behavior' };
    const unsupported = loadRunPlan(map, { ...files.plan, mapContentHash: contentHash(map) });
    expect(unsupported.ok).toBe(false); if (!unsupported.ok) expect(unsupported.issues[0]!.code).toBe('RUN_UNSUPPORTED_EXTENSIONS');
    const owned = structuredClone(run); owned.compiled.arcs['r:forward']!.ownerEntityId = 'third_party_facility';
    const event = files.events.find(value => value.entityId === 'vehicle_forward')!;
    const refused = loadRunEvents(owned, jsonl([event])); expect(refused.ok).toBe(false); if (!refused.ok) expect(refused.issues[0]!.code).toBe('RUN_INTERNAL_OWNER_UNSUPPORTED');
    const a = accepted(loadRunSummary(run, files.summary)), changed = structuredClone(files.summary); changed.metrics[0]!.source = 'different_measurement_process';
    const b = accepted(loadRunSummary(run, changed)); expect(compareSummaries(a.summary!, b.summary!).comparable).toBe(true);
    expect(compareSummaries(a.summary!, external.summary!).comparable).toBe(false);
  });

  it('roundtrips the four explicitly synthetic exchange files without embedding runtime state in the map', () => {
    const { map, files, scenario } = setup(), before = structuredClone(map);
    const plan = accepted(loadRunPlan(map, JSON.stringify(files.plan), scenario)); const events = accepted(loadRunEvents(plan, jsonl(files.events))); const summary = accepted(loadRunSummary(events, JSON.stringify(files.summary)));
    expect(summary.source).toBe('synthetic'); expect(summary.events).toHaveLength(10); expect(summary.summary!.metrics[2]!.value).toBeNull(); expect(map).toEqual(before);
  });
});
