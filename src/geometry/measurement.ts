import type { Vec3 } from '../domain/model';
import { polylineLength2D } from './roads';

/** View-only XY metre measurements. These positions never become road-network nodes. */
export interface MeasurementState { points: Vec3[]; cursor: Vec3 | null; finished: boolean }
export type MeasurementAction = { type: 'add'; point: Vec3 } | { type: 'preview'; point: Vec3 | null } | { type: 'finish' } | { type: 'clear' };
export const emptyMeasurement = (): MeasurementState => ({ points: [], cursor: null, finished: false });
const finitePoint = (point: Vec3): boolean => point.every(Number.isFinite);

export function measurementReducer(state: MeasurementState, action: MeasurementAction): MeasurementState {
  if (action.type === 'clear') return emptyMeasurement();
  if (action.type === 'finish') return state.points.length >= 2 ? { ...state, cursor: null, finished: true } : state;
  if (action.type === 'preview') {
    if (state.finished || !state.points.length || action.point && !finitePoint(action.point)) return state;
    return { ...state, cursor: action.point ? [...action.point] : null };
  }
  if (!finitePoint(action.point)) return state;
  const points = state.finished ? [] : state.points, previous = points.at(-1);
  if (previous && previous[0] === action.point[0] && previous[1] === action.point[1]) return state;
  return { points: [...points, [...action.point]], cursor: null, finished: false };
}

export function measurementLengths(state: MeasurementState): { committedM: number; previewM: number; totalM: number } {
  const committedM = polylineLength2D(state.points), last = state.points.at(-1);
  const previewM = !state.finished && last && state.cursor ? polylineLength2D([last, state.cursor]) : 0;
  return { committedM, previewM, totalM: committedM + previewM };
}
