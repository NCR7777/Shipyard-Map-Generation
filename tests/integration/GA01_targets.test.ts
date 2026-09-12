import { describe, expect, it } from 'vitest';
import { loadMap } from '../../src/domain/load';
import { inspectPlanning } from '../../src/domain/planning';
import { applyMapCommand, commandSupport } from '../../src/domain/commands';
import { GA01_TARGETS, GA01Command, readGA01Target, assertGA01Change, GA01RoadCommand, assertGA01RoadChange } from '../helpers/GA01_targets';

const phase = process.env.GA01_PHASE ?? 'A';
describe('GA01 frozen V01 and V02 genuine inputs', () => {
  it.each(GA01_TARGETS)('$id keeps its frozen frame through a real geometry transaction', async target => {
    const original = await readGA01Target(target);
    const loaded = loadMap(JSON.stringify(original));
    expect(loaded.ok).toBe(true); expect(loaded.report.ok).toBe(true);
    if (!loaded.ok) throw new Error('native load failed');
    expect(loaded.contentHash).toBe(target.contentHash);
    expect(inspectPlanning(original).supported).toBe(true);
    const command = GA01Command(original, target, phase);
    const support = commandSupport(original, command);
    if (phase === 'baseline') { expect(support.allowed).toBe(false); return; }
    expect(support.issues).toEqual([]);
    const result = applyMapCommand(original, command);
    expect(result.ok, JSON.stringify(result.ok ? null : result.issues)).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true); assertGA01Change(original, result.map, target, phase);
    if (phase === 'B') {
      let current = result.map;
      for (const edit of ['shape', 'parameters'] as const) {
        const requested = GA01RoadCommand(current, target, edit); const edited = applyMapCommand(current, requested);
        expect(edited.ok, JSON.stringify(edited.ok ? null : edited.issues)).toBe(true);
        if (!edited.ok) return;
        expect(edited.changed).toBe(true); assertGA01RoadChange(current, edited.map, requested, edit);
        current = edited.map;
      }
    }
    expect(result.transaction?.before).toEqual(original);
    expect(result.transaction?.affectedRefs.some(ref => ref.kind === 'sources')).toBe(true);
    expect((await readGA01Target(target))).toEqual(original);
  }, 30000);
});
