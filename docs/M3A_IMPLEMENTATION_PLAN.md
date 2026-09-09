# M3A 网络发布与到达—服务验证实施计划

日期：2026-09-09。状态：**计划，尚未实现或验收**。本轮只实施 M2A.1；本文件不是仿真支持声明。依据为 `Shipyard_M2A_Review_Service_Nodes_Next_9244a61.md`，沿用已有纯领域、命令、保存、Schema 与适配器边界。M2B 底图/ZIP 可独立开展，不作为 synthetic 小路网验证的前置条件。

## 1. 交付顺序与进入条件

| 子批次 | 实际工作与拟交付文件 | 退出门槛 |
|---|---|---|
| M3A-0 数据合同 | 新建 scenario Schema、生成类型、资源能力矩阵和运行事件协议 ADR；冻结版本迁移、场景摘要、运行配置和缺失参数政策 | Schema/语义反例、旧地图往返及能力门禁回归通过，独立审查批准合同 |
| M3A-1 服务目标解析与路径 | `src/compiler/network.ts`、`src/topology/routes.ts`；编译道路弧、转向、服务点入口和内部路径；新增 `map:compile` CLI | 方向/转向/断路/同址不同 ID/道路相交/内部接续反例通过；不得由 UI 预览代替无 DOM 验证 |
| M3A-2 必要资源编译 | `src/compiler/resources.ts`；先支持车辆数容量的作业位和明确等待位，绑定已有资源 ID；接入领域命令、引用编辑、复制删除与校验 | 同一 resourceId 只有一个容量账本；未实现容量单位、控制模式或扩展明确 unsupported；通过后按能力精确解除门禁 |
| M3A-3 无 DOM 单车单任务 | `src/simulation/engine.ts`、`events.ts`、`service.ts`；固定时长、非抢占服务、确定性事件队列；新增 `scenario:validate`、`simulation:run` CLI | 单任务到达、等待、开始、完成、货物转移和失败测试通过；运行前后 map 摘要相同 |
| M3A-4 双车与日志 | 共享作业位竞争、合法等待/阻塞测试、事件 JSONL 与纯回放 reducer；最后才接可选二维运行面板 | 资源容量守恒、货物单一持有、无渲染确定性和速度无关性通过，独立审查后交付 |

每一批单独记录实际命令、输出、失败修正、代码版本与审查裁决。计划中的 CLI 当前不存在，不能现在调用并解释为成功。不得因一辆图标会移动而跳过前两批编译门槛。

## 2. 三层权威数据

以下为待冻结的合同方向，不是当前可导入的新字段格式。

- `map.json`：节点/道路/入口/服务点/区域和名义资源能力。目标使用 servicePointId，位置只从其 nodeId 获取。保留来源、arrival、显式内部路径。地图中不写任务、占用、排队人数或剩余作业秒数。
- `scenario.json`：scenarioId/schemaVersion、mapId/mapContentHash、seed、车辆初始节点与载荷、货物与任务、放行时间、速度/服务时长假设、工作窗、排队及占位策略。任务包含 originServicePointId 和 destinationServicePointId；起点要求 loading、终点要求 unloading。缺失速度、服务时间、可用容量或源数据时，拒绝运行所选配置，或先要求有来源的显式假设。
- 运行档案：runId、scenario 摘要、地图摘要、compilerVersion/engineVersion、模型配置和原始输入快照索引；独立 events.jsonl 与 runtime/replay。编辑地图只生成新版本，旧日志仍指向原摘要。

当前服务能力只有单一 `kind`。M3A-0 决定是否引入 supportedOperations；若引入，必须显式迁移旧 kind 并移除其独立可编辑权威。若继续单能力，同址 loading/unloading 两点必须绑定同一个作业资源，不能通过复制服务点扩增实体设备容量。

## 3. 服务点可达性编译

1. 用共同 loadMap/validateMap 路径读取地图，冻结规范化快照。编译结果包含 mapContentHash、compilerVersion、profile、已检查/未检查项及结构化问题。结果必须对应完整声明数据，不能只依赖 revision。
2. 道路弧只由 fromNodeId/toNodeId、内部折点与 direction 推导。未知方向阻止发布；不把相交、贴近或同址不同 ID 当作连通。不保存第二套可编辑长度或图。
3. 转向可用性必须有来源：优先显式 movements；允许另一个**用户明确选择、命名并写入编译配置**的简化转向 profile。无配置时不默认为全可转。简化 profile 只证明声明模型的连通，不证明实际转弯可行。
4. `node_proxy` 的运输路径终止于服务点 nodeId。代理点关联某建筑不要求把终点移到中心；场内转运按 arrival.transferAssumption 与场景服务时长来源核对，明确纳入服务或排除，不重复计时。
5. `explicit_internal` 先到设施 accessPoint.nodeId，或 Zone/独立服务点声明的 entryNodeId，再按有序 internalPath 到目标 nodeId。M2A.1 的局部引用连续性只是输入条件；M3A 还要检查公共路径衔接与所有必要转向。单有 accessPointId 不能生成零时间瞬移。
6. 设施边界交叉按声明入口/内部通路分析；不能无条件穿越，也不能把一切设施内道路都拒绝。未实现车辆/货物包络、净高、承载或转弯扫掠时列 unchecked，不能发布“真实运输安全”证书。若所选运行 profile 依赖该项则返回 unsupported。
7. 空路径只在车辆当前节点等于目标 nodeId 且任务阶段、目标 servicePointId 匹配时可接受。经过同节点上的另一个服务点不触发本任务装卸。

## 4. 资源、等待与占用

沿用 `resources` 身份与名义容量，不按每个服务点复制一个账本。首轮限定 capacityUnit=vehicle、known 正整数容量和已实现的 exclusive/shared_capacity 子集；kg、area_m2、directional_exclusive、路口尾部清空等逐项标 unsupported，不能一起解锁。

编译时核对 ServicePoint.resourceIds 与 appliesTo、共享作业位、等待点的引用及物理/逻辑排队声明。业务开始采用一次原子资源申请；多资源全部满足才分配，失败时不持有部分设备等待，避免首版引入 hold-and-wait 死锁。FCFS 同刻以明确的序号/稳定 ID 排序，不依赖对象遍历、线程或渲染顺序。

两类队列必须分开：

- 纯资源单元测试可明确选逻辑队列，忽略车辆转场；该结果只用于队列语义验证。
- 空间运行必须声明合法等待节点/缓冲区容量、从等待位到服务位的路径和进入许可。等待位满则保留车辆在合法上游位置并报告阻塞；不得删除车辆或在同一位置无限叠放。

服务结束释放设备，车辆离开服务位后释放空间占位。两者是不同事件；若出口堵塞，车辆不能被从占位账本中提前清除。非抢占服务需在开始前确认工作窗能覆盖完整时长；本批先拒绝不可预测的中途停机配置，后续再设计可中断服务，不偷偷忽略故障。

## 5. 纯事件引擎

计划状态序列：

```text
TO_PICKUP → ARRIVED_PICKUP → WAITING_TO_LOAD（按需）
          → LOADING → LOADED → TO_DROPOFF
          → ARRIVED_DROPOFF → WAITING_TO_UNLOAD（按需）
          → UNLOADING → COMPLETED
```

有实际等待位时进一步区分 ARRIVED_QUEUE 与 ARRIVED_SERVICE。状态转换由带精确 simulationTime（秒）的事件决定。事件队列按时间、确定的优先级和 sequence 排序；同刻资源释放/请求的先后规则写入协议和测试，不能靠动画碰撞或 requestAnimationFrame 的采样触发。

事件合同拟包含 protocolVersion、runId、eventId、sequence、simulationTime、occurredAt/observedAt、taskId、vehicleId、servicePointId、nodeId、operation、stage、type、causeEventId，以及 map/scenario 摘要引用。到达、等待、service_started、service_completed、departed、blocked/failed 分别记录。未声明消息延迟时 occurredAt=observedAt；有延迟的场景需单独定义观察与执行时钟，不提前使用未来观察。

幂等键至少覆盖 run/task/stage/目标/事件种类。重复到达不能再次申请资源，重复完成不能重复增减货物。cargo 始终只有一个持有者：装载开始仍在来源位置，装载完成转移到车辆；卸载完成转移到目标位置，随后才按任务规则完成。空车卸载、不匹配目标、未放行或货物不可用都有可定位的拒绝原因。

当前 RuntimeStateMessage 0.1.0 只有位姿合同，不足以代表这些业务事实。M3A-0 应增加版本化事件联合类型，并将 SimulationAdapter 的 unknown 输入替换成经过编译的合同；由引擎事件派生位姿/统计。RenderAdapter 可省略，不能反向修改业务状态。不得用空函数返回成功来填满接口。

## 6. 可复现实验与验收

| 用例 | 断言及证据 |
|---|---|
| 单车单任务 | synthetic 明确速度、道路长度和固定服务时长；核算出行/等待/装卸分别耗时；到达时任务未完成，卸载结束才完成 |
| 同址两个服务点 | 当前阶段目标 ID 精确匹配；路过同址错误服务点不触发业务；共享资源账本不重复 |
| 双车资源 FCFS | 纯资源模型：请求时间 0/30 s、服务 120 s、capacity=1、忽略转场；开始 0/120 s、完成 120/240 s。测试名与输出必须标注 logical_queue/synthetic |
| 双车空间等待 | 使用显式等待节点、路径、占位容量；服务位未许可不进入；等待区满保留上游阻塞；离开后才释放空间 |
| 异常与守恒 | 禁止转向、未知方向、内部断路、缺资源/参数、工作窗不足均拒绝或明确等待；资源使用不超容，货物单一持有 |
| 确定性与独立性 | 固定 map/scenario/seed 连跑事件逐项一致；无浏览器、不同回放速度、隐藏标签页得到同一日志；不比较受墙钟影响的测试耗时 |
| 保存与版本 | 运行前后静态 map 序列化一致；编辑后新运行绑定新摘要，旧日志不覆盖；M1.1 多项目/CAS/外部文件失败回归保留 |

测试按无 DOM 单元/集成优先，二维回放测试最后接入。计划命令包括现有 schema:check、typecheck、lint、test、test:integration、build、test:e2e，以及完成后新增的 map:compile、scenario:validate、simulation:run。新命令提供结构化报告和约定退出码；产物登记输入摘要、配置、版本、日志和断言，不用截图代替事件证据。

## 7. 明确未做与下一次决策

M2A.1 没有网络发布、路径搜索、资源占用执行、服务计时或运行回放。M3A 也不包含 3D、VR、吊装动力学、复杂调度优化、强化学习或工程级车货扫掠认证。底图来源与 ZIP 归 M2B。

M3A-0 需锁定：转向 profile、服务多能力迁移取舍、等待位合同、设备/空间释放事件顺序和服务工作窗政策。以上决策应针对最小 synthetic 小路网给出具体 schema 与反例后审查，不能靠隐藏缺字段或自动补假设让演示运行。
