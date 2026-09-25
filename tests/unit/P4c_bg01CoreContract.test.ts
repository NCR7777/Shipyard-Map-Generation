import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { BG01_CALIBRATION_FORMAT, BG01_PIXEL_CONVENTION } from '../../src/adapters/backgroundCalibration';
import { loadMap } from '../../src/domain/load';

/** `scripts/BG01_prepare_raster.py` (P4c) checks its output with this tool's kernel through a TypeScript program it runs with
 *  Node and tsx. That program, as the script holds it, run here on a tiny image: the kernel functions it imports
 *  (`loadMap`, `resolveBackgroundCalibration`, `inspectRasterBytes`) and every field the Python side reads must stay as they
 *  are, or the script breaks while no TypeScript test notices. */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const script = readFileSync(join(ROOT, 'scripts/BG01_prepare_raster.py'), 'utf8');
const program = /program = """([\s\S]*?)"""/.exec(script)![1]!;
const mapPath = join(ROOT, 'examples/M2A1_synthetic_service_targets.map.json');
// A 1 × 1 PNG.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const sha = createHash('sha256').update(png).digest('hex');
const directory = mkdtempSync(join(tmpdir(), 'bg01-contract-')), imagePath = join(directory, 'background.png');
writeFileSync(imagePath, png);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/** What the script reads from the program's output (`core_contract` in the script). */
interface CoreOutput {
  coordinateFrame: unknown; contentHash: string; rasterHeader: { width: number; height: number } | null;
  calibration: { ok: boolean; code?: string; message?: string; imageToWorld?: number[]; sourceEvidence?: unknown[]; controlPoints?: unknown[] } | null;
}
function run(documents: { name: string; text: string }[]): CoreOutput {
  const payload = { mapPath, image: { sha256: sha, widthPx: 1, heightPx: 1 }, imagePath, documents };
  const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', program], { cwd: ROOT, input: JSON.stringify(payload), encoding: 'utf8', env: { ...process.env, TSX_DISABLE_CACHE: '1' } });
  return JSON.parse(output) as CoreOutput;
}

describe('the kernel contract of the offline raster script', () => {
  const loaded = loadMap(readFileSync(mapPath, 'utf8'));
  if (!loaded.ok) throw new Error('fixture');
  const frame = loaded.map.coordinateFrame;
  const calibration = (image = { sha256: sha, widthPx: 1, heightPx: 1 }) => ({ name: 'calibration.json', text: JSON.stringify({
    format: BG01_CALIBRATION_FORMAT, image, coordinateFrame: frame, pixelConvention: BG01_PIXEL_CONVENTION,
    imageToWorld: [1, 0, 0, -1, 0, 1], sourceEvidence: [{ name: 'background.png', sha256: sha, jsonPath: '' }], controlPoints }) });
  // The script carries control points through (`calibration.get('controlPoints', [])`): a renamed or dropped field would lose
  // them without an error.
  const controlPoints = [{ pixel: [0.5, 0.5], world: [0.5, 0.5, 0], role: 'fit' }, { pixel: [1, 1], world: [1, 0, 0], role: 'check' }];

  it('gives the frame, content hash, browser raster header and an accepted calibration, as the script reads them', () => {
    const core = run([calibration()]);
    expect(core.coordinateFrame).toEqual(frame);
    expect(core.contentHash).toBe(loaded.contentHash);
    expect(core.rasterHeader).toMatchObject({ width: 1, height: 1 });
    expect(core.calibration).toMatchObject({ ok: true, imageToWorld: [1, 0, 0, -1, 0, 1] });
    expect(Array.isArray(core.calibration!.sourceEvidence)).toBe(true);
    expect(core.calibration!.controlPoints).toEqual(controlPoints);
  }, 30_000);
  it('gives a refused calibration with its code and message', () => {
    const core = run([calibration({ sha256: 'b'.repeat(64), widthPx: 1, heightPx: 1 })]);
    expect(core.calibration).toMatchObject({ ok: false, code: expect.any(String), message: expect.any(String) });
  }, 30_000);
});
