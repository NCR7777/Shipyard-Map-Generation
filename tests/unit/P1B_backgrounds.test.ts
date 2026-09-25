import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { readZip, ZipError } from '../../src/app/files/zip';
import { backgroundBounds, drawableBackgrounds, type Raster } from '../../src/app/state/backgrounds';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { storedZip } from '../../src/adapters/storedZip';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { backgroundMap } from '../helpers/P1B_backgroundMap';

function load(text: string): YardMap {
  const result = loadMap(text);
  if (!result.ok) throw new Error(result.report.issues.map(issue => issue.message).join('\n'));
  return result.map;
}

describe('background layers are placed from the map alone', () => {
  it('the fixture imports and its footprint follows imageToWorld (y down in pixels, up in the world)', () => {
    const map = load(backgroundMap());
    expect(backgroundBounds(map)).toEqual({ min: [120, 0, 0], max: [184, 48, 0] });
    expect(toSceneSnapshot(load(backgroundMap({ empty: true }))).bounds).toBeNull();
  });
  it('only ready, visible, supported layers are drawn, with their own opacity', () => {
    const map = load(backgroundMap()), sha = map.assets.imgQuadrants!.sha256, levels = [{} as ImageBitmap];
    const ready: Record<string, Raster> = { [sha]: { status: 'ready', levels } }, view = { hidden: [], opacity: { bgQuadrants: 0.4 }, comparison: false };
    expect(drawableBackgrounds(map, ready, view)).toEqual([{ id: 'bgQuadrants', levels, transform: [1, 0, 0, -1, 120, 48], opacity: 0.4 }]);
    expect(drawableBackgrounds(map, ready, { ...view, hidden: ['bgQuadrants'] })).toEqual([]);
    expect(drawableBackgrounds(map, { [sha]: { status: 'missing' } }, view)).toEqual([]);
    // Without declared pixel size the layer cannot be placed: unsupported, never drawn, no footprint.
    const unsized = structuredClone(map) as YardMap; delete unsized.assets.imgQuadrants!.widthPx;
    expect(drawableBackgrounds(unsized, ready, view)).toEqual([]);
    expect(backgroundBounds(unsized)).toBeNull();
  });
});

/** Local headers plus central directory; `deflate` compresses, `utf8` sets the UTF-8 name flag, `declared` forges the size. */
function zipOf(entries: { name: Uint8Array | string; data: Uint8Array; deflate?: boolean; utf8?: boolean; declared?: number; flags?: number }[], comment = new Uint8Array()): ArrayBuffer {
  const locals: Uint8Array[] = [], central: Uint8Array[] = []; let offset = 0;
  for (const entry of entries) {
    const name = typeof entry.name === 'string' ? new TextEncoder().encode(entry.name) : entry.name;
    const body = entry.deflate ? deflateRawSync(entry.data) : entry.data, flags = (entry.flags ?? 0) | (entry.utf8 ? 0x800 : 0);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(6, flags, true); local.setUint16(8, entry.deflate ? 8 : 0, true);
    local.setUint32(18, body.length, true); local.setUint32(22, entry.declared ?? entry.data.length, true); local.setUint16(26, name.length, true);
    const head = new DataView(new ArrayBuffer(46));
    head.setUint32(0, 0x02014b50, true); head.setUint16(8, flags, true); head.setUint16(10, entry.deflate ? 8 : 0, true);
    head.setUint32(20, body.length, true); head.setUint32(24, entry.declared ?? entry.data.length, true); head.setUint16(28, name.length, true); head.setUint32(42, offset, true);
    locals.push(new Uint8Array(local.buffer), name, body); central.push(new Uint8Array(head.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true); end.setUint16(20, comment.length, true);
  const parts = [...locals, ...central, new Uint8Array(end.buffer), comment], out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0; for (const part of parts) { out.set(part, at); at += part.length; }
  return out.buffer;
}
const text = async (buffer: ArrayBuffer) => new TextDecoder().decode(buffer);

describe('zip packages', () => {
  const data = new TextEncoder().encode('{"hello":"船厂"}'.repeat(50));
  it('reads stored entries written by the app itself, and deflated ones', async () => {
    const stored = readZip(new Uint8Array(storedZip([{ name: 'a/map.json', bytes: data }])).buffer, 1 << 20);
    expect(stored.map(entry => entry.name)).toEqual(['a/map.json']);
    expect(await text(await stored[0]!.read())).toBe(new TextDecoder().decode(data));
    const deflated = readZip(zipOf([{ name: 'map.json', data, deflate: true, utf8: true }]), 1 << 20);
    expect(await text(await deflated[0]!.read())).toBe(new TextDecoder().decode(data));
  });
  it('decodes names from Chinese Windows (GBK, no UTF-8 flag) and skips folders', () => {
    const gbk = new Uint8Array([0xba, 0xab, 0xbb, 0xaa, 0x2f, 0x6d, 0x61, 0x70, 0x2e, 0x6a, 0x73, 0x6f, 0x6e]); // 韩华/map.json
    const entries = readZip(zipOf([{ name: '韩华/', data: new Uint8Array(), utf8: true }, { name: gbk, data }]), 1 << 20);
    expect(entries.map(entry => entry.name)).toEqual(['韩华/map.json']);
  });
  it('refuses forged sizes, oversized entries, encryption and non-zip input', async () => {
    await expect(readZip(zipOf([{ name: 'bomb.json', data, deflate: true, declared: 10 }]), 1 << 20)[0]!.read()).rejects.toThrow(ZipError);
    await expect(readZip(zipOf([{ name: 'big.json', data }]), 100)[0]!.read()).rejects.toThrow('过大');
    expect(() => readZip(zipOf([{ name: 'secret.json', data, flags: 1 }]), 1 << 20)).toThrow('加密');
    expect(() => readZip(new TextEncoder().encode('not a zip').buffer, 1 << 20)).toThrow(ZipError);
  });
  it('refuses directory records that share one data stream (unbounded total inflation)', () => {
    // 64 records all pointing at the first entry: each passes its own size check, together they would inflate 64 times.
    const zip = new Uint8Array(zipOf([{ name: 'a.png', data, deflate: true }])), view = new DataView(zip.buffer);
    const end = zip.length - 22, directory = view.getUint32(end + 16, true), record = zip.slice(directory, end);
    const records = new Uint8Array(record.length * 64); for (let i = 0; i < 64; i++) records.set(record, i * record.length);
    const tail = new DataView(new ArrayBuffer(22)); tail.setUint32(0, 0x06054b50, true);
    tail.setUint16(8, 64, true); tail.setUint16(10, 64, true); tail.setUint32(12, records.length, true); tail.setUint32(16, directory, true);
    const forged = new Uint8Array(directory + records.length + 22);
    forged.set(zip.subarray(0, directory)); forged.set(records, directory); forged.set(new Uint8Array(tail.buffer), directory + records.length);
    expect(() => readZip(forged.buffer, 1 << 20)).toThrow('重叠');
  });
  it('ignores an end-record look-alike inside the archive comment, and names a truncated stream', async () => {
    const fake = new Uint8Array(22); new DataView(fake.buffer).setUint32(0, 0x06054b50, true);
    expect(readZip(zipOf([{ name: 'map.json', data, utf8: true }], fake), 1 << 20).map(entry => entry.name)).toEqual(['map.json']);
    // Half of a deflate stream, declared with the full size and marked as deflated.
    const whole = deflateRawSync(data), bytes = new Uint8Array(zipOf([{ name: 'cut.png', data: whole.subarray(0, whole.length >> 1), declared: data.length }]));
    const view = new DataView(bytes.buffer), directory = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint16(8, 8, true); view.setUint16(directory + 10, 8, true);
    await expect(readZip(bytes.buffer, 1 << 20)[0]!.read()).rejects.toThrow('cut.png 解压失败');
  });
});
