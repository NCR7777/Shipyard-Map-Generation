import { describe, expect, it, vi } from 'vitest';
import * as roadGeometry from '../../src/geometry/roads';
import { inspectServiceConnection, inspectServiceConnections } from '../../src/topology/serviceConnections';
import { validateMap } from '../../src/validation/validate';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import { internalServiceFixture } from '../helpers/M2A1_fixtures';

describe('M2A.1 service diagnostics bound repeated geometry work', () => {
  it('derives each referenced road once per bulk inspection despite repeated arcs and shared service paths', () => {
    const map = internalServiceFixture();
    map.nodes.nS!.position = [100, 0, 0];
    map.roads.rInternal!.shapePoints = Array.from({ length: 99 }, (_, i) => [i + 1, 0, 0]);
    map.roads.rInternal!.direction = 'both';
    map.servicePoints.sA!.arrival = { mode: 'explicit_internal', internalPath: Array.from({ length: 11 }, (_, i) => ({ roadId: 'rInternal', direction: i % 2 ? 'backward' : 'forward' })) };
    map.servicePoints.sRepeat = structuredClone(map.servicePoints.sA!);
    map.facilities.fA!.servicePointIds.push('sRepeat');
    const spy = vi.spyOn(roadGeometry, 'roadLength');
    try {
      const summaries = inspectServiceConnections(map).filter(item => ['sA', 'sRepeat'].includes(item.servicePointId));
      expect(summaries).toHaveLength(2);
      expect(summaries.every(item => item.internalPathStatus === 'continuous' && item.internalPathLengthM === 1100)).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      expect(inspectServiceConnection(map, 'sA').internalPathLengthM).toBe(1100);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });

  it('rejects an excessive service-road combination before expanding per-service diagnostics', () => {
    const map = newMap('map_diagnostic_budget', 'synthetic budget', '0.2.0');
    map.nodes.nA = newNode([0, 0, 0]); map.nodes.nB = newNode([1, 0, 0]);
    for (let i = 0; i < 1000; i++) map.roads['r' + i] = { ...newRoad('nA', 'nB'), direction: 'both' };
    for (let i = 0; i < 2001; i++) map.servicePoints['s' + i] = newServicePoint('nB');
    const report = validateMap(map);
    expect(report.ok).toBe(false);
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'SERVICE_CONNECTION_COMPLEXITY_LIMIT', jsonPath: '/servicePoints', severity: 'error' }));
    expect(report.issues.some(issue => issue.code === 'SERVICE_ARRIVAL_UNDECLARED')).toBe(false);
  });
});
