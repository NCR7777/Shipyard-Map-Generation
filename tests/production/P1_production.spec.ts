import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Vec3, Polygon, YardMap } from '../../src/domain/model';
import type { StoredProject } from '../../src/editor/projectController';
import { P1_TARGETS, P1_COLLECTIONS, readP1Target } from '../helpers/P1_targets';

const targets = P1_TARGETS.filter(target => target.family === 'SR03');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const painted = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function project(page: Page): Promise<StoredProject | undefined> {
  return page.evaluate(() => new Promise<StoredProject | undefined>((resolve, reject) => {
    const open = indexedDB.open('shipyard-map-projects', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result; const tx = db.transaction('projects', 'readonly');
      const request = tx.objectStore('projects').get(sessionStorage.getItem('shipyard.activeProjectId')!);
      tx.oncomplete = () => { db.close(); resolve(request.result as StoredProject); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function save(page: Page) {
  const before = await project(page); const hash = (await page.getByTestId('map-hash').textContent())!;
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(async () => {
    const current = await project(page);
    return !!current && current.storageVersion > (before?.storageVersion ?? 0) && current.checkpoint?.contentHash === hash;
  }, { timeout: 60000, intervals: [50, 100] }).toBe(true);
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 60000 });
  const result = await project(page);
  if (!result?.checkpoint) throw new Error('Missing confirmed checkpoint');
  return { projectId: result.projectId, storageVersion: result.storageVersion,
    contentHash: result.checkpoint!.contentHash, savedAt: result.checkpoint!.savedAt, kind: 'checkpoint' };
}
async function download(page: Page, info: TestInfo, name: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name); await (await event).saveAs(path);
  const bytes = await readFile(path); const map = JSON.parse(bytes.toString('utf8')) as YardMap;
  return { path, map, sha256: sha(bytes), contentHash: (await page.getByTestId('map-hash').textContent())! };
}
async function startProbe(page: Page) {
  // Native browser instrumentation only; no application or Konva state is read/written.
  await page.evaluate(() => {
    const data = { frames: [] as number[], longTasks: [] as number[], pointerMoves: 0 };
    let previous = performance.now(); let frame = 0;
    const observeFrame = (now: number) => { data.frames.push(now - previous); previous = now; frame = requestAnimationFrame(observeFrame); };
    frame = requestAnimationFrame(observeFrame);
    const observer = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: 'longtask' });
    const pointer = () => { data.pointerMoves++; }; window.addEventListener('pointermove', pointer);
    Object.assign(window, { __p1ProductionProbe: () => {
      cancelAnimationFrame(frame); observer.disconnect(); window.removeEventListener('pointermove', pointer); return data;
    } });
  });
}
async function measured<T>(page: Page, action: () => Promise<T>) {
  const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
  const before = (await cdp.send('Performance.getMetrics')).metrics;
  await startProbe(page); const start = performance.now(); const value = await action(); await painted(page);
  const elapsedMs = performance.now() - start;
  const probe = await page.evaluate(() => (window as unknown as { __p1ProductionProbe: () => { frames: number[]; longTasks: number[]; pointerMoves: number } }).__p1ProductionProbe());
  const after = (await cdp.send('Performance.getMetrics')).metrics; await cdp.detach();
  const metric = (values: typeof before, name: string) => values.find(item => item.name === name)?.value ?? 0;
  const durations = Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name + 'Ms', (metric(after, name) - metric(before, name)) * 1000]));
  return { value, measurement: { elapsedMs, ...durations, frameCount: probe.frames.length,
    maxFrameGapMs: Math.max(0, ...probe.frames), framesOver50Ms: probe.frames.filter(ms => ms > 50).length,
    longTasks: probe.longTasks, pointerMoves: probe.pointerMoves, jsHeapUsedBytes: metric(after, 'JSHeapUsedSize') } };
}
async function screen(page: Page, point: Vec3) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas missing');
  const camera = page.getByTestId('camera-state'); const scale = Number(await camera.getAttribute('data-scale'));
  return { x: box.x + Number(await camera.getAttribute('data-offset-x')) + point[0] * scale,
    y: box.y + Number(await camera.getAttribute('data-offset-y')) - point[1] * scale };
}
async function drag100(page: Page, from: Vec3, to: Vec3) {
  const hash = (await page.getByTestId('map-hash').textContent())!;
  const a = await screen(page, from); const b = await screen(page, to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 100 });
  await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await page.mouse.up();
  await expect(page.getByTestId('map-hash')).not.toHaveText(hash, { timeout: 60000 });
}
async function choose(page: Page, kind: 'facilities' | 'zones', id: string) {
  await page.getByTestId('object-search').fill(id); await page.getByTestId(kind + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(id);
  await page.getByLabel(kind === 'facilities' ? '设施移动策略' : '区域移动策略', { exact: true }).selectOption('withStaticContents');
  await page.getByLabel('网格吸附', { exact: true }).selectOption('1');
}
function translated(original: YardMap, kind: 'facilities' | 'zones', id: string, nodes: string[], delta: Vec3) {
  const after = structuredClone(original); after.revision++;
  const move = ([x,y,z]: Vec3): Vec3 => [x+delta[0],y+delta[1],z+delta[2]];
  const polygon = (p: Polygon): Polygon => ({ outer: p.outer.map(move) as Polygon['outer'], holes: p.holes.map(ring => ring.map(move) as Polygon['outer']) });
  after[kind][id]!.boundary = polygon(after[kind][id]!.boundary);
  const slots = (after[kind][id]!.extensions!['sr02.planning'] as { slots: { boundary: Polygon }[] }).slots;
  for (const slot of slots) slot.boundary = polygon(slot.boundary);
  for (const node of nodes) after.nodes[node]!.position = move(after.nodes[node]!.position);
  for (const junction of Object.values(after.junctions)) if (junction.boundary && junction.nodeIds.every(node => nodes.includes(node))) junction.boundary = polygon(junction.boundary);
  return after;
}
async function writeEvidence(info: TestInfo, data: object) {
  const path = info.outputPath('evidence.json'); await writeFile(path, JSON.stringify(data, null, 2) + '\n');
  await info.attach('production-evidence', { path, contentType: 'application/json' });
}

for (const target of targets) {
  test(`P1 production ${target.id}: frozen original, current screenshot, checkpoint and lossless reload`, async ({ page, browser }, info) => {
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const original = await readP1Target(target);
    await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
    const scripts = await page.locator('script[src]').evaluateAll(nodes => nodes.map(node => (node as HTMLScriptElement).getAttribute('src')));
    expect(scripts).toHaveLength(1); expect(scripts[0]).toMatch(/^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
    const loadedBundleSha256 = sha(await (await page.request.get(scripts[0]!)).body());
    const outDir = process.env.P1_PRODUCTION_BASELINE === '1' ? '.cache/P2A/p1-evidence/dist' : 'dist';
    expect(loadedBundleSha256).toBe(sha(await readFile(resolve(outDir, scripts[0]!.slice(1)))));
    const imported = await measured(page, async () => {
      await page.getByTestId('json-file-input').setInputFiles(target.absolutePath);
      await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(original.map.metadata.name, { timeout: 60000 });
      await expect(page.getByTestId('scene-count-slots')).toHaveText(String(target.counts[12]), { timeout: 60000 });
      await page.getByRole('button', { name: '适应地图', exact: true }).click();
    });
    for (const [index, kind] of P1_COLLECTIONS.entries()) await expect(page.getByTestId('scene-count-' + kind)).toHaveText(String(target.counts[index]));
    await expect(page.getByTestId('issue-panel')).toContainText('0 错误');
    await expect(page.getByLabel('地图名称', { exact: true })).toBeEnabled();
    const hash = (await page.getByTestId('map-hash').textContent())!; expect(hash).toMatch(/^[a-f0-9]{64}$/);
    const screenshot = info.outputPath(target.id + '-P1-production.png'); await page.screenshot({ path: screenshot });
    const checkpoint = await measured(page, () => save(page));
    const exported = await download(page, info, target.id + '-P1-production.map.json'); expect(exported.map).toEqual(original.map);
    await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(hash, { timeout: 60000 });
    expect((await download(page, info, target.id + '-recovered.map.json')).map).toEqual(original.map);
    let largestMapInteraction: object | undefined;
    if (target.yard === 'D') {
      const search = await measured(page, async () => {
        await page.getByTestId('object-search').fill('F_001');
        await expect(page.getByTestId('facilities-item-F_001')).toBeVisible();
        await expect(page.getByTestId('facilities-item-F_002')).toHaveCount(0);
      });
      await choose(page, 'facilities', 'F_001');
      await page.getByRole('button', { name: '定位 F_001', exact: true }).click(); await painted(page);
      const camera = await page.getByTestId('camera-state').evaluate(node => ({ scale: node.getAttribute('data-scale'), x: node.getAttribute('data-offset-x'), y: node.getAttribute('data-offset-y') }));
      const profiler = process.env.P1_PRODUCTION_PROFILE === '1' ? await page.context().newCDPSession(page) : null;
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.setSamplingInterval', { interval: 1000 }); await profiler.send('Profiler.start'); }
      const drag = await measured(page, () => drag100(page, [175,327,0], [185,332,0]));
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop');
        await writeFile(info.outputPath('SR03_D-drag.cpuprofile'), JSON.stringify(profile)); await profiler.detach();
      }
      const moved = await download(page, info, 'SR03_D-F001-moved.map.json');
      expect(moved.map).toEqual(translated(original.map, 'facilities', 'F_001', ['N_0016','N_0017','N_0018'], [10,5,0]));
      const movedCheckpoint = await measured(page, () => save(page));
      await page.getByRole('button', { name: '撤销', exact: true }).click();
      expect((await download(page, info, 'SR03_D-F001-undo.map.json')).map).toEqual(original.map);
      await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
      largestMapInteraction = { search: search.measurement, drag100Frames: drag.measurement,
        dragCamera: camera, dragView: 'F_001 fitted by the real locate button; complete map remains loaded',
        saveMoved: movedCheckpoint.measurement, receipt: movedCheckpoint.value, beforeHash: hash, afterHash: moved.contentHash };
    }
    expect(errors).toEqual([]); await readP1Target(target);
    await writeEvidence(info, { target: target.id, inputSha256: target.sha256, sourcePath: target.path,
      counts: target.counts, mapContentHash: hash, screenshot, exportedSha256: exported.sha256, receipt: checkpoint.value,
      timings: { importAndFit: imported.measurement, saveOriginal: checkpoint.measurement }, largestMapInteraction,
      buildBundleSha256: loadedBundleSha256, browser: browser.version(), platform: platform(), release: release(), cpu: cpus()[0]?.model,
      logicalCpuCount: cpus().length, totalMemoryBytes: totalmem(), viewport: page.viewportSize(), status: 'PASS',
      interpretation: 'One observed run per map in isolated headless Chrome, production build. Times include Playwright input/wait, double animation frame and save polling overhead; no fixed performance guarantee. Drag uses 100 native move steps, not 100 guaranteed rendered frames. Native Long Task/RAF/CDP metrics do not identify JavaScript functions.' });
  });
}

for (const owner of [
  { kind: 'facilities' as const, id: 'F_001', from: [78,180,0] as Vec3, to: [88,185,0] as Vec3, delta: [10,5,0] as Vec3, nodes: ['N_0012','N_0013','N_0014'] },
  { kind: 'zones' as const, id: 'Z_005', from: [459,94,0] as Vec3, to: [449,99,0] as Vec3, delta: [-10,5,0] as Vec3, nodes: ['N_0031','N_0032','N_0033','N_0035','N_0036','N_0037','N_0038','N_0039'] },
]) {
  test(`P1 production ${owner.id}: real static-contents edit, before/after hashes, checkpoint and reload`, async ({ page }, info) => {
    const target = targets[0]!; const original = await readP1Target(target);
    await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
    await page.getByTestId('json-file-input').setInputFiles(target.absolutePath);
    await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(original.map.metadata.name, { timeout: 60000 });
    await page.getByRole('button', { name: '适应地图', exact: true }).click();
    await choose(page, owner.kind, owner.id);
    const before = await download(page, info, owner.id + '-before.map.json'); expect(before.map).toEqual(original.map);
    await drag100(page, owner.from, owner.to);
    const after = await download(page, info, owner.id + '-after.map.json');
    expect(after.map).toEqual(translated(before.map, owner.kind, owner.id, owner.nodes, owner.delta));
    expect(after.contentHash).not.toBe(before.contentHash);
    const screenshot = info.outputPath(owner.id + '-after.png'); await page.screenshot({ path: screenshot });
    const receipt = await save(page); await page.reload();
    await expect(page.getByTestId('map-hash')).toHaveText(after.contentHash, { timeout: 60000 });
    expect((await download(page, info, owner.id + '-recovered.map.json')).map).toEqual(after.map);
    await readP1Target(target);
    await writeEvidence(info, { target: target.id, owner: { kind: owner.kind, id: owner.id }, inputSha256: target.sha256,
      before: { file: before.path, mapContentHash: before.contentHash, fileSha256: before.sha256 },
      after: { file: after.path, mapContentHash: after.contentHash, fileSha256: after.sha256 },
      receipt, screenshot, status: 'PASS', scope: 'One rigid translation with declared slots/nodes/junctions, resources and unrelated fields deeply equal; original unchanged' });
  });
}
