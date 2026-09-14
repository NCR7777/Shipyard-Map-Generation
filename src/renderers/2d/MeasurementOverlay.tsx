import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { Circle, Group, Label, Line, Tag, Text } from 'react-konva';
import type { Vec3 } from '../../domain/model';
import { worldToScreen, type Camera } from '../../geometry/coordinates';
import { emptyMeasurement, measurementLengths, measurementReducer, type MeasurementState } from '../../geometry/measurement';

/** Input is already in world metres using the current frame camera. No map commands or history. */
export function useMeasurement(active: boolean, resetKey: string | number) {
  const [state, dispatch] = useReducer(measurementReducer, undefined, emptyMeasurement);
  useEffect(() => { dispatch({ type: 'clear' }); }, [active, resetKey]);
  const addPoint = useCallback((point: Vec3) => { if (active) dispatch({ type: 'add', point }); }, [active]);
  const movePointer = useCallback((point: Vec3 | null) => { if (active) dispatch({ type: 'preview', point }); }, [active]);
  const finish = useCallback(() => { if (active) dispatch({ type: 'finish' }); }, [active]);
  const clear = useCallback(() => { dispatch({ type: 'clear' }); }, []);
  const handleKey = useCallback((key: string): boolean => {
    if (!active) return false;
    if (key === 'Enter') { dispatch({ type: 'finish' }); return true; }
    if (key === 'Escape') { dispatch({ type: 'clear' }); return true; }
    return false;
  }, [active]);
  const lengths = useMemo(() => measurementLengths(state), [state]);
  return { state, lengths, addPoint, movePointer, finish, clear, handleKey };
}

const metreFormat = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Draw within the existing screen-coordinate Konva Layer. All hit testing stays with its host. */
export function MeasurementOverlay({ state, camera }: { state: MeasurementState; camera: Camera }) {
  const lengths = measurementLengths(state), last = state.points.at(-1);
  if (!last) return null;
  const cursor = !state.finished ? state.cursor : null, anchor = worldToScreen(cursor ?? last, camera);
  const label = (cursor ? '预览 ' : state.finished ? '总长 ' : '已定 ') + metreFormat.format(lengths.totalM) + ' m' + (cursor ? '（已定 ' + metreFormat.format(lengths.committedM) + ' m）' : '');
  return <Group name="measurement-overlay" listening={false}>
    <Line points={state.points.flatMap(point => worldToScreen(point, camera))} stroke="#087e8b" strokeWidth={2} lineCap="round" lineJoin="round" />
    {cursor && <Line points={[...worldToScreen(last, camera), ...anchor]} stroke="#087e8b" strokeWidth={2} dash={[6, 4]} />}
    {state.points.map((point, index) => { const [x, y] = worldToScreen(point, camera); return <Circle key={index} x={x} y={y} radius={4} fill="#fff" stroke="#087e8b" strokeWidth={2} />; })}
    <Label x={anchor[0] + 12} y={anchor[1] - 32}><Tag fill="#f4ffff" stroke="#087e8b" strokeWidth={1} cornerRadius={4} /><Text text={label} fontSize={13} fill="#075662" padding={7} /></Label>
  </Group>;
}
