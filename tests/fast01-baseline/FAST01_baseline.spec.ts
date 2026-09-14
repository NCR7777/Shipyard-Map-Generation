import { expect, test } from '@playwright/test';
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, exportMapUI } from '../helpers/RF01_workbench';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import type { Polygon, Vec3 } from '../../src/domain/model';

test('FAST01 old HEAD reference-image tracing baseline: twenty outlines and ten roads', async ({ page, browser }, info) => {
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
  await page.locator('summary').filter({ hasText: /^基础图层与标签$/ }).click();
  await page.getByTestId('layer-visible-siteBoundary').uncheck();
  await page.locator('summary').filter({ hasText: /^基础图层与标签$/ }).click();
  const world = async (p: readonly number[]) => {
    const b = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!b) throw Error('no canvas');
    const c=page.getByTestId('camera-state'), scale=Number(await c.getAttribute('data-scale'));
    return {x:b.x+Number(await c.getAttribute('data-offset-x'))+p[0]!*scale,y:b.y+Number(await c.getAttribute('data-offset-y'))-p[1]!*scale,scale,b};
  };
  const click = async(p: readonly number[]) => { const q=await world(p); expect(q.x).toBeGreaterThan(q.b.x);expect(q.x).toBeLessThan(q.b.x+q.b.width);expect(q.y).toBeGreaterThan(q.b.y);expect(q.y).toBeLessThan(q.b.y+q.b.height);await page.mouse.click(q.x,q.y); };
  const outlines = Object.values(original.facilities).map(f=>f.boundary).sort((a,b)=>area(b)-area(a)).slice(0,20);
  function area(p: Polygon) {const xs=p.outer.map(v=>v[0]),ys=p.outer.map(v=>v[1]);return (Math.max(...xs)-Math.min(...xs))*(Math.max(...ys)-Math.min(...ys));}
  expect(outlines).toHaveLength(20);
  const roadPairs=Object.values(original.roads).filter(r=>!r.shapePoints?.length && Math.hypot(original.nodes[r.toNodeId]!.position[0]-original.nodes[r.fromNodeId]!.position[0], original.nodes[r.toNodeId]!.position[1]-original.nodes[r.fromNodeId]!.position[1]) >= 60).slice(0,10).map(r=>[original.nodes[r.fromNodeId]!.position,original.nodes[r.toNodeId]!.position] as [Vec3,Vec3]);
  let userActions=0;
  await page.locator('summary').filter({hasText:/^绘图与显示设置$/}).click();await page.getByLabel('新建设施类型',{exact:true}).selectOption('other');await page.locator('summary').filter({hasText:/^绘图与显示设置$/}).click();
  const start=Date.now();
  for(const [i,p]of outlines.entries()) {
    await page.getByRole('button',{name:i<10?'矩形设施':'矩形区域',exact:true}).click(); userActions++;
    const xs=p.outer.map(v=>v[0]),ys=p.outer.map(v=>v[1]);
    await click([Math.min(...xs),Math.min(...ys)]);await click([Math.max(...xs),Math.max(...ys)]);userActions+=2;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId(i<10?'scene-count-facilities':'scene-count-zones')).toHaveText(String(i<10?i+1:i-9));
  }
  for(const [i,[a,b]]of roadPairs.entries()) {

    await page.getByRole('button',{name:'节点',exact:true}).click(); await click(a); await page.getByRole('button',{name:'节点',exact:true}).click(); await click(b); userActions+=4;
    await page.getByRole('button',{name:'道路折线',exact:true}).click();await click(a);await click(b);userActions+=3;
    await expect(page.getByRole('dialog')).toHaveCount(0);
    if(i===9){await writeFile(info.outputPath('debug-body.txt'),await page.locator('body').innerText());}
    await expect(page.getByTestId('scene-count-roads')).toHaveText(String(i+1));
  }
  const elapsedMs=Date.now()-start; await browserSaved(page);
  const result=JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson);
  expect(Object.keys(result.facilities)).toHaveLength(10);expect(Object.keys(result.zones)).toHaveLength(10);expect(Object.keys(result.roads)).toHaveLength(10);
  await exportMapUI(page,info,'old-head-traced');await page.screenshot({path:info.outputPath('old-head-tracing.png')});
  const measurement = {head:'ee1ae27d040876b40ba1edc8df314f2ca56cdba6',browser:browser.version(),viewport:{width:1920,height:1080},elapsedMs,userActions,setupActions:6,objects:20,roads:10,requiredForms:0,manualIds:0,measurement:'scripted ordinary UI; not human annotation speed',oldSetup:'Select facility kind other once to avoid assuming workshop obstruction; hide legacy site boundary swallowing empty-area clicks',outlines,roadPairs};
  await writeFile(info.outputPath('measurement.json'),JSON.stringify(measurement,null,2));
  await info.attach('measurement.json',{path:info.outputPath('measurement.json'),contentType:'application/json'});
});
