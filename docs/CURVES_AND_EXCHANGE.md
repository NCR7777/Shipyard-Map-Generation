# FAST01 技术合同：统一曲线几何与外部数据交换

本文件为拟议合同，需在实现中形成正式Schema/类型/测试；示例片段不等于现有0.2.0地图可直接导入。
主任务见 `FAST_TRACE_SPEC.md`。核查基线：`bcf4ac4ceefedfcbbc769f694211acacb98542b8`。

## 1. 最小但真正可用的曲线表示

选用两种几何span：直线 line、三次Bezier cubic。两者可组成一条道路路径。
不为“直线”“曲线”“画面样条”“路由折线”维护四套权威几何；SVG path / Konva绘图指令均由此派生。

建议0.3.0中以 `geometry` 替换 `shapePoints`，共同使用道路的fromNodeId/toNodeId作为外部端点。

```ts
type Vec3 = [number, number, number];
type RoadSpan =
  | { kind: 'line' }
  | { kind: 'cubic'; control1: Vec3; control2: Vec3 };

type RoadGeometry = {
  kind: 'path';
  anchors: Vec3[]; // 只存内部几何接续点，不存道路首尾，不是网络节点
  spans: RoadSpan[]; // 必须 anchors.length + 1
};

// 道路其他物理、方向、来源和资源字段沿用现有合同。
// 完整几何锚点 = [fromNode.position, ...anchors, toNode.position]
// spans[i] 的起终点就是完整几何锚点[i]与[i+1]。
```

例：起点(0,0)、内部(80,0)、内部(110,30)、终点(110,100)，第一段直线，中间曲线，末段直线：

```json
{
  "kind": "path",
  "anchors": [[80,0,0],[110,30,0]],
  "spans": [
    {"kind":"line"},
    {"kind":"cubic","control1":[96,0,0],"control2":[110,14,0]},
    {"kind":"line"}
  ]
}
```

上例端点和控制点保持世界米制坐标；图中的两个控制柄不进入nodes。若只是一段曲线，则anchors为空、spans只有一个cubic。

### 1.1 向后兼容

保留旧0.1/0.2读取。只读/不使用新功能时允许按旧版本往返。首次使用新几何或通用类别时，提示一次版本升级/保留原件副本；不在每次绘图都确认。
旧shapePoints精确搬到anchors，各span为line；原折角、节点ID、道路ID、属性及引用不变，不趁迁移拉直道路。
新版不同时保存shapePoints和geometry两个可编辑来源。归一读取入口如 `getRoadPath()` 屏蔽版本差异，计算不在各处自行判断版本。
不能把曲线塞入metadata扩展却让旧软件仍按直线读出。明确0.3.0可以阻止旧软件静默误解。
旧版导出曲线只能做显式有误差说明的降级副本：自适应样本作为旧shapePoints，不变成新网络节点。原始曲线地图不覆盖。

新通用 `Facility.kind=building`、`Zone.kind=unclassified` 随0.3一次增加。未知/通用类别仍可绘制保存，不自动变成可通行或测绘类别。

## 2. 几何函数只实现一套

推荐集中暴露：

```ts
getRoadPath(map, roadId): ResolvedPath
pointAt(path, spanIndex, t): Vec3
tangentAt(path, spanIndex, t): Vec3
pathLength(path, tolerance): LengthResult
flattenPath(path, toleranceM): PolylineWithParameterMap
projectToPath(path, point, tolerance): {spanIndex,t,sM,point,offsetM}
splitPath(path, spanIndex, t): [ResolvedPath, ResolvedPath]
poseAtDistance(path, direction, sM): {position,yawRad}
boundsOfPath(path): Bounds
```

函数名可按已有项目习惯调整，功能不能重复分散在renderer、diagnostic和compiler。

三次Bezier：
`B(t)=(1-t)^3P0+3(1-t)^2tP1+3(1-t)t²P2+t³P3`。
首尾切向由相应控制点差得到。退化切向需要用可用邻段/邻参数求方向，不能输出NaN；完全零长度span按无效几何处理。

长度不是首尾弦长，也不是用户屏幕缩放后临时采样的长度。使用自适应数值积分或de Casteljau细分的控制多边形/弦长上下界，返回误差界/收敛状态。
建议计算起始目标：全路长度误差预算 `max(0.01 m, 1e-4×长度估计)`；空间近似误差可从0.05 m开始。这些是软件数值目标，不是卫星影像实测精度。测试后固定为编译配置版本，不要求用户逐条输入。

### 2.1 最近点、拆路、交点

最近点：先用包围盒/展平线段找候选参数区间，再在曲线上细化。自交/回环导致多个很近候选时需选定分支，不凭屏幕重合合并。
拆分：使用de Casteljau分割cubic、在精确曲线位置创建共享节点；保留全部未分割span，重建左右路径；几何形状保持，不直线近似后当成精确分割。
交点：展平可做候选，必须保留样本对应span/t，细化并用世界坐标容差核验；不能只在图上画交点却不拆路、也不能把所有采样折角建立为节点。

### 2.2 对编辑器友好的操作

“拖直线中点变弯”：设用户拖到的曲线上中点为M，两端A、B。可先用二次控制点 `Q=2M-(A+B)/2`，再转换成cubic：`C1=A+2/3(Q-A)`，`C2=B+2/3(Q-B)`。这是便捷初形，后续可编辑切向柄；不要求用户理解公式。
移动某几何锚点时，相邻控制柄默认随该点平移，保持局部形状意图。拖路网共享节点仍要维护其相邻道路；用户只改某一曲线的形状，不把不相关曲线一起自动圆滑。
移动全部道路路径时，节点、内部锚点、控制柄只变换一次，不重复变换。
反向读取cubic时顺序为 `(P3,P2,P1,P0)`；方向反转不应漏交换两个控制点。

## 3. 连接、平滑和车辆可行性必须分开

**G0几何连续**：两段端点同坐标。
**拓扑连续**：道路通过共享nodeId及允许转向相接。只有前一项不代表后一项。
**G1视觉平滑**：进出切线方向一致；同向直—曲接续可默认保持，不强制路口的所有分支相切。
**具体车辆可行**：还需车身/货物、转弯半径、道路带、作业净空等；本轮不要把G1或半径提示冒充完整扫掠验证。

直线接曲线、曲线接曲线、在曲线中部接支路，均复用同一拆路/共享节点/turn命令。
道路有路口或宽度/限制变化时才分成多个拓扑road；纯line/cubic形状切换可以留在同一个road geometry里。
已有路口的显式禁转不能被新建默认覆盖。新描同层平交可在已启用profile下展开明确的非掉头turns，来源为设计假设。
需要保留的资源引用不能因为拆路被复制为两份独立容量。正向服务内部路径旧弧替换为左→右，反向为右→左；转向按真实路口端部映射，而不是复制到所有子段。

## 4. 道路带和显示一致性

渲染精确line/cubic，并以本地宽度乘相机scale画等宽stroke。粗略全图视图可用较粗显示采样，但这些样本不改变计算结果。
派生物理道路带来自同一中心线和widthM；既有人工corridorPolygon则仍是独立声明，有几何修改时需更新/提示不一致，不能悄悄丢掉。
展平进行碰撞检测时要考虑展平误差：可以保守膨胀误差包络做快速排除，再对临界候选细化。接近边界且误差不足以判断时返回“需细化/未确认”，不要报告假零冲突。
包围盒只能排除远对象；不能把轴对齐矩形当道路带做最终相交或面积计算。固定端帽/连接约定并使渲染与检查可解释，路口处并集重叠本身不一定是错误。
宽度是声明/估计整段横向宽度，不是默认单车道净宽。用户沿卫星底图拖出的宽度标“人工影像估计”；原有实测或未知值在不编辑时保留。

## 5. 编译与统一缓存

编译输入固定mapContentHash、compilerVersion、geometryToleranceVersion、所选profile。输出节点/有向弧、真实路径长度、转向、服务到达、资源与未知限制。
采样累计里程表 `{spanIndex,t,sM,position}` 为派生缓存，外部Node/Python可以直接消费，避免强制它们依赖浏览器。
采样表不能作为编辑几何回写；每条弧仍是一个逻辑道路方向，不把样本当调度节点。
未来提高采样精度只改变编译版本/配置或输出摘要，不擅自改地图ID或产生新路口。
mapContentHash沿用当前仓库算法；文件字节SHA单独命名。不要新增三个互相矛盾的“有效hash”。分类改变会改变声明数据hash，旧计划仍绑定旧图，不能只替换hash。

## 6. Codex语义补丁合同

最小文件建议：

```json
{
  "formatVersion":"1.0",
  "mapId":"MAP_EXAMPLE",
  "baseMapContentHash":"<实际导出时填入>",
  "patches":[{
    "entityType":"facilities",
    "entityId":"F_001",
    "field":"kind",
    "before":"building",
    "after":"workshop",
    "origin":"inferred",
    "evidenceGrade":"medium",
    "evidence":"较大连续屋面且与露天构件区相邻；具体工序不可确认",
    "imageRef":"crops/F_001.raw.jpg"
  }]
}
```

只允许已实现的语义字段/值。几何、ID、资源、宽度、方向、坐标框架不在语义补丁允许名单内。
不是任意JSON Patch执行器，不允许任意路径写入。对应kind或用途变化若触发运行语义，需要单独影响预览/显式研究配置。
同一base下批量apply是一次可撤销事务；内部转换成标准命令并记录来源；用户已确定字段优先。
不要把证据等级写成“模型98%准确”。不能验证的具体用途保持generic，推测值保留inferred标签。

## 7. 调度数据不要塞进地图

### 7.1 文件角色

`map.json`：静态语义主数据。
`compiled-map.json`：有版本的派生图及曲线表。
`scenario.json`：任务、车队、载荷/车型、时窗、资源规则、速度和服务假设。
`plan.json`：外部求解器输出的每车活动序列。
`events.jsonl`：外部运行/仿真过程消息。
`summary.json`：同run的指标与口径。

计划/事件文件可以先选一种作必需入口，另一种作为相同结果模型的适配器；不建设两个独立播放器。

### 7.2 最小计划示意

```ts
interface RunBinding {
  protocolVersion: '1.0';
  runId: string;
  mapId: string;
  mapContentHash: string;
  scenarioId: string;
  scenarioHash: string;
  compilerVersion: string;
}

type Activity =
  | { kind:'travel'; vehicleId:string; t0:number; t1:number;
      roadId:string; direction:'forward'|'backward'; s0M:number; s1M:number }
  | { kind:'wait'|'load'|'unload'; vehicleId:string; t0:number; t1:number;
      nodeId:string; taskId?:string };
```

时间单位模拟秒，`t1>t0`。`sM`为当前行驶方向从该弧起点的累计米数，范围[0,L]；反向读取底层路径时使用 `L-sM` 并将切线反向。
动态vehicleId来自车队/场景，不要求出现在静态map.nodes里。稳定设施/道路/服务点ID才能直接引用地图对象。
跨相邻travel活动检查允许转向、端点和时间连续性；如果中间路径缺失，不以直线插值补出穿楼运动。跨路口的零位移转向是点网络显示，不声称是真车扫掠。
对存在明确turn内部几何的地图，编译器应保留并给回放使用；尚不能消费时明确限制，不假称完全还原。

### 7.3 在线消息预留，不先造服务端

可以定义同一个输入口：
`{...binding, entityType:'vehicle', entityId, seq, simTimeS, state, roadId?, direction?, sM?, position?}`。
每run/每实体序号去重；地图或场景hash不匹配拒绝覆盖当前图；车辆路段里程与独立pose若同时存在必须明确哪个权威。
乱序/缺段用最近有效状态和“资料缺口”提示，不偷偷补造运输任务。首期文件回放即可测这一逻辑，之后WebSocket只是运输层。

### 7.4 按弧长驱动，不按Bezier t匀速

区间均速显示：`s=s0+(s1-s0)*(time-t0)/(t1-t0)`，然后查累计里程表并细化t，计算position和切线yaw。
如果外部提供速度/位置采样，以其为准。固定区间匀速只是显示假设，UI标注一次即可。
wait/load/unload区间位置保持；拖动时间轴使用同一纯函数重建状态，不靠“上一帧”的副作用，保证可重放和可跳转。

### 7.5 结果指标

优先展示外部已给指标；每项包含key、value或null、unit、definition、window和source。缺值不填0。
如由事件派生，明确完成数量、迟交基准、等待时间、运输距离的算法。
利用率涉及资源容量时，应使用同一时域内capacity-time分母及占用语义，不能简单把多容量资源占用事件数相加。
比较A/B只在地图/场景/时域/指标口径可比时显示差值；不把计划动画顺滑视为结果更优。

## 8. 必要测试，而非无限防御

真实曲线至少测试：端点、切向、长度、细分重组、反向、投影、按里程行走、T接入、引用保持、变宽、跨曲线转向、道路带与建筑临界关系。
纯线旧图迁移前后几何与拓扑等价；改名/调透明度不使曲线控制点发生舍入漂移。
语义补丁至少测试字段白名单、过期base、人工覆盖保护和几何不变。
回放至少测试暂停/跳转、曲线近匀速、反向yaw、等待、hash失配及缺段。
复用现有测试框架。明确输入边界和事务不变量即可，不必每个内部纯函数堆重复Schema或异常恢复代码。
