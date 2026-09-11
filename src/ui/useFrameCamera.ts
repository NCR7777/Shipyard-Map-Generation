import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { worldToScreen, type Camera } from '../geometry/coordinates';

interface FrameState { camera: Camera; navigating: boolean; epoch: number }

function snapshot(camera: Camera): Camera {
  worldToScreen([0, 0, 0], camera); // Reuse the existing finite-camera boundary.
  return Object.freeze({ offsetX: camera.offsetX, offsetY: camera.offsetY, scale: camera.scale });
}
function equal(a: Camera, b: Camera) {
  return a.offsetX === b.offsetX && a.offsetY === b.offsetY && a.scale === b.scale;
}

/** One effective camera, one pending frame. Exported for native scheduler fault tests. */
export class FrameCamera {
  private effective: Camera;
  private published: Camera;
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frameToken = 0;
  private settleToken = 0;
  private active = true;
  private navigating = false;
  private epoch = 0;

  constructor(initial: Camera, private readonly publish: (state: FrameState) => void) {
    this.effective = this.published = snapshot(initial);
  }
  read = (): Camera => this.effective;
  hasPending = (): boolean => this.effective !== this.published;
  private emit(camera = this.effective) {
    this.published = camera;
    this.publish({ camera, navigating: this.navigating, epoch: this.epoch });
  }
  private clearScheduled() {
    ++this.frameToken; ++this.settleToken;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = null; this.timer = null;
  }
  queue = (update: (current: Camera) => Camera): void => {
    if (!this.active) return;
    const next = snapshot(update(this.effective));
    if (equal(next, this.effective)) return;
    this.effective = next;
    if (!this.navigating) { this.navigating = true; this.emit(this.published); }
    if (this.frame === null) {
      const token = ++this.frameToken;
      this.frame = requestAnimationFrame(() => {
        if (!this.active || token !== this.frameToken) return;
        this.frame = null; this.emit();
      });
    }
    if (this.timer !== null) clearTimeout(this.timer);
    const token = ++this.settleToken;
    this.timer = setTimeout(() => {
      if (this.active && token === this.settleToken) this.flush();
    }, 150);
  };
  flush = (): Camera => {
    if (!this.active) return this.effective;
    this.clearScheduled(); this.navigating = false;
    // A prior RAF/settle publication may still await React commit. An input flush must publish again.
    this.emit();
    return this.effective;
  };
  replace = (next: Camera): void => {
    if (!this.active) return;
    const checked = snapshot(next);
    this.clearScheduled(); ++this.epoch; this.navigating = false;
    this.effective = equal(checked, this.effective) ? this.effective : checked;
    this.emit();
  };
  cancel = (): void => {
    if (!this.active) return;
    this.clearScheduled(); ++this.epoch; this.navigating = false; this.emit();
  };
  resume = (): void => { this.active = true; };
  dispose = (): void => {
    this.clearScheduled(); this.active = false; this.navigating = false;
    this.effective = this.published;
  };
}

/** React holds the published projection; persistence and input boundaries use read(). */
export function useFrameCamera(initial: Camera) {
  const [state, setState] = useState<FrameState>(() => ({ camera: snapshot(initial), navigating: false, epoch: 0 }));
  const [frames] = useState(() => new FrameCamera(initial, setState));
  const committed = useRef(state.camera);
  useLayoutEffect(() => { committed.current = state.camera; }, [state.camera]);
  const hasPending = useCallback(() => frames.hasPending() || !equal(frames.read(), committed.current), [frames]);
  useEffect(() => { frames.resume(); return frames.dispose; }, [frames]);
  return { ...state, read: frames.read, queue: frames.queue, replace: frames.replace, flush: frames.flush, cancel: frames.cancel, hasPending };
}
