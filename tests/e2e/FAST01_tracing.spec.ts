import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, exportMapUI } from '../helpers/RF01_workbench';
import { newZone } from '../../src/domain/factory';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { drawingAction } from '../helpers/workbenchUi';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import type { Polygon, Vec3, YardMap, RoadSpan } from '../../src/domain/model';
import type { ScenarioFile, PlanFile, RunEvent, SummaryFile } from '../../src/domain/results';

test.use({ viewport: { width: 1920, height: 1080 } });

test('FAST01 F1 reference-image tracing: continuous outlines, automatic road endpoints and saved defaults', async ({ page, browser }, info) => {
  test.setTimeout(180000);
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original);
  sample.mapId = 'MAP_FAST01_CIMC_TRACE'; sample.metadata.name = 'FAST01 CIMC 真实底图描图工作副本'; sample.revision = 0;
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  const image = resolve('.cache/BG01/calibrated-cimc/background.jpg');
  expect(createHash('sha256').update(await readFile(image)).digest('hex')).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([image, resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  await page.getByRole('button', {name:'适应地图',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale,scale,b};
  };
  const click = async(p: readonly number[]) => { const q=await world(p); expect(q.x).toBeGreaterThan(q.b.x);expect(q.x).toBeLessThan(q.b.x+q.b.width);expect(q.y).toBeGreaterThan(q.b.y);expect(q.y).toBeLessThan(q.b.y+q.b.height);await page.mouse.click(q.x,q.y); };
  const outlines = Object.values(original.facilities).map(f=>f.boundary).sort((a,b)=>area(b)-area(a)).slice(0,20);
  function area(p: Polygon) {const xs=p.outer.map(v=>v[0]),ys=p.outer.map(v=>v[1]);return (Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys));}
  expect(outlines).toHaveLength(20);
  const roadPairs=Object.values(original.roads).filter(r=>!r.shapePoints?.length && Math.hypot(original.nodes[r.toNodeId]!.position[0]-original.nodes[r.fromNodeId]!.position[0],original.nodes[r.toNodeId]!.position[1]-original.nodes[r.fromNodeId]!.position[1])>=60).slice(0,10).map(r=>[original.nodes[r.fromNodeId]!.position,original.nodes[r.toNodeId]!.position] as [Vec3,Vec3]);
  await page.getByRole('button',{name:'建筑',exact:true}).click();
  await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  let userActions=0; const start=Date.now();
  for(const [i,p]of outlines.entries()) {
    if (i === 0) { await page.getByRole('button',{name:'建筑',exact:true}).click(); userActions++; }
    if (i === 10) { await page.keyboard.press('g'); userActions++; }
    const xs=p.outer.map(v=>v[0]),ys=p.outer.map(v=>v[1]);
    await click([Math.min(...xs),Math.min(...ys)]);await click([Math.max(...xs),Math.max(...ys)]);userActions+=2;
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('button',{name:'道路',exact:true}).click(); userActions++;
  for(const [index,[a,b]]of roadPairs.entries()) {
    await click(a); await click(b); await page.keyboard.press('Enter'); userActions+=3;
    await expect.poll(async () => Number(await page.getByTestId('road-count').textContent()), { message: 'road ' + index + ' ' + JSON.stringify([a,b]) }).toBeGreaterThanOrEqual(index + 1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const elapsedMs=Date.now()-start; await browserSaved(page);
  const result=JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
  expect(result.schemaVersion).toBe('0.3.0');
  expect(Object.values(result.facilities).every(f => f.kind === 'building')).toBe(true);
  expect(Object.values(result.zones).every(z => z.kind === 'unclassified' && z.passability === 'unknown')).toBe(true);
  expect(Object.values(result.roads).every(r => r.widthM.state === 'known' && r.widthM.value === 12 && r.heightLimitM.state === 'unknown' && r.massLimitKg.state === 'unknown' && r.speedLimitMps.state === 'unknown')).toBe(true);
  await page.getByLabel('新道路默认宽度',{exact:true}).fill('18');
  await browserSaved(page);
  await page.reload(); await browserSaved(page);
  await expect(page.getByLabel('新道路默认宽度',{exact:true})).toHaveValue('18');
  const restored=JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
  expect(restored.roads).toEqual(result.roads);
  expect(Object.keys(result.facilities)).toHaveLength(10);expect(Object.keys(result.zones)).toHaveLength(10);expect(Object.keys(result.roads).length).toBeGreaterThanOrEqual(10);
  await exportMapUI(page,info,'f1-traced');await page.screenshot({path:info.outputPath('f1-tracing.png')});
  const measurement = {phase:'F1',browser:browser.version(),viewport:{width:1920,height:1080},elapsedMs,userActions,objects:20,roads:10,requiredForms:0,manualIds:0,measurement:'scripted ordinary UI; not human annotation speed',outlines,roadPairs};
  await writeFile(info.outputPath('measurement.json'), JSON.stringify(measurement,null,2));
  await info.attach('measurement.json',{path:info.outputPath('measurement.json'),contentType:'application/json'});
});


test('FAST01 F1 real reference canvas width handles and oblique building duplicates preserve geometry and undo', async ({page}, info) => {
  test.setTimeout(120000);
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_FAST01_GESTURES'; sample.metadata.name = 'FAST01 真实底图交互工作副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([resolve('.cache/BG01/calibrated-cimc/background.jpg'), resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale};
  };
  const click = async(p: readonly number[]) => {const q=await world(p);await page.mouse.click(q.x,q.y);};
  const drag = async(a: readonly number[],b: readonly number[]) => {const from=await world(a),to=await world(b);await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});};
  const current = async(): Promise<YardMap> => {await expect.poll(async()=> (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};
  await page.getByRole('button',{name:'道路',exact:true}).click();
  await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click([150,300]); await click([250,300]); await click([350,300]); await page.keyboard.press('Enter');
  const initial = await current(); const roadId=Object.keys(initial.roads)[0]!;
  expect(Object.keys(initial.nodes)).toHaveLength(2);
  expect(initial.roads[roadId]!.geometry?.anchors).toHaveLength(1);
  await page.getByRole('button',{name:'撤销',exact:true}).click();
  expect(Object.keys((await current()).roads)).toHaveLength(0);expect(Object.keys((await current()).nodes)).toHaveLength(0);
  await page.getByRole('button',{name:'重做',exact:true}).click();
  await page.keyboard.press('v'); await click([320,300]);
  const scale = await page.getByTestId('camera-state').getAttribute('data-scale');
  const handles=JSON.parse(await page.getByTestId('road-width-handles').getAttribute('data-handles')??'[]') as {roadId:string;sign:number;position:number[];screen:number[];edgeScreen:number[]}[];
  const handle=handles.find(item=>item.roadId===roadId&&item.sign===1)!;expect(handle).toBeTruthy();
  expect(Math.hypot(handle.screen[0]!-handle.edgeScreen[0]!,handle.screen[1]!-handle.edgeScreen[1]!)).toBeGreaterThan(10);
  const beforePressHash=await page.getByTestId('map-hash').textContent();await click(handle.position);expect(await page.getByTestId('map-hash').textContent()).toBe(beforePressHash);
  await drag(handle.position,[handle.position[0]!,handle.position[1]!+12]);
  await expect(page.getByTestId('road-width-preview')).toBeVisible();
  const previewWidth=Number((await page.getByTestId('road-width-preview').textContent())!.match(/宽度 ([\d.]+) m/)![1]);
  expect(previewWidth).toBeGreaterThan(30); expect(previewWidth).toBeLessThan(40);
  await page.mouse.up();
  const wide=await current();expect(wide.roads[roadId]!.widthM.state).toBe('known');
  if(wide.roads[roadId]!.widthM.state === 'known') expect(wide.roads[roadId]!.widthM.value).toBeCloseTo(previewWidth,2);
  expect(wide.roads[roadId]!.geometry).toEqual(initial.roads[roadId]!.geometry);
  expect(await page.getByTestId('camera-state').getAttribute('data-scale')).toBe(scale);
  if(wide.roads[roadId]!.widthM.state === 'known') expect(wide.sources[wide.roads[roadId]!.widthM.sourceRef!]!.category).toBe('imagery_derived');
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads[roadId]!.widthM).toMatchObject({state:'known',value:12});
  await page.getByRole('button',{name:'重做',exact:true}).click();expect((await current()).roads[roadId]!.widthM).toEqual(wide.roads[roadId]!.widthM);
  await drawingAction(page,'三点斜矩形建筑');
  await click([450,300]);await click([570,330]);await click([530,410]);
  const outlined=await current(),buildingId=Object.keys(outlined.facilities)[0]!,boundary=outlined.facilities[buildingId]!.boundary;
  for(let i=0;i<4;i++){const a=boundary.outer[i]!,b=boundary.outer[(i+1)%4]!,c=boundary.outer[(i+2)%4]!;expect((b[0]-a[0])*(c[0]-b[0])+(b[1]-a[1])*(c[1]-b[1])).toBeCloseTo(0,7);}
  await page.keyboard.press('v');await click([510,355]);await page.keyboard.press('Control+d');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const copied=await current();expect(Object.keys(copied.facilities)).toHaveLength(2);
  const copyId=Object.keys(copied.facilities).find(id=>id!==buildingId)!;
  expect(copied.facilities[copyId]!.boundary.outer).toEqual(boundary.outer.map(p=>[p[0]+10,p[1]+10,p[2]]));
  expect(copied.facilities[buildingId]!.boundary).toEqual(boundary);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).facilities).toEqual(outlined.facilities);
  await page.screenshot({path:info.outputPath('f1-width-oblique.png')});await exportMapUI(page,info,'f1-width-oblique');
});


test('FAST01 F2 real reference curve geometry, true controls, curve T-connection and reopening', async ({page}, info) => {
  test.setTimeout(120000);
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_FAST01_CURVES'; sample.metadata.name = 'FAST01 真实底图曲线工作副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([resolve('.cache/BG01/calibrated-cimc/background.jpg'), resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale};
  };
  const click = async(p: readonly number[]) => {const q=await world(p);await page.mouse.click(q.x,q.y);};
  const drag = async(a: readonly number[],b: readonly number[]) => {const from=await world(a),to=await world(b);await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});};
  const current = async(): Promise<YardMap> => {await expect.poll(async()=> (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};

  await page.getByRole('button',{name:'弯曲',exact:true}).click();
  await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click([300,1023]); await click([400,945]); await click([320,955]);
  const curved=await current(),roadId=Object.keys(curved.roads)[0]!;
  expect(Object.keys(curved.nodes)).toHaveLength(2);
  expect(curved.roads[roadId]!.geometry).toMatchObject({kind:'path',anchors:[],spans:[{kind:'cubic'}]});
  const {roadLength}=await import('../../src/geometry/roads');
  const length=roadLength(curved,roadId);expect(length).toBeGreaterThan(Math.hypot(100,78));
  const savedGeometry=curved.roads[roadId]!.geometry;
  const {getRoadPath,pointAt,tangentAt}=await import('../../src/geometry/roadPath');const actualMid=pointAt(getRoadPath(curved,roadId),0,0.5);
  await page.reload(); await browserSaved(page);expect((await current()).roads[roadId]!.geometry).toEqual(savedGeometry);
  await page.keyboard.press('v'); await click([320,955]);await page.keyboard.press('Shift+f');
  await drag(actualMid,[actualMid[0]-8,actualMid[1]-5]); await page.mouse.up();
  const bent=await current();expect(Object.keys(bent.nodes)).toHaveLength(2);
  expect(bent.roads[roadId]!.geometry).not.toEqual(savedGeometry);
  expect(roadLength(bent,roadId)).toBeGreaterThan(length);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads[roadId]!.geometry).toEqual(savedGeometry);
  const originalScale=Number(await page.getByTestId('camera-state').getAttribute('data-scale'));
  const curveCenter=await world([320,955]);await page.mouse.move(curveCenter.x,curveCenter.y);await page.mouse.wheel(0,-200);
  await expect.poll(async()=>Number(await page.getByTestId('camera-state').getAttribute('data-scale'))).toBeGreaterThan(originalScale);
  expect(roadLength(await current(),roadId)).toBe(length);
  await page.getByRole('button',{name:'道路',exact:true}).click();
  await click([320,1000]);await click(actualMid);
  const joined=await current();expect(Object.keys(joined.roads)).toHaveLength(3);expect(Object.keys(joined.nodes)).toHaveLength(4);
  expect(Object.keys(joined.movements).length).toBeGreaterThan(0);
  expect(Object.values(joined.roads).filter(r=>r.geometry?.spans.some((span: RoadSpan)=>span.kind==='cubic'))).toHaveLength(2);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads).toEqual(curved.roads);
  await page.getByRole('button',{name:'适应地图',exact:true}).click();
  await page.getByRole('button',{name:'道路',exact:true}).click();
  for(const point of [[500,900],[550,950],[600,950],[650,1000]])await click(point);
  await page.keyboard.press('Enter');const straightMixed=await current(),mixedId=Object.keys(straightMixed.roads).find(id=>id!==roadId)!;
  expect(Object.keys(straightMixed.nodes)).toHaveLength(4);
  await page.keyboard.press('v');await click([575,950]);await page.keyboard.press('Shift+f');
  const initialMixedMid=pointAt(getRoadPath(straightMixed,mixedId),1,0.5);await drag(initialMixedMid,[initialMixedMid[0],initialMixedMid[1]+12]);await page.mouse.up();
  const mixed=await current();expect(mixed.roads[mixedId]!.geometry!.spans.map(span=>span.kind)).toEqual(['line','cubic','line']);
  expect(Object.keys(mixed.nodes)).toHaveLength(4);
  const mixedPath=getRoadPath(mixed,mixedId),midpoint=pointAt(mixedPath,1,0.5),tangent=tangentAt(mixedPath,1,0.5);
  const widthHandle=[midpoint[0]-tangent[1]*6,midpoint[1]+tangent[0]*6],wider=[midpoint[0]-tangent[1]*10,midpoint[1]+tangent[0]*10];
  const widthScale=await page.getByTestId('camera-state').getAttribute('data-scale');
  await drag(widthHandle,wider);await page.mouse.up();const widened=await current();
  expect(widened.roads[mixedId]!.widthM).toMatchObject({state:'known'});if(widened.roads[mixedId]!.widthM.state==='known')expect(widened.roads[mixedId]!.widthM.value).toBeGreaterThan(18);
  expect(widened.roads[mixedId]!.geometry).toEqual(mixed.roads[mixedId]!.geometry);expect(await page.getByTestId('camera-state').getAttribute('data-scale')).toBe(widthScale);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads[mixedId]!.widthM).toEqual(mixed.roads[mixedId]!.widthM);
  await page.getByRole('button',{name:'重做',exact:true}).click();expect((await current()).roads[mixedId]!.widthM).toEqual(widened.roads[mixedId]!.widthM);
  await page.reload();await browserSaved(page);expect((await current()).roads[mixedId]).toEqual(widened.roads[mixedId]);
  await page.screenshot({path:info.outputPath('f2-curve.png')});await exportMapUI(page,info,'f2-curve');
});


test('FAST01 F3 real reference package, semantic transaction and selected research access', async ({page}, info) => {
  test.setTimeout(120000);
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_FAST01_COMPLETION'; sample.metadata.name = 'FAST01 真实底图批量补全工作副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  sample.zones.testLand={...newZone(rectanglePolygon([200,900,0],300,200),'测试声明陆域（人工研究假设）','drivable'),passability:'allowed'};
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([resolve('.cache/BG01/calibrated-cimc/background.jpg'), resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale};
  };
  const click = async(p: readonly number[]) => {const q=await world(p);await page.mouse.click(q.x,q.y);};
  const current = async(): Promise<YardMap> => {await expect.poll(async()=> (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};

  await page.getByRole('button',{name:'道路',exact:true}).click();await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click([250,945]);await click([480,945]);await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'建筑',exact:true}).click();
  await click([300,980]);await click([320,1000]);await click([420,965]);await click([455,985]);
  const before=await current(),ids=Object.keys(before.facilities);expect(ids).toHaveLength(2);
  const baseMapContentHash=await page.getByTestId('map-hash').textContent();
  await page.getByRole('tab',{name:'检查与补全',exact:true}).click();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出Codex补标包',exact:true}).click();await (await download).saveAs(info.outputPath('codex-package.zip'));
  const patch={formatVersion:'1.0',mapId:before.mapId,baseMapContentHash,patches:ids.map(entityId=>({entityType:'facilities',entityId,field:'kind',before:'building',after:'workshop',origin:'inferred',evidenceGrade:'medium',evidence:'synthetic acceptance patch: demonstrates review mechanics against the original image; not a confirmed field classification.',imageRef:'crops/'+entityId+'.raw.png'}))};
  await page.getByTestId('semantic-patch-input').setInputFiles({name:'semantic_patch.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(patch))});
  await expect(page.getByRole('region',{name:'语义补丁预览'})).toContainText('2 项可应用');
  await page.getByRole('button',{name:'一次应用可接受项',exact:true}).click();
  const classified=await current();for(const id of ids){expect(classified.facilities[id]!.kind).toBe('workshop');expect(classified.facilities[id]!.boundary).toEqual(before.facilities[id]!.boundary);}
  expect(classified.nodes).toEqual(before.nodes);expect(classified.roads).toEqual(before.roads);
  await page.getByTestId('semantic-patch-input').setInputFiles({name:'stale.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(patch))});
  await expect(page.getByRole('button',{name:'一次应用可接受项',exact:true})).toBeDisabled();expect((await current()).facilities).toEqual(classified.facilities);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).facilities).toEqual(before.facilities);
  await page.getByRole('checkbox',{name:'建筑001 定位 建筑001',exact:true}).check();await page.getByRole('checkbox',{name:'建筑002 定位 建筑002',exact:true}).check();
  await page.locator('summary').filter({hasText:'明确可通行的陆域'}).click();
  await page.locator('details').filter({has:page.locator('summary').filter({hasText:'明确可通行的陆域'})}).getByRole('checkbox').check();
  await page.getByRole('button',{name:'生成选定目标接入建议',exact:true}).click();
  await expect(page.getByRole('button',{name:'一次接受可用接入',exact:true})).toBeEnabled();
  const beforeSelectionChange=await page.getByTestId('map-hash').textContent();
  await page.getByRole('button',{name:'清空目标',exact:true}).click();await expect(page.getByRole('button',{name:'一次接受可用接入',exact:true})).toHaveCount(0);expect(await page.getByTestId('map-hash').textContent()).toBe(beforeSelectionChange);
  await page.getByRole('checkbox',{name:'建筑001 定位 建筑001',exact:true}).check();await page.getByRole('checkbox',{name:'建筑002 定位 建筑002',exact:true}).check();
  await page.getByRole('button',{name:'生成选定目标接入建议',exact:true}).click();
  await page.getByRole('button',{name:'一次接受可用接入',exact:true}).click();
  const connected=await current();expect(Object.keys(connected.accessPoints)).toHaveLength(2);expect(Object.keys(connected.servicePoints)).toHaveLength(2);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads).toEqual(before.roads);
  await page.screenshot({path:info.outputPath('f3-completion.png')});await exportMapUI(page,info,'f3-completion');
});

test('FAST01 F4 original editor verified external playback, sparse events and comparable summaries',async({page},info)=>{
  test.setTimeout(120000);const browserErrors:string[]=[];page.on('console',message=>{if(message.type()==='error'&&!message.location().url.endsWith('/favicon.ico'))browserErrors.push(message.text());});
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_FAST01_RESULTS'; sample.metadata.name = 'FAST01 外部结果回放工作副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([resolve('.cache/BG01/calibrated-cimc/background.jpg'), resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale};
  };
  const click = async(p: readonly number[]) => {const q=await world(p);await page.mouse.click(q.x,q.y);};
  const current = async(): Promise<YardMap> => {await expect.poll(async()=> (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};


  await page.getByRole('button',{name:'弯曲',exact:true}).click();await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);await click([300,1023]);await click([400,945]);await click([320,955]);
  const map=await current(),mapHash=await page.getByTestId('map-hash').textContent();
  await page.keyboard.press('v');await click([320,955]);await page.keyboard.press('Shift+f');
  await page.getByRole('tab',{name:'调度结果',exact:true}).click();
  const exampleDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下载当前地图的 synthetic 示例包',exact:true}).click();await(await exampleDownload).saveAs(info.outputPath('synthetic-run-example.zip'));
  const archive=await readFile(info.outputPath('synthetic-run-example.zip'));
  function member(name:string){let offset=0;while(archive.readUInt32LE(offset)===0x04034b50){expect(archive.readUInt16LE(offset+8)).toBe(0);const size=archive.readUInt32LE(offset+18),nameLength=archive.readUInt16LE(offset+26),extraLength=archive.readUInt16LE(offset+28),start=offset+30+nameLength+extraLength;if(archive.subarray(offset+30,offset+30+nameLength).toString('utf8')===name)return archive.subarray(start,start+size).toString('utf8');offset=start+size;}throw Error('missing '+name);}
  const files={scenario:JSON.parse(member('scenario.json')) as ScenarioFile,plan:JSON.parse(member('plan.json')) as PlanFile,events:member('events.jsonl').split('\n').map(line=>JSON.parse(line) as RunEvent),summary:JSON.parse(member('summary.json')) as SummaryFile};
  const forward=files.plan.activities.find(activity=>activity.kind==='travel'&&activity.vehicleId==='vehicle_forward')!;
  const travelS=forward.t1,atEnd=files.plan.activities.find(activity=>activity.kind==='wait'&&activity.vehicleId==='vehicle_forward')!;
  if(atEnd.kind==='travel')throw Error('expected fixed wait');
  files.plan.activities=files.plan.activities.filter(activity=>!(activity.kind==='wait'&&activity.vehicleId==='vehicle_forward')).map(activity=>activity.kind==='wait'&&activity.vehicleId==='vehicle_backward'&&activity.t0===0?{...activity,t1:2}:activity);
  files.plan.activities.push({...atEnd,kind:'load',t0:travelS,t1:travelS+10},{...atEnd,kind:'unload',t0:travelS+10,t1:travelS+20},{...atEnd,kind:'wait',t0:travelS+20,t1:travelS+30});
  async function ingest(button:string,name:string,data:unknown){await page.getByRole('button',{name:button,exact:true}).click();await page.getByTestId('result-file-input').setInputFiles({name,mimeType:'application/json',buffer:Buffer.from(typeof data==='string'?data:JSON.stringify(data))});await expect(page.getByRole('button',{name:'导入场景',exact:true})).toBeEnabled();}
  await ingest('导入场景','scenario.json',files.scenario);await ingest('导入计划 A','plan.json',files.plan);
  const overlay=page.getByTestId('runtime-overlay');
  const vehicles=async()=>JSON.parse(await overlay.getAttribute('data-vehicles')??'[]') as {vehicleId:string;state:string;position:number[];yawRad:number;source:string}[];
  async function jump(time:number){await page.getByRole('spinbutton',{name:'模拟时间秒',exact:true}).fill(String(time));await expect.poll(async()=>Number(await overlay.getAttribute('data-time-s'))).toBeCloseTo(time,2);return vehicles();}
  expect((await vehicles()).find(item=>item.vehicleId==='vehicle_backward')!.state).toBe('wait');
  expect((await jump(5)).find(item=>item.vehicleId==='vehicle_backward')!.state).toBe('gap');
  const bars=page.getByTestId('activity-bar');expect(await bars.count()).toBe(files.plan.activities.length);
  const travelBar=bars.filter({hasText:'行驶'}).first(),barRect=await travelBar.boundingBox(),trackRect=await page.getByTestId('activity-track').first().boundingBox();
  expect(barRect).toBeTruthy();expect(trackRect).toBeTruthy();expect(Math.abs(barRect!.width/trackRect!.width-travelS/files.scenario.timeWindow.endS)).toBeLessThan(0.01);
  await bars.filter({hasText:'装载'}).click();await expect.poll(async()=>Number(await overlay.getAttribute('data-time-s'))).toBeCloseTo(travelS,2);
  const moving=await jump(30);expect(moving.every(item=>item.state==='travel')).toBe(true);
  const later=await jump(40);expect(later[0]!.position).not.toEqual(moving[0]!.position);
  await page.getByRole('combobox',{name:'结果车辆筛选',exact:true}).selectOption('vehicle_backward');expect(await vehicles()).toHaveLength(1);expect(await bars.count()).toBe(files.plan.activities.filter(activity=>activity.vehicleId==='vehicle_backward').length);
  await page.getByRole('combobox',{name:'结果车辆筛选',exact:true}).selectOption('');
  expect((await jump(travelS+5)).find(item=>item.vehicleId==='vehicle_forward')!.state).toBe('load');
  expect((await jump(travelS+15)).find(item=>item.vehicleId==='vehicle_forward')!.state).toBe('unload');
  expect((await jump(travelS+25)).find(item=>item.vehicleId==='vehicle_forward')!.state).toBe('wait');
  await jump(30);await page.getByRole('combobox',{name:'回放倍率',exact:true}).selectOption('5');await page.getByRole('button',{name:'播放',exact:true}).click();
  await expect.poll(async()=>Number(await overlay.getAttribute('data-time-s'))).toBeGreaterThan(31);await page.getByRole('button',{name:'暂停',exact:true}).click();
  const paused=await overlay.getAttribute('data-time-s');await page.getByRole('combobox',{name:'回放倍率',exact:true}).selectOption('1');expect(await overlay.getAttribute('data-time-s')).toBe(paused);
  await ingest('指标 A','summary.json',files.summary);await expect(page.getByRole('region',{name:'本组结果指标'})).toContainText('未提供');
  const planB={...files.plan,runId:'FAST01-synthetic-run-B',name:'synthetic B same scope'},summaryB={...files.summary,runId:planB.runId};
  await ingest('导入计划 B','plan-b.json',planB);await ingest('指标 B','summary-b.json',summaryB);
  const comparison=page.getByRole('region',{name:'同场景结果比较'});await expect(comparison).toContainText('不可计算');await expect(comparison.getByRole('row').filter({hasText:'makespan'})).toContainText('0');
  await ingest('导入计划 B','stale-plan.json',{...planB,mapContentHash:'f'.repeat(64)});await expect(page.getByRole('alert').filter({hasText:'计划绑定的地图与当前地图不一致'})).toBeVisible();expect(await overlay.getAttribute('data-run-id')).toBe(planB.runId);
  await page.getByRole('combobox',{name:'显示结果组',exact:true}).selectOption('0');
  const sparse=files.events.filter(event=>!(event.entityId==='vehicle_forward'&&event.seq===2)).reverse();
  await ingest('事件 A','events.jsonl',sparse.map(event=>JSON.stringify(event)).join('\n'));
  await expect(page.locator('.results-panel')).toContainText('事件序号缺口');const heldA=await jump(travelS*0.3),heldB=await jump(travelS*0.4);
  expect(heldA.find(item=>item.vehicleId==='vehicle_forward')!.position).toEqual(heldB.find(item=>item.vehicleId==='vehicle_forward')!.position);expect(heldB.every(item=>item.source==='event')).toBe(true);
  expect(await page.getByTestId('map-hash').textContent()).toBe(mapHash);expect((await current()).roads).toEqual(map.roads);
  await page.screenshot({path:info.outputPath('f4-external-playback.png')});await writeFile(info.outputPath('external-files.json'),JSON.stringify(files,null,2));
  await page.getByRole('tab',{name:'描图',exact:true}).click();await page.getByRole('button',{name:'撤销',exact:true}).click();await page.getByRole('tab',{name:'调度结果',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'地图版本已变化'})).toBeVisible();await expect(overlay).toHaveAttribute('data-run-id','');expect(browserErrors).toEqual([]);
});

test('FAST01 F3 legacy research access enables schema once and preserves existing declarations',async({page})=>{
  const original=await readGA01Target(GA01_TARGETS.find(target=>target.id==='cimc_v02')!);
  await readyWorkbench(page);await importMapUI(page,original);await browserSaved(page);
  const current=async()=>{await expect.poll(async()=>(await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};
  const before=await current();expect(before.schemaVersion).toBe('0.2.0');
  await page.getByRole('tab',{name:'检查与补全',exact:true}).click();await page.locator('.research-target-list input[type="checkbox"]').first().check();
  await page.getByRole('button',{name:'生成选定目标接入建议',exact:true}).click();await expect(page.getByRole('dialog',{name:'显式升级地图契约'})).toBeVisible();expect((await current()).schemaVersion).toBe('0.2.0');
  await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const after=await current();expect(after.schemaVersion).toBe('0.3.0');expect(after.nodes).toEqual(before.nodes);expect(after.facilities).toEqual(before.facilities);expect(after.zones).toEqual(before.zones);expect(after.revision).toBe(before.revision+1);
  await page.getByRole('button',{name:'生成选定目标接入建议',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('region',{name:'接入建议'})).toBeVisible();
});

test('FAST01 complete original workflow continuous R C draft, selected widths, direction, measurement and width split',async({page},info)=>{
  test.setTimeout(120000);
  const original = await readGA01Target(GA01_TARGETS.find(t => t.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_FAST01_WORKFLOW'; sample.metadata.name = 'FAST01 连续绘路与快捷操作工作副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([resolve('.cache/BG01/calibrated-cimc/background.jpg'), resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', {name:'收起属性面板',exact:true}).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale};
  };
  const click = async(p: readonly number[]) => {const q=await world(p);await page.mouse.click(q.x,q.y);};
  const current = async(): Promise<YardMap> => {await expect.poll(async()=> (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;};


  await page.getByRole('button',{name:'道路',exact:true}).click();await page.getByRole('button',{name:'保留原图并升级',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
  const canvasBox=await page.getByTestId('map-canvas').boundingBox();
  await click([300,1023]);await click([300,985]);expect(await page.getByTestId('map-canvas').boundingBox()).toEqual(canvasBox);
  await page.getByRole('combobox',{name:'本次道路接续',exact:true}).selectOption('smooth');await page.getByRole('button',{name:'道路',exact:true}).click();await page.keyboard.press('c');
  await expect(page.getByRole('button',{name:'弯曲',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByRole('dialog')).toHaveCount(0);
  await click([360,945]);await click([310,955]);expect(Object.keys((await current()).roads)).toHaveLength(0);
  await page.keyboard.press('r');const lineEnd=await world([420,945]);await page.mouse.move(lineEnd.x,lineEnd.y);await expect(page.getByTestId('road-draft-instruction')).toContainText('当前接续：平滑');
  await click([420,945]);await page.keyboard.press('Enter');const traced=await current(),mixedId=Object.keys(traced.roads)[0]!;
  expect(traced.roads[mixedId]!.geometry!.spans.map(span=>span.kind)).toEqual(['line','cubic','line']);expect(Object.keys(traced.nodes)).toHaveLength(2);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(Object.keys((await current()).nodes)).toHaveLength(0);expect(Object.keys((await current()).roads)).toHaveLength(0);
  await page.getByRole('button',{name:'重做',exact:true}).click();expect((await current()).roads[mixedId]!.geometry).toEqual(traced.roads[mixedId]!.geometry);
  for(const pair of [[[480,945],[560,945]],[[500,1023],[580,1023]]]){await click(pair[0]!);await click(pair[1]!);await page.keyboard.press('Enter');}
  expect(await page.getByTestId('map-canvas').boundingBox()).toEqual(canvasBox);
  const beforeBatch=await current(),ids=Object.keys(beforeBatch.roads);expect(ids).toHaveLength(3);
  await page.keyboard.press('v');await click([390,945]);await page.keyboard.down('Shift');await click([540,1023]);await page.keyboard.up('Shift');
  expect(await page.getByTestId('map-canvas').boundingBox()).toEqual(canvasBox);
  await page.getByRole('button',{name:'所选道路改宽',exact:true}).click();await expect(page.getByRole('dialog',{name:'所选道路一起修改'})).toBeVisible();await page.getByRole('spinbutton',{name:'统一宽度 (m)',exact:true}).fill('18');await page.getByRole('button',{name:'应用到这些道路',exact:true}).click();
  const batch=await current();for(const id of [ids[0]!,ids[2]!]){expect(batch.roads[id]!.widthM).toMatchObject({state:'known',value:18});expect(batch.roads[id]!.geometry).toEqual(beforeBatch.roads[id]!.geometry);}expect(batch.roads[ids[1]!]!).toEqual(beforeBatch.roads[ids[1]!]!);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads).toEqual(beforeBatch.roads);await page.getByRole('button',{name:'重做',exact:true}).click();
  await page.getByRole('button',{name:'所选道路设为反向',exact:true}).click();const backward=await current();expect(backward.roads[ids[0]!]!.direction).toBe('backward');expect(backward.roads[ids[2]!]!.direction).toBe('backward');expect(backward.roads[ids[1]!]!).toEqual(batch.roads[ids[1]!]!);expect(backward.movements).toEqual(batch.movements);
  await page.getByRole('button',{name:'所选道路设为正向',exact:true}).click();expect((await current()).roads[ids[0]!]!.direction).toBe('forward');await page.getByRole('button',{name:'所选道路设为双向',exact:true}).click();
  const beforeMeasure=await current(),measureHash=await page.getByTestId('map-hash').textContent();await page.keyboard.press('m');await expect(page.getByRole('button',{name:'量距',exact:true})).toHaveAttribute('aria-pressed','true');
  await click([300,1023]);await click([360,1023]);await click([360,985]);await page.keyboard.press('Enter');const measured=Number(await page.getByTestId('measurement-readout').getAttribute('data-length-m'));expect(measured).toBeGreaterThan(95);expect(measured).toBeLessThan(101);
  const center=await world([350,1000]);await page.mouse.move(center.x,center.y);await page.mouse.wheel(0,-200);expect(Number(await page.getByTestId('measurement-readout').getAttribute('data-length-m'))).toBe(measured);expect(await page.getByTestId('map-hash').textContent()).toBe(measureHash);expect(await current()).toEqual(beforeMeasure);
  await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'选择',exact:true})).toHaveAttribute('aria-pressed','true');await page.keyboard.press('m');await expect(page.getByTestId('measurement-readout')).toHaveAttribute('data-count','0');
  await page.keyboard.press('v');await click([390,945]);await page.getByRole('button',{name:'此处开始变宽',exact:true}).click();await click([330,951]);
  await expect(page.getByRole('dialog',{name:'此处开始变宽',exact:true})).toBeVisible();await page.getByRole('spinbutton',{name:'此后宽度 (m)',exact:true}).fill('24');await page.getByRole('button',{name:'确认拆分并改宽',exact:true}).click();
  const widened=await current();expect(Object.keys(widened.roads)).toHaveLength(4);const replaced=Object.keys(widened.roads).filter(id=>!ids.includes(id));expect(replaced).toHaveLength(2);expect(replaced.map(id=>widened.roads[id]!.widthM.state==='known'?(widened.roads[id]!.widthM as {value:number}).value:null).sort((a,b)=>a!-b!)).toEqual([18,24]);expect(widened.roads[ids[1]!]!).toEqual(beforeMeasure.roads[ids[1]!]!);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads).toEqual(beforeMeasure.roads);expect((await current()).nodes).toEqual(beforeMeasure.nodes);
  await page.getByRole('button',{name:'建筑',exact:true}).click();await click([480,920]);await click([540,970]);
  await page.getByRole('button',{name:'区域',exact:true}).click();for(const point of [[470,910],[570,910],[570,980],[470,980]])await click(point);await page.keyboard.press('Enter');
  const overlapMap=await current(),facilityId=Object.keys(overlapMap.facilities)[0]!,zoneId=Object.keys(overlapMap.zones)[0]!,overlapHash=await page.getByTestId('map-hash').textContent();
  await page.keyboard.press('v');await click([505,945]);await expect(page.getByTestId('road-item-'+ids[1]!)).toHaveClass(/selected/);await expect(page.getByTestId('selection-cycle')).toContainText('1 / 3');
  await click([505,945]);await expect(page.getByTestId('facilities-item-'+facilityId)).toHaveClass(/selected/);await click([505,945]);await expect(page.getByTestId('zones-item-'+zoneId)).toHaveClass(/selected/);await click([505,945]);await expect(page.getByTestId('road-item-'+ids[1]!)).toHaveClass(/selected/);
  await page.keyboard.press('Tab');await expect(page.getByTestId('facilities-item-'+facilityId)).toHaveClass(/selected/);await page.keyboard.press('Shift+Tab');await expect(page.getByTestId('road-item-'+ids[1]!)).toHaveClass(/selected/);
  expect(await page.getByTestId('map-hash').textContent()).toBe(overlapHash);expect(await page.getByTestId('map-canvas').boundingBox()).toEqual(canvasBox);
  await page.keyboard.press('c');await click([600,1000]);await click([540,1023]);await page.keyboard.press('r');await page.keyboard.press('Enter');
  const connected=await current();expect(connected.roads[ids[2]!]).toBeUndefined();expect(Object.keys(connected.roads)).toHaveLength(5);expect(Object.keys(connected.nodes)).toHaveLength(8);
  const splitNodes=Object.keys(connected.nodes).filter(id=>!overlapMap.nodes[id]&&Object.values(connected.roads).filter(road=>road.fromNodeId===id||road.toNodeId===id).length===3);expect(splitNodes).toHaveLength(1);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect((await current()).roads).toEqual(overlapMap.roads);expect((await current()).nodes).toEqual(overlapMap.nodes);
  await page.screenshot({path:info.outputPath('complete-tracing-workflow.png')});await exportMapUI(page,info,'complete-tracing-workflow');
});
