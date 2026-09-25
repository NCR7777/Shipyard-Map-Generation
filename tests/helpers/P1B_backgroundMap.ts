import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const EXAMPLE = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The image always covers 64 × 48 m with its top-left corner at world (120, 48), right of the example's content,
 *  whatever its pixel size. Quadrants: top-left red, top-right blue, bottom-left green, bottom-right yellow. */
export const QUADRANT_POINTS = { red: [136, 36], blue: [168, 36], green: [136, 12], yellow: [168, 12] } as const;

const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), head = Buffer.alloc(4), tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length); tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
/** A four-colour RGB PNG of any size. */
export function quadrantPng(width = 64, height = 48): Buffer {
  const row = width * 3 + 1, raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const colour = y < height / 2 ? x < width / 2 ? [220, 40, 40] : [40, 80, 220] : x < width / 2 ? [40, 170, 60] : [230, 200, 40];
    raw.set(colour, y * row + 1 + x * 3);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The synthetic example plus one background layer showing `image` (default: 64 × 48 quadrants); `empty` drops every vector object,
 *  `transform` replaces the default placement, `unsized` drops the declared pixel size (an unsupported layer). */
export function backgroundMap(options: { empty?: boolean; mapId?: string; image?: Buffer; transform?: number[]; unsized?: boolean } = {}): string {
  const map = JSON.parse(readFileSync(EXAMPLE, 'utf8')), image = options.image ?? quadrantPng();
  const width = image.readUInt32BE(16), height = image.readUInt32BE(20), metres = 64 / width;
  if (options.mapId) map.mapId = options.mapId;
  if (options.empty) for (const key of ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources']) map[key] = {};
  const sha = createHash('sha256').update(image).digest('hex');
  map.sources.srcImage = { name: '测试影像', category: 'imagery_derived', description: '四色测试图' };
  map.assets.imgQuadrants = { path: `assets/${sha}.png`, sha256: sha, mediaType: 'image/png', sourceRef: 'srcImage', ...options.unsized ? {} : { widthPx: width, heightPx: height } };
  map.backgroundLayers.bgQuadrants = {
    name: '四色测试底图', assetId: 'imgQuadrants', pixelConvention: 'top_left_x_right_y_down_exif_normalized',
    imageToWorld: options.transform ?? [metres, 0, 0, -metres, 120, 48], method: 'manual', controlPoints: [], provenance: { category: 'imagery_derived', sourceRefs: ['srcImage'] },
  };
  return JSON.stringify(map, null, 2);
}
