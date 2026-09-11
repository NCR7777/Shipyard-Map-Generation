import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FrameCamera } from '../../src/ui/useFrameCamera';
import { zoomAt, type Camera, type Vec2 } from '../../src/geometry/coordinates';

const initial: Camera = { offsetX: 80, offsetY: 460, scale: 4 };
let nextId: number;
let frames: Map<number, FrameRequestCallback>;
let request: ReturnType<typeof vi.fn>;
let engines: FrameCamera[];
function setup() {
  const states: { camera: Camera; navigating: boolean; epoch: number }[] = [];
  const engine = new FrameCamera(initial, state => states.push(state));
  engines.push(engine);
  return { engine, states };
}
function frame() {
  const [id, callback] = [...frames.entries()][0]!;
  frames.delete(id); callback(0);
}
beforeEach(() => {
  vi.useFakeTimers(); nextId = 0; frames = new Map(); engines = [];
  request = vi.fn((callback: FrameRequestCallback) => { frames.set(++nextId, callback); return nextId; });
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
});
afterEach(() => { engines.forEach(engine => engine.dispose()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('DP1 single effective camera and bounded scheduling', () => {
  it('accumulates every anchored wheel input while publishing only one pending frame', () => {
    const { engine, states } = setup();
    let expected = initial;
    for (let i = 0; i < 100; ++i) {
      const anchor: Vec2 = [20 + i * 3, 400 - i * 2];
      const ratio = i % 3 ? 1.15 : 1 / 1.15;
      expected = zoomAt(expected, anchor, expected.scale * ratio);
      engine.queue(current => zoomAt(current, anchor, current.scale * ratio));
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(engine.read()).toEqual(expected); expect(engine.hasPending()).toBe(true);
    expect(states).toEqual([{ camera: initial, navigating: true, epoch: 0 }]);
    frame(); expect(engine.hasPending()).toBe(false);
    expect(states.at(-1)).toEqual({ camera: expected, navigating: true, epoch: 0 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(149); expect(states.at(-1)!.navigating).toBe(true);
    vi.advanceTimersByTime(1); expect(states.at(-1)).toEqual({ camera: expected, navigating: false, epoch: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts settle from the last input and does not undo a later frame', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetX: 100 })); frame(); vi.advanceTimersByTime(100);
    engine.queue(c => ({ ...c, offsetX: 200 })); frame(); vi.advanceTimersByTime(100);
    expect(states.at(-1)!.navigating).toBe(true);
    vi.advanceTimersByTime(50);
    expect(states.at(-1)).toEqual({ camera: { ...initial, offsetX: 200 }, navigating: false, epoch: 0 });
  });

  it('flush reads and publishes the current camera immediately without invalidating the interaction epoch', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetY: -120 }));
    const stale = [...frames.values()][0]!;
    const effective = engine.read();
    expect(engine.flush()).toBe(effective); expect(engine.hasPending()).toBe(false);
    expect(states.at(-1)).toEqual({ camera: effective, navigating: false, epoch: 0 });
    const count = states.length; stale(0); vi.advanceTimersByTime(200);
    expect(states).toHaveLength(count); expect(frames.size).toBe(0);
  });

  it('an input flush republishes after settle even if React has not committed the previous publication', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetX: 500 })); frame(); vi.advanceTimersByTime(150);
    expect(engine.hasPending()).toBe(false); expect(states.at(-1)!.navigating).toBe(false);
    const previous = states.at(-1)!; const count = states.length;
    engine.flush();
    expect(states).toHaveLength(count + 1);
    expect(states.at(-1)).toEqual(previous); expect(states.at(-1)).not.toBe(previous);
    expect(states.at(-1)!.epoch).toBe(0);
  });

  it('replacement on fit or same-map project restore invalidates old RAF and settle callbacks', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetX: 200 })); const stale = [...frames.values()][0]!;
    engine.replace(initial); stale(0); vi.advanceTimersByTime(200);
    expect(states.at(-1)).toEqual({ camera: initial, navigating: false, epoch: 1 });
    expect(engine.read()).toEqual(initial); expect(engine.hasPending()).toBe(false);
    engine.replace(initial); expect(states.at(-1)!.epoch).toBe(2);
    expect(frames.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it('cancel retains the last effective navigation while rejecting an old pointer context', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetX: 200 })); const stale = [...frames.values()][0]!;
    engine.cancel(); const count = states.length; stale(0); vi.advanceTimersByTime(200);
    expect(states).toHaveLength(count);
    expect(states.at(-1)).toEqual({ camera: { ...initial, offsetX: 200 }, navigating: false, epoch: 1 });
  });

  it('unmount disposal has no publication and StrictMode resume cannot revive earlier jobs', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c, offsetX: 200 })); const stale = [...frames.values()][0]!;
    const count = states.length; engine.dispose(); stale(0); vi.advanceTimersByTime(200);
    engine.queue(c => ({ ...c, offsetX: 300 })); expect(states).toHaveLength(count);
    expect(frames.size).toBe(0); expect(engine.read()).toEqual(initial);
    engine.resume(); engine.queue(c => ({ ...c, offsetY: 900 })); stale(0);
    expect(frames.size).toBe(1); frame();
    expect(states.at(-1)!.camera).toEqual({ ...initial, offsetY: 900 });
  });

  it('keeps finite tiny-scale cameras and immutable snapshots; no-op input schedules nothing', () => {
    const { engine, states } = setup();
    engine.queue(c => ({ ...c })); expect(request).not.toHaveBeenCalled(); expect(states).toEqual([]);
    const tiny = { offsetX: 125, offsetY: 270, scale: 440 / Number.MAX_VALUE };
    engine.replace(tiny); tiny.offsetX = -1;
    expect(engine.read().offsetX).toBe(125); expect(Object.isFrozen(engine.read())).toBe(true);
    engine.queue(c => zoomAt(c, [799, 10], c.scale * 1.15));
    expect(Object.values(engine.read()).every(Number.isFinite)).toBe(true);
  });

  it.each([0, -1, Infinity, NaN])('rejects scale %s atomically without canceling a valid pending frame', scale => {
    const { engine } = setup(); engine.queue(c => ({ ...c, offsetX: 200 }));
    const before = engine.read();
    expect(() => engine.replace({ ...initial, scale })).toThrow(RangeError);
    expect(() => engine.queue(c => ({ ...c, scale }))).toThrow(RangeError);
    expect(engine.read()).toBe(before); expect(frames.size).toBe(1); frame();
    expect(engine.hasPending()).toBe(false);
  });
});
