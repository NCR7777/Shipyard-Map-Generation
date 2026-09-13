/* global document, window, navigator, performance, requestAnimationFrame, cancelAnimationFrame, PerformanceObserver, MutationObserver, HTMLImageElement, fetch, setTimeout */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';

// One isolated real-UI production comparison; no application state injection or source instrumentation.
const { values } = parseArgs({ options: {
  'data-root': { type: 'string' }, output: { type: 'string' }, dist: { type: 'string' },
  background: { type: 'string' }, calibration: { type: 'string' }, port: { type: 'string', default: '4195' },
  'start-signal': { type: 'string' }, 'warmup-only': { type: 'boolean', default: false },
} });
const editor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(values['data-root'] ?? process.env.SHIPYARD_TEST_DATA_ROOT ?? path.join(editor, '../..'));
if (!values.output) throw new Error('--output is required (fresh evidence directory)');
const out = path.resolve(values.output), dist = path.resolve(values.dist ?? path.join(editor, 'dist'));
if (fs.existsSync(out)) throw new Error('Refusing existing output directory: ' + out);
const targetText = fs.readFileSync(path.join(editor, 'tests/helpers/GA01_targets.ts'), 'utf8');
const frozen = JSON.parse(targetText.slice(targetText.indexOf('const frozen = [') + 'const frozen = '.length, targetText.indexOf('];', targetText.indexOf('const frozen = [')) + 1));
const target = frozen.find(row => row.id === 'dalian_v02');
if (!target) throw new Error('Frozen Dalian V02 target missing');
const mapPath = path.join(root, target.path), imagePath = path.resolve(values.background ?? path.join(editor, '.cache/BG01/calibrated-dalian/background.png'));
const calibrationPath = path.resolve(values.calibration ?? path.join(editor, '.cache/BG01/calibrated-dalian/calibration.json'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bytes = fs.readFileSync(mapPath), imageBytes = fs.readFileSync(imagePath), calibrationBytes = fs.readFileSync(calibrationPath);
assert.equal(sha(bytes), target.sha256, 'blocked_input: frozen Dalian V02 SHA mismatch');
const originalMap = JSON.parse(bytes), calibration = JSON.parse(calibrationBytes);
assert.equal(calibration.image.sha256, sha(imageBytes));
assert.deepEqual(calibration.coordinateFrame, originalMap.coordinateFrame);
const distIndex = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const bundlePath = distIndex.match(/<script[^>]+src="([^"]+)"/)?.[1];
if (!bundlePath) throw new Error('Production bundle missing');
const bundleSha = sha(fs.readFileSync(path.join(dist, bundlePath)));
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(out, 'executed-runner.mjs'), fs.constants.COPYFILE_EXCL);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quantile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)] : null;
const stats = values => ({ count: values.length, p50Ms: quantile(values, .5), p95Ms: quantile(values, .95), maxMs: values.length ? Math.max(...values) : null, over33_3ms: values.filter(v => v > 33.3).length, over50ms: values.filter(v => v > 50).length, over100ms: values.filter(v => v > 100).length });
const report = {
  kind: 'BG01_ISOLATED_PRODUCTION_BACKGROUND_RELATIVE_COMPARISON', status: 'running',
  command: [process.execPath, ...process.argv.slice(1)], input: { path: mapPath, sha256: target.sha256, mapId: target.mapId, contentHash: target.contentHash, revision: originalMap.revision },
  background: { path: imagePath, sha256: sha(imageBytes), calibrationPath, calibrationSha256: sha(calibrationBytes), dimensions: calibration.image },
  bundle: { path: bundlePath, sha256: bundleSha }, runnerSha256: sha(fs.readFileSync(fileURLToPath(import.meta.url))),
  environment: { node: process.version, platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model, logicalCpuCount: os.cpus().length, memoryBytes: os.totalmem(), requestedVsyncHz: 60 },
  trajectory: { durationMs: 10200, panEvents: 300, panRadiusX: 85, panRadiusY: 32, wheelEvents: 20, wheelDelta: 120, mode: 'middle-button pan and alternating zoom in/out, identical event schedule for each trial' },
  limitations: ['60Hz is a Chrome fake-vsync reference source, not a physical display claim.', 'Active RAF intervals and input-handler-to-next-RAF are scheduling observations, not proof of raster presentation or React attribution.', 'No global DP budget verdict; only this image/map/view and hidden versus visible comparison.', 'Image decode and blob URL counters measure API calls, not GPU upload duration.', 'Hiding intentionally releases the image; a fresh decode after re-show is permitted. Repeated decoding during a fixed-visibility navigation trial is measured separately.', 'No resource or semantic map data is changed by the trajectory.'], rounds: [], errors: [],
};
const writeReport = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
let server, browser, serverLogs = '';
try {
  const url = 'http://127.0.0.1:' + values.port;
  try { const existing = await fetch(url); if (existing.ok) throw new Error('Port is already serving; refusing to measure an unowned server'); } catch (error) { if (error.message.includes('already serving')) throw error; }
  server = spawn(process.execPath, [path.join(editor, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', values.port, '--strictPort', '--outDir', dist], { cwd: editor, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { serverLogs += d; }); server.stderr.on('data', d => { serverLogs += d; });
  let ready = false;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* Startup polling. */ } if (server.exitCode !== null) throw new Error(serverLogs); await pause(100); }
  if (!ready) throw new Error('Production preview did not start');
  assert.equal(sha(Buffer.from(await (await fetch(url + bundlePath)).arrayBuffer())), bundleSha, 'Served bundle must equal frozen dist');
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', headless: true, args: ['--fake-vsync-rate=60'] });
  report.environment.chrome = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, acceptDownloads: true });
  await context.addInitScript(() => {
    const counters = { decodeCalls: 0, decodeMs: [], blobCreates: 0, blobRevokes: 0 };
    const decode = HTMLImageElement.prototype.decode, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    HTMLImageElement.prototype.decode = function(...args) { counters.decodeCalls++; const start = performance.now(); return decode.apply(this, args).finally(() => counters.decodeMs.push(performance.now() - start)); };
    URL.createObjectURL = function(...args) { counters.blobCreates++; return create.apply(this, args); };
    URL.revokeObjectURL = function(...args) { counters.blobRevokes++; return revoke.apply(this, args); };
    window.__BG01_imageCounters = counters;
  });
  const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(url);
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 30000 });
  await page.getByTestId('json-file-input').setInputFiles(mapPath);
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(originalMap.metadata.name, { timeout: 60000 });
  await expect(page.getByTestId('map-hash')).toHaveText(target.contentHash);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, calibrationPath]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配', { timeout: 30000 });
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-image-status')).toContainText('图片已就绪', { timeout: 30000 });
  const exportMap = async name => {
    const menu = page.locator('.workbench-menu > summary').filter({ hasText: /^文件$/ });
    if (!await menu.evaluate(e => e.parentElement.open)) await menu.click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
    const download = await pending; const file = path.join(out, name); await download.saveAs(file);
    if (await menu.evaluate(e => e.parentElement.open)) await menu.click();
    return { file, map: JSON.parse(fs.readFileSync(file)), sha256: sha(fs.readFileSync(file)) };
  };
  const base = await exportMap('post-background-before.map.json');
  report.invariant = { contentHash: await page.getByTestId('map-hash').textContent(), revision: base.map.revision, exportedSha256: base.sha256 };
  report.background.id = Object.keys(base.map.backgroundLayers)[0];
  const history = await page.locator('.canvas-status').textContent();
  const camera = () => page.getByTestId('camera-state').evaluate(e => ({ x: Number(e.getAttribute('data-offset-x')), y: Number(e.getAttribute('data-offset-y')), scale: Number(e.getAttribute('data-scale')) }));
  const reset = async mode => {
    await page.getByLabel('显示此底图', { exact: true }).setChecked(mode === 'visible');
    if (mode === 'visible') await expect(page.getByTestId('background-image-status')).toContainText('图片已就绪', { timeout: 30000 });
    const summary = page.locator('summary').filter({ hasText: /^绘图与显示设置$/ });
    if (!await summary.evaluate(e => e.parentElement.open)) await summary.click();
    await page.getByRole('button', { name: '适应地图', exact: true }).click();
    // Same settings/panel layout in both cases; settle load, camera and existing 600ms view persistence before measurement.
    await pause(1500);
    const now = await camera();
    if (report.camera) assert.deepEqual(now, report.camera); else report.camera = now;
    assert.equal(await page.getByTestId('map-hash').textContent(), report.invariant.contentHash);
  };
  const counts = () => page.evaluate(() => ({ ...window.__BG01_imageCounters, decodeMs: [...window.__BG01_imageCounters.decodeMs], resourceEntries: performance.getEntriesByType('resource').map(e => ({ name: e.name, duration: e.duration, transferSize: e.transferSize })) }));
  const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
  const trial = async (mode, round, warmup) => {
    await reset(mode);
    const box = await page.getByTestId('map-canvas').boundingBox(); if (!box) throw new Error('Canvas unavailable');
    report.environment.canvas = box;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const countersBefore = await counts(), metricsBefore = await cdp.send('Performance.getMetrics');
    await page.evaluate(() => {
      const data = { frames: [], inputs: [], cameraChanges: [], longTasks: [], start: performance.now() }; let raf;
      const tick = t => { data.frames.push(t); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick);
      const observer = new PerformanceObserver(list => data.longTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration })))); observer.observe({ type: 'longtask' });
      const cameraElement = document.querySelector('[data-testid="camera-state"]');
      const cameraObserver = new MutationObserver(() => data.cameraChanges.push({ t: performance.now(), x: Number(cameraElement.getAttribute('data-offset-x')), y: Number(cameraElement.getAttribute('data-offset-y')), scale: Number(cameraElement.getAttribute('data-scale')) }));
      cameraObserver.observe(cameraElement, { attributes: true });
      const input = e => data.inputs.push({ type: e.type, t: performance.now(), x: e.clientX, y: e.clientY, dy: e.deltaY ?? 0 });
      window.addEventListener('pointermove', input, { passive: true }); window.addEventListener('wheel', input, { passive: true });
      window.__BG01_stop = () => { cancelAnimationFrame(raf); observer.disconnect(); cameraObserver.disconnect(); window.removeEventListener('pointermove', input); window.removeEventListener('wheel', input); return data; };
    });
    const pending = [], start = performance.now();
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'middle', buttons: 4, clickCount: 1 });
    for (let i = 0; i < 300; i++) {
      const planned = start + i * 10200 / 299;
      if (planned > performance.now()) await pause(planned - performance.now());
      const phase = i / 299 * 2 * Math.PI;
      pending.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + Math.sin(phase) * 85, y: y + (Math.cos(phase) - 1) * 32, button: 'middle', buttons: 4 }));
      if (i % 15 === 0) pending.push(cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: Math.floor(i / 15) % 2 ? 120 : -120, modifiers: 0 }));
    }
    await Promise.all(pending); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'middle', buttons: 0, clickCount: 1 });
    const dispatchDurationMs = performance.now() - start; await pause(500);
    const raw = await page.evaluate(() => window.__BG01_stop());
    const first = raw.inputs[0]?.t, last = raw.inputs.at(-1)?.t;
    if (!Number.isFinite(first) || !Number.isFinite(last)) throw new Error('No received input');
    const activeFrames = raw.frames.slice(1).flatMap((t, i) => t >= first && raw.frames[i] <= last ? [t - raw.frames[i]] : []);
    const latencies = raw.inputs.map(input => { const next = raw.frames.find(t => t >= input.t); return next === undefined ? null : next - input.t; }).filter(v => v !== null);
    const countersAfter = await counts();
    const result = { mode, round, warmup, dispatchDurationMs, activeInputDurationMs: last - first, inputCounts: { pointermove: raw.inputs.filter(i => i.type === 'pointermove').length, wheel: raw.inputs.filter(i => i.type === 'wheel').length }, activeRaf: stats(activeFrames), inputToNextRaf: stats(latencies), imageDuringNavigation: { decodeCalls: countersAfter.decodeCalls - countersBefore.decodeCalls, blobCreates: countersAfter.blobCreates - countersBefore.blobCreates, blobRevokes: countersAfter.blobRevokes - countersBefore.blobRevokes }, countersBefore, countersAfter, metricsBefore, metricsAfter: await cdp.send('Performance.getMetrics'), cameraAfter: await camera(), raw };
    assert(dispatchDurationMs >= 10200); assert(last - first >= 10000, 'At least ten seconds of received active input'); assert.equal(result.inputCounts.wheel, 20);
    assert(new Set(raw.cameraChanges.map(c => c.scale)).size >= 2, 'Wheel must actually change camera scale');
    assert(new Set(raw.cameraChanges.map(c => c.x)).size >= 10, 'Pan must actually change camera position');
    assert.equal(await page.getByTestId('map-hash').textContent(), report.invariant.contentHash); assert.equal(await page.locator('.canvas-status').textContent(), history);
    report.rounds.push(result); writeReport();
    console.log(JSON.stringify({ mode, round, warmup, raf: result.activeRaf, input: result.inputToNextRaf, imageDuringNavigation: result.imageDuringNavigation }));
  };
  await reset('visible');
  const idle = await page.evaluate(() => new Promise(resolve => { const a = []; const tick = t => { a.push(t); if (a.length < 90) requestAnimationFrame(tick); else resolve(a.slice(1).map((v, i) => v - a[i])); }; requestAnimationFrame(tick); }));
  report.environment.idleRaf = stats(idle); report.environment.browser = await page.evaluate(() => ({ userAgent: navigator.userAgent, dpr: window.devicePixelRatio }));
  for (const mode of ['hidden', 'visible']) { await trial(mode, 0, true); await reset(mode); await page.screenshot({ path: path.join(out, mode + '-same-camera.png') }); }
  fs.writeFileSync(path.join(out, 'ready.json'), JSON.stringify({ status: 'warmup_complete_waiting_for_exclusive_measurement', bundle: report.bundle, at: new Date().toISOString(), startSignal: values['start-signal'] ?? null }, null, 2));
  console.log('WARMUP_READY ' + out);
  if (!values['warmup-only']) {
    if (!values['start-signal']) throw new Error('--start-signal is required for formally timed rounds; coordinate with other browser tests');
    const signal = path.resolve(values['start-signal']); let waited = 0;
    while (!fs.existsSync(signal)) { if (waited > 1800000) throw new Error('Timed out waiting for exclusive measurement signal'); await pause(1000); waited += 1000; }
    report.exclusiveMeasurementSignal = { path: signal, contents: fs.readFileSync(signal, 'utf8'), acceptedAt: new Date().toISOString() };
    for (let round = 1; round <= 3; round++) for (const mode of round % 2 ? ['hidden', 'visible'] : ['visible', 'hidden']) await trial(mode, round, false);
  }
  const after = await exportMap('post-navigation-after.map.json');
  assert.deepEqual(after.map, base.map); assert.equal(after.sha256, base.sha256); assert.equal(after.map.revision, report.invariant.revision);
  assert.equal(sha(fs.readFileSync(mapPath)), target.sha256); assert.equal(sha(fs.readFileSync(imagePath)), calibration.image.sha256); assert.equal(sha(fs.readFileSync(calibrationPath)), sha(calibrationBytes));
  assert.equal(sha(fs.readFileSync(path.join(dist, bundlePath))), bundleSha, 'Build changed during comparison');
  assert.equal(report.errors.length, 0);
  report.finalInvariant = { contentHash: await page.getByTestId('map-hash').textContent(), revision: after.map.revision, exportedSha256: after.sha256, originalMapUnchanged: true, imageAndCalibrationUnchanged: true, historyUnchanged: true };
  report.comparison = Object.fromEntries(['hidden', 'visible'].map(mode => { const rows = report.rounds.filter(r => !r.warmup && r.mode === mode); return [mode, { measuredRounds: rows.length, medianRafP95Ms: quantile(rows.map(r => r.activeRaf.p95Ms), .5), medianInputP95Ms: quantile(rows.map(r => r.inputToNextRaf.p95Ms), .5), navigationDecodeCalls: rows.reduce((n, r) => n + r.imageDuringNavigation.decodeCalls, 0), maxFrameMs: rows.length ? Math.max(...rows.map(r => r.activeRaf.maxMs)) : null }]; }));
  report.status = values['warmup-only'] ? 'warmup_only_complete' : 'complete';
} catch (error) { report.status = 'failed'; report.failure = { message: error.message, stack: error.stack }; process.exitCode = 1; console.error(error); }
finally { if (browser) await browser.close(); if (server) server.kill(); fs.writeFileSync(path.join(out, 'server.log'), serverLogs); writeReport(); }