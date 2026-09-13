import type { RasterAssetBytes } from '../editor/projectController';

export const MAX_RASTER_BYTES = 32 * 1024 * 1024;
export const MAX_RASTER_PIXELS = 24_000_000;
export class RasterFileError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'RasterFileError'; }
}
export interface RasterHeader { mimeType: RasterAssetBytes['mimeType']; width: number; height: number }
function fail(code = 'RASTER_INVALID', message = '底图文件损坏或格式不受支持。'): never { throw new RasterFileError(code, message); }

/** Read only bounded metadata before any browser image decoder is allowed to allocate pixels. */
export function inspectRasterBytes(bytes: ArrayBuffer): RasterHeader {
  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength === 0 || bytes.byteLength > MAX_RASTER_BYTES) fail('RASTER_BYTES_LIMIT', '底图必须为不超过 32 MiB 的本地 PNG、JPEG 或 WebP。');
  const data = new Uint8Array(bytes), view = new DataView(bytes);
  const need = (offset: number, length: number) => { if (!Number.isSafeInteger(offset) || offset < 0 || length < 0 || offset + length > data.length) fail(); };
  const text = (offset: number, length: number) => { need(offset, length); return String.fromCharCode(...data.subarray(offset, offset + length)); };
  const u16 = (offset: number, le = false) => { need(offset, 2); return view.getUint16(offset, le); };
  const u32 = (offset: number, le = false) => { need(offset, 4); return view.getUint32(offset, le); };
  const dimensions = (width: number, height: number): [number, number] => {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_RASTER_PIXELS) fail('RASTER_PIXEL_LIMIT', '底图像素总数不能超过 2400 万；请先在本地缩小图片。');
    return [width, height];
  };
  const exif = (offset: number, length: number) => {
    const end = offset + length; need(offset, length);
    if (text(offset, Math.min(6, length)) === 'Exif\0\0') { offset += 6; length -= 6; }
    if (length < 8) fail('RASTER_EXIF_INVALID', '无法核实 EXIF 方向，请先在本地正规化图像。');
    const order = text(offset, 2), le = order === 'II';
    if (!['II', 'MM'].includes(order) || u16(offset + 2, le) !== 42) fail('RASTER_EXIF_INVALID', '无法核实 EXIF 方向，请先在本地正规化图像。');
    const ifd = offset + u32(offset + 4, le);
    if (ifd < offset + 8 || ifd + 2 > end) fail('RASTER_EXIF_INVALID');
    const count = u16(ifd, le);
    if (count > 256 || ifd + 2 + count * 12 + 4 > end) fail('RASTER_EXIF_INVALID');
    for (let index = 0; index < count; index++) {
      const entry = ifd + 2 + index * 12;
      if (u16(entry, le) === 0x0112 && (u16(entry + 2, le) !== 3 || u32(entry + 4, le) !== 1 || u16(entry + 8, le) !== 1)) {
        fail('RASTER_EXIF_ORIENTATION', '底图带有非标准 EXIF 旋转/翻转；请先在本地应用方向并导出正规化图片，避免配准坐标错位。');
      }
    }
  };
  if (data.length >= 24 && text(0, 8) === '\x89PNG\r\n\x1a\n') {
    if (u32(8) !== 13 || text(12, 4) !== 'IHDR') fail();
    const [width, height] = dimensions(u32(16), u32(20));
    let offset = 8, ended = false, payload = false;
    while (offset < data.length) {
      need(offset, 12); const length = u32(offset), kind = text(offset + 4, 4); need(offset + 8, length + 4);
      if (kind === 'acTL') fail('RASTER_ANIMATION_UNSUPPORTED', '动画图片不能作为静态标定底图，请在本地导出单帧。');
      if (kind === 'IHDR' && offset !== 8) fail();
      if (kind === 'eXIf') exif(offset + 8, length);
      if (kind === 'IDAT') payload = true;
      offset += length + 12;
      if (kind === 'IEND') { if (length !== 0 || offset !== data.length) fail(); ended = true; break; }
    }
    if (!ended || !payload) fail();
    return { mimeType: 'image/png', width, height };
  }
  if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
    let offset = 2, size: [number, number] | null = null, scan = false;
    while (offset < data.length) {
      if (data[offset++] !== 0xff) fail();
      while (data[offset] === 0xff) offset++;
      const marker = data[offset++]; if (marker === undefined) fail();
      if (marker === 0xd9) break;
      const length = u16(offset); if (length < 2) fail(); need(offset, length);
      if (marker === 0xe1 && length >= 8 && text(offset + 2, 6) === 'Exif\0\0') exif(offset + 2, length - 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (length < 8 || size) fail(); size = dimensions(u16(offset + 5), u16(offset + 3));
      } else if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) fail('RASTER_JPEG_UNSUPPORTED');
      if (marker === 0xda) {
        scan = true;
        // EXIF metadata between progressive scans must not bypass the orientation contract.
        for (let at = offset + length; at + 10 <= data.length; at++) {
          if (data[at] === 0xff && data[at + 1] === 0xe1 && text(at + 4, 6) === 'Exif\0\0') {
            const size = u16(at + 2); if (size < 8) fail('RASTER_EXIF_INVALID'); exif(at + 4, size - 2);
          }
        }
        break;
      }
      offset += length;
    }
    if (!scan || !size || data[data.length - 2] !== 0xff || data[data.length - 1] !== 0xd9) fail();
    return { mimeType: 'image/jpeg', width: size[0], height: size[1] };
  }
  if (data.length >= 20 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    if (u32(4, true) + 8 !== data.length) fail();
    let offset = 12, canvas: [number, number] | null = null, payload: [number, number] | null = null;
    while (offset < data.length) {
      need(offset, 8); const kind = text(offset, 4), length = u32(offset + 4, true), start = offset + 8; need(start, length);
      if (kind === 'ANIM' || kind === 'ANMF') fail('RASTER_ANIMATION_UNSUPPORTED', '动画 WebP 不能作为静态标定底图。');
      if (kind === 'VP8X') {
        if (length !== 10 || canvas) fail();
        if (data[start]! & 2) fail('RASTER_ANIMATION_UNSUPPORTED');
        canvas = dimensions(1 + data[start + 4]! + data[start + 5]! * 256 + data[start + 6]! * 65536, 1 + data[start + 7]! + data[start + 8]! * 256 + data[start + 9]! * 65536);
      }
      if (kind === 'VP8 ') {
        if (length < 10 || payload || text(start + 3, 3) !== '\x9d\x01\x2a') fail();
        payload = dimensions(u16(start + 6, true) & 0x3fff, u16(start + 8, true) & 0x3fff);
      }
      if (kind === 'VP8L') {
        if (length < 5 || payload || data[start] !== 0x2f || (data[start + 4]! >> 5) !== 0) fail();
        payload = dimensions(1 + data[start + 1]! + ((data[start + 2]! & 0x3f) << 8), 1 + (data[start + 2]! >> 6) + (data[start + 3]! << 2) + ((data[start + 4]! & 15) << 10));
      }
      if (kind === 'EXIF') exif(start, length);
      offset = start + length + (length % 2);
    }
    if (offset !== data.length || !payload || canvas && (canvas[0] !== payload[0] || canvas[1] !== payload[1])) fail();
    return { mimeType: 'image/webp', width: payload[0], height: payload[1] };
  }
  return fail('RASTER_TYPE_UNSUPPORTED', '只支持本地 PNG、JPEG、WebP；扩展名和 MIME 文本不代替实际文件检查。');
}

export async function rasterBytes(bytes: ArrayBuffer): Promise<RasterAssetBytes> {
  const header = inspectRasterBytes(bytes), copy = bytes.slice(0);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return { ...header, bytes: copy, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') };
}
export async function readRasterFile(file: File): Promise<RasterAssetBytes> {
  if (file.size > MAX_RASTER_BYTES) fail('RASTER_BYTES_LIMIT', '底图不能超过 32 MiB。');
  return rasterBytes(await file.arrayBuffer());
}
export interface DecodedRaster { image: HTMLImageElement; dispose(): void }
/** Object URLs are transient; callers own one disposal for each successful decode. */
export async function decodeRaster(asset: RasterAssetBytes): Promise<DecodedRaster> {
  const header = inspectRasterBytes(asset.bytes);
  if (header.width !== asset.width || header.height !== asset.height || header.mimeType !== asset.mimeType) fail('RASTER_METADATA_MISMATCH');
  const url = URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType })), image = new Image();
  try {
    image.src = url; await image.decode();
    if (image.naturalWidth !== header.width || image.naturalHeight !== header.height) fail('RASTER_DECODE_DIMENSIONS', '解码尺寸与文件声明不一致；底图未载入。');
    let disposed = false;
    return { image, dispose: () => { if (!disposed) { disposed = true; image.src = ''; URL.revokeObjectURL(url); } } };
  } catch (error) {
    image.src = ''; URL.revokeObjectURL(url);
    if (error instanceof RasterFileError) throw error;
    return fail('RASTER_DECODE_FAILED', '图片无法解码；可选择有效文件重试，矢量地图保持不变。');
  }
}
