import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
interface Report {
  ok: boolean; status: string; mapContentHash?: string;
  capabilities?: { editable: boolean; unchecked: string[] };
  issues: { code: string; severity: string; jsonPath: string; entityId?: string; suggestedAction: string }[];
}
function validateExample(name: string) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/map-validate.ts', 'examples/' + name], { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  return { exit: result.status, report: JSON.parse(result.stdout) as Report };
}
describe('M2A CLI validates spatial examples through the same browser-free pipeline', () => {
  it('accepts the command-built synthetic spatial draft with editable capabilities', () => {
    const { exit, report } = validateExample('M2A_synthetic.map.json');
    expect(exit).toBe(0);
    expect(report).toMatchObject({ ok: true, status: 'valid', capabilities: { editable: true } });
    expect(report.mapContentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.capabilities!.unchecked).toContain('physical_clearance');
    expect(report.issues.every(issue => issue.severity !== 'error')).toBe(true);
  });
  it('locates the invalid synthetic self-intersection at the facility boundary and exits 1', () => {
    const { exit, report } = validateExample('M2A_invalid_polygon.map.json');
    expect(exit).toBe(1);
    expect(report.ok).toBe(false);
    const issue = report.issues.find(item => item.severity === 'error' && item.jsonPath.startsWith('/facilities/fWorkshop/boundary'));
    expect(issue, JSON.stringify(report.issues)).toBeDefined();
    expect(issue!.entityId).toBe('fWorkshop');
    expect(issue!.suggestedAction.length).toBeGreaterThan(0);
  });
});
