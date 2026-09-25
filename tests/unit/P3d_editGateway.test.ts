import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nudgeBackground } from '../../src/app/state/backgroundEdit';
import { apply, applyAll, MERGE_MS, undo } from '../../src/app/state/edit';
import { store } from '../../src/app/state/store';
import type { MapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { YardMap } from '../../src/domain/model';
import { createSession } from '../../src/editor/session';
import { backgroundMap } from '../helpers/P1B_backgroundMap';

// Where +0.1 then −0.1 does not come back exactly: 0.9819066422096512 + 0.1 − 0.1 = 0.9819066422096513.
const AWKWARD = 0.9819066422096512;
let clock = 0, original: YardMap;
const map = () => store.get().session!.map;
const layer = () => map().backgroundLayers.bgQuadrants!;
const sources = () => Object.keys(map().sources).length;
const history = () => store.get().session!.past.length;

beforeEach(() => {
  const loaded = loadMap(backgroundMap({ transform: [1, 0, 0, -1, AWKWARD, 48] }));
  if (!loaded.ok) throw new Error('fixture');
  original = loaded.map;
  const sha = Object.values(original.assets)[0]!.sha256;
  clock = 1000; vi.spyOn(performance, 'now').mockImplementation(() => clock);
  // Adjusting needs a ready image; the levels are never drawn here.
  store.set(({ mapEpoch }) => ({ session: createSession(original, true), selection: ['backgroundLayers/bgQuadrants'], tool: 'select', switching: false,
    drawing: { ...store.get().drawing, lockedTypes: [], hiddenTypes: [] }, backgroundView: { hidden: [], opacity: {}, comparison: false },
    rasters: { [sha]: { status: 'ready', levels: [] } }, adjusting: { id: 'bgQuadrants', epoch: mapEpoch, keepAspect: true, measure: null } }));
});
afterEach(() => { vi.restoreAllMocks(); store.set({ session: null, adjusting: null, selection: [], rasters: {} }); });
const press = (dx: number, times = 1) => { for (let i = 0; i < times; i++) { clock += 40; nudgeBackground(dx, 0); } };

describe('a run of background nudges', () => {
  it('is one undo step and one lineage record, however long', () => {
    const before = sources();
    press(0.1, 40);
    expect(history()).toBe(1);
    expect(sources()).toBe(before + 1);
    expect(layer().imageToWorld[4]).toBe(AWKWARD + 4);
    expect(layer().provenance.sourceRefs).toHaveLength(original.backgroundLayers.bgQuadrants!.provenance.sourceRefs!.length + 1);
    undo();
    expect(map()).toEqual(original);
  });
  it('that comes back to where it began leaves the map exactly as it was and no undo step', () => {
    press(0.1, 3); press(-0.1, 3);
    expect(history()).toBe(0);
    expect(map()).toEqual(original);
    expect(layer().imageToWorld[4]).toBe(AWKWARD);
  });
  it('starts again after a pause, and after anything else moved the image', () => {
    press(0.1, 2);
    clock += MERGE_MS + 1;
    press(0.1, 2);
    expect(history()).toBe(2);
    const t = layer().imageToWorld;
    expect(apply({ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [t[0], t[1], t[2], t[3], t[4], t[5] + 1] }, '调整底图')).toBe(true);
    press(0.1);
    expect(history()).toBe(4);
  });
  it('without restarting would leave one record per step (why runs restart)', () => {
    const before = sources();
    for (let i = 1; i <= 5; i++) {
      clock += 40;
      apply({ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [1, 0, 0, -1, AWKWARD + i, 48] }, '微调底图', 'plain-run');
    }
    expect(history()).toBe(1);
    expect(sources()).toBe(before + 5);
  });
});

describe('several commands as one step', () => {
  const replaceAndFit = (second: MapCommand): MapCommand[] => [{ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [2, 0, 0, -2, 0, 48] }, second];
  it('are one undo step, undone exactly', () => {
    expect(applyAll(replaceAndFit({ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [2, 0, 0, -2, 10, 48] }), '替换底图图片')).toBe(true);
    expect(history()).toBe(1);
    expect(layer().imageToWorld).toEqual([2, 0, 0, -2, 10, 48]);
    undo();
    expect(map()).toEqual(original);
  });
  it('change nothing when any of them is refused, or touches a locked layer', () => {
    const session = store.get().session;
    expect(applyAll(replaceAndFit({ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [0, 0, 0, 0, 0, 0] }), '替换底图图片')).toBe(false);
    expect(store.get().session).toBe(session);
    store.set(({ drawing }) => ({ drawing: { ...drawing, lockedTypes: ['sources'] } }));
    expect(applyAll(replaceAndFit({ type: 'updateBackgroundTransform', id: 'bgQuadrants', imageToWorld: [2, 0, 0, -2, 10, 48] }), '替换底图图片')).toBe(false);
    expect(store.get().session).toBe(session);
  });
});
