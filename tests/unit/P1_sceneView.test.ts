import { describe, expect, it } from 'vitest';
import { fitCamera } from '../../src/geometry/coordinates';
import { newMap } from '../../src/domain/factory';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { itemValue } from '../../src/compiler/catalog';
import { validateEditorState, DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

describe('P1 declared scene and view isolation', () => {
  it('projects real slots and site boundary without assigning geometry to unrelated logical declarations', async () => {
    const { map } = await readP1Target(P1_TARGETS.find(t => t.id === 'SR03_A')!);
    const before = serializeMap(map);
    const scene = toSceneSnapshot(map);
    expect(scene.items.filter(i => i.kind === 'slots')).toHaveLength(48);
    expect(scene.items.find(i => i.kind === 'siteBoundary')!.polygons).toEqual([map.siteBoundary]);
    const slot = scene.items.find(i => i.kind === 'slots' && i.owner?.id === 'F_001')!;
    expect(itemValue(map, slot)).toMatchObject({ id: 'SLOT_001_001', boundary: slot.polygons[0] });
    expect(scene.items.filter(i => i.kind === 'sources').every(i => i.polygons.length === 0 && i.points.length === 0)).toBe(true);
    expect(scene.items.filter(i => i.kind === 'resources').every(i => i.status === 'logical')).toBe(true);
    slot.polygons[0]!.outer[0][0] += 100;
    expect(serializeMap(map)).toBe(before);
  });
  it('keeps unsupported extension payload in the directory with an exact pointer', () => {
    const map = newMap('unknown_catalog');
    map.extensionNamespaces['future.rules'] = { version: '9', category: 'behavior' };
    map.extensions['future.rules'] = { nested: { opaque: [1, 2, 3] } };
    const scene = toSceneSnapshot(map);
    const item = scene.items.find(i => i.jsonPath === '/extensions/future.rules')!;
    expect(item.status).toBe('unsupported');
    expect(itemValue(map, item)).toEqual({ nested: { opaque: [1, 2, 3] } });
  });
  it('normalizes legacy views and persists new settings independently of semantic JSON', () => {
    const camera = { scale: 2, offsetX: 0, offsetY: 20 };
    expect(validateEditorState({ camera }).drawing).toEqual(DEFAULT_DRAWING_CONFIG);
    const map = newMap('view_independent'); const before = serializeMap(map); const hash = contentHash(map);
    const view = validateEditorState({ camera, drawing: { hiddenTypes: ['facilities'], lockedTypes: ['nodes'], objectSearch: 'F_001', showLabels: false, facilityMovePolicy: 'withStaticContents' } });
    expect(validateEditorState(JSON.parse(JSON.stringify(view)))).toEqual(view);
    expect(contentHash(map)).toBe(hash); expect(serializeMap(map)).toBe(before);
  });
  it('copies accepted layer arrays independently of defaults and caller-owned pending writes', () => {
    const camera = { scale: 2, offsetX: 0, offsetY: 20 };
    const first = validateEditorState({ camera });
    first.drawing.hiddenTypes.push('nodes');
    expect(validateEditorState({ camera }).drawing.hiddenTypes).toEqual([]);
    expect(DEFAULT_DRAWING_CONFIG.hiddenTypes).toEqual([]);
    const lockedTypes: ['slots'] = ['slots'];
    const accepted = validateEditorState({ camera, drawing: { lockedTypes } });
    lockedTypes.splice(0);
    expect(accepted.drawing.lockedTypes).toEqual(['slots']);
  });
  it('shares finite fit behavior for full maps and extreme-coordinate object navigation', () => {
    expect(fitCamera({ min: [1e308, 0, 0], max: [1e308, 0, 0] }, 800, 540)).toBeNull();
    const across = fitCamera({ min: [-1e308, -1e308, 0], max: [1e308, 1e308, 0] }, 800, 540)!;
    expect(across.scale).toBeGreaterThan(0); expect(Object.values(across).every(Number.isFinite)).toBe(true);
    expect(fitCamera({ min: [0, 0, 0], max: [100, 50, 0] }, 800, 540)).toEqual({ scale: 7, offsetX: 50, offsetY: 445 });
  });
  it.each([
    { hiddenTypes: ['unknown'] }, { lockedTypes: ['nodes', 'nodes'] }, { hiddenTypes: null },
    { showLabels: 0 }, { objectSearch: 'x'.repeat(201) }, { lockedTypes: { nodes: true } },
  ])('rejects invalid display configuration %j', drawing => {
    expect(() => validateEditorState({ camera: { scale: 1, offsetX: 0, offsetY: 0 }, drawing })).toThrow();
  });
});
