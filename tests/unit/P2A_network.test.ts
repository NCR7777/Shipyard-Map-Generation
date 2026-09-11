import { describe, expect, it } from 'vitest';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { serializeMap } from '../../src/domain/serialization';
import type { Vec3 } from '../../src/domain/model';
import { inspectNetwork } from '../../src/topology/networkDiagnostics';

function fixture(positions: Record<string, Vec3>, roads: [string, string, string, Vec3[]?][]) {
  const map = newMap('P2A_injected_topology');
  for (const [id, p] of Object.entries(positions)) map.nodes[id] = newNode(p, id);
  for (const [id, a, b, shape = []] of roads) map.roads[id] = newRoad(a, b, shape, id);
  return map;
}
const codes = (map: ReturnType<typeof fixture>) => inspectNetwork(map).issues.map(issue => issue.code);
describe('P2A explicit topology candidates are read-only', () => {
  it('locates an X crossing without creating a shared node or claiming a measured physical layer', () => {
    const map = fixture({ a: [-10,0,0], b: [10,0,0], c: [0,-10,0], d: [0,10,0] }, [['ab','a','b'],['cd','c','d']]);
    const before = serializeMap(map); const result = inspectNetwork(map);
    const crossing = result.issues.find(i => i.code === 'P2A_X_CROSSING_CANDIDATE')!;
    expect(crossing.location?.position).toEqual([0,0,0]); expect(crossing.jsonPath).toBe('/roads/ab/shapePoints');
    expect(crossing.message).toContain('cd'); expect(crossing.message).toContain('不代表');
    expect(serializeMap(map)).toBe(before); expect(Object.keys(map.movements)).toHaveLength(0);
  });
  it('distinguishes T contacts, distinct coincident endpoint IDs and collinear overlap', () => {
    const t = fixture({ a: [-10,0,0], b: [10,0,0], c: [0,0,0], d: [0,10,0] }, [['ab','a','b'],['cd','c','d']]);
    expect(codes(t)).toContain('P2A_T_JUNCTION_CANDIDATE'); expect(codes(t)).toContain('P2A_NODE_NEAR_ROAD_INTERIOR');
    const endpoints = fixture({ a: [-10,0,0], b: [0,0,0], c: [0,0,0], d: [0,10,0] }, [['ab','a','b'],['cd','c','d']]);
    expect(codes(endpoints)).toContain('P2A_ENDPOINT_IDS_DIFFER'); expect(codes(endpoints)).toContain('P2A_COINCIDENT_NODE_IDS');
    const overlap = fixture({ a: [0,0,0], b: [10,0,0], c: [5,0,0], d: [15,0,0] }, [['ab','a','b'],['cd','c','d']]);
    expect(codes(overlap)).toContain('P2A_COLLINEAR_OVERLAP');
    expect(codes(overlap)).not.toContain('P2A_X_CROSSING_CANDIDATE');
  });
  it('does not report the legitimate shared endpoint or an ordinary polyline bend as an unconnected crossing', () => {
    const map = fixture({ a: [-10,0,0], b: [0,0,0], c: [0,10,0] }, [['ab','a','b',[[-5,1,0]]],['bc','b','c']]);
    expect(codes(map).filter(code => /CROSSING|T_JUNCTION|ENDPOINT_IDS|OVERLAP/.test(code))).toEqual([]);
    expect(map.movements).toEqual({});
  });
  it('separates declared height evidence from confirmed connectivity', () => {
    const map = fixture({ a: [-10,0,0], b: [10,0,0], c: [0,-10,5], d: [0,10,5] }, [['ab','a','b'],['cd','c','d']]);
    expect(codes(map)).toContain('P2A_CROSSING_DIFFERENT_Z');
    expect(inspectNetwork(map).checks.find(c => c.id === 'crossing_physical_layers')!.status).toBe('not_checked');
  });
  it('finds self crossings, zero segments and isolated objects without treating separate subnetworks as errors', () => {
    const map = fixture({ a: [0,0,0], b: [10,0,0], c: [50,0,0], d: [60,0,0], marker: [80,0,0] }, [['self','a','b',[[10,10,0],[0,10,0],[0,10,0]]],['cd','c','d']]);
    expect(codes(map)).toEqual(expect.arrayContaining(['P2A_SELF_CROSSING','P2A_ZERO_SEGMENT','P2A_ISOLATED_NODE','P2A_SEPARATE_COMPONENT','P2A_DIRECTION_UNKNOWN']));
    expect(inspectNetwork(map).issues.every(i => i.severity === 'warning')).toBe(true);
  });
  it('reports a repeated bend as a zero segment, not a false self crossing', () => {
    const map = fixture({ a: [0,0,0], b: [10,0,0] }, [['bend','a','b',[[5,5,0],[5,5,0]]]]);
    expect(codes(map)).toContain('P2A_ZERO_SEGMENT');
    expect(codes(map)).not.toContain('P2A_SELF_CROSSING');
  });
  it('uses metre tolerance at the ends of very long segments, not a dimensionless fraction', () => {
    const map = fixture({ a: [0,0,0], b: [1e8,0,0], marker: [1,0,0] }, [['long','a','b']]);
    expect(inspectNetwork(map).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'P2A_NODE_NEAR_ROAD_INTERIOR', entityId: 'marker' }),
    ]));
  });
  it('reports bounded incomplete results, including extreme coordinates, instead of a false clean map', () => {
    const map = fixture({ a: [1e308,0,0] }, []);
    expect(inspectNetwork(map).checks[0]!.status).toBe('not_checked');
    const many = fixture(Object.fromEntries(Array.from({length: 40}, (_,i) => ['n'+i, [0,0,0] as Vec3])), []);
    const result = inspectNetwork(many);
    expect(result.issues.length).toBeLessThanOrEqual(500);
    expect(result.checks[0]!.status).toBe('partial');
  });
});
