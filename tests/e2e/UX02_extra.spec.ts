import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { newMap, newNode, newRoad, newFacility } from '../../src/domain/factory';
import type { Provenance, Vec3, YardMap } from '../../src/domain/model';
import { readyWorkbench, importMapUI, exportMapUI, expectVisiblePosition } from '../helpers/RF01_workbench';
import { drawingControl, openPropertyDetails } from '../helpers/workbenchUi';

async function original(path: string, expectedSHA: string) {
  let bytes: Buffer; try { bytes = await readFile(path); } catch (cause) { throw new Error('blocked_input: UX02 frozen original unavailable ' + path, { cause }); }
  expect(createHash('sha256').update(bytes).digest('hex'), 'blocked_input: frozen original SHA').toBe(expectedSHA);
  return { bytes, map: JSON.parse(bytes.toString('utf8')) as YardMap };
}
async function select(page: Page, kind: string, id: string, locate = false) {
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId((kind === 'roads' ? 'road' : kind) + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', {exact:true})).toHaveValue(id);
  if (locate) await page.getByRole('button',{name:'定位 ' + id,exact:true}).click();
}
async function exported(page: Page, info: TestInfo, label: string) { return (await exportMapUI(page,info,label)).map; }
async function hash(page: Page) { return (await page.getByTestId('map-hash').textContent())!; }
async function count(page: Page) { return Number((await page.locator('.canvas-status').textContent())!.match(/(\d+) 个撤销事务/)![1]); }
function attribute(map: YardMap, provenance: Provenance, field: string) {
  map.sources.source_editor_geometry = {name:'编辑器人工几何设计假设',category:'design_assumption',description:'用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。'};
  provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), ...(provenance.fieldSources?.[field] ? [provenance.fieldSources[field]!] : []), 'source_editor_geometry'])];
  provenance.fieldSources = {...provenance.fieldSources,[field]:'source_editor_geometry'};
}
function repairFixture() {
  const map = newMap('UX02_synthetic_gate_repair','UX02 synthetic gate repair','0.2.0');
  map.nodes.gate = newNode([0,5,0],'专用入口'); map.nodes.public = newNode([-10,5,0],'固定公共端点');
  map.roads.access = newRoad('public','gate',[],'接入段'); map.roads.access.direction = 'both';
  map.facilities.owner = newFacility({outer:[[0,0,0],[10,0,0],[10,10,0],[0,10,0],[0,0,0]],holes:[]},'合成厂房','workshop');
  map.facilities.owner.accessPointIds=['ap']; map.facilities.owner.servicePointIds=['sp'];
  map.accessPoints.ap={name:'专用入口',nodeId:'gate',facilityId:'owner',provenance:{category:'synthetic'}};
  map.servicePoints.sp={name:'代理交接点',nodeId:'gate',facilityId:'owner',accessPointId:'ap',kind:'loading',arrival:{mode:'node_proxy',transferAssumption:'included_in_service_duration',note:'synthetic transfer included in service time; not a path through a building'},resourceIds:[],provenance:{category:'synthetic'}};
  return map;
}

test('UX02 extra real CIMC selected business marker drag is one transaction and property Enter/Escape preserve exact state', async ({page},info)=>{
  test.setTimeout(120000);
  const path=resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913','cimc/map.json');
  const input=await original(path,'98f2fe6c3bbb290ac70fb6dde19e64fa2b25dc537e8d66720b0f6e7866273a27');
  await readyWorkbench(page); await importMapUI(page,input.map,input.bytes);
  await (await drawingControl(page,'网格吸附')).selectOption('0'); await (await drawingControl(page,'节点吸附')).uncheck();
  await select(page,'accessPoints','AP_CR002',true); const h=await count(page), oldHash=await hash(page);
  const a=await expectVisiblePosition(page,[285,1023,0]), b=await expectVisiblePosition(page,[285,1024,0]);
  await page.mouse.move(a.x,a.y); await page.mouse.down(); await page.mouse.move(b.x,b.y,{steps:100});
  expect(await hash(page)).toBe(oldHash); expect(await count(page)).toBe(h); await page.mouse.up();
  await expect.poll(()=>count(page)).toBe(h+1); const moved=await exported(page,info,'cimc-marker-drag');
  expect(moved.nodes.N_CR_f12fb4afb8!.position[0]).toBeCloseTo(285,8); expect(moved.nodes.N_CR_f12fb4afb8!.position[1]).toBeCloseTo(1024,8); expect(moved.nodes.N_CR_f12fb4afb8!.position[2]).toBe(0);
  const expected=structuredClone(input.map); expected.revision++; expected.nodes.N_CR_f12fb4afb8!.position=moved.nodes.N_CR_f12fb4afb8!.position;
  attribute(expected,expected.nodes.N_CR_f12fb4afb8!.provenance,'position'); expect(moved).toEqual(expected);
  await page.getByRole('button',{name:'撤销',exact:true}).click(); expect(await exported(page,info,'marker-undo')).toEqual(input.map);
  await page.getByRole('button',{name:'重做',exact:true}).click(); expect(await exported(page,info,'marker-redo')).toEqual(moved);
  await select(page,'roads','R_CR_b0741fb08f'); const name=page.getByLabel('名称',{exact:true}), beforeName=moved.roads.R_CR_b0741fb08f!.name;
  await name.fill(beforeName+' canceled');
  for (const key of ['Enter','Escape']) {
    await name.dispatchEvent('keydown', { key, isComposing: true, keyCode: 229, bubbles: true });
    await expect(name).toHaveValue(beforeName+' canceled'); expect(await count(page)).toBe(h+1);
    expect(await exported(page,info,'property-ime-'+key)).toEqual(moved);
  }
  await name.press('Escape'); await expect(name).toHaveValue(beforeName);
  expect(await exported(page,info,'property-escape')).toEqual(moved); expect(await count(page)).toBe(h+1);
  await name.fill(beforeName+' Enter'); await name.press('Enter'); await expect.poll(()=>count(page)).toBe(h+2);
  const renamed=structuredClone(moved); renamed.revision++; renamed.roads.R_CR_b0741fb08f!.name=beforeName+' Enter';
  expect(await exported(page,info,'property-enter')).toEqual(renamed);
  await page.getByRole('button',{name:'撤销',exact:true}).click(); expect(await exported(page,info,'property-enter-undo')).toEqual(moved);
  await select(page,'facilities','F_CR002',true);
  await (await drawingControl(page,'网格吸附')).selectOption('1'); // Explicit 1m snapping avoids native input pixel quantization on this fitted view.
  const ownerStart=await expectVisiblePosition(page,[242,998,0]),ownerEnd=await expectVisiblePosition(page,[241,998,0]);
  const ownerHash=await hash(page),ownerHistory=await count(page);
  await page.mouse.move(ownerStart.x,ownerStart.y);await page.mouse.down();await page.mouse.move(ownerEnd.x,ownerEnd.y,{steps:100});
  expect(await hash(page)).toBe(ownerHash);expect(await count(page)).toBe(ownerHistory);await page.mouse.up();
  await expect.poll(()=>count(page)).toBe(ownerHistory+1);const ownerMoved=await exported(page,info,'cimc-owner-body-drag');
  const ownerExpected=structuredClone(moved);ownerExpected.revision++;
  for(const point of ownerExpected.facilities.F_CR002!.boundary.outer)point[0]-=1;
  ownerExpected.nodes.N_CR_f12fb4afb8!.position=[284,1024,0];
  attribute(ownerExpected,ownerExpected.facilities.F_CR002!.provenance,'boundary');attribute(ownerExpected,ownerExpected.nodes.N_CR_f12fb4afb8!.provenance,'position');
  // Verify the requested snapped displacement, then compare every other declaration exactly.
  for(let i=0;i<ownerExpected.facilities.F_CR002!.boundary.outer.length;i++)for(let axis=0;axis<3;axis++)expect(ownerMoved.facilities.F_CR002!.boundary.outer[i]![axis]).toBeCloseTo(ownerExpected.facilities.F_CR002!.boundary.outer[i]![axis]!,8);
  expect(ownerMoved.nodes.N_CR_f12fb4afb8!.position[0]).toBeCloseTo(284,8);expect(ownerMoved.nodes.N_CR_f12fb4afb8!.position[1]).toBeCloseTo(1024,8);expect(ownerMoved.nodes.N_CR_f12fb4afb8!.position[2]).toBe(0);
  ownerExpected.facilities.F_CR002!.boundary=ownerMoved.facilities.F_CR002!.boundary;ownerExpected.nodes.N_CR_f12fb4afb8!.position=ownerMoved.nodes.N_CR_f12fb4afb8!.position;
  expect(ownerMoved).toEqual(ownerExpected);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await exported(page,info,'cimc-owner-body-undo')).toEqual(moved);
  await page.getByRole('button',{name:'重做',exact:true}).click();expect(await exported(page,info,'cimc-owner-body-redo')).toEqual(ownerMoved);
  await original(path,'98f2fe6c3bbb290ac70fb6dde19e64fa2b25dc537e8d66720b0f6e7866273a27');
});

test('UX02 extra contour offers explicit private entrance repair, cancellation is exact and approval keeps all public references',async({page},info)=>{
  const map=repairFixture(); await readyWorkbench(page); await importMapUI(page,map); await select(page,'facilities','owner',true);
  await page.getByLabel('边界编辑模式',{exact:true}).selectOption('polygon'); await openPropertyDetails(page,'边界顶点 · m');
  for(const vertex of [1,4]) await page.getByLabel('外环 顶点 '+vertex+' X (m)',{exact:true}).fill('1');
  const h=await count(page), beforeHash=await hash(page);
  await page.getByRole('button',{name:'应用属性',exact:true}).click(); const dialog=page.getByRole('dialog',{name:'轮廓局部修复预览',exact:true});
  await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button',{name:'确认轮廓与入口局部修复',exact:true})).toBeEnabled();
  expect(await hash(page)).toBe(beforeHash); expect(await count(page)).toBe(h);
  await dialog.getByRole('button',{name:'取消轮廓修改',exact:true}).click(); expect(await exported(page,info,'repair-canceled')).toEqual(map);
  await page.getByRole('button',{name:'应用属性',exact:true}).click(); await expect(dialog).toBeVisible();
  await page.screenshot({path:info.outputPath('gate-repair-preview.png'),fullPage:true});
  await dialog.getByRole('button',{name:'确认轮廓与入口局部修复',exact:true}).click(); await expect(dialog).toHaveCount(0);
  await expect.poll(()=>count(page)).toBe(h+1); const expected=structuredClone(map); expected.revision++;
  expected.facilities.owner!.boundary.outer[0][0]=1;expected.facilities.owner!.boundary.outer[3][0]=1;expected.facilities.owner!.boundary.outer[4]![0]=1;
  expected.nodes.gate!.position=[1,5,0]; attribute(expected,expected.facilities.owner!.provenance,'boundary'); attribute(expected,expected.nodes.gate!.provenance,'position');
  expect(await exported(page,info,'repair-approved')).toEqual(expected);
  await page.getByRole('button',{name:'撤销',exact:true}).click(); expect(await exported(page,info,'repair-undo')).toEqual(map);
  await page.getByRole('button',{name:'重做',exact:true}).click(); expect(await exported(page,info,'repair-redo')).toEqual(expected);
});

test('UX02 extra frozen SR03 slot outside refined outline is rejected without scaling or rewriting slots',async({page},info)=>{
  test.setTimeout(90000); const path=resolve(process.env.SHIPYARD_TEST_DATA_ROOT ?? '.cache/GA01/data-root','projects/shipyard_simulation_SR03/SR03_A/map.json');
  const input=await original(path,'f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a');
  await readyWorkbench(page);await importMapUI(page,input.map,input.bytes);await select(page,'facilities','F_001',true);
  const h=await count(page),beforeHash=await hash(page);await page.getByLabel('矩形高 (m)',{exact:true}).fill('165');await page.getByRole('button',{name:'应用属性',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'轮廓局部修复预览',exact:true});await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button',{name:'确认轮廓与入口局部修复',exact:true})).toBeDisabled();
  await expect(dialog).toContainText('无法安全维护关联');expect(await hash(page)).toBe(beforeHash);expect(await count(page)).toBe(h);
  await page.screenshot({path:info.outputPath('slot-outside-repair-blocked.png'),fullPage:true});await dialog.getByRole('button',{name:'取消轮廓修改',exact:true}).click();
  expect(await exported(page,info,'slot-outside-canceled')).toEqual(input.map);await original(path,'f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a');
});

async function shapeHandlePixels(page:Page,position:Vec3){
  const point=await expectVisiblePosition(page,position);
  return page.getByTestId('map-canvas').evaluate((element,p)=>{
    let count=0;for(const canvas of element.querySelectorAll('canvas')){const b=canvas.getBoundingClientRect(),dpr=canvas.width/b.width;const data=canvas.getContext('2d')!.getImageData(Math.floor((p.x-b.x-8)*dpr),Math.floor((p.y-b.y-8)*dpr),Math.ceil(16*dpr),Math.ceil(16*dpr)).data;for(let i=0;i<data.length;i+=4)if(data[i]===255&&data[i+1]===242&&data[i+2]===196&&data[i+3]===255)count++;}return count;
  },point);
}
test('UX02 extra internal owner mode hides public-road shape handles and rejects toolbar deletion without state change',async({page},info)=>{
  const map=newMap('UX02_synthetic_public_shape','UX02 synthetic public shape guard','0.2.0');
  map.nodes.a=newNode([0,0,0]);map.nodes.b=newNode([0,100,0]);map.roads.public=newRoad('a','b',[[0,50,0]],'公共道路');map.roads.public.direction='both';
  map.facilities.owner=newFacility({outer:[[20,20,0],[60,20,0],[60,60,0],[20,60,0],[20,20,0]],holes:[]},'合成厂房');
  await readyWorkbench(page);await importMapUI(page,map);await select(page,'roads','public',true);
  await expect.poll(()=>shapeHandlePixels(page,[0,50,0])).toBeGreaterThan(4);
  await select(page,'facilities','owner');await page.getByRole('button',{name:'编辑内部',exact:true}).click();await select(page,'roads','public',true);
  await expect.poll(()=>shapeHandlePixels(page,[0,50,0])).toBe(0);const h=await count(page),beforeHash=await hash(page),point=await expectVisiblePosition(page,[0,50,0]);
  await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+20,point.y-10,{steps:20});await page.mouse.up();
  expect(await hash(page)).toBe(beforeHash);expect(await count(page)).toBe(h);
  // A non-draggable canvas gesture may clear selection on empty release; explicitly select the same public road before testing its toolbar guard.
  await select(page,'roads','public');
  await page.getByRole('button',{name:'删除',exact:true}).click();const confirm=page.getByRole('button',{name:'确认删除',exact:true});if(await confirm.isVisible()){if(await confirm.isEnabled())await confirm.click();else await expect(confirm).toBeDisabled();}
  await expect(page.getByRole('dialog',{name:'删除空间对象',exact:true}).getByRole('alert')).toContainText('INTERNAL_SCOPE_PUBLIC_REFERENCE');
  expect(await hash(page)).toBe(beforeHash);expect(await count(page)).toBe(h);await page.keyboard.press('Escape');
  expect(await exported(page,info,'public-shape-protected')).toEqual(map);
});
