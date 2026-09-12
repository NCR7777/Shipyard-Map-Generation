import { describe, expect, it } from 'vitest';
import { ProjectController, type ProjectStorePort, type StoredProject } from '../../src/editor/projectController';
import { editorFixture } from '../helpers/M1_fixtures';
import { contentHash, serializeMap } from '../../src/domain/serialization';

function setup() {
  const rows = new Map<string, StoredProject>(); let last: string | null = null;
  const store: ProjectStorePort = {
    list: async () => [], get: async id => structuredClone(rows.get(id) ?? null),
    commit: async record => { rows.set(record.projectId, structuredClone(record)); },
    getLastProject: async () => last, setLastProject: async id => { last = id; },
    readEditorState: async () => null, writeEditorState: async () => {},
  };
  const controller = new ProjectController(store);
  return { controller, rows, store };
}
async function started() {
  const test = setup(); const map = editorFixture();
  map.coordinateFrame.geographicAnchor = { crs: 'EPSG:32652', coordinateOrder: 'easting,northing,height', origin: [400000, 3900000, 12], rotationRad: 0.3, method: 'GA01 test only' };
  await test.controller.create('A', map); await test.controller.save(map, 'checkpoint');
  const changed = structuredClone(map); changed.coordinateFrame.geographicAnchor!.origin[0] += 10;
  const row = test.rows.get('A')!;
  row.storageVersion++;
  row.draft = { mapJson: serializeMap(changed), contentHash: contentHash(changed), savedAt: 100 };
  return { ...test, map, changed };
}

describe('GA01 fixed-frame reload candidates', () => {
  it('prepare and cancel leave the active context and all storage untouched', async () => {
    const { controller, rows } = await started(); const before = controller.state; const stored = structuredClone(rows);
    const candidate = await controller.prepareOpen('A');
    expect(candidate.recovery.map.coordinateFrame.geographicAnchor?.origin[0]).toBe(400010);
    expect(controller.state).toEqual(before); controller.cancelOpen(candidate);
    expect(controller.state).toEqual(before); expect(rows).toEqual(stored);
    await expect(controller.acceptOpen(candidate)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  });
  it('accept installs exactly the reviewed candidate and its confirmed baseline', async () => {
    const { controller, changed } = await started(); const candidate = await controller.prepareOpen('A');
    const recovery = await controller.acceptOpen(candidate);
    expect(recovery.map).toEqual(changed); expect(controller.state.active?.draftHash).toBe(contentHash(changed));
    await expect(controller.acceptOpen(candidate)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  });
  it('rejects mutation of a publicly displayed candidate', async () => {
    const { controller } = await started(); const candidate = await controller.prepareOpen('A');
    const before = controller.state.active;
    candidate.recovery.map.coordinateFrame.geographicAnchor!.origin[0]++;
    await expect(controller.acceptOpen(candidate)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(controller.state.active).toEqual(before);
  });
  it('rejects a new external body even when its storageVersion is unchanged', async () => {
    const { controller, rows } = await started(); const candidate = await controller.prepareOpen('A');
    const before = controller.state.active; rows.get('A')!.draft!.mapJson += ' ';
    await expect(controller.acceptOpen(candidate)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    expect(controller.state.active).toEqual(before);
  });
  it('rejects a candidate after project navigation or a completed local save', async () => {
    const { controller, map } = await started(); const candidate = await controller.prepareOpen('A');
    await controller.create('B', map);
    await expect(controller.acceptOpen(candidate)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
    await controller.save(map); const local = await controller.prepareOpen('B'); await controller.save(map);
    await expect(controller.acceptOpen(local)).rejects.toMatchObject({ code: 'PROJECT_CHANGED' });
  });
});
