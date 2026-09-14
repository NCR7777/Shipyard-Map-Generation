import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
const fixture = async (name: string) => [...await readFile(new URL('../fixtures/BG01/' + name, import.meta.url))];

test('BG01 real IndexedDB v1 upgrade preserves project/view and stores verified immutable raster bytes across project reimport', async ({ page }) => {
  await page.goto('/');
  const png = await fixture('small.png');
  const result = await page.evaluate(async bytes => {
    const storePath = '/src/adapters/projectStore.ts', rasterPath = '/src/adapters/rasterFiles.ts';
    const { IndexedDBProjectStore } = await import(storePath), { rasterBytes, decodeRaster } = await import(rasterPath);
    const name = 'BG01-migration-' + crypto.randomUUID();
    const old = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore('projects', { keyPath: 'projectId' }); request.result.createObjectStore('metadata'); request.result.createObjectStore('editorStates'); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const project = { projectId: 'A', storageVersion: 7, name: 'existing', updatedAt: 1, draft: { mapJson: 'untouched' } };
    await new Promise<void>((resolve, reject) => { const tx = old.transaction(['projects', 'editorStates'], 'readwrite'); tx.objectStore('projects').put(project); tx.objectStore('editorStates').put({ camera: { offsetX: 2, offsetY: 3, scale: 1 } }, 'A'); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    old.onversionchange = () => old.close();
    const store = new IndexedDBProjectStore(name), asset = await rasterBytes(Uint8Array.from(bytes).buffer);
    const before = await store.get('A');
    await store.putAssetBytes('A', asset); const restored = await store.getAssetBytes('A', asset.sha256);
    const decoded = await decodeRaster(restored); const dimensions = [decoded.image.naturalWidth, decoded.image.naturalHeight]; decoded.dispose();
    const shared = await store.getAssetBytes('B', asset.sha256);
    const missing = await store.getAssetBytes('B', '0'.repeat(64));
    let badHash = ''; try { await store.putAssetBytes('A', { ...asset, sha256: '0'.repeat(64) }); } catch (e) { badHash = (e as { code: string }).code; }
    const after = await store.get('A'), view = await store.readEditorState('A');
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const records = await new Promise<IDBValidKey[]>((resolve, reject) => { const tx = db.transaction('assetBlobs'); const request = tx.objectStore('assetBlobs').getAllKeys(); tx.oncomplete = () => resolve(request.result); tx.onabort = () => reject(tx.error); });
    const version = db.version; db.close(); await store.close();
    return { before, after, view, version, records, sameBytes: String(new Uint8Array(shared.bytes)) === String(new Uint8Array(asset.bytes)), dimensions, missing, badHash };
  }, png);
  expect(result.version).toBe(3); expect(result.before).toEqual(result.after); expect(result.after.draft.mapJson).toBe('untouched');
  expect(result.view.camera).toEqual({ offsetX: 2, offsetY: 3, scale: 1 }); expect(result.records).toHaveLength(2);
  expect(result.sameBytes).toBe(true); expect(result.dimensions).toEqual([3, 2]); expect(result.missing).toBeNull(); expect(result.badHash).toBe('ASSET_HASH_MISMATCH');
});

test('BG01 corrupt stored image and aborted quota transaction do not report successful persistence', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    const sp = '/src/adapters/projectStore.ts', rp = '/src/adapters/rasterFiles.ts';
    const { IndexedDBProjectStore } = await import(sp), { rasterBytes } = await import(rp);
    const name = 'BG01-abort-' + crypto.randomUUID(), store = new IndexedDBProjectStore(name), asset = await rasterBytes(Uint8Array.from(bytes).buffer);
    await store.putAssetBytes('A', asset);
    const original = IDBObjectStore.prototype.put;
    let quota = '';
    try {
      IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) { if (this.name === 'assetBlobs') throw new DOMException('test quota', 'QuotaExceededError'); return original.apply(this, args); };
      await store.putAssetBytes('B', asset);
    } catch (error) { quota = (error as { code: string }).code; } finally { IDBObjectStore.prototype.put = original; }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    const ownB = await new Promise<unknown>((resolve, reject) => { const tx = db.transaction('assetBlobs'); const r = tx.objectStore('assetBlobs').get(['B', asset.sha256]); tx.oncomplete = () => resolve(r.result ?? null); tx.onabort = () => reject(tx.error); });
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('assetBlobs', 'readwrite'); const bad = asset.bytes.slice(0); new Uint8Array(bad)[20] = 1; tx.objectStore('assetBlobs').put({ ...asset, projectId: 'A', bytes: bad }); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    let corrupt = ''; try { await store.getAssetBytes('A', asset.sha256); } catch (error) { corrupt = (error as { code: string }).code; }
    db.close(); await store.close(); return { quota, ownB, corrupt };
  }, await fixture('small.png'));
  expect(result.quota).toBe('PROJECT_STORAGE_QUOTA'); expect(result.ownB).toBeNull(); expect(result.corrupt).not.toBe('');
});

test('BG01 supported byte types really decode; EXIF rotation is rejected and decoder failure releases URL', async ({ page }) => {
  await page.goto('/');
  const inputs = await Promise.all(['small.png', 'small.jpg', 'small.webp', 'rotated-exif.jpg'].map(fixture));
  const results = await page.evaluate(async inputs => {
    const path = '/src/adapters/rasterFiles.ts'; const api = await import(path); const result = [];
    for (const bytes of inputs) {
      try { const asset = await api.rasterBytes(Uint8Array.from(bytes).buffer), decoded = await api.decodeRaster(asset); result.push([decoded.image.naturalWidth, decoded.image.naturalHeight]); decoded.dispose(); }
      catch (e) { result.push((e as { code: string }).code); }
    }
    let created = 0, revoked = 0; const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = blob => { created++; return create(blob); }; URL.revokeObjectURL = url => { revoked++; revoke(url); };
    const decode = HTMLImageElement.prototype.decode;
    try {
      const asset = await api.rasterBytes(Uint8Array.from(inputs[0]!).buffer);
      HTMLImageElement.prototype.decode = () => Promise.reject(new DOMException('decoder rejected image', 'EncodingError'));
      try { await api.decodeRaster(asset); result.push('unexpected decode'); } catch (e) { result.push((e as { code: string }).code); }
    } finally { HTMLImageElement.prototype.decode = decode; URL.createObjectURL = create; URL.revokeObjectURL = revoke; }
    return { result, created, revoked };
  }, inputs);
  expect(results.result.slice(0, 3)).toEqual([[3, 2], [3, 2], [3, 2]]); expect(results.result[3]).toBe('RASTER_EXIF_ORIENTATION');
  expect(results.result[4]).toBe('RASTER_DECODE_FAILED'); expect(results.created).toBe(1); expect(results.revoked).toBe(1);
});

test('BG01 hook ignores late A images after B switch, reuses decoded bytes across view renders and revokes on unmount', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    const path = '/tests/helpers/BG01_hookHarness.ts'; const { exerciseBackgroundHook } = await import(path);
    return exerciseBackgroundHook(bytes, 'load');
  }, await fixture('small.png'));
  expect(result.afterLate).toEqual([['B', 'ready']]); expect(result.afterRender).toEqual(result.beforeRender);
  expect(result.created).toBe(1); expect(result.revoked).toBe(1);
});

test('BG01 late persistence cannot authorize an add after project switch and releases temporary image', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async bytes => {
    const path = '/tests/helpers/BG01_hookHarness.ts'; const { exerciseBackgroundHook } = await import(path);
    return exerciseBackgroundHook(bytes, 'persist');
  }, await fixture('small.png'));
  expect(result.code).toBe('RASTER_STALE_PROJECT'); expect(result.created).toBe(1); expect(result.revoked).toBe(1);
});