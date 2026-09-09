import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import type { YardMap } from '../../src/domain/model';
import { associatedFixture, missingBackgroundFixture } from '../helpers/M2A_fixtures';
import { zoneServiceFixture } from '../helpers/M2A1_fixtures';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = mkdtempSync(path.join(tmpdir(), 'yard-map-m2a1-cli-'));
interface Report {
  ok: boolean; status: string; sourceFileSha256?: string; sourceContentHash?: string; targetContentHash?: string;
  changes?: { path: string; before: unknown; after: unknown }[];
  capabilities?: { editable: boolean };
  issues?: { code: string; severity: string; jsonPath: string; entityId?: string }[];
}
function run(script: 'map-validate' | 'map-migrate', args: string[]) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/' + script + '.ts', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.stderr).toBe('');
  return { exit: result.status, report: JSON.parse(result.stdout) as Report };
}
function file(name: string, text: string) { const filename = path.join(directory, name); writeFileSync(filename, text, 'utf8'); return filename; }
afterAll(() => {
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('yard-map-m2a1-cli-')) throw new Error('Unsafe temporary test cleanup.');
  rmSync(target, { recursive: true, force: true });
});

describe('M2A.1 CLI dual-version validation and explicit no-overwrite migration', () => {
  it.each(['0.1.0', '0.2.0'])('validates %s through the public CLI without a browser', version => {
    const map = version === '0.1.0' ? associatedFixture() : zoneServiceFixture();
    const input = file('validate-' + version + '.json', serializeMap(map));
    const result = run('map-validate', [input]);
    expect(result.exit).toBe(0);
    expect(result.report).toMatchObject({ ok: true, status: 'valid', capabilities: { editable: true } });
  });
  it('locates a new service node reference error at its exact field and exits 1', () => {
    const map = zoneServiceFixture(); map.servicePoints.sZone!.nodeId = 'missing';
    const result = run('map-validate', [file('invalid-service.json', JSON.stringify(map))]);
    expect(result.exit).toBe(1);
    expect(result.report.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'DANGLING_REFERENCE', entityId: 'sZone', jsonPath: '/servicePoints/sZone/nodeId' })]));
  });
  it('migrates to a new file, preserves original bytes, metadata and assets, and reports hashes and exact changes', () => {
    const map = missingBackgroundFixture();
    map.extensionNamespaces['test.migration_meta'] = { category: 'metadata', version: '1' };
    map.extensions['test.migration_meta'] = { arbitrary: ['完整保留', 1.23456789012345] };
    const raw = JSON.stringify(map, null, 4) + '\n';
    const input = file('migration-original.json', raw);
    const output = path.join(directory, 'migration-upgraded.json');
    const result = run('map-migrate', [input, output]);
    expect(result.exit).toBe(0);
    expect(result.report.status).toBe('migrated');
    expect(readFileSync(input, 'utf8')).toBe(raw);
    expect(result.report.sourceFileSha256).toBe(createHash('sha256').update(raw, 'utf8').digest('hex'));
    expect(result.report.sourceContentHash).toBe(contentHash(map));
    const migrated = JSON.parse(readFileSync(output, 'utf8')) as YardMap;
    expect(migrated).toEqual({ ...map, schemaVersion: '0.2.0', revision: map.revision + 1 });
    expect(result.report.targetContentHash).toBe(contentHash(migrated));
    expect(result.report.changes).toEqual([{ path: '/schemaVersion', before: '0.1.0', after: '0.2.0' }, { path: '/revision', before: map.revision, after: map.revision + 1 }]);
    const validated = run('map-validate', [output]);
    expect(validated.exit).toBe(0);
    expect(validated.report.capabilities!.editable).toBe(false);
  });
  it('refuses in-place migration without changing the input', () => {
    const raw = serializeMap(associatedFixture());
    const input = file('same-path.json', raw);
    const result = run('map-migrate', [input, input]);
    expect(result.exit).toBe(2);
    expect(result.report.issues!.some(issue => issue.code === 'MIGRATION_SAME_PATH')).toBe(true);
    expect(readFileSync(input, 'utf8')).toBe(raw);
  });
  it('refuses to overwrite an existing output, preserving both files byte-for-byte', () => {
    const raw = serializeMap(associatedFixture());
    const input = file('existing-source.json', raw);
    const output = file('existing-output.json', 'USER ORIGINAL OUTPUT\n');
    const result = run('map-migrate', [input, output]);
    expect(result.exit).toBe(2);
    expect(result.report.issues!.some(issue => issue.code === 'MIGRATION_OUTPUT_EXISTS')).toBe(true);
    expect(readFileSync(input, 'utf8')).toBe(raw);
    expect(readFileSync(output, 'utf8')).toBe('USER ORIGINAL OUTPUT\n');
  });
  it('refuses new fields smuggled into a legacy input before producing any output', () => {
    const map = associatedFixture(); Object.assign(map.servicePoints.sA!, { zoneId: 'zA' });
    const raw = JSON.stringify(map);
    const input = file('strict-legacy-invalid.json', raw);
    const output = path.join(directory, 'must-not-exist.json');
    const result = run('map-migrate', [input, output]);
    expect(result.exit).toBe(1);
    expect(result.report.issues!.some(issue => issue.severity === 'error' && issue.jsonPath.startsWith('/servicePoints/sA'))).toBe(true);
    expect(existsSync(output)).toBe(false);
    expect(readFileSync(input, 'utf8')).toBe(raw);
  });
  it('copies an already-current map without inventing a second migration or revision', () => {
    const map = zoneServiceFixture();
    const input = file('already-current.json', serializeMap(map));
    const output = path.join(directory, 'already-current-copy.json');
    const result = run('map-migrate', [input, output]);
    expect(result.exit).toBe(0);
    expect(result.report.status).toBe('copied_current_version');
    expect(result.report.changes).toEqual([]);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual(map);
  });
  it('requires the explicit new output path and exits 2 when omitted', () => {
    const input = file('missing-output-arg.json', serializeMap(associatedFixture()));
    const result = run('map-migrate', [input]);
    expect(result.exit).toBe(2);
    expect(result.report.issues!.some(issue => issue.code === 'CLI_ARGUMENT')).toBe(true);
  });
});
