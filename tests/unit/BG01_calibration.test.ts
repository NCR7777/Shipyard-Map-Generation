import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sha256 } from 'js-sha256';
import { newMap } from '../../src/domain/factory';
import { BG01_CALIBRATION_FORMAT, BG01_PIXEL_CONVENTION, resolveBackgroundCalibration } from '../../src/adapters/backgroundCalibration';

const image = { sha256: 'a'.repeat(64), widthPx: 120, heightPx: 80 };
const frame = newMap('BG01_SYNTHETIC', 'synthetic calibration contract').coordinateFrame;
const standard = () => ({ format: BG01_CALIBRATION_FORMAT, image, coordinateFrame: structuredClone(frame), pixelConvention: BG01_PIXEL_CONVENTION,
  imageToWorld: [2, 0.25, -0.5, -3, 40, 200], sourceEvidence: [{ name: 'synthetic-source.png', sha256: image.sha256, jsonPath: '' }] });
const resolveStandard = (document: unknown) => resolveBackgroundCalibration({ image, coordinateFrame: frame, documents: [{ name: 'calibration.json', text: JSON.stringify(document) }] });

describe('BG01 strict background calibration', () => {
  it('preserves the complete non-axis-aligned affine and leaves map/frame input untouched', () => {
    const document = standard(), before = structuredClone(document);
    const result = resolveStandard(document);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.code);
    expect(result.imageToWorld).toEqual([2, 0.25, -0.5, -3, 40, 200]);
    expect(result.coordinateFrame).toEqual(frame);
    expect(document).toEqual(before);
    expect(result.sourceEvidence[0]!.sha256).toBe(sha256(JSON.stringify(document)));
  });

  it('rejects wrong image identity, dimensions, complete frame, pixel convention and singular transforms', () => {
    for (const [patch, code] of [
      [{ image: { ...image, sha256: 'b'.repeat(64) } }, 'BG_IMAGE_SHA_MISMATCH'],
      [{ image: { ...image, widthPx: 121 } }, 'BG_IMAGE_DIMENSION_MISMATCH'],
      [{ coordinateFrame: { ...frame, timeUnit: 'ms' } }, 'BG_FRAME_MISMATCH'],
      [{ coordinateFrame: { ...frame, massUnit: undefined } }, 'BG_FRAME_MISMATCH'],
      [{ pixelConvention: 'pixel_center' }, 'BG_PIXEL_CONVENTION_UNSUPPORTED'],
      [{ imageToWorld: [1, 2, 2, 4, 0, 0] }, 'BG_AFFINE_INVALID'],
      [{ sourceEvidence: [] }, 'BG_SOURCE_EVIDENCE_MISSING'],
    ] as const) expect(resolveStandard({ ...standard(), ...patch })).toMatchObject({ ok: false, code });
  });

  it('refuses duplicate keys/nonfinite JSON and refuses source-pixel approximation as a local transform', () => {
    const run = (text: string) => resolveBackgroundCalibration({ image, coordinateFrame: frame, documents: [{ name: 'g.json', text }] });
    expect(run('{"x":1,"x":2}')).toMatchObject({ ok: false, code: 'BG_JSON_DUPLICATE_KEY' });
    expect(run('{"x":1e400}')).toMatchObject({ ok: false, code: 'BG_JSON_NONFINITE' });
    expect(run(JSON.stringify({ pixel_to_local: [[1, 0, 0], [0, -1, 80]], affine_fit_error_max_m: 0.04 }))).toMatchObject({ ok: false, status: 'preprocess_required' });
    expect(run(JSON.stringify({ sourceBounds: [0, 0, 120, 80], pixelSize: [120, 80] }))).toMatchObject({ ok: false, code: 'BG_REPROJECTION_REQUIRED' });
  });

  it('accepts the real CIMC V02 JPEG only with frozen image/georef/original-map identity and full frame', () => {
    const root = resolve(process.env.SHIPYARD_TEST_DATA_ROOT ?? '../..', 'projects');
    const old = resolve(root, 'cimc_v01'), current = resolve(root, 'Map_Refinement_20260912/cimc_v02');
    const map = JSON.parse(readFileSync(resolve(current, 'map.json'), 'utf8'));
    const actualImage = { sha256: sha256(readFileSync(resolve(current, 'reference/satellite_local.jpg'))), widthPx: 1420, heightPx: 1340 };
    expect(actualImage.sha256).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
    const documents = [{ name: 'georeference.json', text: readFileSync(resolve(current, 'reference/georeference.json'), 'utf8') },
      { name: 'manifest.json', text: readFileSync(resolve(old, 'manifest.json'), 'utf8') },
      { name: 'map.json', text: readFileSync(resolve(old, 'map.json'), 'utf8') }];
    const input = { image: actualImage, coordinateFrame: map.coordinateFrame, documents };
    const result = resolveBackgroundCalibration(input);
    expect(result).toMatchObject({ ok: true, method: 'legacy_manifest', imageToWorld: [1, 0, 0, -1, 0, 1340] });
    expect(resolveBackgroundCalibration({ ...input, documents: documents.slice(0, 1) })).toMatchObject({ ok: false, status: 'uncalibrated' });
    const wrong = structuredClone(input);
    wrong.coordinateFrame.timeUnit = 'ms';
    expect(resolveBackgroundCalibration(wrong)).toMatchObject({ ok: false, code: 'BG_FRAME_UNSUPPORTED' });
    const moved = structuredClone(input);
    moved.coordinateFrame.geographicAnchor.method += ' edited';
    expect(resolveBackgroundCalibration(moved)).toMatchObject({ ok: false, code: 'BG_CALIBRATION_IDENTITY_UNBOUND' });
    const swapped = structuredClone(input);
    swapped.documents[2]!.text += '\n';
    expect(resolveBackgroundCalibration(swapped)).toMatchObject({ ok: false, status: 'uncalibrated' });
  });
});
