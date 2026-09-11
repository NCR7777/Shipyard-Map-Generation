/* global setTimeout, fetch, performance, requestAnimationFrame, cancelAnimationFrame, PerformanceObserver, MutationObserver, document, window, navigator, devicePixelRatio, screen, indexedDB, sessionStorage */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { installLifecycleProbe } from './DP-lifecycle-probe.mjs';

// Production browser measurements only. No domain state is injected or changed.
const { values } = parseArgs({ options: {
  'screen-anchor': { type: 'string' }, output: { type: 'string' }, dist: { type: 'string' }, 'data-root': { type: 'string' },
  modes: { type: 'string', default: 'on,off' }, rounds: { type: 'string', default: '5' },
  'warmup-rounds': { type: 'string', default: '1' }, 'refresh-rate': { type: 'string', default: '60' },
  port: { type: 'string', default: '4183' }, kinds: { type: 'string', default: 'zoom_in,zoom_out,pan' }, profile: { type: 'boolean', default: false }, 'screens-only': { type: 'boolean', default: false }, 'stress-only': { type: 'boolean', default: false },
} });
const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(values['data-root'] ?? process.env.SHIPYARD_TEST_DATA_ROOT ?? path.join(editor, '../..'));
const input = path.join(root, 'projects/SHI_Geoje_Research_Map_v03/map.json');
const frozenSha = 'df1d7c6ec5148ef237e9a5ffa8e2b064e984a397e3799bf44f8f2c3117eaaa5a';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
let inputBytes;
try { inputBytes = fs.readFileSync(input); } catch (error) { throw new Error('blocked_input: frozen SHI v03 map unavailable at ' + input, { cause: error }); }
if (hash(inputBytes) !== frozenSha) throw new Error('blocked_input: SHI v03 original SHA differs; do not substitute another map');
if (!values.output || !values.dist) throw new Error('--output and --dist are required');
const dir = path.resolve(values.output), dist = path.resolve(values.dist);
if (fs.existsSync(dir)) throw new Error('Evidence directory already exists; refusing to overwrite: ' + dir);
if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('Production build index.html is missing');
const modes = values.modes.split(','), kinds = values.kinds.split(',');
if (kinds.some(kind => !['zoom_in', 'zoom_out', 'pan'].includes(kind))) throw new Error('Unsupported trajectory kind');
if (modes.some(mode => !['on', 'off', 'auto', 'focus'].includes(mode))) throw new Error('Unsupported label mode');
const rounds = Number(values.rounds), warmups = Number(values['warmup-rounds']), refreshRate = Number(values['refresh-rate']);
if (![rounds, warmups].every(n => Number.isInteger(n) && n >= 0) || rounds < 1 || !Number.isFinite(refreshRate) || refreshRate < 0) throw new Error('Invalid rounds/refresh rate');
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(dir, 'executed-runner.mjs'), fs.constants.COPYFILE_EXCL);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (a, p) => a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) * p)] ?? null;
const measurementManifestPath = path.join(dist, 'measurement-build.json');
const measurementBuild = fs.existsSync(measurementManifestPath) ? JSON.parse(fs.readFileSync(measurementManifestPath)) : null;
const output = {
  kind: values['stress-only'] ? 'A21_NAVIGATION_PROJECT_LIFECYCLE' : values['screens-only'] ? 'THREE_SCALE_SCREEN_CAPTURE' : values.profile ? 'INSTRUMENTED_PROFILE_SEPARATE_FROM_TIMING' : measurementBuild?.kind ?? 'UNINSTRUMENTED_PRODUCTION_NAVIGATION', measurementBuild,
  command: [process.execPath, ...process.argv.slice(1)], input, inputSha256: frozenSha, dist,
  runnerSha256: hash(fs.readFileSync(fileURLToPath(import.meta.url))),
  lifecycleProbeSha256: values['stress-only'] ? hash(fs.readFileSync(path.join(editor, 'scripts/DP-lifecycle-probe.mjs'))) : null,
  sourceTrajectory: '.cache/DP0-plan-1789134072182/executed-command.ps1',
  trajectory: { durationMs: 10000, wheelCount: 30, wheelDelta: 120, panCount: 600, panRadiusX: 110, panRadiusY: 45 },
  requestedRefreshHz: refreshRate || 'native', rounds: [],
  environment: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), node: process.version },
  limitations: ['RAF intervals are browser scheduling observations, not physical presentation.', 'DOM camera updates do not prove Konva draw completion.', 'CDP CPU sampling is not a React commit profiler.', 'Input dispatch and received timestamps are retained; input counts are not frame counts.', 'Measurement builds retain 400 ms after the timed trajectory to observe settle draws; navigation metrics exclude that tail.', 'The fake-vsync-rate switch controls the browser VSync source; physical display settings stay unchanged.'],
};
let server, browser, logs = '';
try {
  server = spawn(process.execPath, [path.join(editor, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', values.port, '--strictPort', '--outDir', dist], { cwd: editor, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  const url = 'http://127.0.0.1:' + values.port;
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Startup polling only. */ }
    if (server.exitCode !== null) throw new Error(logs);
    await pause(100);
  }
  if (!ready) throw new Error('Production server did not become ready');
  const args = refreshRate ? ['--fake-vsync-rate=' + refreshRate] : [];
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true, args });
  output.browser = browser.version(); output.browserArgs = args;
  const browserCdp = await browser.newBrowserCDPSession();
  try { output.gpu = (await browserCdp.send('SystemInfo.getInfo')).gpu; } catch (error) { output.gpuUnavailable = String(error); }
  await browserCdp.detach();
  const context = await browser.newContext({ baseURL: url, viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  if (values['stress-only']) await context.addInitScript(installLifecycleProbe);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  output.idleRaf = await page.evaluate(() => new Promise(resolve => {
    const times = []; let start;
    function tick(t) { start ??= t; times.push(t); if (t - start < 3000) requestAnimationFrame(tick); else resolve(times); }
    requestAnimationFrame(tick);
  }));
  const idleIntervals = output.idleRaf.slice(1).map((t, i) => t - output.idleRaf[i]);
  output.idleRafSummary = { p50: quantile(idleIntervals, .5), p95: quantile(idleIntervals, .95), count: idleIntervals.length };
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByTestId('json-file-input').setInputFiles(input);
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(JSON.parse(inputBytes).metadata.name, { timeout: 60000 });
  await expect(page.getByTestId('scene-count-slots')).toHaveText('1108');
  await page.getByRole('button', { name: '适应地图', exact: true }).click(); await pause(1200);
  output.hash = await page.getByTestId('map-hash').textContent();
  const editorInvariant = async () => ({ document: await page.locator('.document-meta').textContent(), history: await page.locator('.canvas-status span:last-child').textContent(), undoDisabled: await page.getByRole('button', { name: '撤销', exact: true }).isDisabled(), redoDisabled: await page.getByRole('button', { name: '重做', exact: true }).isDisabled() });
  output.initialEditorInvariant = await editorInvariant();
  output.script = await page.locator('script[src]').getAttribute('src');
  output.bundleSha256 = hash(await (await page.request.get(output.script)).body());
  const builtScript = path.join(dist, output.script.replace(/^\//, ''));
  if (hash(fs.readFileSync(builtScript)) !== output.bundleSha256) throw new Error('Served production bundle differs from frozen build');
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas has no bounds');
  output.canvas = box; output.viewport = page.viewportSize();
  Object.assign(output.environment, await page.evaluate(() => ({ dpr: devicePixelRatio, performanceTimeOrigin: performance.timeOrigin, ua: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency, screen: { width: screen.width, height: screen.height } })));
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  console.log(JSON.stringify({ stage: 'READY', dir, bundle: output.bundleSha256, idleRaf: output.idleRafSummary, canvas: box }));

  async function probe(kind, warmup, round, labels) {
    await page.evaluate(() => {
      const data = { frameTimes: [], frames: [], longTasks: [], inputs: [], cameraMutations: [] }; let previous = null, raf;
      const tick = t => { data.frameTimes.push(t); if (previous !== null) data.frames.push(t - previous); previous = t; raf = requestAnimationFrame(tick); };
      raf = requestAnimationFrame(tick);
      const po = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, duration: entry.duration })))); po.observe({ type: 'longtask' });
      const camera = document.querySelector('[data-testid="camera-state"]');
      const mo = new MutationObserver(() => data.cameraMutations.push({ t: performance.now(), camera: camera.textContent })); mo.observe(camera, { attributes: true });
      const input = event => data.inputs.push({ type: event.type, t: performance.now(), eventTimeStamp: event.timeStamp, x: event.clientX, y: event.clientY, dy: event.deltaY ?? null, buttons: event.buttons ?? 0 });
      window.addEventListener('wheel', input, { passive: true }); window.addEventListener('pointermove', input);
      window.__stopDP = () => { cancelAnimationFrame(raf); po.disconnect(); mo.disconnect(); window.removeEventListener('wheel', input); window.removeEventListener('pointermove', input); return data; };
      window.__DPMeasurement?.reset?.();
    });
    if (values.profile && !warmup) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start'); }
    const before = (await cdp.send('Performance.getMetrics')).metrics, sent = [], x = box.x + box.width / 2, y = box.y + box.height / 2;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (kind === 'pan') await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'middle', buttons: 4, clickCount: 1 });
    const count = kind === 'pan' ? 600 : 30, start = performance.now(), browserStart = await page.evaluate(() => performance.now()), pending = [];
    for (let i = 0; i < count; i++) {
      const planned = i * 10000 / count; await pause(Math.max(0, start + planned - performance.now()));
      const angle = i / (count - 1) * Math.PI * 2;
      const event = kind === 'pan' ? { type: 'mouseMoved', x: x + Math.sin(angle) * 110, y: y + (1 - Math.cos(angle)) * 45, button: 'middle', buttons: 4 } : { type: 'mouseWheel', x, y, deltaX: 0, deltaY: kind === 'zoom_in' ? -120 : 120 };
      const record = { plannedMs: planned, sentMs: performance.now() - start, ...event }; sent.push(record);
      pending.push(cdp.send('Input.dispatchMouseEvent', event).then(() => { record.ackMs = performance.now() - start; }));
    }
    await Promise.all(pending); while (performance.now() - start < 10000) await pause(Math.max(1, start + 10000 - performance.now()));
    if (kind === 'pan') await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'middle', buttons: 0, clickCount: 1 });
    const durationMs = performance.now() - start, raw = await page.evaluate(() => window.__stopDP());
    if (values.profile && !warmup) { const result = await cdp.send('Profiler.stop'); fs.writeFileSync(path.join(dir, `${labels}-${round}-${kind}.cpuprofile`), JSON.stringify(result.profile)); await cdp.send('Profiler.disable'); }
    const navigationEndMetrics = (await cdp.send('Performance.getMetrics')).metrics;
    if (measurementBuild) await pause(400);
    const instrumentation = await page.evaluate(() => window.__DPMeasurement?.snapshot?.() ?? null);
    const after = navigationEndMetrics, metric = (list, name) => list.find(item => item.name === name)?.value ?? 0;
    const item = { kind, warmup, round, labels, durationMs, frameCount: raw.frames.length, maxRafGapMs: raw.frames.length ? Math.max(...raw.frames) : null, rafP50: quantile(raw.frames, .5), rafP95: quantile(raw.frames, .95), over50: raw.frames.filter(value => value > 50).length, over100: raw.frames.filter(value => value > 100).length, cameraUpdates: raw.cameraMutations.length, receivedEvents: raw.inputs.length, requested: count, ...Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map(name => [name + 'Ms', 1000 * (metric(after, name) - metric(before, name))])), heap: metric(after, 'JSHeapUsedSize'), camera: await page.getByTestId('camera-state').textContent() };
    if (instrumentation) {
      const associations = instrumentation.inputLatencies ?? [], finite = key => associations.map(input => input[key]).filter(Number.isFinite);
      const eventLatencies = finite('eventLatencyMs'), receiptLatencies = finite('receiptLatencyMs');
      const restores = instrumentation.restores ?? [], restoreLatencies = restores.map(restore => restore.latencyMs).filter(Number.isFinite);
      item.draw = { validNativeInputs: instrumentation.inputs.filter(input => input.valid).length, effectiveInputs: associations.length, completedInputs: associations.filter(input => input.generation != null).length, incompleteInputs: associations.filter(input => input.generation == null).length, invalidEventClocks: associations.filter(input => !input.eventClockValid).length, eventP50: quantile(eventLatencies, .5), eventP95: quantile(eventLatencies, .95), receiptP50: quantile(receiptLatencies, .5), receiptP95: quantile(receiptLatencies, .95), restoreCount: restores.length, restoreIncomplete: restores.filter(restore => restore.latencyMs == null).length, restoreP95: quantile(restoreLatencies, .95), generationCount: instrumentation.cameraGenerations.length, generationCompleted: instrumentation.cameraGenerations.filter(frame => frame.allLayerDrawEnd != null).length };
    }
    fs.writeFileSync(path.join(dir, `${labels}-${warmup ? 'warmup-' : ''}${round}-${kind}.json`), JSON.stringify({ summary: item, raw, sent, browserStart, instrumentation }));
    output.rounds.push(item); console.log(JSON.stringify(item)); await pause(800);
  }
  await page.locator('.layer-controls summary').click();
  for (const labels of modes) {
    if (['on', 'off'].includes(labels)) await page.getByTestId('show-labels').setChecked(labels === 'on');
    else await page.getByTestId('label-mode').selectOption(labels);
    await pause(1000);
    for (let iteration = 0; !values['screens-only'] && !values['stress-only'] && iteration < rounds + warmups; iteration++) {
      const warmup = iteration < warmups, round = warmup ? iteration + 1 : iteration - warmups + 1;
      await page.getByRole('button', { name: '适应地图', exact: true }).click(); await pause(800);
      if (!warmup && round === 1) await page.screenshot({ path: path.join(dir, labels + '-overview.png') });
      for (const kind of kinds) {
        await probe(kind, warmup, round, labels);
        if (kind === 'zoom_in' && !warmup && round === 1) await page.screenshot({ path: path.join(dir, labels + '-local.png') });
      }
    }
    // Screenshots are deliberately outside timed trajectories.
    await page.getByRole('button', { name: '适应地图', exact: true }).click(); await pause(800);
    let anchor = null;
    if (values['screen-anchor']) {
      const [kind, id] = values['screen-anchor'].split('/'), map = JSON.parse(inputBytes);
      if (kind !== 'servicePoints' || !map.servicePoints[id]) throw new Error('Screen anchor must reference a declared service point');
      const point = map.nodes[map.servicePoints[id].nodeId].position, camera = JSON.parse(await page.getByTestId('camera-state').textContent());
      const from = { x: box.x + point[0] * camera.scale + camera.offsetX, y: box.y - point[1] * camera.scale + camera.offsetY }, to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      if (from.x < box.x || from.x > box.x + box.width || from.y < box.y || from.y > box.y + box.height) throw new Error('Screen anchor outside fit viewport');
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...from });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'middle', buttons: 4, clickCount: 1 });
      for (let step = 1; step <= 6; step++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6, button: 'middle', buttons: 4 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'middle', buttons: 0, clickCount: 1 }); await pause(800);
      const centered = JSON.parse(await page.getByTestId('camera-state').textContent());
      const screenOffset = { x: point[0] * centered.scale + centered.offsetX - box.width / 2, y: -point[1] * centered.scale + centered.offsetY - box.height / 2 };
      if (Math.hypot(screenOffset.x, screenOffset.y) > 2) throw new Error('Native middle drag did not center the declared service point');
      anchor = { key: values['screen-anchor'], worldPosition: point, from, to, centered, screenOffset, method: 'native middle drag from fit viewport, no camera injection' };
    }
    const captures = [];
    for (const scale of ['overview', 'sector', 'local']) {
      if (scale !== 'overview') {
        for (let i = 0; i < 15; i++) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x + box.width / 2, y: box.y + box.height / 2, deltaX: 0, deltaY: -120 });
        await pause(800);
      }
      const filename = labels + '-fixed-' + scale + '.png';
      await page.screenshot({ path: path.join(dir, filename) });
      captures.push({ scale, filename, camera: await page.getByTestId('camera-state').textContent(), canvas: box, ...(measurementBuild ? { labelAudit: await page.evaluate(() => window.__DPMeasurement.snapshot().labelAudit) } : {}) });
    }
    (output.screens ??= []).push({ labels, anchor, captures });
  }
  if (values['stress-only']) {
    const activeId = () => page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
    const originalProject = await activeId();
    await page.getByRole('button', { name: '浏览器另存为', exact: true }).click();
    await expect.poll(activeId, { timeout: 60000 }).not.toBe(originalProject);
    const copiedProject = await activeId();
    const records = [];
    async function record(kind, round) {
      await expect(page.getByTestId('map-hash')).toHaveText(output.hash);
      const metrics = (await cdp.send('Performance.getMetrics')).metrics;
      const state = await page.evaluate(() => {
        const m = window.__DPMeasurement?.snapshot?.();
        return { mounted: m?.mounted ?? null, display: { ...document.querySelector('[data-testid="display-state"]')?.dataset }, projectId: sessionStorage.getItem('shipyard.activeProjectId'), history: document.querySelector('.canvas-status span:last-child')?.textContent, lifecycle: window.__DPLifecycle?.snapshot?.() ?? null };
      });
      records.push({ kind, round, ...state, heap: metrics.find(item => item.name === 'JSHeapUsedSize')?.value });
    }
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.getByRole('button', { name: '适应地图', exact: true }).click(); await pause(500); await record('before', 0);
    for (let round = 1; round <= 20; round++) {
      await page.evaluate(() => window.__DPMeasurement?.reset?.());
      for (const deltaY of [-120, -120, -120, 120, 120, 120]) await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'middle', buttons: 4, clickCount: 1 });
      for (let step = 0; step < 12; step++) {
        const angle = step / 11 * Math.PI * 2;
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.sin(angle) * 30, y: y + (1 - Math.cos(angle)) * 15, button: 'middle', buttons: 4 });
        await pause(20);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'middle', buttons: 0, clickCount: 1 });
      await pause(400); await record('navigation', round);
    }
    for (let round = 1; round <= 5; round++) {
      const target = round % 2 ? originalProject : copiedProject;
      await page.evaluate(() => window.__DPMeasurement?.reset?.());
      await page.getByRole('button', { name: '最近项目', exact: true }).click();
      await page.getByTestId('project-item-' + target).click();
      await expect(page.getByRole('dialog', { name: '最近项目', exact: true })).not.toBeVisible({ timeout: 60000 });
      await expect.poll(activeId).toBe(target);
      await page.getByRole('button', { name: '适应地图', exact: true }).click(); await pause(500); await record('project-switch', round);
    }
    output.stress = { originalProject, copiedProject, records, limitations: ['Short stress trajectories are lifecycle checks, not the formal 10-second performance rounds.', 'JS heap fluctuates with GC; mounted objects and bounded text-cache sizes are recorded independently.', 'Probe arrays reset before each cycle so they do not create a false growing-memory trend.'] };
  }
  if (values.profile) {
    const storedVersion = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('shipyard-map-projects', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, read = db.transaction('projects', 'readonly').objectStore('projects').get(sessionStorage.getItem('shipyard.activeProjectId'));
        read.onsuccess = () => { const result = read.result; db.close(); resolve({ version: result?.storageVersion ?? 0, hash: result?.checkpoint?.contentHash }); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    }));
    const previous = await storedVersion(); await page.evaluate(() => window.__DPMeasurement?.reset?.());
    await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdp.send('Profiler.start');
    const start = performance.now(); await page.getByRole('button', { name: '保存工程', exact: true }).click();
    await expect.poll(async () => (await storedVersion()).version, { timeout: 60000 }).toBeGreaterThan(previous.version);
    const checkpoint = await storedVersion(); if (checkpoint.hash !== output.hash) throw new Error('Checkpoint hash differs');
    const elapsedMs = performance.now() - start, result = await cdp.send('Profiler.stop'); await cdp.send('Profiler.disable');
    fs.writeFileSync(path.join(dir, 'checkpoint-save.cpuprofile'), JSON.stringify(result.profile));
    fs.writeFileSync(path.join(dir, 'checkpoint-save.json'), JSON.stringify({ elapsedMs, previous, checkpoint, instrumentation: await page.evaluate(() => window.__DPMeasurement?.snapshot?.() ?? null) }, null, 2));
  }
  output.finalEditorInvariant = await editorInvariant(); output.editorInvariantUnchanged = JSON.stringify(output.initialEditorInvariant) === JSON.stringify(output.finalEditorInvariant);
  output.finalHash = await page.getByTestId('map-hash').textContent(); output.mapHashUnchanged = output.finalHash === output.hash;
  output.originalBytesUnchanged = hash(fs.readFileSync(input)) === frozenSha; output.errors = errors;
  output.medians = modes.flatMap(labels => kinds.map(kind => {
    const list = output.rounds.filter(item => !item.warmup && item.labels === labels && item.kind === kind);
    return { labels, kind, rounds: list.length, ...Object.fromEntries(['rafP50', 'rafP95', 'over50', 'over100', 'ScriptDurationMs', 'TaskDurationMs', 'durationMs'].map(key => [key, quantile(list.map(item => item[key]), .5)])) };
  }));
  if (!output.mapHashUnchanged || !output.originalBytesUnchanged || !output.editorInvariantUnchanged || errors.length) throw new Error('Map identity or browser error invariant failed');
  if (values['stress-only']) {
    output.stress.beforePageClose = await page.evaluate(() => window.__DPLifecycle.snapshot());
    await page.close(); output.stress.pageClosed = page.isClosed();
    output.stress.limitations.push('Page close destroys the browser document; this does not independently prove React component-unmount cleanup.');
    fs.writeFileSync(path.join(dir, 'stress.json'), JSON.stringify(output.stress, null, 2));
  }
  output.status = values['stress-only'] ? 'STRESS_CHECKED' : values['screens-only'] ? 'SCREENS_CAPTURED' : 'MEASURED';
} catch (error) { output.status = 'FAILED'; output.error = error.stack; process.exitCode = 1; }
finally {
  if (browser) await browser.close(); if (server && server.exitCode === null) server.kill();
  fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(output, null, 2)); fs.writeFileSync(path.join(dir, 'server.log'), logs);
  console.log(JSON.stringify({ status: output.status, dir, error: output.error, probes: output.rounds.length }));
}
