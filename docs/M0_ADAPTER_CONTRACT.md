# M0 纯核心与适配器契约

日期：2026-09-09。范围：M1 的地图数据、二维场景投影与未来集成契约。接口状态区分 implemented、documented_interface、unsupported；测试通过情况只在阶段报告登记。

## 已实现接口的职责

| 接口 | 输入 / 输出职责 | M1 状态 |
|---|---|---|
| `parseMap` | JSON 文本 → 受大小限制的解析、重复键/非有限数/结构检查、结构化结果；不接触当前编辑会话 | implemented |
| `validateMap` | YardMap + validation profile → `ValidationReport`；Schema 与跨实体/基础几何检查共用 | implemented，仅 draft |
| `serializeMap` | YardMap → 确定性 JSON；不舍入坐标，不写文件 | implemented |
| 内容摘要 | 排除 revision 后的规范化声明数据 → SHA-256；用于导入基线与派生结果绑定 | implemented |
| `applyMapCommand` | 文档 + 命令 → 原子成功结果或带 Issue 的拒绝；不直接操作 React/Canvas | implemented，M1 命令集；检查结果见 M1 阶段报告 |
| `toSceneSnapshot` | 有效文档 → 脱离渲染器的场景数据，附来源地图摘要、派生道路长度和能力限制 | implemented，节点/道路 |
| 网络编译、路径查询、场景运行 | 编译后的不可变地图、场景 → 网络/运行输出 | unsupported，M3/M4 |
| 三维/VR 渲染 | SceneSnapshot + 运行状态 → 引擎对象 | documented_interface，M5 |

`ValidationReport` 含 `ok`、`profile`、`status: valid/invalid/unsupported` 和 `issues`。Issue 含稳定 `code`、`severity: error/warning`、`jsonPath`、`message`、`suggestedAction`，可附 `entityType`、`entityId`、`location`（行、列或世界位置）。不能把 `unsupported` 转成 `ok:true` 后让下游继续执行。

调用约束：外部修改后的文本必须先 parse/validate，再替换领域文档并生成场景。严禁从 Canvas 反序列化恢复主数据，或直接把未验证的 JSON 强制转换为 YardMap。命令接口的事务结果由编辑器历史持有；拖动中间状态留在临时视图，提交失败时仍使用事务前文档。

M1 实际命令集：addNode、addRoad、updateNode（名称/位置）、updateRoad（名称/内部折点/方向）、renameMap、translateSelection、duplicateSelection、deleteSelection。选择集为 `{nodes:string[], roads:string[]}`，位移为米制 Vec3；复制调用方提供覆盖闭包的 idMap，新 ID 必须全局唯一。会话层保存最多 100 个领域事务，undo/redo 直接使用冻结的事务快照，重做不重新分配 ID。

## SceneSnapshot

场景快照使用本地米制右手坐标，不携带屏幕缩放/平移、不拥有交通规则：

| 字段 | 契约 |
|---|---|
| `schemaVersion` | 本版为 `0.1.0` |
| `mapId`, `mapContentHash` | 绑定唯一地图版本；异步或缓存结果必须核对 hash 后才能用于当前场景 |
| `coordinateFrame` | 保留 YardMap 坐标与单位约定 |
| `nodes` | 按稳定 ID 映射的节点快照数组，每项 `id`, `name`, `position:Vec3` |
| `roads` | 道路快照数组，每项 `id`, `name`, `fromNodeId`, `toNodeId`, `points:Vec3[]`, `lengthM`；端点 ID 保留用于按引用预览；几何是实时派生结果 |
| `bounds` | `{min:Vec3,max:Vec3}`，空场景为 null |
| `missingCapabilities` | 尚未渲染或尚未检查的能力；不能由前端隐藏后宣称全部支持 |

消费方不能反向修改快照并称完成地图编辑；所有修改仍通过领域命令。SceneSnapshot 不是完整地图的另一种存储格式，不用于取代 map.json 或进行有损重导出。二维渲染器按 ID 建立图形，屏幕 Y 翻转仅在投影边界执行。1m 的屏幕比例、原点、三基向量与往返由坐标单元测试检验；Z 值保留，但 M1 的二维图像不显示高度。

## SimulationAdapter 与运行消息

本次只交付框架无关接口类型和消息夹具，没有真实仿真器、优化器、服务器或运行成功函数。未来适配器应消费不可变的编译地图与独立 scenario；输入明确 mapId、mapContentHash、Schema/编译器/场景版本，输出状态或事件流，禁止直接改静态地图。

现有 `RuntimeStateMessage` 具体字段为 protocolVersion（0.1.0）、mapId、mapContentHash、scenarioId、scenarioVersion、entityId、sequence、simulationTime、occurredAt、observedAt、pose；pose 为 `{position:Vec3, yawRad:number}`。运行消息至少绑定稳定实体 ID、sequence、simulationTime 与 pose；时间单位 s，位置 m，角度 rad。`occurredAt` 表示事件发生时间，`observedAt` 表示系统观察到的时间；两者不得混为同一可见时间，不把未来观察消息提前纳入状态。消费者处理乱序/迟报的策略属于未来运行实现，不由渲染帧率决定。

`SimulationAdapter` 的声明为只读 capabilities、`start(input): AsyncIterable<RuntimeStateMessage>` 和 `stop(): Promise<void>`；`SimulationInput` 已具 mapId/mapContentHash/compilerVersion/scenarioId/scenarioVersion 标识，但 compiledMap 和 scenario 的内部类型尚为 unknown，待 M3/M4 冻结。类型声明不能作为可运行服务或完整线协议。

消息夹具仅验证接口字段和语义边界，不是实际车辆运行记录。不同 mapContentHash 的消息不能在当前图上无提示播放；历史回放必须绑定原地图快照，缺少快照时报告不能可靠重放。

## RenderAdapter 与未来坐标适配

RenderAdapter 声明 capabilities、`setScene(snapshot)`、可选 `applyRuntimeState(message)` 和 `dispose()`，消费 SceneSnapshot 和可选运行状态，不拥有连通、转向、容量或调度规则。实际 M1 二维渲染按该数据责任边界运行；Three.js、Unity、VR 没有实现，也没有可点击的伪功能入口。

未来三维适配必须显式处理坐标基、单位、原点与姿态。例如采用本地 Z-up 到 glTF Y-up 的 `(x,y,z) → (x,z,-y)` 时，平移、方向、对象姿态和反变换都要一致；这是待实现约定，不代表当前已支持 glTF。三维模型可用 assetId 与稳定实体 ID 绑定，不能用模型几何替换道路连接和设施入口。未知高度保持未知，显示拉伸假设不得写成实测属性。

## 文件与进程边界

CLI 的输入为本地 JSON 文件，不启动浏览器或 Canvas。验证成功草稿退出 0；数据错误退出 1；参数/文件错误退出 2；未支持配置退出 3。CLI 程序的标准输出是结构化 JSON；脚本调用方使用 `npm run --silent map:validate -- FILE` 避免 npm 命令横幅，或直接调用 Node/tsx 入口。文件路径与错误信息作为文本，不执行。以 package.json 中 `map:validate` 的实际入口为准，M1 不提供假成功 `map:compile`。

浏览器标准文件选择与下载是基线，不假设 Node 文件系统 API 可用于网页。scenario、回放、editor-state 与二进制 assets 各自独立；M1 只实现 map JSON 文件的导入/下载，其余文件及 ZIP 打包仍是后续任务。资产丢失可显示 missingCapabilities 或警告，不能删除 map 中的矢量实体。
