import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { recordSiteBoundaryNormalization } from '../../src/domain/geometrySources';
import { newMap } from '../../src/domain/factory';
import { normalizePolygonBetweenVertices, polygonArea2D } from '../../src/geometry/polygons';
import { contentHash } from '../../src/domain/serialization';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { dryRunRepair } from '../../scripts/MQ01_core';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';

const command: MapCommand = { type: 'normalizeSiteBoundary' };
function fixture() {
  const map = newMap('MQ01_BOUNDARY', 'boundary cleanup test');
  map.siteBoundary = { outer: [[0,0,0],[5,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,0]],
    holes: [[[2,2,0],[2,4,0],[4,4,0],[4,2,0],[2,2,0]]] };
  return map;
}

describe('MQ01 exact site-boundary normalization', () => {
  it('preserves holes, area, old data and frame in one reversible transaction; repeats are no-ops', () => {
    const map = fixture(), session = createSession(map, true), result = editSession(session, command);
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1);
    const after = result.session.map;
    expect(after.siteBoundary!.outer).toHaveLength(map.siteBoundary!.outer.length - 1);
    expect(after.siteBoundary!.holes).toEqual(map.siteBoundary!.holes);
    expect(polygonArea2D(after.siteBoundary!)).toBe(polygonArea2D(map.siteBoundary!));
    expect(after.coordinateFrame).toEqual(map.coordinateFrame);
    expect(undoSession(result.session).map).toEqual(map);
    expect(redoSession(undoSession(result.session)).map).toEqual(after);
    expect(editSession(result.session, command).session).toBe(result.session);
    const record = JSON.parse(after.sources.source_mq01_site_boundary!.description!);
    expect(record.before).toEqual(map.siteBoundary); expect(record.after).toEqual(after.siteBoundary);
    expect(result.session.past[0]!.affectedRefs).toContainEqual({ kind: 'siteBoundary', id: 'siteBoundary' });
    expect(commandSupport(map, command).affectedRefs).toEqual(result.session.past[0]!.affectedRefs);
  });
  it('preserves bends, near-collinear points, backtracking and nonplanar vertices', () => {
    for (const middle of [[5,1e-12,0],[15,0,0],[5,0,1]] as const) {
      const map = fixture(); map.siteBoundary!.outer[1] = [...middle];
      expect(normalizePolygonBetweenVertices(map.siteBoundary!)).toEqual(map.siteBoundary);
    }
    const empty = newMap('MQ01_EMPTY'); expect(applyMapCommand(empty, command)).toEqual({ ok: true, map: empty, changed: false });
  });
  it('rejects arbitrary parameters and unsupported extensions atomically', () => {
    const map = fixture();
    expect(applyMapCommand(map, { ...command, boundary: map.siteBoundary } as MapCommand).ok).toBe(false);
    map.extensionNamespaces['unknown.geometry'] = { version: '1', category: 'behavior' };
    expect(commandSupport(map, command).issues[0]!.code).toBe('READ_ONLY_MAP');
  });
  it('exposes both boundary and added source to the existing locked/protected repair gate', () => {
    const map = fixture(), hash = contentHash(map);
    const evidence = { rule: 'MQ-P01', classification: 'A' as const, reason: 'exact between vertices', references: ['test'], expectedChange: 'one less redundant vertex' };
    for (const kind of ['siteBoundary', 'sources']) {
      const result = dryRunRepair(map, 'test', command, evidence, { lockedTypes: [kind], protectedRefs: [], sourceFilesSha256: {} });
      expect(result.ok).toBe(false); if (!result.ok) expect(result.issues[0]!.code).toBe('LOCKED_DEPENDENCY');
    }
    const protectedResult = dryRunRepair(map, 'test', command, evidence, { lockedTypes: [], protectedRefs: [{ kind: 'siteBoundary', id: 'siteBoundary' }], sourceFilesSha256: {} });
    expect(protectedResult.ok).toBe(false); expect(contentHash(map)).toBe(hash);
  });
  it('allocates source IDs past assets/backgrounds and keeps all original sources', () => {
    const before = fixture(), after = structuredClone(before), base = 'source_mq01_site_boundary';
    after.siteBoundary = normalizePolygonBetweenVertices(after.siteBoundary!);
    after.assets[base] = { path: 'image.png', sha256: '0'.repeat(64), mediaType: 'image/png', sourceRef: 'old' };
    after.backgroundLayers[base + '_1'] = { name: 'reference', assetId: base, pixelConvention: 'top_left_x_right_y_down_exif_normalized', imageToWorld: [1,0,0,-1,0,0], method: 'manual', controlPoints: [], provenance: { category: 'synthetic' } };
    after.sources[base + '_2'] = { name: 'original', category: 'synthetic', description: 'original source' };
    expect(recordSiteBoundaryNormalization(before, after)).toEqual([{ kind: 'sources', id: base + '_3' }]);
    expect(after.sources[base + '_2']!.name).toBe('original');
  });
  it('removes exactly the two frozen Weihai redundant site-boundary vertices', async () => {
    const target = GA01_TARGETS.find(t => t.id === 'weihai_v02')!, map = await readGA01Target(target);
    const result = applyMapCommand(map, command);
    expect(result.ok, JSON.stringify(result)).toBe(true); if (!result.ok) return;
    expect(result.map.siteBoundary!.outer).toEqual(map.siteBoundary!.outer.filter((_, i) => i !== 3 && i !== 4));
    expect(polygonArea2D(result.map.siteBoundary!)).toBe(polygonArea2D(map.siteBoundary!));
    expect(result.map.siteBoundary!.holes).toEqual(map.siteBoundary!.holes);
    expect(result.map.resources).toEqual(map.resources);
    expect(contentHash(await readGA01Target(target))).toBe(target.contentHash);
  });
});
