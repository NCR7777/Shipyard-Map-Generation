import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { GA01_TARGETS, GA01Command, assertGA01Change, assertGA01Equal } from '../helpers/GA01_targets';
import { readyWorkbench, importMapUI, selectResult, exportMapUI, browserSaved, storedWorkspace, checkpoint, expectVisiblePosition } from '../helpers/RF01_workbench';
import { saveToBrowser } from '../helpers/workbenchUi';

interface Target { id: string; path: string; sha256: string; contentHash: string; ga01TargetId: string; inputRole: string }
const manifestPath = resolve(process.env.MQ01_REPAIRED_MANIFEST ?? '.cache/MQ01/browser-targets.json');
let targets: Target[];
try { targets = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { targets: Target[] }).targets; }
catch (cause) { throw new Error('blocked_input: missing MQ01 repaired-map acceptance manifest ' + manifestPath, { cause }); }
if (!Array.isArray(targets) || targets.length === 0) throw new Error('blocked_input: MQ01 target list is empty');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
test.setTimeout(150000);
test.use({ viewport: { width: 1920, height: 1080 }, trace: 'on' });

for (const target of targets) test('MQ01 repaired production geometry/save/roundtrip ' + target.id, async ({ page, browser }, info) => {
  const expectedBundle = process.env.MQ01_EXPECTED_BUNDLE;
  if (!expectedBundle) throw new Error('blocked_build: MQ01_EXPECTED_BUNDLE must name the newly verified production JS asset');
  const errors: string[] = [], bundles: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.ok() && /\/assets\/[^/]+\.js$/.test(new URL(response.url()).pathname)) bundles.push(response.url()); });
  const input = resolve(target.path), bytes = await readFile(input);
  expect(sha(bytes), 'blocked_input: repaired input SHA changed').toBe(target.sha256);
  // Manifest preparation and the actual browser import use shared loadMap; Playwright only reads the exact frozen JSON here.
  const original = JSON.parse(bytes.toString('utf8')) as YardMap;
  const prior = GA01_TARGETS.find(value => value.id === target.ga01TargetId);
  if (!prior || !original.nodes[prior.nodeId]) throw new Error('blocked_input: previously verified micro-edit node is missing; choose a new explicit target');
  const command = GA01Command(original, prior, 'B');
  if (command.type !== 'updateNode') throw new Error('Expected existing local node micro-edit');
  await readyWorkbench(page); await importMapUI(page, original, bytes);
  await expect(page.getByTestId('map-hash')).toHaveText(target.contentHash);
  await selectResult(page, 'node', prior.nodeId);
  const initialPosition = await expectVisiblePosition(page, original.nodes[prior.nodeId]!.position);
  await page.screenshot({ path: info.outputPath('01-repaired-import.png'), fullPage: true });
  await page.getByLabel('X (m)', { exact: true }).fill(String(command.patch.position![0]));
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.getByTestId('map-hash')).not.toHaveText(target.contentHash);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const edited = await exportMapUI(page, info, 'edited');
  assertGA01Change(original, edited.map, prior, 'B');
  const editedHash = (await page.getByTestId('map-hash').textContent())!;
  await expect(page.getByTestId('map-hash')).toHaveText(editedHash);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assertGA01Equal((await exportMapUI(page, info, 'undo')).map, original);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assertGA01Equal((await exportMapUI(page, info, 'redo')).map, edited.map);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const beforeSave = (await storedWorkspace(page)).record!;
  await saveToBrowser(page);
  const saved = await checkpoint(page, editedHash, beforeSave.storageVersion); await browserSaved(page);
  assertGA01Equal(JSON.parse(saved.checkpoint!.mapJson), edited.map);
  expect(saved.projectId).toBe(beforeSave.projectId);
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(editedHash, { timeout: 30000 }); await browserSaved(page);
  assertGA01Equal((await exportMapUI(page, info, 'refreshed')).map, edited.map);
  const previousProject = (await storedWorkspace(page)).record!.projectId;
  await importMapUI(page, edited.map, await readFile(edited.path));
  await expect.poll(async () => (await storedWorkspace(page)).record?.projectId).not.toBe(previousProject);
  assertGA01Equal((await exportMapUI(page, info, 'reimported')).map, edited.map);
  await selectResult(page, 'node', prior.nodeId);
  const finalPosition = await expectVisiblePosition(page, edited.map.nodes[prior.nodeId]!.position);
  await page.screenshot({ path: info.outputPath('02-saved-refreshed-reimported.png'), fullPage: true });
  expect(bundles.some(url => new URL(url).pathname === '/assets/' + expectedBundle), 'must actually load expected production bundle').toBe(true);
  expect(errors).toEqual([]); expect(sha(await readFile(input))).toBe(target.sha256);
  await writeFile(info.outputPath('MQ01-browser-receipt.json'), JSON.stringify({ target, originalMapId: original.mapId, originalRevision: original.revision, editedRevision: edited.map.revision,
    originalHash: target.contentHash, editedHash, nodeId: prior.nodeId, requestedPosition: command.patch.position,
    initialPosition, finalPosition, bundles: [...new Set(bundles)], browser: browser.version(), savedStorageVersion: saved.storageVersion, previousStorageVersion: beforeSave.storageVersion,
    inputUnchanged: true, exactUndoRedo: true, fullCoordinateFramePreserved: true, allUnrelatedFieldsPreserved: true, checkpointExact: true, refreshExact: true, jsonRoundtripExact: true }, null, 2));
});
