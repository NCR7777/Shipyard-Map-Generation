import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Provenance, Vec3, YardMap } from '../../src/domain/model';
import { checkpoint, expectVisiblePosition, exportMapUI, importMapUI, readyWorkbench, selectBrowserTarget, storedWorkspace } from '../helpers/RF01_workbench';
import { drawingControl, openChecks } from '../helpers/workbenchUi';

const path = resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913', 'hanwha/map.json');
const inputSHA = '026bf0c409b151aa005fe59d50e0aeda294eca83a5fbccf9b5927b9190cb4749';
const ownerId = 'F_HW123', accessId = 'AP_HW123', serviceId = 'SP_HW123';
const accessNode = 'N_HW_7aa9ceb679', serviceNode = 'N_HW_f68dfea91a', publicNode = 'N_HW_fed23d71eb';
async function frozen() {
  let bytes: Buffer; try { bytes = await readFile(path); } catch (cause) { throw new Error('blocked_input: required HW123 original missing: ' + path, { cause }); }
  expect(createHash('sha256').update(bytes).digest('hex'), 'blocked_input: actual Hanwha SHA').toBe(inputSHA);
  return { bytes, map: JSON.parse(bytes.toString('utf8')) as YardMap };
}
async function select(page: Page, kind: 'facilities' | 'accessPoints', id: string, locate = true) {
  await page.getByTestId('object-search').fill(id); await page.getByTestId(kind + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(id);
  if (locate) await page.getByRole('button', { name: '定位 ' + id, exact: true }).click();
}
async function hash(page: Page) { return (await page.getByTestId('map-hash').textContent())!; }
async function history(page: Page) { return Number((await page.locator('.canvas-status').textContent())!.match(/(\d+) 个撤销事务/)![1]); }
async function current(page: Page, info: TestInfo, name: string) { return (await exportMapUI(page, info, name)).map; }
function attribute(map: YardMap, provenance: Provenance, field: string) {
  map.sources.source_editor_geometry = { name: '编辑器人工几何设计假设', category: 'design_assumption', description: '用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。' };
  provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), ...(provenance.fieldSources?.[field] ? [provenance.fieldSources[field]!] : []), 'source_editor_geometry'])];
  provenance.fieldSources = { ...provenance.fieldSources, [field]: 'source_editor_geometry' };
}
async function drag(page: Page, from: Vec3, to: Vec3) {
  const a = await expectVisiblePosition(page, from), b = await expectVisiblePosition(page, to);
  const beforeHash = await hash(page), beforeHistory = await history(page);
  await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{ steps:100 });
  expect(await hash(page)).toBe(beforeHash); expect(await history(page)).toBe(beforeHistory); await page.mouse.up();
  await expect.poll(() => history(page)).toBe(beforeHistory+1);
}
async function undoRedo(page: Page, info: TestInfo, before: YardMap, after: YardMap, name: string) {
  await page.getByRole('button',{name:'撤销',exact:true}).click(); expect(await current(page,info,name+'-undo')).toEqual(before);
  await page.getByRole('button',{name:'重做',exact:true}).click(); expect(await current(page,info,name+'-redo')).toEqual(after);
}

test('UX02 real Hanwha HW123 boundary entrance and rigid quay edit retain explicit internal access, fixed public anchor and complete JSON', async ({page},info) => {
  test.setTimeout(180000); const input=await frozen(), errors:string[]=[]; page.on('pageerror', error => errors.push(error.message));
  await readyWorkbench(page); await importMapUI(page,input.map,input.bytes);
  await (await drawingControl(page,'网格吸附')).selectOption('1'); await (await drawingControl(page,'节点吸附')).uncheck();
  await select(page,'facilities',ownerId); await page.screenshot({path:info.outputPath('hanwha-before.png'),fullPage:true});
  await select(page,'accessPoints',accessId);
  await drag(page,input.map.nodes[accessNode]!.position,[1888,2175,0]);
  const movedPoint=await current(page,info,'HW123-entrance-moved'); const expectedPoint=structuredClone(input.map);expectedPoint.revision++;
  expectedPoint.nodes[accessNode]!.position=[1888,2175,0];attribute(expectedPoint,expectedPoint.nodes[accessNode]!.provenance,'position');
  expect(movedPoint).toEqual(expectedPoint);expect(movedPoint.servicePoints[serviceId]!.arrival).toEqual(input.map.servicePoints[serviceId]!.arrival);
  await undoRedo(page,info,input.map,movedPoint,'HW123-entrance');
  await select(page,'accessPoints',accessId);
  const beforeRejectedHash=await hash(page),beforeRejectedHistory=await history(page);
  await page.getByRole('button',{name:'在画布重新定位',exact:true}).click();const outside=await expectVisiblePosition(page,[1889,2175,0]);await page.mouse.click(outside.x,outside.y);
  expect(await hash(page)).toBe(beforeRejectedHash);expect(await history(page)).toBe(beforeRejectedHistory);
  await page.getByTestId('map-canvas').focus();await page.keyboard.press('Escape');
  await openChecks(page);await expect(page.getByTestId('issue-panel').getByRole('button',{name:/^OWNER_ENTRANCE_REPOSITION_REQUIRED /})).toBeVisible();await expect(page.getByTestId('issue-panel').getByRole('button',{name:/^OWNER_INTERNAL_ROAD_OUTSIDE /})).toBeVisible();
  expect(await current(page,info,'HW123-off-boundary-rejected')).toEqual(movedPoint);
  await page.getByRole('button',{name:'检查与问题',exact:true}).click();
  // Restore the original through the actual one-step history before exercising whole-owner movement.
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page,info,'HW123-original-restored')).toEqual(input.map);
  await select(page,'facilities',ownerId);
  await drag(page,[1882,2120,0],[1883,2121,0]);
  const moved=await current(page,info,'HW123-owner-moved'),expected=structuredClone(input.map);expected.revision++;
  for(const ring of [expected.facilities[ownerId]!.boundary.outer,...expected.facilities[ownerId]!.boundary.holes])for(const point of ring){point[0]+=1;point[1]+=1;}
  attribute(expected,expected.facilities[ownerId]!.provenance,'boundary');
  for(const id of [accessNode,serviceNode]){expected.nodes[id]!.position[0]+=1;expected.nodes[id]!.position[1]+=1;attribute(expected,expected.nodes[id]!.provenance,'position');}
  expect(moved).toEqual(expected);
  expect(moved.nodes[publicNode]).toEqual(input.map.nodes[publicNode]);
  expect(moved.roads).toEqual(input.map.roads);expect(moved.resources).toEqual(input.map.resources);expect(moved.movements).toEqual(input.map.movements);
  expect(moved.accessPoints).toEqual(input.map.accessPoints);expect(moved.servicePoints).toEqual(input.map.servicePoints);expect(moved.coordinateFrame).toEqual(input.map.coordinateFrame);
  const beforeRelative=input.map.nodes[serviceNode]!.position.map((v,i)=>v-input.map.nodes[accessNode]!.position[i]!);
  const afterRelative=moved.nodes[serviceNode]!.position.map((v,i)=>v-moved.nodes[accessNode]!.position[i]!);expect(afterRelative).toEqual(beforeRelative);
  await page.screenshot({path:info.outputPath('hanwha-after.png'),fullPage:true});await undoRedo(page,info,input.map,moved,'HW123-owner');
  const savedHash=await hash(page),version=(await storedWorkspace(page)).record!.storageVersion;
  await page.getByRole('button',{name:'保存工程',exact:true}).click();await selectBrowserTarget(page);const record=await checkpoint(page,savedHash,version);expect(JSON.parse(record.checkpoint!.mapJson)).toEqual(moved);
  await page.reload();await expect(page.getByTestId('map-hash')).toHaveText(savedHash,{timeout:30000});
  const exported=await exportMapUI(page,info,'HW123-refreshed');expect(exported.map).toEqual(moved);
  await importMapUI(page,moved,await readFile(exported.path));expect(await current(page,info,'HW123-reimported')).toEqual(moved);
  await select(page,'facilities',ownerId);await page.screenshot({path:info.outputPath('hanwha-restored.png'),fullPage:true});
  await select(page,'accessPoints','AP_HW068');
  const protectedHash=await hash(page),protectedHistory=await history(page),protectedPoint=moved.nodes[moved.accessPoints.AP_HW068!.nodeId]!.position;
  await expect(page.getByTestId('move-edit-guidance')).toBeVisible();await expect(page.getByTestId('move-edit-guidance')).toContainText('公共');
  const fixedStart=await expectVisiblePosition(page,protectedPoint),fixedEnd=await expectVisiblePosition(page,[protectedPoint[0]+1,protectedPoint[1]+1,protectedPoint[2]]);
  await page.mouse.move(fixedStart.x,fixedStart.y);await page.mouse.down();await page.mouse.move(fixedEnd.x,fixedEnd.y,{steps:30});await page.mouse.up();
  expect(await hash(page)).toBe(protectedHash);expect(await history(page)).toBe(protectedHistory);expect(await current(page,info,'HW068-public-protected')).toEqual(moved);
  await frozen();expect(errors).toEqual([]);
});
