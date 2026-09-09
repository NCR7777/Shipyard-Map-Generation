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
  it.each([1.15, 1 / 1.15])('keeps the cursor anchor while zooming an extremely wide fit by %s', factor => {
    // Fit of bounds [MAX/4, -MAX/2] .. [MAX, MAX/2] in an 800 x 540 viewport.
    const before = { offsetX: 125, offsetY: 270, scale: 440 / Number.MAX_VALUE };
    const cursor: [number, number] = [799, 10];
    expect(screenToWorld(cursor, before)[0]).toBe(Infinity);
    const after = zoomAt(before, cursor, before.scale * factor);
    expect(Object.values(after).every(Number.isFinite)).toBe(true);
    // Compare coordinates measured in MAX_VALUE-sized units without constructing an infinite world point.
    expect((cursor[0] - after.offsetX) / (after.scale * Number.MAX_VALUE))
      .toBeCloseTo((cursor[0] - before.offsetX) / (before.scale * Number.MAX_VALUE), 13);
    expect((after.offsetY - cursor[1]) / (after.scale * Number.MAX_VALUE))
      .toBeCloseTo((before.offsetY - cursor[1]) / (before.scale * Number.MAX_VALUE), 13);
  });
  it.each([0, -1, Infinity, NaN])('rejects invalid scale %s', scale => {
    expect(() => screenToWorld([0, 0], { scale, offsetX: 0, offsetY: 0 })).toThrow(RangeError);
    expect(() => zoomAt({ scale, offsetX: 0, offsetY: 0 }, [0, 0], 1)).toThrow(RangeError);
    expect(() => zoomAt({ scale: 1, offsetX: 0, offsetY: 0 }, [0, 0], scale)).toThrow(RangeError);
  });
});
