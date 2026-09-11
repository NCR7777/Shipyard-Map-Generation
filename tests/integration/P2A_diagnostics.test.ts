import { expect, test } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadMap } from '../../src/domain/load';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { createSession } from '../../src/editor/session';
import { diagnoseMap, type DiagnosticReport } from '../../src/validation/diagnostics';
import { previewPath, type PathPreviewReport } from '../../src/topology/pathPreview';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

const root = fileURLToPath(new URL('../../', import.meta.url));
const targets = P1_TARGETS.filter(target => target.family === 'SR03');
const from = { kind: 'servicePoints' as const, id: 'SP_001' };
const to = { kind: 'servicePoints' as const, id: 'SP_002' };
const evidenceDir = new URL('../../.cache/P2A/diagnostics/', import.meta.url);

for (const target of targets) {
  test('P2A frozen ' + target.id + ': read-only diagnosis, explicit path and unchanged persistence inputs', async () => {
    const original = await readP1Target(target);
    const loaded = loadMap(original.text); expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error('blocked_input: frozen original failed shared loading');
    const session = createSession(loaded.map, true);
    const before = serializeMap(session.map); const history = structuredClone(session);
    const started = performance.now();
    const diagnostics = diagnoseMap(session.map);
    const path = previewPath(session.map, from, to);
    const elapsedMs = performance.now() - started;
    expect(diagnostics.mapContentHash).toBe(loaded.contentHash);
    expect(diagnostics.status).toBe('partial'); // Undeclared physical layers/clearance remain unknown.
    expect(diagnostics.checks.some(check => check.status === 'not_checked')).toBe(true);
    expect(diagnostics.issues.filter(issue => issue.severity === 'error')).toEqual([]);
    expect(path.status).toBe('found');
    expect(path.confirmed!.lengthM).toBeCloseTo({ A: 78.5, B: 283.5, C: 544.5, D: 570 }[target.yard], 7);
    expect(serializeMap(session.map)).toBe(before); expect(session).toEqual(history);
    expect(contentHash(session.map)).toBe(loaded.contentHash);
    const reloaded = loadMap(serializeMap(session.map)); expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error('Roundtrip failed');
    expect(reloaded.map).toEqual(original.map);
    expect(diagnoseMap(reloaded.map)).toEqual(diagnostics);
    expect(previewPath(reloaded.map, from, to)).toEqual(path);
    expect((await readP1Target(target)).text).toBe(original.text);
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(new URL(target.id + '.json', evidenceDir), JSON.stringify({
      input: { path: target.path, sha256: target.sha256, bytes: Buffer.byteLength(original.text) },
      elapsedMs, interpretation: 'Only this explicitly named service pair was queried; no all-pairs reachability or field clearance claim.',
      diagnostics, path,
    }, null, 2) + '\n');
  }, 60000);
}

function cli(args: string[]) {
  const run = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/map-diagnose.ts', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  expect(run.error).toBeUndefined(); expect(run.signal).toBeNull(); expect(run.stderr).toBe('');
  return { code: run.status, report: JSON.parse(run.stdout) as { diagnostics?: DiagnosticReport; path?: PathPreviewReport; code?: string; status?: string } };
}
test('P2A CLI shares the exact original/core report and never writes its input', async () => {
  const target = targets[0]!; const before = await readP1Target(target);
  const result = cli([target.absolutePath, '--from', 'servicePoints:SP_001', '--to', 'servicePoints:SP_002']);
  expect(result.code).toBe(0);
  expect(result.report.diagnostics).toEqual(diagnoseMap(before.map));
  expect(result.report.path).toEqual(previewPath(before.map, from, to));
  expect((await readP1Target(target)).text).toBe(before.text);
}, 30000);
test('P2A CLI rejects file/argument/invalid JSON input without treating partial reports as publish approval', async () => {
  expect(cli([]).code).toBe(2);
  expect(cli(['examples/M1_synthetic.map.json', '--from', 'nodes:N_1']).code).toBe(2);
  expect(cli(['examples/M1_synthetic.map.json', '--from', 'servicePoints:S_1']).code).toBe(2);
  expect(cli(['missing-P2A-file.json']).report.code).toBe('CLI_IO');
  const invalid = cli(['examples/M1_invalid.map.json']); expect(invalid.code).toBe(1);
  expect(invalid.report.status).toBe('invalid');
  const text = await readFile(new URL('../../examples/M1_invalid.map.json', import.meta.url), 'utf8');
  expect(loadMap(text).ok).toBe(false);
}, 30000);
