import { openPropertyDetails } from '../helpers/workbenchUi';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { backgroundFrame } from '../../src/geometry/backgrounds';
import { readyWorkbench, importMapUI, browserSaved, exportMapUI, storedWorkspace, selectResult, fileAction, checkpoint } from '../helpers/RF01_workbench';
import { GA01_TARGETS, readGA01Target, GA01Boundary, GA01RoadCommand } from '../helpers/GA01_targets';

const target = GA01_TARGETS.find(item => item.id === 'cimc_v02')!;
const calibratedDir = resolve(process.env.BG01_CALIBRATION_DIR ?? '.cache/BG01/calibrated-cimc');
const imagePath = resolve(calibratedDir, 'background.jpg');
const calibrationPath = resolve(calibratedDir, 'calibration.json');
const imageSHA = '8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713';
async function inputs() {
  const original = await readGA01Target(target);
  let calibration: { imageToWorld: [number,number,number,number,number,number] };
  try { expect(createHash('sha256').update(await readFile(imagePath)).digest('hex')).toBe(imageSHA); calibration = JSON.parse(await readFile(calibrationPath, 'utf8')); }
  catch (error) { throw Error('blocked_input: BG01 calibrated CIMC image/calibration unavailable or mismatched. Run documented BG01_prepare_raster command. ' + String(error), { cause: error }); }
  return { original, calibration };
}
async function openPanel(page: Page) { const panel = page.getByTestId('background-panel'); if (!(await panel.isVisible())) await page.getByRole('button', { name: '底图', exact: true }).click(); await expect(panel).toBeVisible(); }
async function added(page: Page) {
  const { original, calibration } = await inputs();
  await readyWorkbench(page); await importMapUI(page, original); await openPanel(page);
  await page.getByTestId('background-file-input').setInputFiles([imagePath, calibrationPath]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配', { timeout:30000 });
  await page.getByRole('button', { name:'添加此底图', exact:true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1',{timeout:30000});
  await browserSaved(page); return { original, calibration };
}
async function current(page: Page): Promise<YardMap> { await browserSaved(page); return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson); }
function preservedVectors(before: YardMap, after: YardMap) { const normalized = structuredClone(after); normalized.revision=before.revision; normalized.assets=before.assets; normalized.backgroundLayers=before.backgroundLayers; normalized.sources=before.sources; expect(normalized).toEqual(before); }
async function hash(page: Page) { return (await page.getByTestId('map-hash').textContent())!; }
async function count(page: Page) { return Number(((await page.locator('.canvas-status').textContent())!.match(/(\d+) 个撤销事务/) ?? [])[1]); }
async function projectPoint(page: Page, xy: readonly number[]) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if(!box)throw Error('no canvas');
  const state = page.getByTestId('camera-state'); const scale=Number(await state.getAttribute('data-scale'));
  return { x:box.x+Number(await state.getAttribute('data-offset-x'))+xy[0]!*scale, y:box.y+Number(await state.getAttribute('data-offset-y'))-xy[1]!*scale, scale };
}
async function screenshot(page:Page,info:TestInfo,name:string) { await page.screenshot({path:info.outputPath(name+'.png'),fullPage:true}); }

test('BG01 real calibrated editor: transforms, history, independent vectors, display prefs, save/refresh/switch and JSON roundtrip', async ({page,browser},info)=>{
  test.setTimeout(90000); // Multiple raster transforms, project restores and JSON roundtrips; assertion timeouts stay unchanged.
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const {original,calibration}=await added(page);
  let map=await current(page);const id=Object.keys(map.backgroundLayers)[0]!;
  expect(map.backgroundLayers[id]!.imageToWorld).toEqual(calibration.imageToWorld);preservedVectors(original,map);await exportMapUI(page,info,'calibrated-original-background');
  await page.getByRole('button',{name:'适应地图',exact:true}).click(); await screenshot(page,info,'01-calibrated-overlay');
  const declaredHash=await hash(page),rev=map.revision,history=await count(page);
  await page.getByLabel('影像对照模式',{exact:true}).check();await page.getByLabel('底图透明度 (%)',{exact:true}).fill('35');
  await page.getByLabel('显示此底图',{exact:true}).uncheck();await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','0');
  await page.getByLabel('锁定此底图',{exact:true}).uncheck();await page.getByLabel('显示此底图',{exact:true}).check();
  await page.getByLabel('底图透明度 (%)',{exact:true}).fill('100');await page.getByLabel('锁定此底图',{exact:true}).check();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  expect(await hash(page)).toBe(declaredHash);expect(await count(page)).toBe(history);expect((await current(page)).revision).toBe(rev);
  await screenshot(page,info,'02-image-comparison');
  await page.getByLabel('底图透明度 (%)',{exact:true}).fill('0');
  expect(await page.getByTestId('map-canvas').locator('canvas').first().evaluate(canvas => (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0,0,(canvas as HTMLCanvasElement).width,(canvas as HTMLCanvasElement).height).data.some((v,i)=>i%4===3&&v!==0))).toBe(false);
  expect(await hash(page)).toBe(declaredHash);await page.getByLabel('底图透明度 (%)',{exact:true}).fill('100');
  await page.getByRole('button',{name:'调整底图',exact:true}).click();
  await page.getByLabel('底图 X (m)',{exact:true}).fill('5');await page.getByLabel('底图 Y (m)',{exact:true}).fill('1343');
  await page.getByRole('button',{name:'应用底图数值',exact:true}).click();
  map=await current(page);expect(map.backgroundLayers[id]!.imageToWorld.slice(4)).toEqual([5,1343]);preservedVectors(original,map);
  const positioned=map;
  const beforeRotate=backgroundFrame(map.backgroundLayers[id]!.imageToWorld,1420,1340);
  await page.getByLabel('底图旋转 (°)',{exact:true}).fill('15');await page.getByRole('button',{name:'应用底图数值',exact:true}).click();
  map=await current(page);const rotated=backgroundFrame(map.backgroundLayers[id]!.imageToWorld,1420,1340);
  expect(rotated.center[0]).toBeCloseTo(beforeRotate.center[0],9);expect(rotated.center[1]).toBeCloseTo(beforeRotate.center[1],9);expect(rotated.rotationRad).toBeCloseTo(Math.PI/12,10);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(positioned);
  await page.getByRole('button',{name:'重做',exact:true}).click();expect(await current(page)).toEqual(map);
  await page.getByRole('button',{name:'适应底图',exact:true}).click();
  const center=await projectPoint(page,rotated.center), dragHistory=await count(page);
  await page.mouse.move(center.x,center.y);await page.mouse.down();await page.mouse.move(center.x+20,center.y+10,{steps:100});await page.mouse.up();
  const dragged=await current(page);expect(await count(page)).toBe(dragHistory+1);
  expect(dragged.backgroundLayers[id]!.imageToWorld[4]-map.backgroundLayers[id]!.imageToWorld[4]).toBeCloseTo(20/center.scale,5);
  expect(dragged.backgroundLayers[id]!.imageToWorld[5]-map.backgroundLayers[id]!.imageToWorld[5]).toBeCloseTo(-10/center.scale,5);
  preservedVectors(original,dragged);
  await page.getByRole('button',{name:'适应底图',exact:true}).click();
  const df=backgroundFrame(dragged.backgroundLayers[id]!.imageToWorld,1420,1340), corner=await projectPoint(page,df.corners[2]);
  await page.mouse.move(corner.x,corner.y);await page.mouse.down();await page.mouse.move(corner.x+16,corner.y+12,{steps:20});await page.mouse.up();
  map=await current(page);const sf=backgroundFrame(map.backgroundLayers[id]!.imageToWorld,1420,1340);
  expect(sf.corners[0]).toEqual(df.corners[0]);expect(sf.widthM/df.widthM).toBeCloseTo(sf.heightM/df.heightM,9);expect(sf.widthM).toBeGreaterThan(df.widthM);
  await page.getByRole('button',{name:'适应底图',exact:true}).click();
  const mid=await projectPoint(page,sf.center);const beforeCancel=await hash(page),hc=await count(page);
  await page.mouse.move(mid.x,mid.y);await page.mouse.down();await page.mouse.move(mid.x+15,mid.y+10,{steps:10});await page.keyboard.press('Escape');await page.mouse.up();
  expect(await hash(page)).toBe(beforeCancel);expect(await count(page)).toBe(hc);
  const finish=page.getByRole('button',{name:'完成调整并锁定',exact:true});if(await finish.isVisible())await finish.click();
  await expect(page.getByLabel('锁定此底图',{exact:true})).toBeChecked();
  const savedMap=await current(page),savedHash=await hash(page);preservedVectors(original,savedMap);
  await page.getByLabel('底图透明度 (%)',{exact:true}).fill('68');await page.getByRole('button',{name:'保存工程',exact:true}).click();
  const chooser=page.getByRole('dialog',{name:'选择保存目标',exact:true});if(await chooser.isVisible())await chooser.getByRole('button',{name:'仅保存浏览器恢复',exact:true}).click();
  await browserSaved(page);const projectId=(await storedWorkspace(page)).record!.projectId;
  await page.reload();await expect(page.getByRole('button',{name:'保存工程',exact:true})).toBeEnabled({timeout:30000});await openPanel(page);
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');await expect(page.getByLabel('底图透明度 (%)',{exact:true})).toHaveValue('68');await expect(page.getByLabel('影像对照模式',{exact:true})).toBeChecked();expect(await hash(page)).toBe(savedHash);
  const exported=await exportMapUI(page,info,'saved-background');expect(exported.map).toEqual(savedMap);
  await fileAction(page,'新建地图');await page.getByLabel('新地图名称',{exact:true}).fill('BG01 switch target');await page.getByRole('button',{name:'创建地图',exact:true}).click();await browserSaved(page);
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','0');
  await fileAction(page,'最近项目');await page.getByTestId('project-item-'+projectId).click();await browserSaved(page);await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');expect(await hash(page)).toBe(savedHash);
  await importMapUI(page,savedMap,await readFile(exported.path));await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');expect(await current(page)).toEqual(savedMap);
  await screenshot(page,info,'03-restored-image-and-map');
  expect(errors).toEqual([]);expect(await readGA01Target(target)).toEqual(original);expect(createHash('sha256').update(await readFile(imagePath)).digest('hex')).toBe(imageSHA);
  await info.attach('BG01-real-receipt.json',{body:JSON.stringify({mapSHA:target.sha256,imageSHA,originalUnchanged:true,frameAndVectorsUnchanged:true,oneDragOneUndo:true,calibratedPlacement:true,displayOnlyHashUnchanged:true,restored:true,jsonRoundtrip:true,browser:browser.version()},null,2),contentType:'application/json'});
});

test('BG01 locked raster leaves real node, road and building editing safe; delete/undo only removes background',async({page},info)=>{
  const {original}=await added(page);const first=await current(page);const bgId=Object.keys(first.backgroundLayers)[0]!;const firstHash=await hash(page);
  await selectResult(page,'node',target.nodeId);
  await page.getByLabel('X (m)',{exact:true}).fill(String(first.nodes[target.nodeId]!.position[0]+0.01));
  await page.getByRole('button',{name:'应用属性',exact:true}).click();await expect(page.getByTestId('map-hash')).not.toHaveText(firstHash);
  let map=await current(page);expect(map.coordinateFrame).toEqual(original.coordinateFrame);expect(map.backgroundLayers).toEqual(first.backgroundLayers);
  const roadCommand=GA01RoadCommand(map,target,'shape');
  await page.getByTestId('object-search').fill(roadCommand.id);await page.getByTestId('road-item-'+roadCommand.id).click();await openPropertyDetails(page, '技术详情与折点');await page.getByRole('button',{name:'添加内部折点',exact:true}).click();
  for(const [axis,v]of [['X',roadCommand.patch.shapePoints![0]![0]],['Y',roadCommand.patch.shapePoints![0]![1]],['Z',roadCommand.patch.shapePoints![0]![2]]]as const)await page.getByLabel('折点 1 '+axis+' (m)',{exact:true}).fill(String(v));
  await page.getByRole('button',{name:'应用属性',exact:true}).click();map=await current(page);expect(map.roads[roadCommand.id]!.shapePoints).toEqual(roadCommand.patch.shapePoints);expect(map.backgroundLayers).toEqual(first.backgroundLayers);
  await selectResult(page,'facilities',target.facilityId);const mode=page.getByLabel('边界编辑模式',{exact:true});if(await mode.isVisible())await mode.selectOption('polygon');
  await openPropertyDetails(page, '边界顶点 · m');const boundary=GA01Boundary(map,target);
  for(const [i,p]of boundary.outer.slice(0,-1).entries())for(const [axis,v]of [['X',p[0]],['Y',p[1]]] as const)await page.getByLabel('外环 顶点 '+(i+1)+' '+axis+' (m)',{exact:true}).fill(String(v));
  await page.getByRole('button',{name:'应用属性',exact:true}).click();map=await current(page);expect(map.facilities[target.facilityId]!.boundary).toEqual(boundary);expect(map.backgroundLayers).toEqual(first.backgroundLayers);
  await openPanel(page);const beforeDelete=await current(page);
  await page.getByRole('button',{name:'删除此底图',exact:true}).click();const deleted=await current(page);expect(deleted.backgroundLayers[bgId]).toBeUndefined();expect(deleted.nodes).toEqual(beforeDelete.nodes);expect(deleted.facilities).toEqual(beforeDelete.facilities);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(beforeDelete);await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await screenshot(page,info,'04-vectors-edited-above-locked-background');expect(await readGA01Target(target)).toEqual(original);
});

test('BG01 wrong calibration, corrupt/oversize import and mismatched relink preserve map and missing raster keeps vectors',async({page},info)=>{
  const {original}=await added(page);let map=await current(page);const initialHash=await hash(page),h=await count(page);
  const wrong=JSON.parse(await readFile(calibrationPath,'utf8'));wrong.coordinateFrame.geographicAnchor.rotationRad+=0.01;
  await page.getByTestId('background-file-input').setInputFiles([{name:'background.jpg',mimeType:'image/jpeg',buffer:await readFile(imagePath)},{name:'wrong-frame.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(wrong))}]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('FRAME');await expect(page.getByRole('button',{name:'添加此底图',exact:true})).toBeDisabled();expect(await hash(page)).toBe(initialHash);
  await page.getByRole('button',{name:'取消导入',exact:true}).click();
  await page.getByTestId('background-file-input').setInputFiles({name:'corrupt.jpg',mimeType:'image/jpeg',buffer:Buffer.from('invalid image')});await expect(page.getByTestId('background-panel').getByRole('alert')).toBeVisible();expect(await hash(page)).toBe(initialHash);
  await page.getByTestId('background-file-input').setInputFiles({name:'too-large.png',mimeType:'image/png',buffer:Buffer.alloc(32*1024*1024+1)});await expect(page.getByTestId('background-panel').getByRole('alert')).toContainText('32');expect(await count(page)).toBe(h);
  await page.getByTestId('background-relink-input').setInputFiles(resolve('tests/fixtures/BG01/small.png'));await expect(page.getByTestId('background-panel').getByRole('alert')).toContainText('SHA');expect(await hash(page)).toBe(initialHash);
  const id=Object.keys(map.backgroundLayers)[0]!,assetId=map.backgroundLayers[id]!.assetId;
  // Explicit named fault copy, not a claim of an error in the real original.
  map=structuredClone(map);map.metadata.name+=' BG01 injected missing raster';map.assets[assetId]!.sha256='0'.repeat(64);
  await importMapUI(page,map);await openPanel(page);await expect(page.getByTestId('background-image-status')).toContainText('图片缺失');expect(await current(page)).toEqual(map);
  await selectResult(page,'node',target.nodeId);await expect(page.getByLabel('X (m)',{exact:true})).toBeEnabled();expect(map.coordinateFrame).toEqual(original.coordinateFrame);
  await screenshot(page,info,'05-missing-image-vector-retained');
});


test('BG01 affine precision, dirty-input save, rotation handle, blur cancellation, asset reuse and explicit replacement',async({page},info)=>{
  await added(page);const base=await current(page),id=Object.keys(base.backgroundLayers)[0]!;
  const fault=structuredClone(base);fault.metadata.name+=' BG01 affine manual test';const t:[number,number,number,number,number,number]=[0.123456789012345,0.07,0.2,-0.3,40,200];fault.backgroundLayers[id]!.imageToWorld=t;fault.backgroundLayers[id]!.method='manual';
  await importMapUI(page,fault);await openPanel(page);await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await page.getByRole('button',{name:'调整底图',exact:true}).click();await page.getByLabel('底图 X (m)',{exact:true}).fill('41');
  await page.keyboard.press('Control+s');const chooser=page.getByRole('dialog',{name:'选择保存目标',exact:true});if(await chooser.isVisible())await chooser.getByRole('button',{name:'仅保存浏览器恢复',exact:true}).click();
  await page.getByRole('dialog',{name:'有未应用输入',exact:true}).getByRole('button',{name:'应用后保存',exact:true}).click();
  let map=await current(page);expect(map.backgroundLayers[id]!.imageToWorld).toEqual([...t.slice(0,4),41,200]);preservedVectors(fault,map);
  await page.getByRole('button',{name:'适应底图',exact:true}).click();
  let f=backgroundFrame(map.backgroundLayers[id]!.imageToWorld,1420,1340);const c=await projectPoint(page,f.center),p0=await projectPoint(page,f.corners[0]),p1=await projectPoint(page,f.corners[1]);
  const top={x:(p0.x+p1.x)/2,y:(p0.y+p1.y)/2},norm=Math.hypot(top.x-c.x,top.y-c.y);const r={x:top.x+(top.x-c.x)/norm*32,y:top.y+(top.y-c.y)/norm*32};
  const angle=Math.PI/18,dx=r.x-c.x,dy=r.y-c.y,end={x:c.x+Math.cos(angle)*dx+Math.sin(angle)*dy,y:c.y-Math.sin(angle)*dx+Math.cos(angle)*dy};
  const history=await count(page);
  await page.evaluate(()=> { const probe: number[][]=[]; (window as unknown as {bg01Mouse:number[][]}).bg01Mouse=probe; window.addEventListener('mousedown',e=>probe.push([e.clientX,e.clientY]),{once:true}); window.addEventListener('mouseup',e=>probe.push([e.clientX,e.clientY]),{once:true}); });
  await page.mouse.move(r.x,r.y);await page.mouse.down();await page.mouse.move(end.x,end.y,{steps:20});await page.mouse.up();
  const native=await page.evaluate(()=>(window as unknown as {bg01Mouse:number[][]}).bg01Mouse);
  const nativeAngle=Math.atan2(c.y-native[1]![1]!,native[1]![0]!-c.x)-Math.atan2(c.y-native[0]![1]!,native[0]![0]!-c.x);
  const rotated=await current(page);f=backgroundFrame(rotated.backgroundLayers[id]!.imageToWorld,1420,1340);expect(f.rotationRad).toBeCloseTo(Math.atan2(t[1],t[0])+nativeAngle,9);expect(await count(page)).toBe(history+1);
  await page.getByRole('button',{name:'适应底图',exact:true}).click();const mid=await projectPoint(page,f.center),beforeBlur=await hash(page),historyBlur=await count(page);
  await page.mouse.move(mid.x,mid.y);await page.mouse.down();await page.mouse.move(mid.x+20,mid.y+20,{steps:10});await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.mouse.up();expect(await hash(page)).toBe(beforeBlur);expect(await count(page)).toBe(historyBlur);
  await page.getByRole('button',{name:'完成调整并锁定',exact:true}).click();
  await page.getByRole('button',{name:'删除此底图',exact:true}).click();const deleted=await current(page);expect(Object.keys(deleted.backgroundLayers)).toHaveLength(0);
  await page.getByTestId('background-file-input').setInputFiles([imagePath,calibrationPath]);await page.getByRole('button',{name:'添加此底图',exact:true}).click();await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');map=await current(page);expect(Object.keys(map.assets)).toHaveLength(Object.keys(base.assets).length);
  const replacementBefore=map,replaceId=Object.keys(map.backgroundLayers)[0]!;
  await page.getByTestId('background-replacement-input').setInputFiles(resolve('tests/fixtures/BG01/small.png'));await expect(page.getByRole('button',{name:'明确替换此图片',exact:true})).toBeVisible();expect(await current(page)).toEqual(replacementBefore);
  await page.getByRole('button',{name:'明确替换此图片',exact:true}).click();map=await current(page);expect(map.backgroundLayers[replaceId]!.imageToWorld).toEqual(replacementBefore.backgroundLayers[replaceId]!.imageToWorld);expect(map.backgroundLayers[replaceId]!.method).toBe('manual');expect(map.backgroundLayers[replaceId]!.assetId).not.toBe(replacementBefore.backgroundLayers[replaceId]!.assetId);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(replacementBefore);await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');await screenshot(page,info,'06-affine-history-and-replacement');
});


test('BG01 calibrated raster pixels stay aligned across camera zoom/pan; hidden and locked are independent',async({page},info)=>{
  const {original}=await added(page);const map=await current(page),startHash=await hash(page),initialCount=await count(page);
  const raw=(await readFile(imagePath)).toString('base64');
  await page.evaluate(async raw=>{const image=new Image();image.src='data:image/jpeg;base64,'+raw;await image.decode();(window as unknown as {bg01Reference:HTMLImageElement}).bg01Reference=image;},raw);
  const comparisons:object[]=[];
  for(let step=0;step<4;step++){
    await page.getByRole('button',{name:'适应地图',exact:true}).click();
    const box=await page.getByTestId('map-canvas').boundingBox();if(!box)throw Error('no canvas');
    await page.mouse.move(box.x+box.width*0.45,box.y+box.height*0.35);
    for(let i=0;i<step;i++)await page.mouse.wheel(0,-120);
    if(step){await page.mouse.down({button:'middle'});await page.mouse.move(box.x+box.width*0.45+step*7,box.y+box.height*0.35+step*5,{steps:4});await page.mouse.up({button:'middle'});}
    await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating','false');
    const comparison=await page.evaluate(async()=>{
      await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
      const actual=document.querySelector<HTMLCanvasElement>('[data-testid="map-canvas"] canvas')!,state=document.querySelector<HTMLElement>('[data-testid="camera-state"]')!;
      const scale=Number(state.dataset.scale),x=Number(state.dataset.offsetX),y=Number(state.dataset.offsetY),dpr=actual.width/Number.parseFloat(actual.style.width);
      const expected=document.createElement('canvas');expected.width=actual.width;expected.height=actual.height;const ctx=expected.getContext('2d')!;
      // Independently known CIMC corner contract: pixel (u,v) -> world (u,1340-v).
      ctx.setTransform(dpr*scale,0,0,dpr*scale,dpr*x,dpr*(y-1340*scale));ctx.drawImage((window as unknown as {bg01Reference:HTMLImageElement}).bg01Reference,0,0);
      const got=actual.getContext('2d')!.getImageData(0,0,actual.width,actual.height).data,want=ctx.getImageData(0,0,expected.width,expected.height).data;
      let max=0,samples=0;for(let yy=20;yy<actual.height-20;yy+=31)for(let xx=20;xx<actual.width-20;xx+=29){const index=(yy*actual.width+xx)*4;if(want[index+3]===255){samples++;for(let k=0;k<4;k++)max=Math.max(max,Math.abs(got[index+k]!-want[index+k]!));}}
      return {scale,x,y,dpr,samples,maxChannelDifference:max};
    });
    expect(comparison.samples).toBeGreaterThan(20);expect(comparison.maxChannelDifference).toBeLessThanOrEqual(1);comparisons.push(comparison);
    expect(await hash(page)).toBe(startHash);
  }
  await page.getByRole('button',{name:'调整底图',exact:true}).click();await page.getByLabel('显示此底图',{exact:true}).uncheck();
  await expect(page.getByLabel('显示此底图',{exact:true})).not.toBeChecked();await expect(page.getByLabel('锁定此底图',{exact:true})).toBeChecked();await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-adjusting','');
  await page.getByLabel('锁定此底图',{exact:true}).uncheck();await expect(page.getByLabel('显示此底图',{exact:true})).not.toBeChecked();expect(await count(page)).toBe(initialCount);expect(await hash(page)).toBe(startHash);expect(await current(page)).toEqual(map);
  await page.getByLabel('显示此底图',{exact:true}).check();await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded','1');
  await info.attach('BG01-independent-raster-alignment.json',{body:JSON.stringify({comparisons,originalVectorsUnchanged:true,hashUnchanged:true,hiddenIndependentOfLocked:true},null,2),contentType:'application/json'});
  expect(await readGA01Target(target)).toEqual(original);
});

test('BG01 real CIMC checkpoint save and same-SHA recovery after stored image corruption and deletion', async ({ page }, info) => {
  test.setTimeout(90000); // Full image-byte fault injection and repeated recovery exceed the short-test budget.
  const { original } = await added(page);
  const baseline = await current(page), baselineHash = await hash(page);
  const layerId = Object.keys(baseline.backgroundLayers)[0]!;
  const asset = baseline.assets[baseline.backgroundLayers[layerId]!.assetId]!;
  expect(asset.sha256).toBe(imageSHA);
  const beforeSave = (await storedWorkspace(page)).record!;
  const projectId = beforeSave.projectId;
  const expectedMapJson = beforeSave.draft!.mapJson;
  expect(JSON.parse(expectedMapJson)).toEqual(baseline);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: '选择保存目标', exact: true });
  if (await chooser.isVisible()) await chooser.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click();
  const saved = await checkpoint(page, baselineHash, beforeSave.storageVersion);
  expect(saved.projectId).toBe(projectId);
  expect(saved.storageVersion).toBeGreaterThan(beforeSave.storageVersion);
  expect(saved.checkpoint!.mapJson).toBe(expectedMapJson);
  expect(JSON.parse(saved.checkpoint!.mapJson)).toEqual(baseline);
  const repairs: object[] = [];
  for (const fault of ['corrupt', 'delete'] as const) {
    // This isolated test changes only the current project's asset bytes, never a map record.
    const storedBeforeFault = (await storedWorkspace(page)).record!;
    const mutation = await page.evaluate(async ({ projectId, sha256, fault }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('shipyard-map-projects');
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise<{ fault: string; originalBytes: number[] }>((resolve, reject) => {
          const tx = db.transaction('assetBlobs', 'readwrite'), store = tx.objectStore('assetBlobs');
          const request = store.get([projectId, sha256]);
          const matchingKeys = store.index('sha256').getAllKeys(sha256);
          let originalBytes: number[] | undefined, problem = '';
          request.onsuccess = () => {
            const row = request.result;
            if (!row || row.projectId !== projectId || row.sha256 !== sha256 || !(row.bytes instanceof ArrayBuffer)) {
              problem = 'Expected current-project raster row missing or mismatched'; tx.abort(); return;
            }
            originalBytes = [...new Uint8Array(row.bytes)];
            if (fault === 'delete') store.delete([projectId, sha256]);
            else {
              const bytes = row.bytes.slice(0), view = new Uint8Array(bytes); view[0] = view[0]! ^ 0xff;
              store.put({ ...row, bytes }); // Deliberately invalid signature; declared SHA is unchanged.
            }
          };
          matchingKeys.onsuccess = () => {
            // A valid copy in another test project would mask deletion through shared-SHA fallback.
            if (matchingKeys.result.length !== 1) { problem = 'Recovery fixture has unexpected shared raster copies'; tx.abort(); }
          };
          tx.oncomplete = () => resolve({ fault, originalBytes: originalBytes! });
          tx.onabort = () => reject(Error(problem || String(tx.error)));
          tx.onerror = () => { /* transaction abort supplies the failure */ };
        });
      } finally { db.close(); }
    }, { projectId, sha256: asset.sha256, fault });
    expect(createHash('sha256').update(Buffer.from(mutation.originalBytes)).digest('hex')).toBe(imageSHA);
    expect((await storedWorkspace(page)).record).toEqual(storedBeforeFault);
    await page.reload();
    await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 30000 });
    await openPanel(page);
    await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '0');
    await expect(page.getByTestId('background-image-status')).toContainText(fault === 'delete' ? '图片缺失' : '只支持本地 PNG、JPEG、WebP');
    expect((await storedWorkspace(page)).record!.projectId).toBe(projectId);
    expect(await hash(page)).toBe(baselineHash); expect(await current(page)).toEqual(baseline);
    const historyBeforeRepair = await count(page);
    const recordBeforeRepair = (await storedWorkspace(page)).record!;
    await page.getByTestId('background-relink-input').setInputFiles(imagePath);
    await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
    await expect(page.getByTestId('background-image-status')).toContainText('图片已就绪');
    const historyAfterRepair = await count(page);
    expect(await hash(page)).toBe(baselineHash); expect(historyAfterRepair).toBe(historyBeforeRepair);
    expect(await current(page)).toEqual(baseline);
    expect((await storedWorkspace(page)).record).toEqual(recordBeforeRepair);
    await page.reload();
    await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 30000 });
    await openPanel(page);
    await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
    expect(await hash(page)).toBe(baselineHash); expect(await current(page)).toEqual(baseline);
    const exported = await exportMapUI(page, info, 'BG01-' + fault + '-recovered');
    expect(exported.map).toEqual(baseline); expect(exported.map.coordinateFrame).toEqual(original.coordinateFrame);
    preservedVectors(original, exported.map);
    repairs.push({ fault, projectId, sameImageSHA: imageSHA, hash: baselineHash, historyBeforeRepair, historyAfterRepair, exactMapAndCheckpointPreserved: true, readyAfterReload: true });
  }
  const context = page.context(); await page.close(); const reopened = await context.newPage();
  await readyWorkbench(reopened); await openPanel(reopened);
  await expect(reopened.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
  expect(await hash(reopened)).toBe(baselineHash); expect(await current(reopened)).toEqual(baseline);
  expect((await storedWorkspace(reopened)).record!.projectId).toBe(projectId);
  await screenshot(reopened, info, '07-same-image-relinked-and-reopened');
  expect(await readGA01Target(target)).toEqual(original);
  expect(createHash('sha256').update(await readFile(imagePath)).digest('hex')).toBe(imageSHA);
  await info.attach('BG01-same-SHA-recovery-receipt.json', { body: JSON.stringify({
    originalMapSHA: target.sha256, imageSHA, originalUnchanged: true, closedAndReopened: true,
    checkpoint: { projectId, beforeVersion: beforeSave.storageVersion, afterVersion: saved.storageVersion, contentHash: saved.checkpoint!.contentHash, exactMapJson: true }, repairs,
  }, null, 2), contentType: 'application/json' });
});
