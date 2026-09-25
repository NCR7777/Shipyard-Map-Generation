/** Minimal ZIP reader for map packages: stored and deflate entries (native DecompressionStream).
 *  No ZIP64, encryption or spanning; CRC is not checked because every payload is validated downstream (map import, image SHA-256).
 *  Entries may not overlap: many directory records pointing at one small stream would otherwise inflate without bound. */
export interface ZipEntry { name: string; size: number; read(): Promise<ArrayBuffer> }

export class ZipError extends Error {}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Names without the UTF-8 flag are usually the system code page; on Chinese Windows that is GBK. */
function entryName(bytes: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return utf8.decode(bytes);
  try { return utf8.decode(bytes); } catch { return new TextDecoder('gbk').decode(bytes); }
}

/** Streams the entry and stops as soon as it grows past its declared size, so a forged header cannot inflate a bomb. */
async function inflate(data: Uint8Array, size: number): Promise<ArrayBuffer> {
  const reader = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const out = new Uint8Array(size); let length = 0;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    if (length + value.length > size) { await reader.cancel(); throw new ZipError('压缩包内容与声明的大小不符。'); }
    out.set(value, length); length += value.length;
  }
  if (length !== size) throw new ZipError('压缩包内容与声明的大小不符。');
  return out.buffer;
}

export function readZip(buffer: ArrayBuffer, maxEntryBytes: number): ZipEntry[] {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  // The end record must close the directory it describes; a look-alike signature inside the archive comment does not.
  let end = -1;
  for (let at = buffer.byteLength - 22; at >= Math.max(0, buffer.byteLength - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && view.getUint32(at + 16, true) + view.getUint32(at + 12, true) === at) { end = at; break; }
  }
  if (end < 0) throw new ZipError('不是有效的 zip 文件。');
  const count = view.getUint16(end + 10, true), directory = view.getUint32(end + 16, true);
  if (count === 0xffff || directory === 0xffffffff) throw new ZipError('不支持 ZIP64 压缩包。');
  const entries: ZipEntry[] = [], spans: [number, number][] = [];
  for (let at = directory, index = 0; index < count; index++) {
    if (at + 46 > buffer.byteLength || view.getUint32(at, true) !== 0x02014b50) throw new ZipError('zip 目录损坏。');
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true);
    const packed = view.getUint32(at + 20, true), size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true), extra = view.getUint16(at + 30, true), comment = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = entryName(bytes.subarray(at + 46, at + 46 + nameLength), (flags & 0x800) !== 0);
    at += 46 + nameLength + extra + comment;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new ZipError(`${name} 已加密，无法读取。`);
    if (method !== 0 && method !== 8) throw new ZipError(`${name} 使用了不支持的压缩方式。`);
    if (local + 30 > buffer.byteLength || view.getUint32(local, true) !== 0x04034b50) throw new ZipError('zip 条目损坏。');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    if (start + packed > buffer.byteLength) throw new ZipError('zip 条目超出文件范围。');
    spans.push([local, start + packed]);
    entries.push({ name, size, read: async () => {
      if (size > maxEntryBytes) throw new ZipError(`${name} 过大，未读取。`);
      const data = bytes.subarray(start, start + packed);
      if (method === 8) {
        try { return await inflate(data, size); }
        catch (error) { throw error instanceof ZipError ? error : new ZipError(`${name} 解压失败，数据可能已损坏。`); }
      }
      if (packed !== size) throw new ZipError('压缩包内容与声明的大小不符。');
      return data.slice().buffer;
    } });
  }
  spans.sort((a, b) => a[0] - b[0]);
  if (spans.some((span, index) => index > 0 && span[0] < spans[index - 1]![1])) throw new ZipError('zip 条目互相重叠，拒绝读取。');
  return entries;
}
