import { describe, expect, it } from 'vitest';
import {
  ProjectController, ProjectPersistenceError, validateEditorState,
  type EditorState, type ProjectStorePort, type ProjectSummary, type StoredProject,
} from '../../src/editor/projectController';
import { contentHash, serializeMap } from '../../src/domain/serialization';
import { editorFixture } from '../helpers/M1_fixtures';

/** Fault-injection port tests; the actual IndexedDB adapter is exercised separately in Chrome. */
class ControlledStore implements ProjectStorePort {
  rows = new Map<string, StoredProject>();
  views = new Map<string, EditorState>();
  last: string | null = null;
  commits = 0;
  reads = 0;
  viewWrites = 0;
  beforeCommit: (() => Promise<void>) | null = null;
  afterCommit: (() => Promise<void>) | null = null;
  beforeLastRead: (() => Promise<void>) | null = null;
  failure: Error | null = null;
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
  async readEditorState(id: string): Promise<EditorState | null> { return structuredClone(this.views.get(id) ?? null); }
  async writeEditorState(id: string, view: EditorState): Promise<void> { this.viewWrites += 1; this.views.set(id, structuredClone(view)); }
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
    expect(store.views.get('project_A')).toEqual({ camera: { offsetX: 10, offsetY: 20, scale: 3 } });
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
