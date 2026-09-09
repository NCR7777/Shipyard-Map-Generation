# M2A.1 双版本与服务目标契约

本文件描述本批实际数据与命令接口；测试结果以阶段报告为准。服务接路诊断不等于 M3A 网络发布，也不执行到达、装卸、排队或资源竞争。

## 版本与旧文件保护

- `schemas/map.schema.json` 保留原 `0.1.0` Schema，`model.generated.ts` 仍由它生成。
- `schemas/map-0.2.schema.json` 定义 `0.2.0`，生成 `model.v02.generated.ts`。`schema:generate` / `schema:check` 同时覆盖两份，不手改生成类型。
- `newMap(id, name, version?)` 默认新建 `0.2.0`；第三参数可明确选择 `0.1.0`。旧图导入、编辑、浏览器草稿恢复及导出保留原版本，不自动迁移。
- `0.1.0` 仍拒绝 `zoneId`、`arrival` 等未定义字段。未来版本拒绝。规范化键序、数组顺序和除 revision 外的 SHA-256 摘要算法没有改变；未经编辑的旧图规范 JSON 和内容摘要保持一致。
- `upgradeSchema` 是显式原子命令，只把 `schemaVersion` 从 `0.1.0` 改为 `0.2.0`，并按普通事务增加一次 revision。`schemaUpgradeChanges` 与成功结果的 `migrationChanges` 列出这两个字段的实际前后值。重复升级已经是 `0.2.0` 的图为无修改结果。
- 原节点、实体 ID、几何、来源、资产和合法扩展完整保留，不推断区域、入口、到达语义，也不更改 layoutBasis。升级带受保护实体的图只允许这项版本操作，升级后原只读能力门禁仍有效。普通编辑不能借此绕过资源、转向、底图或未知行为保护。

浏览器升级前应保留原工程备份，确认差异后通过同一领域命令提交；撤销升级恢复完整旧版本。保存到 IndexedDB 的是版本化完整 JSON，存储 CAS 版本不是地图 schemaVersion，二者不混用。

CLI 使用新路径输出，不原地覆盖：

```text
npm run map:migrate -- examples/M2A_synthetic.map.json my-upgraded.map.json
npm run map:validate -- my-upgraded.map.json
```

输入及输出路径都必须明确；同路径、解析后同一目标或已经存在的输出拒绝，且使用独占创建防止检查后的覆盖竞争。非法地图退出 1，文件/参数/路径错误退出 2，成功退出 0。成功报告包括源文件 SHA-256、迁移前后内容摘要、输入/输出路径及实际差异；迁移也只调用 `loadMap`、`applyMapCommand(upgradeSchema)` 和 `serializeMap`。如果新输出写入中途失败，可能留下不完整的新文件，错误会明确提示；输入文件保持不变。已经是 0.2.0 的输入可显式复制至新路径，差异为空。

## 服务能力、归属与到达声明

`kind` 仍是本批唯一服务能力：loading / unloading / parking / berth / other。本批没有并列的 supportedOperations，也不以复制同址点创建额外服务容量。多操作和共享资源执行属于后续契约。

`ServicePoint.zoneId?` 是 0.2.0 新增的可选主归属，与 `facilityId` 互斥。区域归属不能同时引用设施 `accessPointId`。设施入口仍必须与显式设施归属一致；缺归属可存为草稿并提示。Zone 没有新增可编辑成员数组，`zoneServicePointIds(map, id)` 和 SceneSnapshot 的区域成员列表由服务点主归属派生。几何覆盖和名称相同不建立归属。

`arrival?` 是 0.2.0 新字段，缺失表示未声明并显示草稿诊断，不自动补默认值：

```json
{
  "mode": "node_proxy",
  "transferAssumption": "excluded_from_model",
  "note": "synthetic：本次研究不建模入口后的场内转运。"
}
```

`node_proxy` 把 `nodeId` 作为业务地点的节点级代理；transferAssumption 只能是 `included_in_service_duration` 或 `excluded_from_model`，必须写非空说明。该声明不填服务秒数、不保证入口可达，也不认定已经完成服务。位于 workshop 厂房多边形内部的代理会提示核对位置；边界代理不要求为通过检查伪造室内道路。

```json
{
  "mode": "explicit_internal",
  "entryNodeId": "node_zone_entry",
  "internalPath": [
    { "roadId": "road_internal", "direction": "forward" }
  ]
}
```

`explicit_internal.internalPath` 是用户明确声明的有序 ArcRef，引用既有道路，不是另一份坐标几何。设施服务点必须使用同设施的 accessPointId，其节点就是唯一入口，禁止额外 entryNodeId；区域或独立服务点须明确 entryNodeId。缺入口或空路径可存草稿但标 blocked；道路/节点引用悬空、明确禁止的方向、端点 ID 不连续、错误首尾或已声明禁止转向是硬错误。单条声明最多 2048 弧，长度由道路实时派生。整图接续检查预算为 2000000 个几何线段、服务点×道路及内部弧×转向组合，超过明确报错，不以跳过检查充当成功。

没有寻找最短路、自动补路或默认开放路口。未知方向不能确认为可行；没有转向发布时，即使几何连续也保持 unchecked。区域是水域、禁入、障碍或声明 forbidden 通行时，服务点可保留为草稿，但诊断普通陆运接入不支持；不因 kind=berth、说明文字或新增服务点修改区域通行规则，也没有无实现的安全豁免。

## 区域闭包与内部路径引用

区域整体平移/旋转新增 `zoneMovePolicy`，枚举与设施一致：`boundaryOnly` / `withAssociatedNodes`。只有区域已拥有服务点时必须明确策略；无成员的旧区域命令保持兼容。后者移动服务点 nodeId 对应节点，共享节点只移动一次，相邻道路端点随权威节点派生。显式接续起点是路网身份，未显式选中时不会仅因移动服务位置而搬动入口。

`selectionImpact(map, selection, facilityPolicy?, zonePolicy?)` 返回移动闭包和影响道路。复制闭包增加所选区域的服务点、权威节点和内部声明的显式入口节点，但不自动复制路网；有内部 ArcRef 时，必须把全部被引用道路明确选入复制范围，否则拒绝复制。复制后道路/入口节点引用均重映射。单独复制区域服务点需要 `associationPolicy: 'retainOwner'`；旧 `retainFacility` 仅授权保留设施归属。

删除有成员点的区域必须指定 `zonePolicy: 'withAssociatedPoints'`；节点清理沿用 keep / deleteUnused，点的显式 entryNodeId 也纳入 deleteUnused 候选，仍有外部道路、点或内部入口引用的节点保留。内部声明引用道路时，删除道路或拆分道路会拒绝；本批不猜测如何重写到达声明。所有失败保持原图与历史。

## 诊断接口与明确限制

批量 `inspectServiceConnections(map)` 在本次计算内对道路长度按 ID 缓存，同一路重复出现在多条声明中不会重复遍历全部折点；缓存不写回地图。

`inspectServiceConnection(map, servicePointId)` 返回 `ServiceConnectionSummary`：主归属、目标节点、显式 incidentRoadIds、arrivalMode、internalPathStatus、可获得的 internalPathLengthM、结构化 issues 和 unchecked。

`status` 只有 `blocked` / `unchecked`，没有 reachable / simulation-ready。`internalPathStatus: 'continuous'` 仅表示声明的道路几何及端点 ID 连续；全网外部接入、必要转向、净空/承载及资源执行仍未发布。节点落在道路中部不算端点，相交和同址不同 ID 不自动合并，服务点与入口之间不能瞬移。

纯核心仍不导入 DOM、React 或渲染器。场景坐标只从 nodes 和道路/多边形权威几何派生。M3A 的任务状态机、运行时服务时长、资源队列、货物守恒和事件日志不属于本批实现；M2B 底图/ZIP 也未实现。
