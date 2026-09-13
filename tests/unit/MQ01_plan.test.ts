import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { dryRunRepair, applyRepairPlan } from '../../scripts/MQ01_core';

function fixture() {
  const map = newMap('MQ01_PLAN_SYNTHETIC', 'explicitly synthetic repair-plan test');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]);
  map.roads.r = { ...newRoad('a', 'b'), direction: 'both' };
  return map;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const evidence = { rule: 'MQ-N01', classification: 'A' as const, reason: 'Synthetic pure subdivision retains travel geometry.', references: ['synthetic test'], expectedChange: 'One explicit intermediate node; same path and resources.' };
const command = { type: 'splitRoad' as const, id: 'r', distanceM: 50, nodeId: 'middle', newRoadIds: ['rA', 'rB'] as [string, string] };

describe('MQ01 immutable repair plans', () => {
  it('binds actual bytes and semantic state; deterministic one-command transaction preserves input/frame', () => {
    const map = fixture(), before = structuredClone(map), fileSha = digest(serializeMap(map));
    const dry = dryRunRepair(map, fileSha, command, evidence); expect(dry.ok).toBe(true);
    if (!dry.ok) throw Error('dry run failed');
    const applied = applyRepairPlan(map, fileSha, dry.plan); expect(applied.ok).toBe(true);
    if (!applied.ok) throw Error('application failed');
    expect(map).toEqual(before); expect(applied.map).toEqual(dry.map);
    expect(applied.map.coordinateFrame).toEqual(map.coordinateFrame); expect(applied.map.revision).toBe(map.revision + 1);
    expect(contentHash(applied.map)).toBe(dry.plan.expectedContentHash);
    expect(() => applyRepairPlan(applied.map, digest(serializeMap(applied.map)), dry.plan)).toThrow('MQ_STALE_PLAN');
  });
  it('rejects same-revision external edits, byte-only edits, tampered commands and unreviewed evidence without mutation', () => {
    const map = fixture(), fileSha = digest(serializeMap(map)), dry = dryRunRepair(map, fileSha, command, evidence);
    if (!dry.ok) throw Error('dry run failed');
    const external = structuredClone(map); external.nodes.b!.position[0] = 120;
    expect(() => applyRepairPlan(external, fileSha, dry.plan)).toThrow('MQ_STALE_PLAN');
    expect(() => applyRepairPlan(map, digest(serializeMap(map) + '\n'), dry.plan)).toThrow('MQ_STALE_PLAN');
    expect(() => applyRepairPlan(map, fileSha, { ...dry.plan, command: { ...command, distanceM: 60 } })).toThrow('MQ_RESULT_MISMATCH');
    expect(() => applyRepairPlan(map, fileSha, { ...dry.plan, evidence: { ...evidence, references: [] } })).toThrow('MQ_INVALID_PLAN');
    expect(map).toEqual(fixture());
  });
  it('rejects direct and indirect protected dependencies and a changed protection baseline', () => {
    const map = fixture(), fileSha = digest(serializeMap(map));
    const locked = { lockedTypes: ['roads'], protectedRefs: [], sourceFilesSha256: {} };
    const rejected = dryRunRepair(map, fileSha, command, evidence, locked);
    expect(rejected.ok).toBe(false); if (!rejected.ok) expect(rejected.issues[0]!.code).toBe('LOCKED_DEPENDENCY');
    const dry = dryRunRepair(map, fileSha, command, evidence); if (!dry.ok) throw Error('dry failed');
    expect(() => applyRepairPlan(map, fileSha, dry.plan, locked)).toThrow('MQ_PROTECTION_CHANGED');
    expect(dryRunRepair(map, fileSha, command, evidence, { ...locked, lockedTypes: [], protectedRefs: [{ kind: 'roads', id: 'r' }] }).ok).toBe(false);
  });
  it('does not prepare no-op or rejected repairs and never changes the source map', () => {
    const map = fixture(), before = structuredClone(map), fileSha = digest(serializeMap(map));
    expect(dryRunRepair(map, fileSha, { type: 'updateNode', id: 'a', patch: { position: [0, 0, 0] } }, evidence).ok).toBe(false);
    expect(dryRunRepair(map, fileSha, { ...command, distanceM: 0 }, evidence).ok).toBe(false);
    expect(map).toEqual(before);
  });
});
