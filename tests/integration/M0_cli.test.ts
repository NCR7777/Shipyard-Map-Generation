import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const fixtureFile = path.join(projectRoot, 'examples/M1_synthetic.map.json');
const invalidFile = path.join(projectRoot, 'examples/M1_invalid.map.json');
const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'yard-map-cli-'));

interface CliReport {
  ok: boolean;
  status: 'valid' | 'invalid' | 'unsupported';
  profile: string;
  mapContentHash?: string;
  issues: { code: string; severity: string; jsonPath: string; entityId?: string }[];
}

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/map-validate.ts', ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return { status: result.status, report: JSON.parse(result.stdout) as CliReport };
}

afterAll(() => {
  const resolvedDirectory = path.resolve(temporaryDirectory);
  if (path.dirname(resolvedDirectory) !== path.resolve(tmpdir()) || !path.basename(resolvedDirectory).startsWith('yard-map-cli-')) {
    throw new Error('Refusing cleanup outside the generated test temporary directory.');
  }
  rmSync(resolvedDirectory, { recursive: true, force: true });
});

describe('M0 CLI: browser-free shared import and validation', () => {
  it('accepts the synthetic draft and emits only structured JSON with exit 0', () => {
    const { status, report } = runCli([fixtureFile]);
    expect(status).toBe(0);
    expect(report).toMatchObject({ ok: true, status: 'valid', profile: 'draft' });
    expect(report.mapContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.issues.every((issue) => issue.severity !== 'error')).toBe(true);
  });

  it('locates the invalid example dangling endpoint and exits 1', () => {
    const { status, report } = runCli([invalidFile]);
    expect(status).toBe(1);
    expect(report).toMatchObject({ ok: false, status: 'invalid', profile: 'draft' });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: 'error', jsonPath: expect.stringMatching(/^\/roads\/[^/]+\/toNodeId$/) }),
    ]));
  });

  it.each([
    [],
    [fixtureFile, '--unknown'],
    [fixtureFile, '--profile'],
    [fixtureFile, fixtureFile],
  ])('reports malformed arguments %j with exit 2', (...args: string[]) => {
    const { status, report } = runCli(args);
    expect(status).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'CLI_ARGUMENT')).toBe(true);
  });

  it('reports unreadable files with structured diagnostics and exit 2', () => {
    const { status, report } = runCli([path.join(temporaryDirectory, 'missing.json')]);
    expect(status).toBe(2);
    expect(report.ok).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'CLI_IO')).toBe(true);
  });

  it.each(['topology_preview', 'level2_network', 'swept_geometry', 'future_profile'])('does not fake the unsupported %s validation profile', (profile) => {
    const { status, report } = runCli([fixtureFile, '--profile', profile]);
    expect(status).toBe(3);
    expect(report).toMatchObject({ ok: false, status: 'unsupported', profile });
  });

  it('detects content changed outside the editor without trusting revision', () => {
    const original = JSON.parse(readFileSync(fixtureFile, 'utf8')) as {
      revision: number;
      nodes: Record<string, { position: number[] }>;
      roads: Record<string, { toNodeId: string }>;
    };
    const road = Object.values(original.roads)[0];
    expect(road).toBeDefined();
    const node = original.nodes[road!.toNodeId];
    expect(node).toBeDefined();
    node!.position = [120, 0, 0];
    const editedFile = path.join(temporaryDirectory, 'external-edit.json');
    writeFileSync(editedFile, JSON.stringify(original), 'utf8');
    const originalResult = runCli([fixtureFile]);
    const editedResult = runCli([editedFile]);
    expect(originalResult.status).toBe(0);
    expect(editedResult.status).toBe(0);
    expect(editedResult.report.mapContentHash).not.toBe(originalResult.report.mapContentHash);
    const serializedRevision = (JSON.parse(readFileSync(editedFile, 'utf8')) as { revision: number }).revision;
    expect(serializedRevision).toBe(original.revision);
  });

  it('checks Schema-generated types without changing source files', () => {
    const result = spawnSync(process.execPath, ['scripts/generate-types.mjs', '--check'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('enforces pure-core dependency boundaries in Node', () => {
    const output = execFileSync(process.execPath, ['scripts/check-boundaries.mjs'], {
      cwd: projectRoot, encoding: 'utf8', timeout: 20_000, windowsHide: true,
    });
    expect(output).toContain('Core boundaries: PASS');
  });
});
