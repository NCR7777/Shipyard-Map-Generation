# FAST01 本地交换与研究输入

本文件说明已实现的统一曲线、F3 语义补标、研究接入和 F4 外部结果接口。交换文件绑定当前地图快照；所有地图修改都进入原 `MapCommand`、事务历史和保存路径。不会由外部补丁替换地图，也不会另建几何或历史模型。

## 0. 统一几何与旧图迁移

Schema 0.3.0 增加通用建筑 building、未分类区域 unclassified。道路只存一份 geometry：内部 anchors 加 line/cubic spans，spans.length = anchors.length + 1；首尾引用原 nodes。几何控制点和自适应样本均不是路网节点。

0.1/0.2 仍按原版本读取、保存。首次启用新几何或通用类别时明确创建升级副本：原 shapePoints 原值搬到 geometry.anchors，逐段建立 line，revision 加一；坐标框架、实体 ID、道路端点、来源、服务及资源引用保留。升级保留原工程和原文件关系记录，新副本解除原文件写回关联；后续通过“另存为”选新文件。0.3 不同时保存 shapePoints，未提供隐式降级导出。

权威函数集中在 src/geometry/roadPath.ts；渲染、接入、拆路、道路带检查、编译和回放都使用它。三次曲线使用 de Casteljau 控制多边形/弦长界：长度预算 max(0.01 m, 1e-4 × 初始长度上界)，默认空间误差 0.05 m；临界道路带/走廊检查细化至 0.0001 m，不能证明时返回 uncertain。数值配置版本为 world-metre-0.01-1e-4-flat0.05-v1，与视窗 zoom 无关，不表示影像测量精度。

编译入口 npm run map:compile -- map.json --out compiled-map.json，输出文件必须不存在，禁止覆盖输入。编译版本 FAST01.1，profile 为 declared-network-v1；输出米制节点、双向逻辑弧、解析路径、里程表、转向、服务点、共享资源及来源。每个方向的 allowed 为 true/false/null；unknown 不能解释为允许。未知行为扩展保留并标 unsupported_extensions；元数据扩展不改变通行语义。

## 1. 地图与原始影像包

编辑器的 `buildCodexPackage` 导出本地 ZIP，包含以下角色：

| 文件 | 用途 |
| --- | --- |
| `map.json` | 导出时静态地图快照，保留坐标框架、ID、来源和未知值 |
| `compiled-map.json` | 同一快照的有版本派生图和曲线里程表；样本不是路网节点 |
| `drawing-defaults.json` | 当前快速描图默认配置及其设计假设标记 |
| `sources.json` | 地图来源字典 |
| `assets/...` | 资产原始文件字节，具体路径见 `manifest.assets` |
| `overview/<layer>.png` | 原底图上的道路、轮廓与 ID 总览 |
| `calibration/<layer>.json` | 底图资产声明、像素到世界变换、地图哈希和总览缩放 |
| `crops/<layer>/<entity>.raw.png` | 未叠加矢量的原图像素裁片 |
| `crops/<layer>/<entity>.outline.png` | 对应裁片的轮廓、邻域道路和 ID 对照图 |
| `unclassified.json` | 通用建筑/区域及对应原图裁片引用 |
| `semantic_patch.template.json` | 本次地图绑定的空补丁模板 |
| `manifest.json` | 地图绑定、文件字节 SHA、资产映射、裁片矩形及覆盖缺失列表 |

`mapContentHash` 沿用 `src/domain/serialization.ts` 的当前规范化声明数据算法；文件字节 SHA 单独称 `fileSha256`。不能以编辑 JSON 后替换哈希的方式复用旧计划或旧补丁。

`manifest.crops` 同时记录完整图片的 `imageToWorld`、裁片原图像素矩形 `pixelRect`，以及裁片自身像素坐标的 `cropPixelToWorld`。二维仿射数组 `[a,b,c,d,e,f]` 表示 `worldX=a*pixelX+c*pixelY+e`、`worldY=b*pixelX+d*pixelY+f`；地图坐标框架另行声明米制 XY 平面。原始裁片与 ID 对照图必须区分；无校准覆盖的对象列入 `missing`，不得凭空补影像证据。

## 2. 限字段语义补丁

领域入口在 `src/domain/semanticPatch.ts`：

```ts
previewSemanticPatch(map, input: unknown): SemanticPatchPreview
// 标准命令，一次接受所有 ready 项；一项结构错误则整批不执行。
{ type: 'applySemanticPatch', patch: SemanticPatchFile }
```

文件格式严格为：

```json
{
  "formatVersion": "1.0",
  "mapId": "<导出地图 ID>",
  "baseMapContentHash": "<manifest.baseMapContentHash>",
  "patches": [{
    "entityType": "facilities",
    "entityId": "facility_trace_001",
    "field": "kind",
    "before": "building",
    "after": "workshop",
    "origin": "inferred",
    "evidenceGrade": "medium",
    "evidence": "连续屋顶与相邻露天作业区支持厂房用途推测，具体工序未确认。",
    "imageRef": "crops/<实际 layer ID>/facility_trace_001.raw.png"
  }]
}
```

复制 `imageRef` 时必须使用本次清单中的真实文件路径。导入器检查相对路径形式；它不自行访问外部 ZIP，也不把路径字符串的存在当成影像事实已获验证。

仅允许 `facilities`、`zones` 的 `kind` 或 `name`，不接受任意 JSON 路径。实体、字段旧值、地图 ID 和完整内容哈希必须匹配；重复字段、缺失证据、额外字段和未知类别都拒绝。补丁为 1 至 4096 项。

预览中每项状态如下：

| 状态 | 处理 |
| --- | --- |
| `ready` | 高/中证据且未受保护的语义字段，批量接受后保存 |
| `protected` | 人工明确/锁定、测绘字段来源或既有明确类别，保留原值 |
| `low_evidence` | 证据不足，保留通用类别 |
| `semantic_impact` | 区域转为 `drivable`、`forbidden`、`water`、`obstacle` 等会影响运行解释，留给单独研究配置 |
| `unchanged` | 新旧值一致，不创建无效历史 |

不补承载、净高、速度、服务时间、资源容量、真实产能或通行方向；不移动边界、道路、节点和控制点。`building → workshop` 的推测仅作分类及重叠提示，不自动启用人工厂房的硬性穿越阻挡。人工明确的厂房声明仍保留原有保护。

推测元数据存于合法命名空间 `org.shipyard.fast_trace.semantic`，声明为 `{version:'1.0', category:'metadata'}`，实体载荷是 `fields.kind` / `fields.name`。每个字段记录 `origin`、`locked`、`sourceRef`、证据等级/描述/裁片引用和旧新值。对应 `provenance.fieldSources` 指向真实存在的地图来源记录，几何原始来源不被改称测绘。推测来源为 `imagery_derived` 并明确 `origin=inferred`；证据等级不是统计准确率。

`isInferredSemantic(entity, field = 'kind')` 供原场景编译器显示推测标记。通过原属性命令修改类别或名称会记录 `origin=manual, locked=true`，后续模型批次不能覆盖。

## 3. 明确选定目标的研究接入

领域入口在 `src/domain/researchAccess.ts`：

```ts
type ResearchTarget = { kind: 'facilities' | 'zones'; id: string };
prepareResearchAccess(map, targets, {
  landZoneIds: ['<用户明确选择的可行驶陆域 ID>'],
  maxDistanceM: 50, // 可选，默认 50，允许 (0, 1000]
  widthM: 12,      // 可选，新 connector 的设计宽度，不是现场净宽
  transferAssumption: 'excluded_from_model', // 可选默认值
  note: ''
}): ResearchAccessProposal;

// 不传 acceptedTargetIds 时接受本次 ready 项；传入时只接受该子集。
{ type: 'applyResearchAccess', proposal, acceptedTargetIds?: string[] }
```

只有显式选择且已声明 `kind=drivable, passability=allowed` 的陆域可以支撑接入。候选使用真实曲线路径投影，完整短接线必须位于明确陆域，不能穿过设施内部、其他建筑、水域、禁区或孔洞。影像看起来像道路、坐标邻近、轮廓重叠均不自动赋予通行许可。每个目标单独返回 `ready`、`existing` 或 `unresolved` 及原因；预算不足也明确未完成，不伪称无障碍。

接受前重新核对地图 ID、内容哈希和整个建议，并重新计算候选，防止修改预览几何后直接提交。标准事务复用现有拆路、接点、方向兼容转向维护、资源引用及服务路径重映射；批量连接同一道路时保持原始里程映射。曲线拆分保留解析路径，样本只用于候选搜索，不变成节点。原禁转和共享资源容量保留。

设施新增边界交接点与 `node_proxy` 服务点；区域新增同样的代理服务点。它们以 `design_assumption` 来源明确写明未知真实门位和未建模内部路线，不生成假内部运输道路或资源。`transferAssumption` 可为 `excluded_from_model` 或 `included_in_service_duration`；后一选项仍需外部场景提供相应服务时长，不由地图推算。已有服务点/到达语义保留，进入后续检查，不重新生成。所有接受项是一笔可撤销事务。

## 4. 按研究级别检查

```ts
checkResearchInput(map, 'spatial' | 'routing' | 'scheduling', targets, originNodeId?)
```

`spatial` 检查数据、坐标、引用和来源基础有效性，缺少服务时间等调度参数不阻止继续描图。`routing` 检查选定目标的服务点/到达声明，并用既有声明路由检查器核对起点可达性；缺少明确起点时可使用首个选定目标已有服务点的节点，并在报告列出这一实际起点。仅检查该起点到目标的有向路由，不宣称所有目标之间互相可达。

`scheduling` 在上述基础上列出外部场景所需的车辆、任务、速度、日历、服务时间和资源容量。地图单独不能给出完整调度就绪结论。所有级别都不证明车辆扫掠、现场净空、承载或现场作业可执行性。

## 5. 外部调度结果

F4 读取本地文件，在原地图画布叠加车辆、当前道路和活动，不向静态地图写入运行状态。领域入口是 `src/domain/results.ts`，编译版本由 `src/compiler/routing.ts` 的 `COMPILER_VERSION` 导出。

计划、每行事件和汇总都带完整绑定：`{protocolVersion:'1.0',runId,mapId,mapContentHash,scenarioId,scenarioHash,compilerVersion}`。地图哈希使用既有规范化声明数据算法。计划核对当前图和编译版本；事件、汇总核对完整运行绑定。失败保留已有结果；地图内容改变后隐藏旧图叠加。

### 5.1 场景与摘要

`scenario.json` 的合同为：

| 字段 | 内容 |
| --- | --- |
| `protocolVersion,scenarioId` | 协议 1.0 和场景 ID |
| `units` | 固定 `{length:'m',time:'s'}` |
| `vehicles` | `[{id,name?}]`；动态车辆不是地图节点 |
| `tasks` | `[{id,name?,originNodeId?,destinationNodeId?,dueS?}]` |
| `timeWindow` | `{startS,endS}`，结束大于开始 |
| `assumptions` | 假设说明字符串数组 |
| `parameters` | 可选外部调度参数对象 |

文件不自填摘要。loadScenario 递归按字典序排列对象键、保留数组顺序，对紧凑 JSON 的 UTF-8 字节计算 SHA-256；所有 parameters 参与摘要。播放器不把参数存在当作其调度约束已检查。任务节点引用必须存在，车辆、任务 ID 须唯一。

只有计划自填绑定、没有匹配场景文件时仍可查看，但标记 `SCENARIO_CONTENT_UNVERIFIED`，禁止 A/B 差值。有核验场景时，活动车辆、任务、时域和场景摘要均须匹配；未出现在计划里的场景任务逐名提示。

### 5.2 活动与曲线回放

`plan.json` 增加 `source:'synthetic'|'external'`、可选 name 和 activities。每项含 vehicleId、可选 taskId、秒制 t0/t1，且 t1 大于 t0。

| 活动 kind | 位置字段 |
| --- | --- |
| travel | `roadId,direction:'forward'|'backward',s0M,s1M` |
| wait / load / unload | `nodeId` |

里程沿声明的有向弧递增且位于道路范围内。位置、朝向、长度统一使用解析路径和弧长内核；反向弧同时反转路径与切向。行驶区间采用明确标记的匀速显示假设；等待保持节点及可确定的前序朝向。

同车活动重叠拒绝。时间资料缺口保持最近已知位置并标 gap；空间断开提示，不补虚构连接。显式禁转即使隔着等待也拒绝；未声明转向提示不完整，不宣称完全可达。编译器保留 movement.internalPath，本版活动协议尚无独立转向时间和里程活动，因此经过该几何时返回 `RUN_MOVEMENT_GEOMETRY_UNSUPPORTED`。

未支持行为扩展返回 `RUN_UNSUPPORTED_EXTENSIONS`。编译弧保留 ownerEntityId；本版场景只有节点端点，不能继承服务点所有者授权，引用内部道路的计划或事件返回 `RUN_INTERNAL_OWNER_UNSUPPORTED`，不因空间相连推定第三方穿越许可。

### 5.3 离线事件

`events.jsonl` 每个非空行是严格 JSON，含完整绑定及 `entityType:'vehicle',entityId,seq,simTimeS,state`，可附 taskId。seq 为非负整数；state 为 travel / wait / load / unload / idle。位置形式为 nodeId，或 roadId+direction+sM，或当前地图世界米制 position:[x,y,z]（可附 yawRad）。

道路里程与独立坐标同时存在时，必须用 `poseAuthority:'road'|'position'` 指定权威；节点不能与其他位置形式并用。按运行和车辆维护序号；同实体同序号同内容去重，冲突拒绝整批。到达乱序排序并提示；序号递增但时间倒退的样本丢弃并提示；序号缺口保持可见。

事件回放保持最新已提供样本，不插补稀疏样本间的运动。计划与事件共用 RunFrame 和原画布叠加，每车索引避免每帧扫描整个事件文件。

### 5.4 汇总与 A/B

`summary.json` 在绑定外含 `metrics:[{key,value,unit,definition,window,source}]`，value 为有限数或 null，window 为 {startS,endS}。缺值保留 null，不视为零；不从面积、车位数或影像类别猜容量、利用率。

A/B 要求：两个场景内容已核验且相同；地图、编译版本相同；实际任务集合、车辆集合和回放时域相同；指标集合、单位、定义及统计时间窗相同；运行证据类别同为 synthetic 或同为 external。不同求解器的指标 source 字符串可以不同，来源仍保留展示；不同方案可使用不同 runId。

差值为 B-A。任一兼容条件失败或任一值缺失时差值为 null，并列原因。相同场景摘要不能掩盖某方案少做任务。

### 5.5 入口、边界和示例

loadScenario(input) 成功返回 {ok:true,scenario,scenarioHash}。loadRunPlan(map,input,verifiedScenario?)、loadRunEvents(run,jsonlText)、loadRunSummary(run,input) 成功返回 {ok:true,run}，失败返回 {ok:false,issues}，不修改已有运行。

frameAt(run,timeS,{vehicleIds?,taskIds?}) 是确定性的时间到画面计算，返回 {timeS,vehicles,activeActivities,issues}；每车含位置、朝向、状态、当前真实 ResolvedPath 或 null 及 plan/event 来源。compareSummaries(a,b) 返回兼容性、原因与指标差值。

单次输入最多 10 MiB、嵌套最多 64 层；拒绝注释、尾逗号、重复键、非有限数及未知字段。结构、绑定检查集中于输入边界，回放帧不重复全图验证。

makeSyntheticRunFiles(map) 生成可实际导入的 scenario.json、plan.json、events.jsonl、summary.json。界面下载 synthetic-run-example.zip 包含四文件并绑定当前真实地图。优先选现有公开双向曲线，无可用道路则不生成。两车分别正、反向行驶并等待，不虚构掉头许可。固定 5 km/h、时序和指标是 synthetic 协议接入示例，不是优化收益或现场执行证据。

### 局部宽度与人工方向修正

`splitRoadAndSetWidth` 在原道路 from→to 弧长 `distanceM` 处分段，`direction=forward` 改后半段，`backward` 改前半段；自动生成节点和道路 ID，沿用曲线精确拆分、服务路径/转向/共享容量重映射及同一历史事务。`widthM` 为 0.1–1000 m 的有限数，缺少新来源时记录设计假设。只改变所选半段的宽度；新宽度仍须通过既有必要几何保护，错误时原图不变。

手工更改道路方向通过原 updateRoad/updateRoadBatch，实际改变时替换该字段来源为人工设计声明，保留旧 sourceRefs；不改变方向时不生成新 source。不能拿影像宽度来源充作交通方向证据。M 量距、叠放循环和未提交的 R/C 草稿均不进入权威地图。
