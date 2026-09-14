import { describe, expect, it } from 'vitest';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import { roadLength } from '../../src/geometry/roads';
import { getRoadPath } from '../../src/geometry/roadPath';
import { loadMap } from '../../src/domain/load';
import { serializeMap } from '../../src/domain/serialization';

describe('FAST01 original reference maps migrate by representation only', () => {
  for (const target of GA01_TARGETS) it(target.id + ' keeps frozen frame, geometry, limits and all references in 0.3', async () => {
    const original = await readGA01Target(target);
    const before = createSession(original, true);
    const result = editSession(before, { type: 'upgradeSchema', targetVersion: '0.3.0' });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    const map = result.session.map;
    expect(map.schemaVersion).toBe('0.3.0'); expect(map.revision).toBe(original.revision + 1);
    for (const key of ['coordinateFrame', 'nodes', 'facilities', 'zones', 'junctions', 'movements', 'servicePoints', 'accessPoints', 'resources', 'sources', 'assets', 'backgroundLayers', 'extensions', 'extensionNamespaces'] as const) expect(map[key]).toEqual(original[key]);
    expect(Object.keys(map.roads)).toEqual(Object.keys(original.roads));
    for (const [id, old] of Object.entries(original.roads)) {
      const { shapePoints, ...fields } = old;
      const { geometry, ...nextFields } = map.roads[id]!;
      expect(nextFields).toEqual(fields);
      expect(geometry).toEqual({ kind: 'path', anchors: shapePoints, spans: Array.from({ length: shapePoints.length + 1 }, () => ({ kind: 'line' })) });
      expect(getRoadPath(map, id)).toEqual(getRoadPath(original, id));
      expect(roadLength(map, id)).toBe(roadLength(original, id));
    }
    expect(validateMap(map).ok).toBe(true);
    const reload = loadMap(serializeMap(map)); expect(reload.ok).toBe(true);
    if (reload.ok) expect(serializeMap(reload.map)).toBe(serializeMap(map));
    expect(undoSession(result.session).map).toEqual(original);
    expect(await readGA01Target(target)).toEqual(original);
  });
});
