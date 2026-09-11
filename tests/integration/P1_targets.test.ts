import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMap } from '../../src/domain/load';
import { serializeMap } from '../../src/domain/serialization';
import { P1_COLLECTIONS, P1_TARGETS, originalSlotCount, readP1Target, resolveP1DataRoot } from '../helpers/P1_targets';

for (const target of P1_TARGETS) {
  test(`P1 exact original ${target.id}: complete input, core validation and ten lossless round trips`, async () => {
    const { text, map } = await readP1Target(target);
    expect(map.schemaVersion).toBe('0.2.0');
    expect(map.revision).toBe(0);
    expect(map.siteBoundary).toBeDefined();
    expect([...P1_COLLECTIONS.map(kind => Object.keys(map[kind]).length), originalSlotCount(map)]).toEqual(target.counts);
    const first = loadMap(text);
    expect(first.ok, JSON.stringify(first.report.issues)).toBe(true);
    if (!first.ok) throw new Error('Core rejected a frozen original.');
    expect(first.report.ok, JSON.stringify(first.report.issues)).toBe(true);
    expect(first.map).toEqual(map);
    for (const [index, kind] of P1_COLLECTIONS.entries()) {
      expect(first.scene.items.filter(item => item.kind === kind), kind).toHaveLength(target.counts[index]!);
    }
    expect(first.scene.items.filter(item => item.kind === 'slots')).toHaveLength(target.counts[12]);
    expect(first.scene.items.filter(item => item.kind === 'siteBoundary')).toHaveLength(target.family === 'SR02' || target.family === 'SR03' ? 1 : 0);
    for (const resource of first.scene.items.filter(item => item.kind === 'resources')) {
      const targets = map.resources[resource.id]!.appliesTo.map(ref => first.scene.items.find(item => item.kind === ref.entityType && item.id === ref.entityId));
      expect(resource.polygons).toEqual(targets.flatMap(item => item?.polygons ?? []));
      expect(resource.lines).toEqual(targets.flatMap(item => item?.lines ?? []));
      expect(resource.points).toEqual(targets.flatMap(item => item?.points ?? []));
    }
    let current = first;
    for (let i = 0; i < 10; i++) {
      const loaded = loadMap(serializeMap(current.map));
      expect(loaded.ok, JSON.stringify(loaded.report.issues)).toBe(true);
      if (!loaded.ok) throw new Error('Round trip failed.');
      expect(loaded.report.ok, JSON.stringify(loaded.report.issues)).toBe(true);
      expect(loaded.map).toEqual(map);
      expect(loaded.contentHash).toBe(first.contentHash);
      current = loaded;
    }
    expect((await readP1Target(target)).text).toBe(text);
  }, 60000);
}

test('P1 explicit data-root resolution fails closed for blank or missing roots', async () => {
  const target = P1_TARGETS[0]!;
  expect(resolveP1DataRoot('.')).toBe(resolve('.'));
  expect(() => resolveP1DataRoot('  ')).toThrow('blocked_input');
  const missingRoot = resolve(tmpdir(), 'shipyard-missing-originals-' + randomUUID());
  await expect(readP1Target({ ...target, absolutePath: resolve(resolveP1DataRoot(missingRoot), target.path) })).rejects.toThrow('blocked_input');
});
