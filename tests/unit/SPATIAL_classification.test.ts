import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import extensionSchema from '../../schemas/spatial-classification-1.0.schema.json';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import type { YardMap } from '../../src/domain/model';
import { newMap, newFacility, newZone } from '../../src/domain/factory';
import { upgradeMapToV03 } from '../../src/domain/upgradeV03';
import { SPATIAL_CLASSIFICATION_NAMESPACE as NS, getSpatialClassification, getSpatialClasses, spatialClassificationEditable, type SpatialClassification } from '../../src/domain/spatialClassification';
import { createSession, editSession, undoSession, redoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';
import { compileMap } from '../../src/compiler/routing';
import { serializeMap, contentHash } from '../../src/domain/serialization';
import { zoneServiceFixture } from '../helpers/M2A1_fixtures';
import { rectangle } from '../helpers/M2A_fixtures';

function fixture(): YardMap {
  const map = upgradeMapToV03(zoneServiceFixture()).map;
  map.zones.dock = newZone(rectangle(120, 40, 20, 20), '待分类区域', 'unclassified');
  map.extensionNamespaces['test.metadata'] = { category: 'metadata', version: '1' };
  map.zones.dock.extensions = { 'test.metadata': { retain: [3, 'fA'] } };
  map.resources.r = { name: 'unrelated resource', kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'known', value: 7 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'servicePoints', entityId: 'sA' }], provenance: { category: 'synthetic' } };
  map.sources.survey = { name: '既有来源声明', category: 'surveyed', description: '单元测试来源记录，不代表现场核验。' };
  return map;
}
function update(classification: SpatialClassification | null): MapCommand { return { type: 'updateZone', id: 'dock', patch: {}, classification }; }
function success(map: ReturnType<typeof fixture>, command: MapCommand) {
  const result = applyMapCommand(map, command); expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw Error('Expected command success'); return result;
}

describe('spatial classification metadata is separate from declared geometry and routing', () => {
  it('updates an advanced zone, name and sourced depth in one transaction without changing coarse semantics or arcs', () => {
    const map = fixture(), before = structuredClone(map), compiled = compileMap(map), session = createSession(map, true);
    const result = editSession(session, { type: 'updateZone', id: 'dock', patch: { name: '一号干船坞' }, classification: { classId: 'dry_dock', depthM: { state: 'known', value: 11, sourceRef: 'survey' }, depthReference: '坞口结构标高，向下' } });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true); expect(result.session.past).toHaveLength(1);
    const after = result.session.map, stored = getSpatialClassification(after, 'zones', 'dock');
    expect(stored).toEqual({ classId: 'dry_dock', depthM: { state: 'known', value: 11, sourceRef: 'survey' }, depthReference: '坞口结构标高，向下' });
    expect(after.zones.dock).toMatchObject({ kind: 'unclassified', passability: 'unknown', boundary: before.zones.dock!.boundary });
    expect(after.zones.dock!.extensions?.['test.metadata']).toEqual(before.zones.dock!.extensions?.['test.metadata']);
    for (const field of ['nodes', 'roads', 'resources', 'accessPoints', 'servicePoints', 'junctions', 'movements'] as const) expect(after[field]).toEqual(before[field]);
    const exported = compileMap(after); expect(exported.arcs).toEqual(compiled.arcs); expect(exported.mapContentHash).not.toBe(compiled.mapContentHash);
    expect(exported.zones.dock!.extensions?.[NS]).toEqual(stored); expect(exported.extensionNamespaces[NS]).toEqual({ version: '1.0', category: 'metadata' });
    expect(validateMap(JSON.parse(serializeMap(after))).ok).toBe(true); expect(map).toEqual(before);
    expect(undoSession(result.session).map).toEqual(before); expect(redoSession(undoSession(result.session)).map).toEqual(after);
  });
  it('creates an explicit depth design assumption and preserves its history when changed to unknown', () => {
    const map = fixture(), classified = success(map, { ...update({ classId: 'dry_dock', depthM: { state: 'known', value: 9 }, depthReference: '设计坞口标高' }), designAssumption: { id: 'depth_assumption', description: '明确的设计假设' } } as MapCommand).map;
    expect(classified.sources.depth_assumption).toMatchObject({ category: 'design_assumption', description: '明确的设计假设' });
    expect(getSpatialClassification(classified, 'zones', 'dock')?.depthM).toEqual({ state: 'known', value: 9, sourceRef: 'depth_assumption' });
    const unknown = success(classified, update({ classId: 'dry_dock', depthM: { state: 'unknown' }, depthReference: '设计坞口标高' })).map;
    expect(unknown.zones.dock!.provenance.sourceRefs).toContain('depth_assumption'); expect(unknown.sources.depth_assumption).toEqual(classified.sources.depth_assumption);
    expect(unknown.zones.dock!.provenance.fieldSources?.[NS + '.depthM']).toBeUndefined();
  });
  it('does not create history for identical classification, catalog or an already absent classification', () => {
    const map = fixture();
    expect(success(map, update(null)).changed).toBe(false);
    const classified = success(map, update({ classId: 'dry_dock', depthM: { state: 'known', value: 9, sourceRef: 'survey' }, depthReference: '坞口' })).map;
    const session = createSession(classified, true), result = editSession(session, update(getSpatialClassification(classified, 'zones', 'dock')!));
    expect(result.ok).toBe(true); expect(result.session.past).toHaveLength(0); expect(result.session.map).toBe(session.map);
    const custom = [{ id: 'custom_yard', label: '分段临存', appliesTo: ['zones'] as ['zones'] }];
    const catalog = success(map, { type: 'setSpatialClasses', customClasses: custom }).map;
    expect(success(catalog, { type: 'setSpatialClasses', customClasses: custom }).changed).toBe(false);
  });
  it('keeps building and zone catalogs disjoint and preserves legacy facility kinds', () => {
    const map = fixture(); expect(getSpatialClasses(map, 'facilities').some(item => item.id === 'dry_dock')).toBe(false);
    expect(getSpatialClasses(map, 'zones').some(item => item.id === 'workshop')).toBe(false);
    const changed = success(map, { type: 'updateFacility', id: 'fA', patch: {}, classification: { classId: 'warehouse' } }).map;
    expect(changed.facilities.fA!.kind).toBe(map.facilities.fA!.kind); expect(changed.facilities.fA!.accessPointIds).toEqual(map.facilities.fA!.accessPointIds);
    for (const classification of [{ classId: 'dry_dock' }, { classId: 'warehouse', depthM: { state: 'unknown' } }] as SpatialClassification[]) {
      expect(applyMapCommand(map, { type: 'updateFacility', id: 'fA', patch: { name: 'must not apply' }, classification }).ok).toBe(false);
    }
  });
  it.each([
    { classId: 'missing' }, { classId: 'workshop' },
    ...[0, -1, NaN, Infinity].map(value => ({ classId: 'dry_dock', depthM: { state: 'known', value, sourceRef: 'survey' }, depthReference: '坞口' })),
    { classId: 'dry_dock', depthM: { state: 'known', value: 8 }, depthReference: '坞口' },
    { classId: 'dry_dock', depthM: { state: 'known', value: 8, sourceRef: 'missing' }, depthReference: '坞口' },
    { classId: 'dry_dock', depthM: { state: 'known', value: 8, sourceRef: 'survey' } },
    { classId: 'dry_dock', depthM: { state: 'unrestricted' } },
  ])('rejects invalid metadata atomically: %j', value => {
    const map = fixture(), session = createSession(map, true), before = contentHash(map);
    const result = editSession(session, { type: 'updateZone', id: 'dock', patch: { name: 'must not apply' }, classification: value as SpatialClassification });
    expect(result.ok).toBe(false); expect(result.session).toBe(session); expect(contentHash(map)).toBe(before);
    expect(result.issues[0]!.jsonPath).toContain('/zones/dock/extensions/' + NS);
  });
  it('protects custom class references and validates imported payloads at the same boundary', () => {
    let map = fixture(); const custom = { id: 'custom_yard', label: '一类区域', appliesTo: ['zones'] as ['zones'] };
    map = success(map, { type: 'setSpatialClasses', customClasses: [custom] }).map;
    map = success(map, update({ classId: custom.id })).map;
    const renamed = success(map, { type: 'setSpatialClasses', customClasses: [{ ...custom, label: '改名区域' }] }).map;
    expect(getSpatialClassification(renamed, 'zones', 'dock')!.classId).toBe(custom.id);
    for (const customClasses of [[], [{ ...custom, appliesTo: ['facilities'] }], [{ ...custom, appliesTo: ['facilities', 'zones'] }], [{ ...custom, id: 'constructor' }], [{ ...custom, id: 'dry_dock' }]]) {
      const result = applyMapCommand(map, { type: 'setSpatialClasses', customClasses } as MapCommand); expect(result.ok).toBe(false);
    }
    const malformed = structuredClone(map); (malformed.zones.dock!.extensions![NS] as SpatialClassification).classId = 'not_present';
    expect(validateMap(malformed).issues.some(issue => issue.code === 'SPATIAL_CLASS_REFERENCE' && issue.severity === 'error')).toBe(true);
    const misplaced = structuredClone(map); misplaced.metadata.extensions = { [NS]: { customClasses: [] } };
    expect(validateMap(misplaced).issues.some(issue => issue.code === 'SPATIAL_CLASS_SCOPE' && issue.jsonPath === '/metadata/extensions/' + NS)).toBe(true);
  });
  it('preserves unsupported metadata versions while unrelated property changes remain allowed', () => {
    const map = fixture(); map.extensionNamespaces[NS] = { version: '9.0', category: 'metadata' };
    map.zones.dock!.extensions![NS] = { future: ['preserved', 22] }; map.extensions[NS] = { futureCatalog: true };
    expect(validateMap(map).ok).toBe(true); expect(spatialClassificationEditable(map, 'zones', 'dock')).toBe(false);
    const renamed = success(map, { type: 'updateZone', id: 'dock', patch: { name: 'new name' } }).map;
    expect(renamed.zones.dock!.extensions![NS]).toEqual(map.zones.dock!.extensions![NS]); expect(renamed.extensions).toEqual(map.extensions);
    expect(applyMapCommand(map, update({ classId: 'yard' })).ok).toBe(false); expect(applyMapCommand(map, { type: 'setSpatialClasses', customClasses: [] }).ok).toBe(false);
    map.extensionNamespaces.foreign = { version: '1', category: 'behavior' }; map.extensions.foreign = { retained: true };
    expect(applyMapCommand(map, { type: 'updateZone', id: 'dock', patch: { name: 'blocked by behavior' } }).ok).toBe(false);
  });
  it('keeps the standalone extension schema aligned with emitted payloads', () => {
    const ajv = new Ajv2020({ strict: true, allErrors: true }); ajv.addSchema(extensionSchema);
    const validator = (name: string) => ajv.getSchema(extensionSchema.$id + '#/$defs/' + name)!;
    let map = fixture();
    map = success(map, { type: 'setSpatialClasses', customClasses: [{ id: 'custom_test', label: '自定义建筑', appliesTo: ['facilities'] }] }).map;
    map = success(map, { type: 'updateFacility', id: 'fA', patch: {}, classification: { classId: 'custom_test' } }).map;
    map = success(map, update({ classId: 'dry_dock', depthM: { state: 'known', value: 5, sourceRef: 'survey' }, depthReference: '坞口结构' })).map;
    for (const [name, payload] of [['catalog', map.extensions[NS]], ['buildingAnnotation', map.facilities.fA!.extensions![NS]], ['zoneAnnotation', map.zones.dock!.extensions![NS]]] as const) expect(validator(name)(payload), JSON.stringify(validator(name).errors)).toBe(true);
    expect(validator('buildingAnnotation')({ classId: 'warehouse', depthM: { state: 'unknown' } })).toBe(false);
    expect(validator('zoneAnnotation')({ classId: 'dry_dock', depthM: { state: 'known', value: 5, sourceRef: 'survey' } })).toBe(false);
  });
  it('carries classification through creation, copying and undo, but keeps unknown-copy protection', () => {
    let map = newMap('copy_test', 'copy', '0.3.0');
    const created = applyMapCommand(map, { type: 'quickTraceBoundary', kind: 'area', boundary: rectangle(0, 0, 10, 10), classification: { classId: 'dry_dock' } });
    expect(created.ok).toBe(true); if (!created.ok) return; map = created.map as typeof map;
    const id = Object.keys(map.zones)[0]!; expect(getSpatialClassification(map, 'zones', id)?.classId).toBe('dry_dock');
    const copy = applyMapCommand(map, { type: 'duplicateSelection', selection: { nodes: [], roads: [], zones: [id] }, delta: [20, 0, 0], idMap: { [id]: 'copy_zone' } });
    expect(copy.ok, JSON.stringify(copy)).toBe(true); if (copy.ok) expect(getSpatialClassification(copy.map, 'zones', 'copy_zone')).toEqual(getSpatialClassification(map, 'zones', id));
    const plain = newMap('plain', 'plain', '0.3.0');
    for (const command of [
      { type: 'addFacility', id: 'building', facility: newFacility(rectangle(0, 0, 10, 10)), classification: { classId: 'office' } },
      { type: 'addZone', id: 'zone', zone: newZone(rectangle(20, 0, 10, 10)), classification: { classId: 'yard' } },
    ] as MapCommand[]) { const session = createSession(plain, true), result = editSession(session, command); expect(result.ok).toBe(true); expect(result.session.past).toHaveLength(1); expect(undoSession(result.session).map).toEqual(plain); }
    const opaque = structuredClone(map); opaque.extensionNamespaces.foreign = { version: '1', category: 'metadata' }; opaque.zones[id]!.extensions!.foreign = { unknownReference: 'n' };
    expect(applyMapCommand(opaque, { type: 'duplicateSelection', selection: { nodes: [], roads: [], zones: [id] }, delta: [20, 0, 0], idMap: { [id]: 'copy_zone' } }).ok).toBe(false);
  });
});
