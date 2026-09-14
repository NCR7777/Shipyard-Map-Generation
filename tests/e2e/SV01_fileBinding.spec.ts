import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('SV01 real IndexedDB v2 upgrade restores exact native handles by project and keeps stale file baselines', async ({ page }) => {
  await page.goto('/');
  const json = await readFile(new URL('../../examples/M1_synthetic.map.json', import.meta.url), 'utf8');
  const name = 'SV01-bindings-' + Date.now();
  const prepared = await page.evaluate(async ({ json, name }) => {
    const projectPath = '/src/adapters/projectStore.ts', localPath = '/src/adapters/localFiles.ts';
    const { IndexedDBProjectStore } = await import(projectPath), { LocalFileController } = await import(localPath);
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('projects', { keyPath: 'projectId' }); db.createObjectStore('metadata'); db.createObjectStore('editorStates');
        const assets = db.createObjectStore('assetBlobs', { keyPath: ['projectId', 'sha256'] }); assets.createIndex('sha256', 'sha256');
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const existing = { projectId: 'A', storageVersion: 7, name: 'v2 project', updatedAt: 12, draft: { mapJson: json } };
    await new Promise<void>((resolve, reject) => {
      const tx = old.transaction(['projects', 'editorStates', 'assetBlobs'], 'readwrite');
      tx.objectStore('projects').put(existing); tx.objectStore('editorStates').put({ camera: { offsetX: 1, offsetY: 2, scale: 3 } }, 'A');
      tx.objectStore('assetBlobs').put({ projectId: 'A', sha256: 'a'.repeat(64), bytes: new Uint8Array([11, 22, 33]).buffer });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    old.close();
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle(name, { create: true });
    const store = new IndexedDBProjectStore(name);
    for (const id of ['A', 'B']) {
      const folder = await directory.getDirectoryHandle(id, { create: true }), handle = await folder.getFileHandle('map.json', { create: true });
      const stream = await handle.createWritable(); await stream.write(json); await stream.close();
      const local = new LocalFileController({ showOpenFilePicker: async () => [handle] });
      const candidate = await local.open(); if (candidate.status !== 'opened') throw new Error(candidate.message);
      local.acceptOpen(candidate.token); await store.writeLocalFileBinding(id, local.exportBinding());
    }
    const before = await store.get('A'), view = await store.readEditorState('A');
    await store.close(); return { before, view };
  }, { json, name });

  await page.reload();
  const restored = await page.evaluate(async ({ name }) => {
    const projectPath = '/src/adapters/projectStore.ts', localPath = '/src/adapters/localFiles.ts', modelPath = '/src/domain/load.ts';
    const { IndexedDBProjectStore } = await import(projectPath), { LocalFileController } = await import(localPath), { loadMap } = await import(modelPath);
    const store = new IndexedDBProjectStore(name), a = await store.readLocalFileBinding('A'), b = await store.readLocalFileBinding('B');
    const before = await a.handle.getFile(), loaded = loadMap(await before.text());
    if (!loaded.ok) throw new Error('fixture load failed');
    const root = await navigator.storage.getDirectory(), directory = await root.getDirectoryHandle(name);
    const original = await (await directory.getDirectoryHandle('A')).getFileHandle('map.json');
    const sameIdentity = await a.handle.isSameEntry(original), differentIdentity = !await a.handle.isSameEntry(b.handle);
    const local = new LocalFileController({}), state = local.restoreBinding(a);
    loaded.map.metadata.name = 'SV01 restored save to original handle';
    const result = await local.write(loaded.map);
    if (result.status !== 'saved') throw new Error(result.message);
    await store.writeLocalFileBinding('A', local.exportBinding());
    const current = await (await original.getFile()).text(), other = await (await b.handle.getFile()).text();
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const asset = await new Promise<number[]>((resolve, reject) => { const tx = db.transaction('assetBlobs'), r = tx.objectStore('assetBlobs').get(['A', 'a'.repeat(64)]); tx.oncomplete = () => resolve([...new Uint8Array(r.result.bytes)]); tx.onabort = () => reject(tx.error); });
    const record = await store.get('A'), version = db.version; db.close(); await store.close();
    return { state, result, current, other, sameIdentity, differentIdentity, record, version, asset };
  }, { name });
  expect(restored.version).toBe(3); expect(restored.record).toEqual(prepared.before);
  expect(prepared.view.camera).toEqual({ offsetX: 1, offsetY: 2, scale: 3 }); expect(restored.asset).toEqual([11, 22, 33]);
  expect(restored.sameIdentity).toBe(true); expect(restored.differentIdentity).toBe(true); expect(restored.state.status).toBe('linked');
  expect(JSON.parse(restored.current).metadata.name).toBe('SV01 restored save to original handle'); expect(restored.other).toBe(json);

  await page.reload();
  const conflict = await page.evaluate(async name => {
    const projectPath = '/src/adapters/projectStore.ts', localPath = '/src/adapters/localFiles.ts', modelPath = '/src/domain/load.ts';
    const { IndexedDBProjectStore } = await import(projectPath), { LocalFileController } = await import(localPath), { loadMap } = await import(modelPath);
    const store = new IndexedDBProjectStore(name), binding = await store.readLocalFileBinding('A'), local = new LocalFileController({});
    local.restoreBinding(binding);
    const bytes = await (await binding.handle.getFile()).text(), loaded = loadMap(bytes);
    if (!loaded.ok) throw new Error('fixture load failed');
    const writable = await binding.handle.createWritable(); await writable.write(bytes + '\n'); await writable.close();
    const result = await local.write(loaded.map), unchanged = await (await binding.handle.getFile()).text() === bytes + '\n';
    let invalid = '';
    try { await store.writeLocalFileBinding('A', { ...binding, rawHash: 'invalid' }); } catch (e) { invalid = (e as { code: string }).code; }
    const preserved = await store.readLocalFileBinding('A');
    await store.close();
    // Only this test's unique OPFS directory; no user filesystem entry is accessible here.
    await (await navigator.storage.getDirectory()).removeEntry(name, { recursive: true });
    return { status: result.status, unchanged, invalid, baselinePreserved: preserved.rawHash === binding.rawHash };
  }, name);
  expect(conflict).toEqual({ status: 'conflict', unchanged: true, invalid: 'LOCAL_FILE_BINDING_INVALID', baselinePreserved: true });
});
