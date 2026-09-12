import { describe, expect, it } from 'vitest';
import { applyMapCommand, commandSupport, type MapCommand } from '../../src/domain/commands';
import { newMap, newNode, newRoad, newZone } from '../../src/domain/factory';
import { rectangle } from '../helpers/M2A_fixtures';
import { inspectSpatialEdit } from '../../src/validation/spatialDiagnostics';

function fixture() {
  const map = newMap('synthetic_TE01_spatial');
  map.nodes.a = newNode([0, 0, 0]); map.nodes.b = newNode([100, 0, 0]);
  map.roads.r = { ...newRoad('a', 'b'), direction: 'both' as const, widthM: { state: 'known' as const, value: 2 } };
  return map;
}
describe('TE01 geometry-preserving topology and changed spatial relations', () => {
  it('keeps the old forbidden-space relationship when merely subdividing an identical road band', () => {
    const map = fixture(); map.zones.z = { ...newZone(rectangle(20, -1, 5, 2)), passability: 'forbidden' };
    const snapshot = structuredClone(map);
    const command: MapCommand = { type: 'splitRoad', id: 'r', distanceM: 50, nodeId: 'mid', newRoadIds: ['left', 'right'] };
    expect(commandSupport(map, command).geometryPreservedRoadIds).toEqual(['left', 'right']);
    const result = applyMapCommand(map, command);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(map).toEqual(snapshot);
    if (!result.ok) throw new Error('Expected exact subdivision');
    expect(result.map.zones).toEqual(map.zones);
    const changedZone = structuredClone(result.map); changedZone.zones.z!.boundary = rectangle(30, -1, 5, 2);
    expect(inspectSpatialEdit(map, changedZone, { geometryPreservedRoadIds: ['left', 'right'] }).some(issue => issue.code === 'SPATIAL_ROAD_FORBIDDEN')).toBe(true);
  });
  it('checks moved branch geometry on a connection even though target-road subdivision is equivalent', () => {
    const map = fixture(); map.nodes.c = newNode([50, 20, 0]); map.nodes.d = newNode([50, 40, 0]);
    map.roads.branch = { ...newRoad('c', 'd'), direction: 'both', widthM: { state: 'known', value: 2 } };
    map.zones.z = { ...newZone(rectangle(49, 8, 2, 4)), passability: 'forbidden' };
    const command: MapCommand = { type: 'connectNodeToRoad', nodeId: 'c', roadId: 'r', distanceM: 50, newRoadIds: ['left', 'right'], junctionId: 'join', approvedMovements: [] };
    const snapshot = structuredClone(map);
    const support = commandSupport(map, command);
    expect(support.allowed, JSON.stringify(support.issues)).toBe(true);
    expect(support.geometryPreservedRoadIds).not.toContain('branch');
    const result = applyMapCommand(map, command);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Forbidden crossing must reject');
    expect(result.issues.some(issue => issue.code === 'SPATIAL_ROAD_FORBIDDEN' && issue.entityId === 'branch')).toBe(true);
    expect(map).toEqual(snapshot);
  });
});
