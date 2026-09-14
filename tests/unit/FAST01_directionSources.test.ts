import { describe, expect, it } from 'vitest';
import { applyMapCommand, type MapCommand } from '../../src/domain/commands';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';
import { serializeMap } from '../../src/domain/serialization';
import { createSession, editSession, undoSession } from '../../src/editor/session';
import { validateMap } from '../../src/validation/validate';

function run(map: YardMap, command: MapCommand) {
  const before = serializeMap(map), result = applyMapCommand(map, command);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('Expected successful direction edit.');
  expect(serializeMap(map)).toBe(before); expect(validateMap(result.map).ok).toBe(true);
  return result;
}
function quickMap() {
  let map: YardMap = newMap('FAST01_direction', 'synthetic direction attribution', '0.3.0');
  for (const y of [0, 100, 200]) map = run(map, { type: 'quickTraceRoad', points: [[0, y, 0], [100, y, 0]] }).map;
  return map;
}
function constrainedMap() {
  const map = newMap('FAST01_direction_dependencies', 'synthetic existing turn contract', '0.2.0');
  map.sources.declared = { name: '原方向声明', category: 'design_assumption', description: 'Existing explicit direction fixture.' };
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]); map.nodes.c = newNode([200, 0, 0]);
  for (const [id, from, to] of [['r', 'a', 'b'], ['s', 'b', 'c']] as const) {
    map.roads[id] = { ...newRoad(from, to), direction: 'forward', provenance: { category: 'synthetic', fieldSources: { direction: 'declared' } } };
  }
  map.junctions.j = { name: '原路口', nodeIds: ['b'], model: 'explicit_movements', resourceIds: [], provenance: { category: 'synthetic' } };
  map.movements.blocked = { name: '既有禁转', junctionId: 'j', incomingArc: { roadId: 'r', direction: 'forward' }, outgoingArc: { roadId: 's', direction: 'forward' }, allowed: false, resourceIds: [], provenance: { category: 'synthetic' } };
  map.servicePoints.service = { ...newServicePoint('b'), arrival: { mode: 'explicit_internal', entryNodeId: 'a', internalPath: [{ roadId: 'r', direction: 'forward' }] } };
  return map;
}

describe('FAST01 manual road-direction provenance', () => {
  it('replaces a quick-trace default attribution only after a real change, retains its source, and reuses the manual source', () => {
    const map = quickMap(), id = Object.keys(map.roads)[0]!, old = map.roads[id]!;
    const result = run(map, { type: 'updateRoad', id, patch: { direction: 'forward' } });
    const road = result.map.roads[id]!, source = road.provenance.fieldSources?.direction;
    expect(source).toBe('source_editor_direction');
    expect(road.provenance.sourceRefs).toEqual(expect.arrayContaining([old.provenance.fieldSources!.direction!, source!]));
    expect(result.map.sources[source!]!.category).toBe('design_assumption');
    expect(result.map.sources[old.provenance.fieldSources!.direction!]).toEqual(map.sources[old.provenance.fieldSources!.direction!]);
    expect(result.transaction!.affectedRefs).toContainEqual({ kind: 'sources', id: source });
    expect(road.widthM).toEqual(old.widthM); expect(road.geometry).toEqual(old.geometry); expect(road.provenance.category).toBe(old.provenance.category);
    const next = run(result.map, { type: 'updateRoad', id, patch: { direction: 'backward' } });
    expect(next.map.roads[id]!.provenance.fieldSources?.direction).toBe(source);
    expect(next.map.sources).toEqual(result.map.sources);
    const same = run(map, { type: 'updateRoad', id, patch: { direction: 'both' } });
    expect(same.changed).toBe(false); expect(same.map.sources).toEqual(map.sources);
  });

  it('uses one source for an arbitrary selected batch and undoes all direction declarations together', () => {
    const map = quickMap(), ids = Object.keys(map.roads), session = createSession(map, true);
    const result = editSession(session, { type: 'updateRoadBatch', ids: [ids[0]!, ids[2]!, ids[0]!], patch: { direction: 'backward' } });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    expect(result.session.past).toHaveLength(1);
    for (const id of [ids[0]!, ids[2]!]) {
      expect(result.session.map.roads[id]!.direction).toBe('backward');
      expect(result.session.map.roads[id]!.provenance.fieldSources?.direction).toBe('source_editor_direction');
    }
    expect(Object.keys(result.session.map.sources).length - Object.keys(map.sources).length).toBe(1);
    expect(result.session.map.roads[ids[1]!]).toEqual(map.roads[ids[1]!]);
    expect(serializeMap(undoSession(result.session).map)).toBe(serializeMap(map));
  });

  it('avoids existing IDs and never borrows an imagery width estimate as evidence of traffic direction', () => {
    const map = structuredClone(quickMap()), id = Object.keys(map.roads)[0]!;
    map.nodes.source_editor_direction = newNode([300, 300, 0]);
    map.sources.source_editor_direction_1 = { name: '原影像', category: 'imagery_derived', description: 'Preserve this unrelated source.' };
    const result = run(map, { type: 'updateRoad', id, patch: { direction: 'forward', widthM: { state: 'known', value: 16 } }, designAssumption: { id: 'width_image_estimate', origin: 'manual_image_estimate' } });
    expect(result.map.roads[id]!.provenance.fieldSources).toMatchObject({ direction: 'source_editor_direction_2', widthM: 'width_image_estimate' });
    expect(result.map.sources.source_editor_direction_2!.category).toBe('design_assumption');
    expect(result.map.sources.width_image_estimate!.category).toBe('imagery_derived');
    expect(result.map.sources.source_editor_direction_1).toEqual(map.sources.source_editor_direction_1);
    expect(result.map.nodes.source_editor_direction).toEqual(map.nodes.source_editor_direction);
  });

  it('retains explicit forbidden turns and service paths when expanding an existing directional road', () => {
    const map = constrainedMap(), result = run(map, { type: 'updateRoad', id: 'r', patch: { direction: 'both' } });
    expect(result.map.movements).toEqual(map.movements); expect(result.map.movements.blocked!.allowed).toBe(false);
    expect(result.map.servicePoints).toEqual(map.servicePoints); expect(result.map.junctions).toEqual(map.junctions);
    expect(result.map.roads.r!.provenance.fieldSources?.direction).toBe('source_editor_direction');
    expect(result.map.roads.r!.provenance.sourceRefs).toContain('declared');
  });

  it.each(['single', 'batch'] as const)('rolls back a %s direction edit that invalidates existing arcs without deleting turns or emitting sources', mode => {
    const map = constrainedMap(), session = createSession(map, true), before = serializeMap(map);
    const command: MapCommand = mode === 'single' ? { type: 'updateRoad', id: 'r', patch: { direction: 'backward' } } : { type: 'updateRoadBatch', ids: ['s', 'r'], patch: { direction: 'backward' } };
    const result = editSession(session, command);
    expect(result.ok).toBe(false); expect(result.issues.map(issue => issue.code)).toContain('ARC_DIRECTION_CONFLICT');
    expect(result.session).toBe(session); expect(result.session.past).toHaveLength(0);
    expect(serializeMap(result.session.map)).toBe(before); expect(serializeMap(map)).toBe(before);
    expect(result.session.map.sources.source_editor_direction).toBeUndefined();
    expect(result.session.map.movements.blocked!.allowed).toBe(false);
  });
});
