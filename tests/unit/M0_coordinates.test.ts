import { describe, it, expect } from 'vitest';
import { worldToScreen, screenToWorld, zoomAt } from '../../src/geometry/coordinates';

describe('M0 metric camera', () => {
  it('converts origin, basis vectors and preserves the selected Z plane', () => {
    const camera = { offsetX: 100, offsetY: 200, scale: 4 };
    expect(worldToScreen([0, 0, 0], camera)).toEqual([100, 200]);
    expect(worldToScreen([1, 0, 0], camera)).toEqual([104, 200]);
    expect(worldToScreen([0, 1, 0], camera)).toEqual([100, 196]);
    expect(worldToScreen([0, 0, 1], camera)).toEqual([100, 200]);
    expect(screenToWorld(worldToScreen([17.25, -6.125, 3], camera), camera, 3)).toEqual([17.25, -6.125, 3]);
  });
  it('zooms around the cursor without changing the world point', () => {
    const before = { offsetX: 31, offsetY: 80, scale: 2 };
    const after = zoomAt(before, [170, 230], 8);
    expect(screenToWorld([170, 230], before)).toEqual(screenToWorld([170, 230], after));
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid scale %s', scale => {
    expect(() => screenToWorld([0, 0], { scale, offsetX: 0, offsetY: 0 })).toThrow(RangeError);
  });
});
