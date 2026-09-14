import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../src/domain/model';
import { screenToWorld, worldToScreen, zoomAt, type Camera } from '../../src/geometry/coordinates';
import { emptyMeasurement, measurementLengths, measurementReducer } from '../../src/geometry/measurement';

describe('FAST01 view-only world-metre ruler', () => {
  it('measures 3-4-5 and multi-leg paths in horizontal world metres across camera zoom and translation', () => {
    const world: Vec3[] = [[12, -7, 50], [15, -3, 100], [15, 9, 0]];
    const cameras: Camera[] = [{ offsetX: 400, offsetY: 300, scale: 1 }, { offsetX: -80, offsetY: 720, scale: 23 }, zoomAt({ offsetX: 400, offsetY: 300, scale: 1 }, [170, 220], 0.125)];
    for (const camera of cameras) {
      let state = emptyMeasurement();
      for (const point of world) state = measurementReducer(state, { type: 'add', point: screenToWorld(worldToScreen(point, camera), camera, point[2]) });
      expect(measurementLengths({ ...state, points: state.points.slice(0, 2) }).totalM).toBeCloseTo(5, 10);
      expect(measurementLengths(state).totalM).toBeCloseTo(17, 10);
    }
  });

  it('keeps pointer preview uncommitted, finishes only clicked points and starts a new measurement after completion', () => {
    let state = emptyMeasurement();
    state = measurementReducer(state, { type: 'add', point: [0, 0, 0] });
    expect(measurementReducer(state, { type: 'finish' }).finished).toBe(false);
    state = measurementReducer(state, { type: 'add', point: [3, 4, 0] });
    state = measurementReducer(state, { type: 'preview', point: [3, 16, 0] });
    expect(measurementLengths(state)).toEqual({ committedM: 5, previewM: 12, totalM: 17 });
    state = measurementReducer(state, { type: 'finish' });
    expect(state.points).toHaveLength(2); expect(measurementLengths(state).totalM).toBe(5); expect(state.cursor).toBeNull();
    state = measurementReducer(state, { type: 'add', point: [30, 40, 0] }); expect(state.points).toEqual([[30, 40, 0]]);
    expect(measurementReducer(state, { type: 'clear' })).toEqual(emptyMeasurement());
  });
});
