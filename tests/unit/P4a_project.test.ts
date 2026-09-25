import { describe, expect, it } from 'vitest';
import { loadMap } from '../../src/domain/load';
import { backgroundMap } from '../helpers/P1B_backgroundMap';
import { DEFAULT_DRAWING_CONFIG, validateEditorState, type ProjectControllerState } from '../../src/editor/projectController';
import { createSession, editSession } from '../../src/editor/session';
import { editorStateOf, saveStatus, viewOf } from '../../src/app/state/project';
import { DEFAULT_UNITS, sceneOf, store, type AppState } from '../../src/app/state/store';

function mapWithLayers() {
  const loaded = loadMap(backgroundMap()); if (!loaded.ok) throw new Error('fixture map did not load');
  return loaded.map;
}
const camera = { offsetX: 12.5, offsetY: 300, scale: 4.25 };

describe('the project view: what a reload restores', () => {
  it('camera, display settings, units and background display survive storing and restoring', () => {
    const map = mapWithLayers();
    const state = {
      session: createSession(map, true), camera, units: { mass: 'kg' as const, speed: 'm/s' as const },
      drawing: { ...DEFAULT_DRAWING_CONFIG, showOrdinaryNodes: true, snapGrid: 5 as const, lockedTypes: ['roads' as const] },
      backgroundView: { hidden: Object.keys(map.backgroundLayers), opacity: { [Object.keys(map.backgroundLayers)[0]!]: 0.4 }, comparison: true },
    };
    expect(Object.keys(map.backgroundLayers)).toHaveLength(1);
    const stored = validateEditorState(editorStateOf(state));
    expect(stored.camera).toEqual(camera);
    expect(viewOf(stored, false)).toEqual({ drawing: state.drawing, units: state.units, backgroundView: state.backgroundView });
  });
  it('a project without a stored view restores defaults, keeping the comparison preference of the page', () => {
    expect(viewOf(null, true)).toEqual({ drawing: DEFAULT_DRAWING_CONFIG, units: DEFAULT_UNITS, backgroundView: { hidden: [], opacity: {}, comparison: true } });
  });
  it('nothing to store before the camera has settled or without a map', () => {
    const base = { units: DEFAULT_UNITS, drawing: DEFAULT_DRAWING_CONFIG, backgroundView: { hidden: [], opacity: {}, comparison: false } };
    expect(editorStateOf({ ...base, session: null, camera })).toBeNull();
    expect(editorStateOf({ ...base, session: createSession(mapWithLayers(), true), camera: null })).toBeNull();
  });
});

describe('the save status line', () => {
  const map = mapWithLayers(), session = createSession(map, true), hash = sceneOf(map).mapContentHash;
  const state = (phase: AppState['project']['phase'], edited = false): AppState => {
    let current = session;
    if (edited) { const result = editSession(session, { type: 'renameMap', name: '改名' }); if (!result.ok) throw new Error('rename refused'); current = result.session; }
    return { ...store.get(), session: current, project: { phase, failure: null } };
  };
  const controller = (patch: Partial<ProjectControllerState> & { draftHash?: string | null; checkpointHash?: string | null } = {}): ProjectControllerState => ({
    ready: true, saving: false, error: null,
    active: { projectId: 'p', name: 'P4a', storageVersion: 1, draftHash: patch.draftHash === undefined ? hash : patch.draftHash, checkpointHash: patch.checkpointHash ?? null },
    ...patch,
  });
  it('tells saved, draft-only, pending, saving, failed, conflict and memory apart', () => {
    expect(saveStatus(state('open'), controller({ checkpointHash: hash }))?.text).toBe('已保存');
    expect(saveStatus(state('open'), controller())?.text).toBe('已自动保存（草稿）');
    expect(saveStatus(state('open'), controller({ draftHash: null }))?.text).toBe('有修改待保存');
    expect(saveStatus(state('open'), controller({ saving: true }))?.text).toBe('保存中…');
    const conflict = Object.assign(new Error('另一标签页已保存此工程'), { code: 'PROJECT_CONFLICT' }) as never;
    expect(saveStatus(state('open'), controller({ error: conflict }))?.tone).toBe('error');
    const quota = Object.assign(new Error('浏览器存储空间不足'), { code: 'PROJECT_STORAGE_QUOTA' }) as never;
    expect(saveStatus(state('open'), controller({ error: quota }))?.text).toBe('保存失败：浏览器存储空间不足');
    // A view-only failure is a warning; the map itself is saved.
    const view = Object.assign(new Error('视窗或绘图配置未保存'), { code: 'EDITOR_STATE_SAVE_FAILED' }) as never;
    expect(saveStatus(state('open'), controller({ error: view }))).toEqual({ text: '视图设置未保存（地图已保存）', tone: 'warn' });
    expect(saveStatus(state('memory', true), controller())?.text).toBe('只在本页内存中（未存入浏览器）');
    expect(saveStatus(state('starting'), controller())?.text).toBe('正在恢复浏览器工程…');
    expect(saveStatus({ ...state('none'), session: null }, controller())).toBeNull();
  });
});
