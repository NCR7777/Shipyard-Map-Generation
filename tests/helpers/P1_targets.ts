import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { YardMap } from '../../src/domain/model';

// Exact user-owned originals, not reduced/recreated fixtures. Missing or changed inputs fail closed.
// Tuple counts: nodes, roads, facilities, zones, accessPoints, servicePoints,
// junctions, movements, resources, sources, assets, backgroundLayers, extension slots.
const originals = [
  ['imports', 'A', '9426d3f21f77fc756a2da71e194cd76d4ca35b141a9880a9fa4ac8926f24cf9d', [20,21,16,0,16,0,0,0,0,8,0,0,0]],
  ['imports', 'B', '6d5ed3b06417e3c0f14db819195beabe66d93049592a9c42a56653e1cc75b3ed', [27,29,21,0,21,0,0,0,0,8,0,0,0]],
  ['imports', 'C', '3772943bf8ae866e0588be449a9542e7b50fb1ff153767ac8fa19c312873b8ad', [17,18,13,0,13,0,0,0,0,8,0,0,0]],
  ['imports', 'D', '2d0127da81f7b2bbd7f66179286c8b205286cb03090a5c6c10b08d42138a338f', [22,24,17,0,17,0,0,0,0,8,0,0,0]],
  ['connected', 'A', '0bbd11f175cc268560aaba73a2f9f4bb53edc439c0dc63c7810208c77b8434cc', [25,25,16,0,16,0,0,0,0,9,0,0,0]],
  ['connected', 'B', 'f55d71108fe1acfd4807e9c7d7a856b17f6ecf46f7ae06391b672c2815ec3def', [32,33,21,0,21,0,0,0,0,9,0,0,0]],
  ['connected', 'C', '7990f77b11d5c1d53ad61be3779b055bd14859810198332ed6c697f6e39181ce', [24,25,13,0,13,0,0,0,0,9,0,0,0]],
  ['connected', 'D', 'c319cf5d5ba94d3ee61d44e622fdfebf7f11c467e4e037abacee8c5aff19b212', [30,33,17,0,17,0,0,0,0,9,0,0,0]],
  ['SR02', 'A', 'ded6923c802b360497e4c19caf10a000b86fc96dfdaec8d83c3bd9aac6aa9bd4', [72,85,4,8,8,14,68,260,141,5,0,0,159]],
  ['SR02', 'B', 'ccc88578adc30cb4d7a0524b8233134ef917349892e10a3c65ec4dc586bb7e86', [143,170,24,13,36,29,137,518,284,4,0,0,142]],
  ['SR02', 'C', 'f7da7edddd82221576f23f299082c68dfdc681efcdb65eef4e13b21b81134bed', [86,101,8,8,14,18,80,308,169,5,0,0,160]],
  ['SR02', 'D', 'f635f98c2c5645819d223a970066f23be5dbd020e0a555adec4c3b21397767a3', [88,103,8,12,10,20,80,320,173,4,0,0,308]],
  ['SR03', 'A', 'f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a', [59,71,12,5,8,11,56,224,119,2,0,0,48]],
  ['SR03', 'B', '283d08934e1e0dd6b5c14fdf6569ef622db99ea6ccf6f3e421c38ca581eb1921', [149,175,38,17,34,31,142,526,294,2,0,0,209]],
  ['SR03', 'C', '01fd0d6075060d846ed30f1362187a90a297a78376688c910ddc90c7a848b125', [129,149,33,24,10,29,117,452,252,2,0,0,318]],
  ['SR03', 'D', '0fb0d6f565d35431d934ae2dbdfeae63c5948675b40d31ac7641af888abc7622', [207,245,62,27,28,47,188,782,412,2,0,0,1421]],
] as const;
export const P1_COLLECTIONS = ['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'junctions', 'movements', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
// SHIPYARD_TEST_DATA_ROOT is the directory containing projects/, never a replacement fixture.
export function resolveP1DataRoot(dataRoot = process.env.SHIPYARD_TEST_DATA_ROOT): string {
  if (dataRoot !== undefined && !dataRoot.trim()) throw new Error('blocked_input: SHIPYARD_TEST_DATA_ROOT must name the directory containing projects/');
  return dataRoot === undefined ? fileURLToPath(new URL('../../../../', import.meta.url)) : resolve(dataRoot);
}
export const P1_TARGETS = originals.map(([family, yard, sha256, counts]) => {
  const path = family === 'SR02' || family === 'SR03'
    ? `projects/shipyard_simulation_${family}/${family}_${yard}/map.json`
    : `projects/shipyard_editor_${family}/YARD_${yard}.map.json`;
  return { family, yard, id: `${family}_${yard}`, path, sha256, counts,
    absolutePath: resolve(resolveP1DataRoot(), path) };
});
export type P1Target = typeof P1_TARGETS[number];
export async function readP1Target(target: P1Target): Promise<{ text: string; map: YardMap }> {
  let bytes: Buffer;
  try { bytes = await readFile(target.absolutePath); }
  catch (error) { throw new Error(`blocked_input: required original ${target.path} cannot be read at ${target.absolutePath}; SHIPYARD_TEST_DATA_ROOT must contain projects/`, { cause: error }); }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== target.sha256) throw new Error(`blocked_input: ${target.path} SHA256 ${actual} differs from frozen ${target.sha256}; do not substitute another map`);
  const text = bytes.toString('utf8');
  return { text, map: JSON.parse(text) as YardMap };
}
export function originalSlotCount(map: YardMap): number {
  return [...Object.values(map.facilities), ...Object.values(map.zones)].reduce((sum, owner) => {
    const payload = owner.extensions?.['sr02.planning'] as { slots?: unknown[] } | undefined;
    return sum + (payload?.slots?.length ?? 0);
  }, 0);
}
