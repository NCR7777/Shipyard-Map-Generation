import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DRAWING_CONFIG, ProjectController, ProjectPersistenceError, validateEditorState,
  type DrawingConfig, type EditorState, type EditorStateInput, type ProjectStorePort, type ProjectSummary, type StoredProject,
} from '../../src/editor/projectController';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { editorFixture } from '../helpers/M1_fixtures';

/** Fault-injection port tests; the actual IndexedDB adapter is exercised separately in Chrome. */
class ControlledStore implements ProjectStorePort {
  rows = new Map<string, StoredProject>();
  views = new Map<string, EditorStateInput>();
  last: string | null = null;
  commits = 0;
  reads = 0;
  viewWrites = 0;
  beforeCommit: (() => Promise<void>) | null = null;
  afterCommit: (() => Promise<void>) | null = null;
  beforeLastRead: (() => Promise<void>) | null = null;
  failure: Error | null = null;
  beforeViewWrite: ((id: string, view: EditorState) => Promise<void>) | null = null;
  viewFailure: Error | null = null;
  async list(): Promise<ProjectSummary[]> {
    return [...this.rows.values()].map(row => ({ projectId: row.projectId, name: row.name, storageVersion: row.storageVersion, updatedAt: row.updatedAt, hasDraft: !!row.draft, hasCheckpoint: !!row.checkpoint }));
  }
  async get(id: string) { this.reads += 1; return structuredClone(this.rows.get(id) ?? null); }
  async commit(record: StoredProject, expectedVersion: number | null): Promise<void> {
    this.commits += 1;
    if (this.beforeCommit) await this.beforeCommit();
    if (this.failure) throw this.failure;
    if ((this.rows.get(record.projectId)?.storageVersion ?? null) !== expectedVersion) throw new ProjectPersistenceError('PROJECT_CONFLICT', 'test concurrent commit');
    this.rows.set(record.projectId, structuredClone(record));
    if (this.afterCommit) await this.afterCommit();
  }
  async getLastProject(): Promise<string | null> { if (this.beforeLastRead) await this.beforeLastRead(); return this.last; }
  async setLastProject(id: string): Promise<void> { this.last = id; }
  async readEditorState(id: string): Promise<EditorStateInput | null> { return structuredClone(this.views.get(id) ?? null); }
  async writeEditorState(id: string, view: EditorState): Promise<void> {
    this.viewWrites += 1;
    if (this.beforeViewWrite) await this.beforeViewWrite(id, view);
    if (this.viewFailure) throw this.viewFailure;
    this.views.set(id, structuredClone(view));
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function started(store = new ControlledStore()) {
  const controller = new ProjectController(store, () => 1000 + store.commits);
  await controller.initialize();
  const map = editorFixture();
  await controller.create('project_A', map);
  return { store, controller, map };
}

describe('M1.1 browser-project persistence coordination (fault-injection unit port)', () => {
  it('S01 saves without exporting and restores through the shared load pipeline', async () => {
    const { controller, store, map } = await started();
    expect(store.rows.size).toBe(0);
    const receipt = await controller.save(map, 'checkpoint');
    expect(receipt.contentHash).toBe(contentHash(map));
    expect(controller.state.active?.draftHash).toBe(contentHash(map));
    const reopened = new ProjectController(store);
    const recovered = await reopened.initialize();
    expect(recovered?.map).toEqual(map);
    expect(recovered?.source).toBe('draft');
    expect(reopened.state.active?.checkpointHash).toBe(contentHash(map));
  });

  it('S02 keeps project identities, recent names and view targets independent', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    await controller.saveEditorState({ camera: { offsetX: 10, offsetY: 20, scale: 2 } });
    const second = editorFixture(); second.metadata.name = '另一方案'; second.nodes.nB!.position[0] = 200;
    await controller.create('project_B', second, { camera: { offsetX: 200, offsetY: 0, scale: 1 } });
    await controller.save(second, 'checkpoint');
    const list = await controller.list();
    expect(list.map(row => row.projectId)).toEqual(['project_B', 'project_A']);
    expect(list[0]!.name).toBe('另一方案');
    const recovered = await controller.open('project_A');
    expect(recovered.map).toEqual(map);
    expect(recovered.editorState?.camera).toEqual({ offsetX: 10, offsetY: 20, scale: 2 });
    expect(store.views.get('project_B')?.camera.offsetX).toBe(200);
  });

  it('S03 initializes once and cannot write before delayed recovery completes', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const original = structuredClone(store.rows.get('project_A'));
    const wait = deferred(); store.beforeLastRead = () => wait.promise;
    const recovery = new ProjectController(store);
    const first = recovery.initialize(); const second = recovery.initialize();
    expect(first).toBe(second);
    await expect(recovery.save(editorFixture())).rejects.toMatchObject({ code: 'PROJECT_NOT_READY' });
    expect(store.rows.get('project_A')).toEqual(original);
    expect(store.commits).toBe(1);
    wait.resolve();
    expect((await first)?.map).toEqual(map);
    expect(recovery.state.ready).toBe(true);
  });

  it('S04 confirms A only after commit, never marks editing snapshot B saved', async () => {
    const { controller, store, map } = await started();
    const wait = deferred(); store.beforeCommit = () => wait.promise;
    const saveA = controller.save(map, 'draft');
    const originalHash = contentHash(map);
    map.nodes.nB!.position[0] = 120;
    expect(controller.state.saving).toBe(true);
    expect(controller.state.active?.draftHash).toBeNull();
    await Promise.resolve();
    expect(store.rows.size).toBe(0);
    wait.resolve();
    const receipt = await saveA;
    expect(receipt.contentHash).toBe(originalHash);
    expect(controller.state.active?.draftHash).toBe(originalHash);
    expect(controller.state.active?.draftHash).not.toBe(contentHash(map));
    expect(JSON.parse(store.rows.get('project_A')!.draft!.mapJson).nodes.nB.position[0]).toBe(100);
  });

  it('serializes queued same-tab saves using the committed storage version', async () => {
    const { controller, store, map } = await started();
    const wait = deferred(); store.beforeCommit = () => wait.promise;
    const first = controller.save(map);
    map.nodes.nB!.position[0] = 120;
    const second = controller.save(map);
    wait.resolve();
    expect((await first).storageVersion).toBe(1);
    expect((await second).storageVersion).toBe(2);
    expect(controller.state.active?.draftHash).toBe(contentHash(map));
    expect(controller.state.saving).toBe(false);
  });

  it('S05 quota failure preserves the last successful checkpoint and draft', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const original = structuredClone(store.rows.get('project_A'));
    const quota = new Error('quota'); quota.name = 'QuotaExceededError'; store.failure = quota;
    map.nodes.nB!.position[0] = 150;
    await expect(controller.save(map, 'checkpoint')).rejects.toMatchObject({ code: 'PROJECT_STORAGE_QUOTA' });
    expect(store.rows.get('project_A')).toEqual(original);
    expect(controller.state.active?.draftHash).toBe(original!.draft!.contentHash);
    expect(controller.state.error?.code).toBe('PROJECT_STORAGE_QUOTA');
    store.failure = null;
    await controller.save(map, 'checkpoint');
    expect(controller.state.error).toBeNull();
  });

  it('S06 independent storage CAS rejects another tab even with unchanged revision', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const tab2 = new ProjectController(store);
    const recovered = await tab2.initialize();
    const secondMap = recovered!.map;
    map.nodes.nB!.position[0] = 120;
    secondMap.nodes.nB!.position[0] = 130;
    expect(map.revision).toBe(secondMap.revision);
    await controller.save(map);
    await expect(tab2.save(secondMap)).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    expect(JSON.parse(store.rows.get('project_A')!.draft!.mapJson).nodes.nB.position[0]).toBe(120);
    expect(secondMap.nodes.nB!.position[0]).toBe(130);
    expect(tab2.state.active?.storageVersion).toBe(1);
    expect(await tab2.checkExternalVersion()).toBe(true);
    expect(tab2.state.error?.code).toBe('PROJECT_CONFLICT');
  });

  it('draft saves preserve explicit checkpoint and previous explicit checkpoint', async () => {
    const { controller, store, map } = await started();
    const original = serializeMap(map);
    await controller.save(map, 'checkpoint');
    map.nodes.nB!.position[0] = 120;
    await controller.save(map, 'draft');
    expect(store.rows.get('project_A')!.checkpoint!.mapJson).toBe(original);
    expect(store.rows.get('project_A')!.previousCheckpoint).toBeNull();
    const second = serializeMap(map);
    await controller.save(map, 'checkpoint');
    expect(store.rows.get('project_A')!.checkpoint!.mapJson).toBe(second);
    expect(store.rows.get('project_A')!.previousCheckpoint!.mapJson).toBe(original);
    map.nodes.nB!.position[0] = 140;
    await controller.save(map, 'draft');
    expect(store.rows.get('project_A')!.checkpoint!.mapJson).toBe(second);
    expect(store.rows.get('project_A')!.previousCheckpoint!.mapJson).toBe(original);
  });

  it('recovers a valid checkpoint from corrupt draft without automatically rewriting any record', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    store.rows.get('project_A')!.draft = { mapJson: '{"schemaVersion":"99.0.0"}', contentHash: 'bad', savedAt: 3000 };
    const corrupt = structuredClone(store.rows.get('project_A'));
    const reopened = new ProjectController(store);
    const recovered = await reopened.initialize();
    expect(recovered?.source).toBe('checkpoint');
    expect(recovered?.map).toEqual(map);
    expect(recovered?.warnings.length).toBeGreaterThan(0);
    expect(reopened.state.active?.draftHash).toBe(contentHash(map));
    expect(store.rows.get('project_A')).toEqual(corrupt);
    expect(store.commits).toBe(1);
  });

  it('rejects bad snapshot hash or all-invalid records and never creates a replacement empty map', async () => {
    const { controller, store, map } = await started();
    await controller.save(map);
    store.rows.get('project_A')!.draft!.contentHash = '0'.repeat(64);
    const recovery = new ProjectController(store);
    await expect(recovery.initialize()).rejects.toMatchObject({ code: 'PROJECT_NO_VALID_SNAPSHOT' });
    expect(recovery.state.ready).toBe(false);
    expect(recovery.state.active).toBeNull();
    expect(store.commits).toBe(1);
  });

  it('allows initialization retry after a real storage error instead of caching rejected promise', async () => {
    const store = new ControlledStore();
    store.beforeLastRead = async () => { throw new Error('temporary read error'); };
    const controller = new ProjectController(store);
    await expect(controller.initialize()).rejects.toThrow('temporary read error');
    store.beforeLastRead = null;
    expect(await controller.initialize()).toBeNull();
    expect(controller.state.ready).toBe(true);
  });

  it('failed open leaves the previous active identity and confirmed baselines intact', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const original = controller.state.active;
    await expect(controller.open('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
    expect(controller.state.active).toEqual(original);
    expect(store.last).toBe('project_A');
  });

  it('does not apply an old-project acknowledgement to a newly selected project', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const second = editorFixture(); second.metadata.name = '第二工程';
    await controller.create('project_B', second);
    await controller.save(second, 'checkpoint');
    await controller.open('project_A');
    const wait = deferred(); store.beforeCommit = () => wait.promise;
    map.nodes.nB!.position[0] = 120;
    const save = controller.save(map);
    await Promise.resolve(); // Enter the in-flight commit before switching.
    await controller.open('project_B');
    const selected = controller.state.active;
    wait.resolve();
    expect((await save).projectId).toBe('project_A');
    expect(controller.state.active).toEqual(selected);
    expect(store.last).toBe('project_B');
  });

  it('S09 view-only changes neither alter map JSON nor increment document storage version', async () => {
    const { controller, store, map } = await started();
    await controller.saveEditorState({ camera: { offsetX: 5, offsetY: 6, scale: 2 } });
    expect(store.viewWrites).toBe(0);
    await controller.save(map);
    expect(store.viewWrites).toBe(1);
    const previous = structuredClone(store.rows.get('project_A'));
    await controller.saveEditorState({ camera: { offsetX: 10, offsetY: 20, scale: 3 } });
    expect(store.rows.get('project_A')).toEqual(previous);
    expect(store.views.get('project_A')).toEqual({ camera: { offsetX: 10, offsetY: 20, scale: 3 }, drawing: DEFAULT_DRAWING_CONFIG });
    expect(validateEditorState({ camera: { offsetX: 1, offsetY: 1, scale: 0.01 } }).camera.scale).toBe(0.01);
    expect(() => validateEditorState({ camera: { offsetX: 0, offsetY: 0, scale: 0 } })).toThrow();
  });

  it('writes recovery backups with no active-project, last-open or map-ID changes', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const active = controller.state.active;
    const external = editorFixture(); external.nodes.nB!.position[0] = 140;
    const summary = await controller.backup('recovery_external', external);
    expect(summary.name).toContain('恢复副本');
    expect(controller.state.active).toEqual(active);
    expect(store.last).toBe('project_A');
    expect(store.rows.get('recovery_external')!.draft!.mapJson).toBe(serializeMap(external));
    expect(store.rows.get('recovery_external')!.checkpoint!.mapJson).toBe(serializeMap(external));
    await expect(controller.backup('recovery_external', map)).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    expect(store.rows.get('recovery_external')!.draft!.mapJson).toBe(serializeMap(external));
  });

  it('S02 prefers the current tab project identity instead of another tab last-open metadata', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const second = editorFixture(); second.metadata.name = '另一标签页的工程';
    await controller.create('project_B', second); await controller.save(second);
    expect(store.last).toBe('project_B');
    const tabA = new ProjectController(store);
    const restored = await tabA.initialize('project_A');
    expect(restored?.projectId).toBe('project_A');
    expect(restored?.map).toEqual(map);
    expect(store.last).toBe('project_B');
  });

  it('warns when a removed tab project falls back to a valid global recent project', async () => {
    const { controller, store, map } = await started();
    await controller.save(map);
    const tab = new ProjectController(store);
    const restored = await tab.initialize('removed_project');
    expect(restored?.projectId).toBe('project_A');
    expect(restored?.warnings.some(issue => issue.code === 'PROJECT_RECENT_NOT_FOUND')).toBe(true);
    expect(store.commits).toBe(1);
  });

  it('keeps a missing preferred-project warning when no project exists yet', async () => {
    const store = new ControlledStore();
    const tab = new ProjectController(store);
    expect(await tab.initialize('removed_project')).toBeNull();
    const recovery = await tab.create('new_project', editorFixture());
    expect(recovery.warnings.some(issue => issue.code === 'PROJECT_RECENT_NOT_FOUND')).toBe(true);
    expect(store.commits).toBe(0);
  });
  it('keeps the recovery label after geometry edits, while explicit map renaming updates the project name', async () => {
    const { controller, map } = await started();
    await controller.backup('recovery_named', map);
    const recovery = await controller.open('recovery_named');
    const working = recovery.map;
    working.nodes.nB!.position[0] = 123;
    await controller.save(working);
    expect(controller.state.active?.name).toBe(map.metadata.name + '（恢复副本）');
    working.metadata.name = '明确重命名工程';
    await controller.save(working);
    expect(controller.state.active?.name).toBe('明确重命名工程');
  });
  it('does not misclassify a local commit awaiting acknowledgement as an external focus conflict', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const wait = deferred(); store.afterCommit = () => wait.promise;
    map.nodes.nB!.position[0] = 121;
    const saving = controller.save(map);
    await Promise.resolve();
    expect(store.rows.get('project_A')!.storageVersion).toBe(2);
    expect(controller.state.active?.storageVersion).toBe(1);
    expect(controller.state.saving).toBe(true);
    const reads = store.reads;
    expect(await controller.checkExternalVersion()).toBe(false);
    expect(store.reads).toBe(reads);
    expect(controller.state.error).toBeNull();
    wait.resolve(); await saving;
    expect(controller.state.active?.storageVersion).toBe(2);
    store.rows.get('project_A')!.storageVersion = 3;
    expect(await controller.checkExternalVersion()).toBe(true);
    expect(controller.state.error?.code).toBe('PROJECT_CONFLICT');
  });
  it('invalid map or view cannot enter storage or alter a confirmed map baseline', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const original = structuredClone(store.rows.get('project_A'));
    map.roads.rAB!.toNodeId = 'missing';
    await expect(controller.save(map)).rejects.toThrow();
    await expect(controller.saveEditorState({ camera: { offsetX: NaN, offsetY: 0, scale: 1 } })).rejects.toMatchObject({ code: 'EDITOR_STATE_INVALID' });
    expect(store.rows.get('project_A')).toEqual(original);
  });
});

const camera = { offsetX: 8, offsetY: 9, scale: 2 };
const editorState = (drawing: Partial<DrawingConfig> = {}): EditorState => ({ camera: { ...camera }, drawing: { ...DEFAULT_DRAWING_CONFIG, ...drawing } });

describe('stable drawing configuration in independent editor state', () => {
  it('normalizes old camera-only and partial settings, retaining explicit false and zero', () => {
    expect(validateEditorState({ camera })).toEqual(editorState());
    expect(validateEditorState({ camera, drawing: { snapGrid: 0, snapNodes: false, facilityKind: 'quay' } })).toEqual(editorState({ facilityKind: 'quay' }));
    const legacySixFields = {
      snapGrid: 10, snapNodes: true, facilityKind: 'dock', zoneKind: 'buffer',
      facilityMovePolicy: 'withAssociatedNodes', zoneMovePolicy: 'boundaryOnly',
    };
    expect(validateEditorState({ camera, drawing: legacySixFields }).drawing).toEqual({ ...DEFAULT_DRAWING_CONFIG, ...legacySixFields });
    expect(validateEditorState({ camera, drawing: { showRoadBands: false, showRoadCenterlines: false, showOrdinaryNodes: false } }))
      .toEqual(editorState({ showRoadBands: false, showRoadCenterlines: false, showOrdinaryNodes: false }));
    const normalized = validateEditorState({ camera });
    normalized.drawing.snapNodes = true; normalized.camera.scale = 100;
    expect(DEFAULT_DRAWING_CONFIG.snapNodes).toBe(false);
    expect(camera.scale).toBe(2);
  });

  it.each([
    null, [], { snapGrid: null }, { snapGrid: -1 }, { snapGrid: 2 }, { snapGrid: NaN }, { snapGrid: Infinity },
    { snapGrid: '5' }, { snapNodes: 0 }, { snapNodes: null }, { facilityKind: 'ship' }, { zoneKind: 'road' },
    { facilityMovePolicy: 'all' }, { zoneMovePolicy: null }, { tool: 'select' }, { snapGrid: undefined },
    { showRoadBands: null }, { showRoadBands: 0 }, { showRoadBands: 'false' },
    { showRoadCenterlines: undefined }, { showRoadCenterlines: 1 }, { showRoadCenterlines: 'true' },
    { showOrdinaryNodes: null }, { showOrdinaryNodes: [] }, { showOrdinaryNodes: 'false' },
  ])('rejects invalid or transient configuration %j without inventing defaults', drawing => {
    expect(() => validateEditorState({ camera, drawing })).toThrowError(expect.objectContaining({ code: 'EDITOR_STATE_INVALID' }));
  });

  it('persists a complete configuration and restores it independently from map bytes and revisions', async () => {
    const { controller, store, map } = await started();
    const state = editorState({ snapGrid: 10, snapNodes: true, facilityKind: 'quay', zoneKind: 'water', facilityMovePolicy: 'withAssociatedNodes', zoneMovePolicy: 'withAssociatedNodes' });
    await controller.save(map, 'checkpoint');
    const record = structuredClone(store.rows.get('project_A'));
    await controller.saveEditorState(state);
    expect(store.rows.get('project_A')).toEqual(record);
    expect((await new ProjectController(store).initialize())?.editorState).toEqual(state);
    state.drawing.snapGrid = 1;
    expect(store.views.get('project_A')?.drawing?.snapGrid).toBe(10);
  });

  it.each([{ snapGrid: 2 }, { showRoadBands: 'false' }])('restores legacy defaults and retains a map when only the drawing record is corrupt: %j', async drawing => {
    const { controller, store, map } = await started(); await controller.save(map);
    store.views.set('project_A', { camera });
    expect((await new ProjectController(store).initialize())?.editorState).toEqual(editorState());
    const bad = { camera, drawing } as unknown as EditorStateInput;
    store.views.set('project_A', bad);
    const recovered = await new ProjectController(store).initialize();
    expect(recovered?.map).toEqual(map);
    expect(recovered?.editorState).toBeNull();
    expect(recovered?.warnings.some(issue => issue.code === 'EDITOR_STATE_RECOVERY_FAILED')).toBe(true);
    expect(store.views.get('project_A')).toEqual(bad);
    expect(store.commits).toBe(1);
  });

  it('keeps road display settings per project and recovery copy without modifying static map snapshots', async () => {
    const { controller, store, map } = await started();
    await controller.save(map, 'checkpoint');
    const mapRecordA = structuredClone(store.rows.get('project_A'));
    const stateA = editorState({ showRoadBands: false, showRoadCenterlines: true, showOrdinaryNodes: false });
    await controller.saveEditorState(stateA);
    await controller.create('project_B', map, editorState({ showRoadCenterlines: false }));
    await controller.save(map, 'checkpoint');
    const mapRecordB = structuredClone(store.rows.get('project_B'));
    expect((await controller.open('project_A')).editorState).toEqual(stateA);
    await controller.backup('road_display_recovery', map, stateA);
    expect((await controller.open('project_B')).editorState).toEqual(editorState({ showRoadCenterlines: false }));
    const restoredCopy = await controller.open('road_display_recovery');
    expect(restoredCopy.editorState).toEqual(stateA);
    expect(serializeMap(restoredCopy.map)).toBe(serializeMap(map));
    expect(contentHash(restoredCopy.map)).toBe(contentHash(map));
    expect(restoredCopy.map.revision).toBe(map.revision);
    expect(store.rows.get('project_A')).toEqual(mapRecordA);
    expect(store.rows.get('project_B')).toEqual(mapRecordB);
  });

  it('stages pre-commit settings without orphan writes and writes the latest snapshot on first map save', async () => {
    const { controller, store, map } = await started();
    const gate = deferred(); store.beforeCommit = () => gate.promise;
    const saving = controller.save(map);
    await Promise.resolve();
    await controller.saveEditorState(editorState({ snapGrid: 1 }));
    await controller.saveEditorState(editorState({ snapGrid: 5, snapNodes: true }));
    expect(store.viewWrites).toBe(0);
    gate.resolve(); await saving;
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 5, snapNodes: true }));
  });

  it('serializes a slow old editor write before a newer snapshot rather than letting the old value finish last', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    const gate = deferred(); const entered = deferred();
    store.beforeViewWrite = async () => { entered.resolve(); await gate.promise; };
    const first = controller.saveEditorState(editorState({ snapGrid: 1 }));
    await entered.promise;
    const second = controller.saveEditorState(editorState({ snapGrid: 10, snapNodes: true }));
    await Promise.resolve(); expect(store.viewWrites).toBe(1);
    gate.resolve(); await Promise.all([first, second]);
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 10, snapNodes: true }));
  });

  it('orders map auxiliary editor writes with editor requests and never writes a superseded queued configuration', async () => {
    const { controller, store, map } = await started();
    await controller.saveEditorState(editorState({ snapGrid: 1 })); await controller.save(map);
    const gate = deferred(); const entered = deferred(); const written: number[] = [];
    store.beforeCommit = async () => { entered.resolve(); await gate.promise; };
    store.beforeViewWrite = async (_id, view) => { written.push(view.drawing.snapGrid); };
    const saving = controller.save(map); await entered.promise;
    const old = controller.saveEditorState(editorState({ snapGrid: 5 }));
    const latest = controller.saveEditorState(editorState({ snapGrid: 10 }));
    gate.resolve(); await Promise.all([saving, old, latest]);
    expect(written).not.toContain(5);
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 10 }));
    const auxiliaryGate = deferred(); const auxiliaryEntered = deferred();
    store.beforeCommit = null;
    store.beforeViewWrite = async (_id, view) => { if (view.drawing.snapGrid === 10) { auxiliaryEntered.resolve(); await auxiliaryGate.promise; } };
    const mapSave = controller.save(map); await auxiliaryEntered.promise;
    const final = controller.saveEditorState(editorState({ snapGrid: 0 }));
    auxiliaryGate.resolve(); await Promise.all([mapSave, final]);
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 0 }));
  });

  it('keeps delayed editor requests and errors attached to their captured project context', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    const gate = deferred(); const entered = deferred();
    store.beforeViewWrite = async id => { if (id === 'project_A') { entered.resolve(); await gate.promise; throw new Error('A write failed'); } };
    const first = controller.saveEditorState(editorState({ snapGrid: 1 })).catch(error => error as ProjectPersistenceError);
    await entered.promise;
    const queued = controller.saveEditorState(editorState({ snapGrid: 5 })).catch(error => error as ProjectPersistenceError);
    await controller.create('project_B', map, editorState({ snapGrid: 10 }));
    const savingB = controller.save(map);
    gate.resolve();
    expect(await first).toMatchObject({ code: 'EDITOR_STATE_SAVE_FAILED' });
    expect(await queued).toMatchObject({ code: 'PROJECT_CHANGED' });
    await savingB;
    expect(controller.state.active?.projectId).toBe('project_B');
    expect(controller.state.error).toBeNull();
    expect(store.views.get('project_B')).toEqual(editorState({ snapGrid: 10 }));
    expect(store.views.has('project_A')).toBe(false);
  });

  it('retains failed editor writes and map baselines, retries successfully, and never clears a map conflict', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    await controller.saveEditorState(editorState({ snapGrid: 1 }));
    const record = structuredClone(store.rows.get('project_A'));
    store.viewFailure = new Error('quota while writing editor settings');
    await expect(controller.saveEditorState(editorState({ snapGrid: 10 }))).rejects.toMatchObject({ code: 'EDITOR_STATE_SAVE_FAILED' });
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 1 }));
    expect(store.rows.get('project_A')).toEqual(record);
    expect(controller.state.error?.code).toBe('EDITOR_STATE_SAVE_FAILED');
    store.viewFailure = null;
    await controller.saveEditorState(editorState({ snapGrid: 10 }));
    expect(controller.state.error).toBeNull();
    store.rows.get('project_A')!.storageVersion += 1;
    expect(await controller.checkExternalVersion()).toBe(true);
    await expect(controller.saveEditorState(editorState({ snapGrid: 5 }))).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 10 }));
    expect(controller.state.error?.code).toBe('PROJECT_CONFLICT');
  });

  it('copies editor settings only for an explicitly requested recovery copy without changing the active project', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    const active = controller.state.active;
    const state = editorState({ snapGrid: 5, snapNodes: true, facilityKind: 'dock', zoneKind: 'buffer' });
    await controller.backup('recovery_settings', map, state);
    expect(controller.state.active).toEqual(active);
    expect(store.last).toBe('project_A');
    expect(store.views.get('recovery_settings')).toEqual(state);
    expect((await controller.open('recovery_settings')).editorState).toEqual(state);
    await controller.backup('external_map_only', map);
    expect(store.views.has('external_map_only')).toBe(false);
  });
  it('reports auxiliary editor failure after the map commit without pretending the configuration is saved', async () => {
    const { controller, store, map } = await started();
    await controller.saveEditorState(editorState({ snapGrid: 5 }));
    store.viewFailure = new Error('editor store failed');
    const receipt = await controller.save(map, 'checkpoint');
    expect(receipt.contentHash).toBe(contentHash(map));
    expect(controller.state.active?.draftHash).toBe(contentHash(map));
    expect(controller.state.error?.code).toBe('PROJECT_AUX_SAVE_FAILED');
    expect(store.views.has('project_A')).toBe(false);
    expect(store.rows.get('project_A')!.checkpoint!.mapJson).toBe(serializeMap(map));
  });

  it('rejects an incomplete configured backup and does not attach its delayed failure to another project', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    const gate = deferred(); const entered = deferred();
    store.beforeViewWrite = async id => { if (id === 'backup_failed') { entered.resolve(); await gate.promise; throw new Error('backup settings failed'); } };
    const backup = controller.backup('backup_failed', map, editorState({ snapGrid: 10 })).catch(error => error as ProjectPersistenceError);
    await entered.promise;
    await controller.create('project_B', map, editorState({ snapGrid: 1 }));
    const active = controller.state.active;
    gate.resolve();
    expect(await backup).toMatchObject({ code: 'PROJECT_STORAGE_ERROR' });
    expect(controller.state.active).toEqual(active);
    expect(controller.state.error).toBeNull();
    expect(store.rows.get('backup_failed')!.draft!.mapJson).toBe(serializeMap(map));
    expect(store.views.has('backup_failed')).toBe(false);
  });

  it('rejects an already queued editor request when a focus check discovers a conflict during the prior write', async () => {
    const { controller, store, map } = await started(); await controller.save(map);
    await controller.saveEditorState(editorState({ snapGrid: 10 }));
    const gate = deferred(); const entered = deferred();
    store.beforeViewWrite = async () => { entered.resolve(); await gate.promise; };
    const first = controller.saveEditorState(editorState({ snapGrid: 1 }));
    await entered.promise;
    const second = controller.saveEditorState(editorState({ snapGrid: 5 }));
    const rejected = expect(second).rejects.toMatchObject({ code: 'PROJECT_CONFLICT' });
    store.rows.get('project_A')!.storageVersion += 1;
    expect(await controller.checkExternalVersion()).toBe(true);
    const writes = store.viewWrites;
    gate.resolve(); await first; await rejected;
    expect(store.viewWrites).toBe(writes);
    expect(store.views.get('project_A')).toEqual(editorState({ snapGrid: 1 }));
    expect(controller.state.error?.code).toBe('PROJECT_CONFLICT');
  });

});


describe('DP1 label mode migration at the existing persistence boundary', () => {
  it.each([
    [{}, 'auto'], [{ showLabels: true }, 'auto'], [{ showLabels: false }, 'off'],
    [{ labelMode: 'focus', showLabels: false }, 'focus'],
    [{ labelMode: 'off', showLabels: true }, 'off'],
    [{ labelMode: 'debug_all', showLabels: null }, 'debug_all'],
  ])('normalizes legacy input %j to the one authoritative mode %s', (drawing, mode) => {
    const normalized = validateEditorState({ camera, drawing: { ...drawing, snapGrid: 0, snapNodes: false } });
    expect(normalized.camera).toEqual(camera);
    expect(normalized.drawing.labelMode).toBe(mode);
    expect(normalized.drawing.snapGrid).toBe(0); expect(normalized.drawing.snapNodes).toBe(false);
    expect(normalized.drawing).not.toHaveProperty('showLabels');
    expect(validateEditorState(normalized)).toEqual(normalized);
  });

  it.each([
    { labelMode: undefined, showLabels: false }, { labelMode: null }, { labelMode: true },
    { labelMode: 'all', showLabels: true }, { showLabels: null }, { showLabels: undefined },
    { showLabels: 'false' }, { labelMode: 'auto', cameraPending: true },
  ])('rejects invalid modes and transient fields %j', drawing => {
    expect(() => validateEditorState({ camera, drawing })).toThrowError(expect.objectContaining({ code: 'EDITOR_STATE_INVALID' }));
  });

  it('restores a real legacy record and stores only labelMode without editing the map record', async () => {
    const { store, controller, map } = await started(); await controller.save(map, 'checkpoint');
    const record = structuredClone(store.rows.get('project_A'));
    store.views.set('project_A', { camera, drawing: { showLabels: false, snapGrid: 0, snapNodes: false } });
    const restored = new ProjectController(store); const recovery = await restored.initialize();
    expect(recovery!.editorState).toEqual(editorState({ labelMode: 'off' }));
    expect(recovery!.warnings).toEqual([]);
    await restored.saveEditorState(recovery!.editorState!);
    expect(store.views.get('project_A')!.drawing).not.toHaveProperty('showLabels');
    expect(store.rows.get('project_A')).toEqual(record);
    expect(contentHash(recovery!.map)).toBe(contentHash(map));
  });
});
