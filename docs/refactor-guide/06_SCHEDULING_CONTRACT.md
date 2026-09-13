# 06｜接入调度系统：可执行的数据合同

本章为拟议合同，不是当前已实现接口。保留既有RuntimeStateMessage/SimulationAdapter的兼容性；新能力通过明确版本适配，不同名覆盖语义。[S12]

## 1. 责任分工

编辑器负责静态地图、几何拓扑、服务/资源声明、来源、检查、不可变研究输入发布，以及外部计划/运行结果的只读呈现。
外部系统负责运输任务、车辆/货物、时间、队列、互斥执行、优化、仿真、实际派工与设备安全。无需在本项目先实现求解器才能对接。

最低可交付接入不是一个空TypeScript接口：必须实现map编译、声明配置校验、可阅读JSON包、独立Node/Python读取示例、一个明确标示mock的结果往返验证。不要求现场传感器或真实调度系统已经存在。

## 2. 数据分层

| 文件/对象 | 内容 | 禁止混入 |
|---|---|---|
| map.json | 静态几何、道路方向/物理值、转向、服务点、资源定义、来源 | 实时占用、任务进度、车辆当前位置 |
| compiled-map.json | 原map派生道路弧、长度、转向、服务内部路线、资源映射、限制状态 | 可独立修改的第二份地图 |
| scenario.json | mapRef、任务、车辆、货物、时窗、日历、装卸时长、假设 | 偷偷替代map几何/容量 |
| plan.json | 排程结果、道路弧路径、服务/资源占用计划、状态和算法信息 | 自动写回map |
| runtime.jsonl | runId、事件/状态、时间和顺序 | 直接驱动编辑命令 |

图的地理frame与地图版本固定。场景假设可以为实验补齐速度等未知值，但必须另存假设来源/作用字段和派生配置摘要，不覆盖map原始unknown。

## 3. 发布身份

建议共享标识：

```ts
// 提议的数据合同，需在RF06落地并以JSON Schema验证。
type MapRef = {
  mapId: string;
  mapContentHash: string;       // 现有规范化算法，排除revision
  schemaVersion: '0.1.0' | '0.2.0';
};
type CompiledRef = MapRef & {
  compilerVersion: string;
  rulesVersion: string;
  profileId: string;
  profileVersion: string;
  compileOptionsHash: string;
  artifactSha256: string;       // 派生产物字节摘要，不是mapHash
};
```

mapHash必须由源JSON依现有算法计算，不接受消费者随手排序/浮点格式差异导致的另一个hash。官方编译器输出hash和source文件摘要；Python消费者至少校验source字节摘要与manifest，并使用共享测试向量验证语义hash实现。不要把Python默认json.dumps当作与JavaScript数值序列化必然一致。
所有异步返回携带mapRef；地图改动后缓存、计划和运行覆盖标为stale，不自动重绑定。

## 4. 编译输出最小范围

- 固定coordinateFrame、源mapRef、编译/规则/配置版本、覆盖报告。
- 节点坐标，物理道路ID与有向弧ArcRef；每弧的端点、按唯一几何推导的长度、方向和保留状态的物理限制。
- 允许/禁止/未声明转向；不能将共享节点转换为全通。搜索状态必须保留incomingArc。
- 服务点owner、权威nodeId、到达模式、入口、按方向的内部路径。到达声明不是唯一出口；当前允许的出弧仍按合同处理。
- 储位/停车位按当前已知表示读取；资源ID、单位、容量状态、controlModel、appliesTo反向索引。
- 来源与未检查条件。没有速度时travelTime不能填0；只有已声明速度并且命名为nominal的时间才可计算。倒车/转向/等候/装卸时间属于场景或外部模型。

公共路、设施内部路、允许的源/目标内部路线必须区分。不能把另一设施内部路线用作公共捷径。此项必须有反例测试。

## 5. 发布配置而非笼统“可调度”

建议三个明确配置：

1. `editable_draft_v1`：结构与引用合法，可保存未完成声明。
2. `routing_input_v1`：显式方向/转向/服务接入满足所选路由目标；对unknown返回未定或阻止发布，不暗中全通。
3. `scheduling_input_v1`：在routing基础上校验所选外部调度器声明需要的资源语义和场景字段。静态地图本身不要求包含全部车辆参数；编译器/场景校验共同检查。

每个配置定义required/optional字段、未知处理、支持几何、资源单位和外部消费者能力。消费者不需要的物理约束可声明未检查；需要的值未知必须阻止发布或明确引用可追溯实验假设。
结果建议 `ready / ready_with_assumptions / blocked`，同时给出checked/not_checked列表。所有ready只代表该研究输入合同完整，始终不是现场安全认证。
RF06可扩展现有validateMap profile或新建publication判定模块，但必须与CLI/UI共用同一规则，不复制第二套判断。

## 6. 外部场景与计划

场景任务至少有唯一jobId、pickupServicePointId、dropoffServicePointId；根据调度器需要有releaseTime、dueTime、cargoRef、vehicleClassRef、handlingRequirements。绝对时间与仿真相对秒分开，timezone不用于修改本地几何。
车辆和货物规格必须来自用户输入/显式假设，不能为空时任意补值。装卸时间不写到map；服务点的node_proxy核算策略与场景handlingTime一致，避免遗漏或双重计算场内运输。
计划路径以有向road ArcRef序列及time intervals表示；任务/车辆/资源引用可校验，plan有runId和scenarioHash。系统可读入和高亮计划，但不证明计划已优化或可实际执行。

## 7. 状态消息与乱序

现有RuntimeStateMessage 0.1.0已包括地图/场景/sequence/times/pose。新增runId、streamEpoch、entityType、payload类型等需版本升级或外层信封，不能在0.1.0合同里静默改变required字段。
同一run/entity/epoch维护序号；重复消息幂等，旧消息丢弃并计数；重连重启明确新的epoch或快照起始，不能让计数从0后被永久拒绝。
收到不匹配mapHash/scenarioHash/未知entity/非有限坐标/错误单位/超限消息时，不移动当前地图对象、不写map，显示原因。occurredAt/observedAt用于数据延迟说明，simulationTime可以暂停/回放但必须有运行模式，不以墙钟决定历史位置。
RF06首先支持本地JSON/JSONL导入和内存mock消息；网络WebSocket/HTTP运输层后续按实际系统协议接入。默认不监听公网、不放宽CORS、不上传地图。

## 8. RF06真实完成标准

1. 对真实目标地图用同一Node CLI产生编译包；不可发布输入明确blocked，不能为了全通过删问题。
2. Node消费者与Python读取示例在无浏览器状态下解析服务、道路、转向、资源；检查摘要和缺项。
3. 使用一个小型人工声明场景产生mock计划/状态文件；UI只读叠加。
4. 改动地图后原计划拒绝套用；恢复原版本后才能重新加载。
5. 服务内部路线、禁转、共享资源、乱序消息、错误单位/ID和缺参数均有合同测试。
6. `map:compile`、`map:publish`等命令名只有实际实现后才写成可用CLI。当前仓库仅有概念或接口的能力保持documented_interface/unsupported，不伪成功。
