import { useSyncExternalStore } from 'react';
import type { Vec3 } from '../../domain/model';
import type { DraftRoad } from '../../editor/roadDrawing';
import { notify, store, type ShapeKind, type Tool } from './store';

/** The one drawing in progress. It belongs to the map revision it started on (`token`); camera moves never touch it. */
export type Draft =
  | { kind: 'road'; road: DraftRoad; token: number }
  | { kind: 'shape'; target: 'building' | 'zone'; shape: ShapeKind; points: Vec3[]; token: number }
  | { kind: 'measure'; points: Vec3[]; finished: boolean };

let draft: Draft | null = null;
const listeners = new Set<() => void>();
/** Kept out of the main store: points are added often and only the canvas and the tool bar need them. */
export const draftStore = {
  get: () => draft,
  set(next: Draft | null) { draft = next; listeners.forEach(listener => listener()); },
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
};
export const useDraft = () => useSyncExternalStore(draftStore.subscribe, draftStore.get);

export const DRAWING_TOOLS: readonly Tool[] = ['node', 'road', 'curve', 'building', 'zone', 'measure', 'entrance', 'service'];
const pointsOf = (current: Draft) => current.kind === 'road' ? current.road.points.length : current.points.length;

/** Switches tool. A road draft carries over between road and curve (R / C continue the same road); panning keeps any draft;
 *  every other switch drops the draft and says so. */
export function setTool(tool: Tool): void {
  const current = draftStore.get();
  const keeps = !current || tool === 'pan' || current.kind === 'road' && (tool === 'road' || tool === 'curve');
  if (!keeps) {
    draftStore.set(null);
    if (current.kind !== 'measure' && pointsOf(current) > 0) notify(`已放弃未完成的草稿（${pointsOf(current)} 个点）。`);
  }
  // Choosing a tool always means any building for entrances; the building's inspector sets its own after this.
  store.set({ tool, entranceFor: null });
}
/** A draft started before the map changed (undo, another edit) no longer fits it. */
export function dropStaleDraft(token: number): void {
  const current = draftStore.get();
  if (current && current.kind !== 'measure' && current.token !== token) { draftStore.set(null); notify('地图已变化，未完成的草稿已取消。'); }
}
