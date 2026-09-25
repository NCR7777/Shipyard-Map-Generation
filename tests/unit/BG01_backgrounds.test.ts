import { describe, expect, it } from 'vitest';
import type { Asset, BackgroundLayer, YardMap } from '../../src/domain/model';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { mapCapabilities } from '../../src/domain/capabilities';
import { BACKGROUND_PIXEL_CONVENTION, inspectAsset, inspectBackground } from '../../src/domain/backgrounds';
import { backgroundDeterminant, backgroundFrame, backgroundPoint, resizeBackgroundCorner, rotateBackground, scaleBackground, translateBackground, type BackgroundTransform } from '../../src/geometry/backgrounds';
import { createSession, editSession, redoSession, undoSession } from '../../src/editor/session';
import { serializeMap } from '../../src/domain/serialization';
import { loadMap } from '../../src/domain/load';
import { editorFixture } from '../helpers/M1_fixtures';
import { rectangle, testFacility } from '../helpers/M2A_fixtures';

const transform: BackgroundTransform = [2, 0.5, 0.25, -3, 100, 200];
const asset: Asset = { path: 'assets/synthetic.png', sha256: 'a'.repeat(64), mediaType: 'image/png', widthPx: 80, heightPx: 60, sourceRef: 'source_image' };
const layer: BackgroundLayer = {
  name: 'synthetic raster', assetId: 'image', pixelConvention: BACKGROUND_PIXEL_CONVENTION,
  imageToWorld: transform, method: 'affine',
  controlPoints: [{ pixel: [0, 0], world: [100, 200, 7], role: 'fit' }, { pixel: [80, 60], world: [275, 60, 7], role: 'check' }],
  provenance: { category: 'imagery_derived', sourceRefs: ['source_image'], fieldSources: { imageToWorld: 'source_image', controlPoints: 'source_image' } },
};
function fixture(): YardMap {
  const map = editorFixture();
  map.coordinateFrame.geographicAnchor = { crs: 'EPSG:32651', coordinateOrder: 'E,N,Z', origin: [-123.456, 987.654, 23], rotationRad: 0.37, method: 'unverified test reference' };
  map.sources.source_image = { name: 'Synthetic test image declaration', category: 'synthetic', description: 'No real survey or imagery claim.' };
  map.assets.image = structuredClone(asset); map.backgroundLayers.background = structuredClone(layer);
  return map;
}
function apply(map: YardMap, command: MapCommand) {
  const result = applyMapCommand(map, command);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result;
}
function vectors(map: YardMap) {
  return Object.fromEntries((['coordinateFrame', 'siteBoundary', 'nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'extensions', 'extensionNamespaces'] as const).map(key => [key, map[key]]));
}
function near(a: readonly number[], b: readonly number[]) { a.forEach((value, i) => expect(value).toBeCloseTo(b[i]!, 10)); }

describe('BG01 affine image geometry', () => {
  it('derives pixel-corner bounds, dimensions and basis angle from a sheared affine', () => {
    const frame = backgroundFrame(transform, 80, 60);
    expect(frame.corners).toEqual([[100, 200], [260, 240], [275, 60], [115, 20]]);
    expect(frame.center).toEqual([187.5, 130]);
    expect(frame.widthM).toBeCloseTo(80 * Math.hypot(2, 0.5));
    expect(frame.heightM).toBeCloseTo(60 * Math.hypot(0.25, -3));
    expect(frame.rotationRad).toBeCloseTo(Math.atan2(0.5, 2));
  });
  it('translates and rotates in world space, retaining the center and determinant', () => {
    expect(translateBackground(transform, [7, -9])).toEqual([2, 0.5, 0.25, -3, 107, 191]);
    const rotated = rotateBackground(transform, 80, 60, Math.PI / 2);
    near(backgroundFrame(rotated, 80, 60).center, backgroundFrame(transform, 80, 60).center);
    expect(backgroundDeterminant(rotated)).toBeCloseTo(backgroundDeterminant(transform));
    near(backgroundPoint(rotated, [0, 0]), [117.5, 42.5]);
    expect(rotateBackground(transform, 80, 60, 0)).toEqual(transform);
  });
  it.each([0, 1, 2, 3] as const)('corner %i resize retains its opposite world point and preserves shear', corner => {
    const fixed = ((corner + 2) % 4) as 0 | 1 | 2 | 3;
    const scaled = scaleBackground(transform, 80, 60, 1.7, 0.6, fixed);
    const old = backgroundFrame(transform, 80, 60), next = backgroundFrame(scaled, 80, 60);
    near(next.corners[fixed], old.corners[fixed]);
    near(resizeBackgroundCorner(transform, 80, 60, corner, next.corners[corner]), scaled);
    expect(scaled[1] / scaled[0]).toBeCloseTo(transform[1] / transform[0]);
    expect(scaled[2] / scaled[3]).toBeCloseTo(transform[2] / transform[3]);
    const uniform = scaleBackground(transform, 80, 60, 2, 2, fixed);
    near(resizeBackgroundCorner(transform, 80, 60, corner, backgroundFrame(uniform, 80, 60).corners[corner], true), uniform);
  });
  it('rejects zero, negative, singular and nonfinite transforms without clamping to mirrored geometry', () => {
    for (const factor of [0, -1, NaN, Infinity]) expect(() => scaleBackground(transform, 80, 60, factor, 1, 0)).toThrow();
    expect(() => backgroundFrame([1, 1, 1, 1, 0, 0], 80, 60)).toThrow();
    expect(() => translateBackground(transform, [NaN, 0])).toThrow();
    expect(scaleBackground(transform, 80, 60, 1, 1, 2)).toEqual(transform);
  });
});

describe('BG01 atomic background commands', () => {
  it('adds image, declared source and layer in one undoable transaction without changing vectors or frame', () => {
    const map = editorFixture(), original = serializeMap(map);
    const session = createSession(map, true);
    const result = editSession(session, { type: 'addBackground', id: 'background', assetId: 'image', asset, layer,
      source: { id: 'source_image', value: fixture().sources.source_image! } });
    expect(result.ok).toBe(true); expect(result.session.past).toHaveLength(1);
    expect(vectors(result.session.map)).toEqual(vectors(map));
    expect(serializeMap(undoSession(result.session).map)).toBe(original);
    expect(redoSession(undoSession(result.session)).map).toEqual(result.session.map);
    expect(result.session.past[0]!.affectedRefs).toEqual(expect.arrayContaining([
      { kind: 'backgroundLayers', id: 'background' }, { kind: 'assets', id: 'image' }, { kind: 'sources', id: 'source_image' }, { kind: 'sources', id: 'source_editor_background' },
    ]));
    const loaded = loadMap(serializeMap(result.session.map));
    expect(loaded.ok && loaded.capabilities.editable).toBe(true);
    expect(loaded.ok && loaded.map).toEqual(result.session.map);
  });
  it('marks only changed transform/method as manual while keeping original control points, other field sources and all vectors', () => {
    const map = fixture(), original = serializeMap(map);
    const result = apply(map, { type: 'updateBackgroundTransform', id: 'background', imageToWorld: translateBackground(transform, [10, -5]) });
    const next = result.map.backgroundLayers.background!;
    expect(next.controlPoints).toEqual(layer.controlPoints);
    expect(next.method).toBe('manual'); expect(next.provenance.category).toBe('imagery_derived');
    expect(next.provenance.fieldSources).toEqual({ controlPoints: 'source_image', imageToWorld: 'source_editor_background', method: 'source_editor_background' });
    expect(next.provenance.sourceRefs).toContain('source_image');
    expect(JSON.parse(result.map.sources.source_editor_background!.description).calibrationStatus).toContain('no_valid_residual');
    expect(vectors(result.map)).toEqual(vectors(map)); expect(serializeMap(map)).toBe(original);
    expect(result.map.assets).toEqual(map.assets);
  });
  it('preserves original assets and control points when replacing; deleting retains images, provenance ledger and vectors', () => {
    const map = fixture(), replacement = { ...asset, path: 'assets/replacement.png', sha256: 'b'.repeat(64), widthPx: 40 };
    const replaced = apply(map, { type: 'replaceBackgroundAsset', id: 'background', assetId: 'replacement', asset: replacement }).map;
    expect(replaced.assets.image).toEqual(map.assets.image);
    expect(replaced.backgroundLayers.background!.controlPoints).toEqual(layer.controlPoints);
    expect(replaced.backgroundLayers.background!.imageToWorld).toEqual(transform);
    expect(replaced.backgroundLayers.background!.method).toBe('manual');
    const deleted = apply(replaced, { type: 'deleteBackground', id: 'background' }).map;
    expect(deleted.backgroundLayers).toEqual({}); expect(deleted.assets).toEqual(replaced.assets);
    expect(vectors(deleted)).toEqual(vectors(map)); expect(mapCapabilities(deleted).editable).toBe(true);
    expect(JSON.parse(deleted.sources.source_editor_background_1!.description).retainedControlPoints).toEqual(layer.controlPoints);
  });
  it('no-op and failed transforms do not create history, revisions or sources', () => {
    const session = createSession(fixture(), true);
    for (const command of [
      { type: 'updateBackgroundTransform', id: 'background', imageToWorld: [...transform] },
      { type: 'replaceBackgroundAsset', id: 'background', assetId: 'image', asset },
    ] as MapCommand[]) {
      const result = editSession(session, command); expect(result.ok).toBe(true); expect(result.session).toBe(session);
    }
    for (const imageToWorld of [[0, 0, 0, 0, 0, 0], [2, 0, 0, 3, 100, 200], [NaN, 0, 0, -1, 0, 0]] as BackgroundTransform[]) {
      const result = editSession(session, { type: 'updateBackgroundTransform', id: 'background', imageToWorld });
      expect(result.ok).toBe(false); expect(result.session).toBe(session);
    }
  });
  it('cannot inject fields, overwrite an image path, reuse another entity ID or mutate unknown metadata references', () => {
    const map = fixture(), original = serializeMap(map);
    const commands: MapCommand[] = [
      { type: 'updateBackgroundTransform', id: 'background', imageToWorld: transform, coordinateFrame: {} } as unknown as MapCommand,
      { type: 'replaceBackgroundAsset', id: 'background', assetId: 'new_image', asset: { ...asset, sha256: 'b'.repeat(64) } },
      { type: 'replaceBackgroundAsset', id: 'background', assetId: 'nA', asset: { ...asset, path: 'assets/other.png' } },
    ];
    for (const command of commands) expect(applyMapCommand(map, command).ok).toBe(false);
    expect(serializeMap(map)).toBe(original);
    map.extensionNamespaces.custom = { category: 'metadata', version: '1' }; map.extensions.custom = { selectedImage: 'background' };
    expect(commandSupport(map, { type: 'deleteBackground', id: 'background' }).allowed).toBe(false);
  });
  it('preserves unsupported asset/pixel/extension protections while allowing declared raster vectors without resolved bytes', () => {
    const map = fixture(); expect(mapCapabilities(map).editable).toBe(true);
    expect(inspectBackground(map, 'background').supported).toBe(true);
    expect(inspectAsset({ ...asset, path: 'assets/../private.png' }).supported).toBe(false);
    for (const mutate of [
      (m: YardMap) => { delete m.assets.image!.widthPx; },
      (m: YardMap) => { m.backgroundLayers.background!.pixelConvention = 'unknown' as BackgroundLayer['pixelConvention']; },
      (m: YardMap) => { m.backgroundLayers.background!.extensions = { custom: { residual: 0.03 } }; },
      (m: YardMap) => { m.extensionNamespaces.custom = { category: 'behavior', version: '1' }; },
    ]) {
      const next = structuredClone(map); mutate(next); expect(mapCapabilities(next).editable).toBe(false);
    }
  });
  it('allocates lineage IDs around existing asset/background IDs and retains a replaced field-only source', () => {
    const map = fixture();
    map.assets.source_editor_background = structuredClone(asset);
    map.backgroundLayers.source_editor_background_1 = structuredClone(layer);
    map.sources.field_only = { name: 'Old fit', category: 'drawing', description: 'Prior field source.' };
    map.backgroundLayers.background!.provenance.fieldSources!.imageToWorld = 'field_only';
    const result = apply(map, { type: 'updateBackgroundTransform', id: 'background', imageToWorld: translateBackground(transform, [1, 0]) });
    expect(result.map.backgroundLayers.background!.provenance.fieldSources!.imageToWorld).toBe('source_editor_background_2');
    expect(result.map.backgroundLayers.background!.provenance.sourceRefs).toContain('field_only');
    expect(result.map.sources.field_only).toEqual(map.sources.field_only);
  });
  it('does not leak a newly imported source or asset when later layer validation fails', () => {
    const session = createSession(editorFixture(), true);
    const invalid = { ...layer, imageToWorld: [1, 1, 1, 1, 0, 0] as BackgroundTransform };
    const result = editSession(session, { type: 'addBackground', id: 'background', assetId: 'image', asset, layer: invalid,
      source: { id: 'source_image', value: fixture().sources.source_image! } });
    expect(result.ok).toBe(false); expect(result.session).toBe(session);
    expect(result.session.map.assets).toEqual({}); expect(result.session.map.backgroundLayers).toEqual({});
    expect(result.session.map.sources.source_image).toBeUndefined();
  });
  it('retains a shared facility asset and allocates source IDs around planning slots', () => {
    const map = fixture();
    const slotId = 'source_editor_background';
    map.extensionNamespaces['sr02.planning'] = { version: '1.0', category: 'behavior' };
    map.facilities.owner = { ...testFacility('owner', rectangle(-10, -10, 40, 20)), assetId: 'image', extensions: { 'sr02.planning': {
      role: 'yard', dimensionBasis: 'synthetic', slotGapM: 0, slotLengthM: 2, slotWidthM: 2, transportAisleWidthM: 3,
      slots: [{ id: slotId, boundary: rectangle(0, 0, 2, 2) }], storageResourceId: 'storage',
    } } };
    map.resources.storage = { name: 'storage', kind: 'other', capacityUnit: 'area_m2', capacity: { state: 'known', value: 4 }, controlModel: 'shared_capacity',
      appliesTo: [{ entityType: 'facilities', entityId: 'owner' }], provenance: { category: 'synthetic' },
      extensions: { 'sr02.planning': { slotAreaM2: 4, slotIds: [slotId], unitMeaning: 'cargo_storage_area' } } };
    const result = apply(map, { type: 'deleteBackground', id: 'background' });
    expect(result.map.sources.source_editor_background).toBeUndefined();
    expect(result.map.sources.source_editor_background_1).toBeDefined();
    expect(result.map.assets.image).toEqual(map.assets.image);
    expect(vectors(result.map)).toEqual(vectors(map));
  });

  it('never treats inherited collection properties as a layer or lets prototype keys disappear from final validation', () => {
    const map = editorFixture();
    expect(inspectBackground(map, 'toString').supported).toBe(false);
    const result = applyMapCommand(map, { type: 'addBackground', id: '__proto__', assetId: 'image', asset, layer,
      source: { id: 'source_image', value: fixture().sources.source_image! } });
    expect(result.ok).toBe(false);
    expect(map.backgroundLayers).toEqual({}); expect(Object.getPrototypeOf(map.backgroundLayers)).toBe(Object.prototype);
  });

});
