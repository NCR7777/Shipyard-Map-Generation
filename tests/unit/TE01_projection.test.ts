import { describe, expect, it } from 'vitest';
import { projectPolyline } from '../../src/geometry/roads';

describe('topology centerline picking geometry', () => {
  it('projects bends with horizontal chainage and interpolated Z, without dropping zero-length vertices', () => {
    const line: [number, number, number][] = [[0, 0, 7], [0, 0, 7], [30, 0, 7], [30, 40, 9]];
    expect(projectPolyline([34, 20, 8], line)).toEqual({ position: [30, 20, 8], distanceM: 50, offsetM: 4 });
    expect(line[1]).toEqual([0, 0, 7]);
  });
  it('clamps outside projections to authoritative endpoints and keeps the first equal-distance segment', () => {
    expect(projectPolyline([-2, 3, 0], [[0, 0, 0], [10, 0, 0]])).toEqual({ position: [0, 0, 0], distanceM: 0, offsetM: Math.hypot(2, 3) });
    expect(projectPolyline([8, 2, 0], [[0, 0, 0], [10, 0, 0], [10, 10, 0]])).toEqual({ position: [8, 0, 0], distanceM: 8, offsetM: 2 });
  });
  it('does not invent a split for empty or zero-length lines', () => {
    expect(projectPolyline([1, 0, 0], [])).toBeNull();
    expect(projectPolyline([1, 0, 0], [[0, 0, 0], [0, 0, 0]])).toBeNull();
  });
});
