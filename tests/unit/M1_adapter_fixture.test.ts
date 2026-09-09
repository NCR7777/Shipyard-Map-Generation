import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { loadMap } from '../../src/domain/load';
import type { RuntimeStateMessage } from '../../src/adapters/contracts';

it('binds the documented synthetic simulation message to the exact map without claiming an executed adapter', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../examples/M1_simulation_message.fixture.json', import.meta.url), 'utf8')) as {
    fixtureKind: string; dataClassification: string; executed: boolean; mapFile: string; message: RuntimeStateMessage;
  };
  expect(fixture).toMatchObject({ fixtureKind: 'simulation_adapter_message', dataClassification: 'synthetic', executed: false, mapFile: 'M1_synthetic.map.json' });
  const loaded = loadMap(readFileSync(new URL('../../examples/M1_synthetic.map.json', import.meta.url), 'utf8'));
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) throw new Error('Synthetic adapter fixture map should load.');
  expect(fixture.message).toMatchObject({ protocolVersion: '0.1.0', mapId: loaded.map.mapId, mapContentHash: loaded.contentHash });
  expect(fixture.message.scenarioId).toContain('fixture');
  expect(fixture.message.entityId).toContain('fixture');
  expect(Number.isInteger(fixture.message.sequence)).toBe(true);
  expect(fixture.message.sequence).toBeGreaterThanOrEqual(0);
  expect([fixture.message.simulationTime, fixture.message.occurredAt, fixture.message.observedAt, fixture.message.pose.yawRad, ...fixture.message.pose.position].every(Number.isFinite)).toBe(true);
  expect(fixture.message.pose.position).toHaveLength(3);
  expect(loaded.map).not.toHaveProperty('scenario');
  expect(loaded.map).not.toHaveProperty('runtimeState');
});
