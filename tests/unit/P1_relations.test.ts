import { describe, expect, it } from 'vitest';
import { relatedKeys } from '../../src/app/ui/relations';
import type { YardMapV02 } from '../../src/domain/model';
import { editorFixture, testNode } from '../helpers/M1_fixtures';

/** A → B → C through junction jB, one turn, and resources declared from both sides. */
function fixture() {
  const map = editorFixture();
  map.nodes.nC = testNode('C', 200);
  map.roads.rBC = { ...map.roads.rAB!, name: 'BC', fromNodeId: 'nB', toNodeId: 'nC', resourceIds: ['resRoad'] };
  map.roads.rAB = { ...map.roads.rAB!, resourceIds: ['resRoad'] };
  map.junctions.jB = { name: 'B 路口', nodeIds: ['nB'], model: 'explicit_movements', resourceIds: ['resJunction'], provenance: { category: 'synthetic' } };
  map.movements.mABC = {
    name: 'A→C', junctionId: 'jB', incomingArc: { roadId: 'rAB', direction: 'forward' }, outgoingArc: { roadId: 'rBC', direction: 'forward' },
    allowed: true, resourceIds: ['resJunction'], provenance: { category: 'synthetic' },
  };
  const resource = { kind: 'other', capacityUnit: 'vehicle', capacity: { state: 'unknown' }, controlModel: 'exclusive', provenance: { category: 'synthetic' } } as const;
  // resRoad is listed by rAB and rBC but only declares rAB; resJunction declares the junction, and the movement lists it.
  map.resources.resRoad = { ...resource, name: '路段', appliesTo: [{ entityType: 'roads', entityId: 'rAB' }] };
  map.resources.resJunction = { ...resource, name: '路口占用', appliesTo: [{ entityType: 'junctions', entityId: 'jB' }] };
  return map;
}
/** Adds a survey source cited four different ways, an image used by a facility and a background layer, and a service point entering at nA. */
function withSources() {
  const map = fixture() as YardMapV02;
  map.sources.srcSurvey = { name: '测绘', category: 'surveyed', description: '' };
  map.sources.srcOther = { name: '其他', category: 'unknown', description: '' };
  map.roads.rAB = { ...map.roads.rAB!, provenance: { category: 'surveyed', sourceRefs: ['srcSurvey'] } };
  map.roads.rBC = { ...map.roads.rBC!, widthM: { state: 'known', value: 6, sourceRef: 'srcSurvey' } };
  map.resources.resJunction = { ...map.resources.resJunction!, provenance: { category: 'surveyed', fieldSources: { capacity: 'srcSurvey' } } };
  map.assets.imgA = { path: 'a.png', sha256: '0'.repeat(64), mediaType: 'image/png', sourceRef: 'srcSurvey' };
  map.backgroundLayers.bgA = {
    name: '底图', assetId: 'imgA', pixelConvention: 'top_left_x_right_y_down_exif_normalized', imageToWorld: [1, 0, 0, -1, 0, 0],
    method: 'manual', controlPoints: [], provenance: { category: 'imagery_derived', sourceRefs: ['srcOther'] },
  } as unknown as YardMapV02['backgroundLayers'][string];
  map.facilities.fA = {
    name: '厂房', kind: 'workshop', boundary: { outer: [[0, 20, 0], [20, 20, 0], [20, 40, 0], [0, 40, 0], [0, 20, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, assetId: 'imgA', provenance: { category: 'synthetic' },
  };
  map.servicePoints.sC = {
    name: 'C 装卸', kind: 'loading', nodeId: 'nC', resourceIds: [], provenance: { category: 'synthetic' },
    arrival: { mode: 'explicit_internal', entryNodeId: 'nA', internalPath: [{ roadId: 'rAB', direction: 'forward' }] },
  };
  return map;
}
const keys = (kind: Parameters<typeof relatedKeys>[1], id: string) => relatedKeys(fixture(), kind, id).map(([, key]) => key);

describe('relations list explicit references once, in both directions', () => {
  it('a resource listed by the object and also applying to it appears once', () => {
    expect(keys('roads', 'rAB').filter(key => key === 'resources/resRoad')).toHaveLength(1);
    expect(relatedKeys(fixture(), 'junctions', 'jB').filter(([, key]) => key === 'resources/resJunction')).toEqual([['资源', 'resources/resJunction']]);
  });
  it('junctions and movements show their nodes, roads, turns and resources', () => {
    expect(keys('junctions', 'jB')).toEqual(['nodes/nB', 'movements/mABC', 'resources/resJunction']);
    expect(keys('movements', 'mABC')).toEqual(['junctions/jB', 'roads/rAB', 'roads/rBC', 'resources/resJunction']);
    expect(keys('nodes', 'nB')).toEqual(['roads/rAB', 'roads/rBC', 'junctions/jB']);
  });
  it('a resource shows what it applies to, then every other object that lists it', () => {
    expect(relatedKeys(fixture(), 'resources', 'resRoad')).toEqual([['作用于道路', 'roads/rAB'], ['被道路引用', 'roads/rBC']]);
    expect(relatedKeys(fixture(), 'resources', 'resJunction')).toEqual([['作用于路口', 'junctions/jB'], ['被转向引用', 'movements/mABC']]);
  });
  it('sources list every record that cites them: provenance, field sources, known physical values and assets', () => {
    expect(relatedKeys(withSources(), 'sources', 'srcSurvey').map(([, key]) => key)).toEqual(['roads/rAB', 'roads/rBC', 'resources/resJunction', 'assets/imgA']);
    expect(relatedKeys(withSources(), 'sources', 'srcOther').map(([, key]) => key)).toEqual(['backgroundLayers/bgA']);
  });
  it('images and background layers, and nodes used as an internal-path entry', () => {
    const map = withSources();
    expect(relatedKeys(map, 'assets', 'imgA')).toEqual([['来源', 'sources/srcSurvey'], ['被建筑使用', 'facilities/fA'], ['被底图使用', 'backgroundLayers/bgA']]);
    expect(relatedKeys(map, 'facilities', 'fA')).toEqual([['图片资源', 'assets/imgA']]);
    expect(relatedKeys(map, 'backgroundLayers', 'bgA')).toEqual([['图片资源', 'assets/imgA']]);
    expect(relatedKeys(map, 'nodes', 'nA')).toContainEqual(['以此为通道入口', 'servicePoints/sC']);
    expect(relatedKeys(map, 'nodes', 'nC')).toContainEqual(['作业点', 'servicePoints/sC']);
  });
});
