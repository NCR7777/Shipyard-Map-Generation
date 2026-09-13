import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inspectRasterBytes, MAX_RASTER_BYTES, rasterBytes } from '../../src/adapters/rasterFiles';
import { validateBackgroundPreferences, validateEditorState } from '../../src/editor/projectController';

const file = (name: string) => Uint8Array.from(readFileSync(new URL('../fixtures/BG01/' + name, import.meta.url))).buffer;
const camera = { offsetX: 0, offsetY: 0, scale: 1 };
describe('BG01 local raster admission and stable view preferences', () => {
  it('reads dimensions from actual PNG/JPEG/WebP bytes and computes immutable byte hashes', async () => {
    for (const [name, mimeType] of [['small.png', 'image/png'], ['small.jpg', 'image/jpeg'], ['small.webp', 'image/webp']]) {
      const bytes = file(name!); expect(inspectRasterBytes(bytes)).toEqual({ mimeType, width: 3, height: 2 });
      const asset = await rasterBytes(bytes); expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      new Uint8Array(bytes).fill(0); expect(inspectRasterBytes(asset.bytes).width).toBe(3);
    }
  });
  it('rejects a non-normalized EXIF orientation before decoding', () => {
    expect(() => inspectRasterBytes(file('rotated-exif.jpg'))).toThrow(expect.objectContaining({ code: 'RASTER_EXIF_ORIENTATION' }));
  });
  it('rejects disguised SVG, truncated images, excessive bytes and header dimension bombs', () => {
    expect(() => inspectRasterBytes(new TextEncoder().encode('<svg/>').buffer)).toThrow();
    expect(() => inspectRasterBytes(file('small.png').slice(0, 24))).toThrow();
    expect(() => inspectRasterBytes(new ArrayBuffer(MAX_RASTER_BYTES + 1))).toThrow(expect.objectContaining({ code: 'RASTER_BYTES_LIMIT' }));
    const bomb = file('small.png'); new DataView(bomb).setUint32(16, 20_000); new DataView(bomb).setUint32(20, 20_000);
    expect(() => inspectRasterBytes(bomb)).toThrow(expect.objectContaining({ code: 'RASTER_PIXEL_LIMIT' }));
  });
  it('rejects a WebP RIFF body size mismatch before decoding', () => {
    const bytes = file('small.webp'); new DataView(bytes).setUint32(4, bytes.byteLength + 100, true);
    expect(() => inspectRasterBytes(bytes)).toThrow();
  });
  it('old camera/drawing records retain their existing normalized shape', () => {
    const legacy = validateEditorState({ camera, drawing: { showLabels: false } });
    expect(legacy.drawing.labelMode).toBe('off'); expect(legacy).not.toHaveProperty('backgrounds');
    expect(validateBackgroundPreferences({})).toEqual({ comparisonMode: false, layers: {} });
  });
  it('fills per-layer defaults and persists only declared preferences', () => {
    expect(validateEditorState({ camera, backgrounds: { layers: { bgA: { opacity: 0.4 }, bgB: { locked: false, visible: false } } } }).backgrounds)
      .toEqual({ comparisonMode: false, layers: { bgA: { opacity: 0.4, locked: true, visible: true }, bgB: { opacity: 1, locked: false, visible: false } } });
    const special = validateBackgroundPreferences(JSON.parse('{"layers":{"__proto__":{"visible":false}}}')).layers;
    expect(Object.hasOwn(special, '__proto__')).toBe(true); expect(special['__proto__']!.visible).toBe(false);
  });
  it('rejects transient settings, nonfinite opacity, null and malformed preferences', () => {
    for (const backgrounds of [null, [], { comparisonMode: 1 }, { layers: null }, { layers: { a: { opacity: NaN } } }, { layers: { a: { opacity: -1 } } }, { layers: { a: { hover: true } } }, { adjusting: true }]) {
      expect(() => validateEditorState({ camera, backgrounds })).toThrow(expect.objectContaining({ code: 'EDITOR_STATE_INVALID' }));
    }
  });
});
