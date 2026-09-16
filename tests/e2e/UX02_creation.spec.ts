import { expect, test, type Page } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { newMap, newNode, newRoad, newFacility } from '../../src/domain/factory';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, selectResult, exportMapUI, expectVisiblePosition } from '../helpers/RF01_workbench';
function fixture() {
  const map = newMap('UX02_synthetic_creation', 'UX02 synthetic association acceptance'); map.schemaVersion = '0.2.0';
  map.nodes.a = newNode([0,0,0], '公共南端'); map.nodes.b = newNode([0,100,0], '公共北端');
  map.roads.public = newRoad('a','b',[], '公共道路'); map.roads.public.direction = 'both';
  map.facilities.workshop = newFacility({ outer: [[20,20,0],[60,20,0],[60,60,0],[20,60,0],[20,20,0]], holes: [] }, 'UX02测试厂房', 'workshop');
  return map;
}
async function current(page: Page): Promise<YardMap> { await browserSaved(page); return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson); }
async function clickWorld(page: Page, x: number, y: number) {
  const point=await expectVisiblePosition(page,[x,y,0]);await page.mouse.click(point.x,point.y);
}
test('UX02 atomic canvas entrance, explicit turns and service handoff survive history and JSON', async ({page}, info) => {
  const errors:string[]=[]; page.on('pageerror', e=>errors.push(e.message));
  await readyWorkbench(page); const original=fixture(); original.resources.shared={name:'synthetic shared work capacity',kind:'loading',capacityUnit:'vehicle',capacity:{state:'known',value:2},controlModel:'shared_capacity',appliesTo:[{entityType:'facilities',entityId:'workshop'}],provenance:{category:'synthetic'}}; await importMapUI(page,original);
  await selectResult(page,'facilities','workshop'); await page.getByRole('button',{name:'添加入口',exact:true}).last().click();
  await page.getByRole('button',{name:'单个入口与接路设置',exact:true}).click();
  await page.getByRole('dialog',{name:'添加入口',exact:true}).getByLabel('名称',{exact:true}).fill('东侧接入口');
  await page.getByRole('button',{name:'在画布放置入口',exact:true}).click(); await clickWorld(page,20,30);
  await page.getByRole('button',{name:'在画布选择接入道路',exact:true}).click(); await clickWorld(page,0,30);
  await page.getByLabel('新接入段方向',{exact:true}).selectOption('both'); await page.getByLabel('新接入段宽度 (m)',{exact:true}).fill('4');
  await expect(page.getByRole('region',{name:'关联影响预览'})).toBeVisible();
  const turns=page.getByRole('checkbox',{name:/允许新转向/}); expect(await turns.count()).toBeGreaterThan(0);
  for(let i=0;i<await turns.count();i++) await expect(turns.nth(i)).not.toBeChecked();
  await page.getByRole('button',{name:'仅允许驶入',exact:true}).click(); expect(await turns.evaluateAll(elements=>elements.filter(element=>(element as HTMLInputElement).checked).length)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'清除本次许可',exact:true}).click(); for(let i=0;i<await turns.count();i++)await expect(turns.nth(i)).not.toBeChecked();
  await turns.first().check();
  await page.getByRole('button',{name:'确认关联并创建',exact:true}).click(); await expect(page.getByRole('dialog',{name:'添加入口',exact:true})).toHaveCount(0);
  const afterEntrance=await current(page), apId=Object.keys(afterEntrance.accessPoints)[0]!;
  expect(afterEntrance.nodes.a).toEqual(original.nodes.a);expect(afterEntrance.nodes.b).toEqual(original.nodes.b); expect(afterEntrance.facilities.workshop!.boundary).toEqual(original.facilities.workshop!.boundary);
  expect(afterEntrance.facilities.workshop!.accessPointIds).toContain(apId);expect(Object.keys(afterEntrance.roads)).toHaveLength(3);
  expect(afterEntrance.coordinateFrame).toEqual(original.coordinateFrame);expect(afterEntrance.resources).toEqual(original.resources);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(original);
  await page.getByRole('button',{name:'重做',exact:true}).click();expect(await current(page)).toEqual(afterEntrance);
  await selectResult(page,'facilities','workshop');await page.getByRole('button',{name:'添加作业点',exact:true}).last().click();
  await page.getByRole('dialog',{name:'添加作业点',exact:true}).getByLabel('名称',{exact:true}).fill('边界装载交接');await page.getByLabel('经过入口',{exact:true}).selectOption(apId);
  await page.getByLabel('到达语义',{exact:true}).selectOption('node_proxy');await page.getByLabel('代理到达说明',{exact:true}).fill('synthetic test: 场内短驳计入服务时长，不当作车辆已进入厂房。');
  await page.getByRole('button',{name:'确认关联并创建',exact:true}).click();await expect(page.getByRole('dialog',{name:'添加作业点',exact:true})).toHaveCount(0);
  const afterService=await current(page), sp=Object.values(afterService.servicePoints)[0]!;
  expect(sp.nodeId).toBe(afterService.accessPoints[apId]!.nodeId);expect(sp.arrival?.mode).toBe('node_proxy');expect(sp.resourceIds).toEqual([]);
  // Ordinary explicit_internal flow, including a canvas-selected owned prefix and shared capacity.
  let previous=afterService;
  for (const [index, position] of [[40,30],[40,45]].entries()) {
    await selectResult(page,'facilities','workshop');await page.getByRole('button',{name:'添加作业点',exact:true}).last().click();
    const dialog=page.getByRole('dialog',{name:'添加作业点',exact:true});await dialog.getByLabel('名称',{exact:true}).fill('内部作业 '+index);
    await page.getByLabel('经过入口',{exact:true}).selectOption(apId);await page.getByLabel('到达语义',{exact:true}).selectOption('explicit_internal');
    await page.getByRole('button',{name:'在画布放置作业点',exact:true}).click();await clickWorld(page,position[0]!,position[1]!);
    if(index===0)await page.getByRole('button',{name:'直接从入口连接到作业位置',exact:true}).click();
    else {await page.getByRole('button',{name:'在画布选择连续内部路径',exact:true}).click();await clickWorld(page,30,30);await page.getByRole('button',{name:'返回关联预览',exact:true}).click();}
    await page.getByLabel('新接入段方向',{exact:true}).selectOption('forward');await page.getByLabel('新接入段宽度 (m)',{exact:true}).fill('3');
    await dialog.locator('summary').filter({hasText:/^复用已有资源/}).click();await page.getByLabel('复用已有资源',{exact:true}).selectOption(['shared']);
    await dialog.locator('summary').filter({hasText:/^高级关联声明$/}).click();await expect(page.getByRole('button',{name:'打开高级关联表单',exact:true})).toBeDisabled();
    await page.getByRole('button',{name:'仅允许驶入',exact:true}).click();
    await page.getByRole('button',{name:'确认关联并创建',exact:true}).click();await expect(dialog).toHaveCount(0);
    const next=await current(page), made=Object.entries(next.servicePoints).find(([id])=>!previous.servicePoints[id])![1];
    expect(made.arrival?.mode).toBe('explicit_internal');if(made.arrival?.mode!=='explicit_internal')throw Error('wrong arrival');expect(made.arrival.internalPath).toHaveLength(index+1);
    let node=next.accessPoints[apId]!.nodeId;for(const arc of made.arrival.internalPath){const road=next.roads[arc.roadId]!;expect(road.fromNodeId).toBe(node);expect(road.direction).toBe('forward');expect(arc.direction).toBe('forward');node=road.toNodeId;}
    expect(node).toBe(made.nodeId);expect(next.nodes[node]!.position).toEqual([...position,0]);expect(made.resourceIds).toEqual(['shared']);
    expect(next.resources.shared!.capacity).toEqual(original.resources.shared!.capacity);expect(Object.keys(next.resources)).toEqual(['shared']);expect(next.nodes.a).toEqual(original.nodes.a);expect(next.nodes.b).toEqual(original.nodes.b);expect(next.coordinateFrame).toEqual(original.coordinateFrame);
    for(const [id,value] of Object.entries(previous.servicePoints))expect(next.servicePoints[id]).toEqual(value);
    await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(previous);await page.getByRole('button',{name:'重做',exact:true}).click();expect(await current(page)).toEqual(next);previous=next;
  }
  await page.screenshot({path:info.outputPath('association-canvas.png'),fullPage:true});
  const exported=await exportMapUI(page,info,'UX02-created-synthetic');expect(exported.map).toEqual(previous);
  await page.reload();await expect(page.getByRole('button',{name:'保存工程',exact:true})).toBeEnabled();expect(await current(page)).toEqual(previous);expect(errors).toEqual([]);
});

test('UX02 batch widths have one source, same-value no-op and public internal references are protected', async ({page}, info) => {
  await readyWorkbench(page);const map=fixture(); map.nodes.c=newNode([0,200,0],'公共北端二'); map.roads.second=newRoad('b','c',[],'公共道路二');map.roads.second.direction='both';
  map.sources.old={name:'synthetic old width',category:'synthetic',description:'fixture'};
  for(const road of Object.values(map.roads))road.widthM={state:'known',value:6,sourceRef:'old'};
  await importMapUI(page,map);
  async function road() {await page.getByTestId('object-search').fill('public');await page.getByTestId('road-item-public').click();}
  await road();await page.getByRole('button',{name:'连续路段一起修改',exact:true}).click();await page.getByLabel('统一宽度 (m)',{exact:true}).fill('6');await page.getByRole('button',{name:'应用到这些道路',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'内容未变化，未创建事务。'})).toBeVisible();await expect(page.getByRole('button',{name:'撤销',exact:true})).toBeDisabled();expect(await current(page)).toEqual(map);
  await road();await page.getByRole('button',{name:'连续路段一起修改',exact:true}).click();await page.getByLabel('统一宽度 (m)',{exact:true}).fill('7.5');await page.getByRole('button',{name:'应用到这些道路',exact:true}).click();
  const changed=await current(page);expect(changed.roads.public!.widthM).toMatchObject({state:'known',value:7.5});expect(changed.roads.second!.widthM).toEqual(changed.roads.public!.widthM);expect(Object.keys(changed.sources)).toHaveLength(2);expect(changed.sources.old).toEqual(map.sources.old);
  expect(changed.roads.public!.heightLimitM).toEqual(map.roads.public!.heightLimitM);expect(changed.coordinateFrame).toEqual(map.coordinateFrame);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(map);await page.getByRole('button',{name:'重做',exact:true}).click();expect(await current(page)).toEqual(changed);
  await selectResult(page,'facilities','workshop');await page.getByRole('button',{name:'编辑内部',exact:true}).click();await road();
  await expect(page.getByLabel('道路宽度 (m) 数值',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'删除',exact:true}).click(); const confirm=page.getByRole('button',{name:'确认删除',exact:true}); if(await confirm.isVisible())await confirm.click();
  expect(await current(page)).toEqual(changed);await page.keyboard.press('Escape');await page.screenshot({path:info.outputPath('batch-and-public-scope.png'),fullPage:true});
});


test('UX02 explicit one-way reversal and later-road preset leave existing geometry and hidden limits intact',async({page},info)=>{
  await readyWorkbench(page);const original=fixture();original.roads.public!.direction='forward';original.roads.public!.widthM={state:'known',value:6};
  original.roads.public!.heightLimitM={state:'not_applicable',reason:'synthetic open road'};
  await importMapUI(page,original);await page.getByTestId('object-search').fill('public');await page.getByTestId('road-item-public').click();
  await page.getByRole('button',{name:'反转行驶方向',exact:true}).click();
  await expect(page.getByLabel('道路方向',{exact:true})).toHaveValue('backward');
  await page.getByRole('button',{name:'应用属性',exact:true}).click();
  const reversed=await current(page),expected=structuredClone(original);expected.revision++;expected.roads.public!.direction='backward';expect(reversed).toEqual(expected);
  await page.getByRole('button',{name:'用于随后新建道路',exact:true}).click();const preset=page.getByRole('dialog',{name:'后续新道路预设',exact:true});await preset.getByRole('button',{name:'取消',exact:true}).click();expect(await current(page)).toEqual(reversed);
  await page.getByRole('button',{name:'用于随后新建道路',exact:true}).click();await preset.getByRole('button',{name:'确认使用此预设',exact:true}).click();expect(await current(page)).toEqual(reversed);
  await page.getByRole('button',{name:'节点',exact:true}).click();await clickWorld(page,10,20);await clickWorld(page,10,80);
  await expect(page.getByTestId('node-count')).toHaveText('4'); const beforeRoad=await current(page);await page.getByRole('button',{name:'道路折线',exact:true}).click();await clickWorld(page,10,20);await clickWorld(page,10,80);
  await expect(page.getByTestId('road-count')).toHaveText('2'); const final=await current(page),road=Object.entries(final.roads).find(([id])=>id!=='public')![1];expect(road.direction).toBe('backward');expect(road.widthM).toMatchObject({state:'known',value:6});
  if(road.widthM.state!=='known'||!road.widthM.sourceRef)throw Error('new width source absent');expect(final.sources[road.widthM.sourceRef]!.category).toBe('design_assumption');
  expect(road.heightLimitM).toEqual({state:'unknown'});expect(road.massLimitKg).toEqual({state:'unknown'});expect(road.speedLimitMps).toEqual({state:'unknown'});
  expect(final.roads.public).toEqual(reversed.roads.public);expect(final.coordinateFrame).toEqual(original.coordinateFrame);expect(final.facilities).toEqual(original.facilities);
  await page.getByRole('button',{name:'撤销',exact:true}).click();expect(await current(page)).toEqual(beforeRoad);await page.getByRole('button',{name:'重做',exact:true}).click();expect(await current(page)).toEqual(final);
  expect((await exportMapUI(page,info,'preset-explicit-new-road')).map).toEqual(final);
});
