# Shipyard-Map-Generation：源码审查与下一阶段开发任务

审查日期：2026-09-09。
仓库：https://github.com/NCR7777/Shipyard-Map-Generation
固定审查提交：`a8e7b03b083c7f187e5920ed0ddb043efe4acad1`（main）。

## 1. 范围与证据边界

通过 GitHub 连接读取了该提交的仓库结构、核心数据与命令、编辑会话、主界面、属性面板、二维渲染、校验器、适配器、场景快照、Schema、阶段报告和浏览器关键路径测试的相关部分。

这是源码审查，不是本轮独立测试验收。本地 `git clone` 因 `Could not resolve host: github.com` 失败；没有取得可执行的完整本地检出，因此没有重新执行 npm ci、构建、单元测试或 Playwright。仓库 M1_STAGE_REPORT.md 记载的 82 项单元测试、15 项集成测试和 7 项浏览器测试通过，是仓库已有报告，不是本轮重跑结果。没有修改仓库、提交、分支或远程文件。

## 2. 总体判断

保留现有工程，不建议重写。它已经具有框架独立的地图模型、Schema、原子编辑命令、撤销重做、受控 JSON 导入导出、内容摘要与接口边界。

但它仍是 M1 点线地图编辑器，不是完整的第二层船厂空间布局工具。用户指出的保存与设施编辑缺口真实存在，不是按钮位置没有找到。

## 3. 由源码确认的当前实现

### 3.1 保存不是持久化

- `src/ui/App.tsx` 每次初始化调用 `createSession(newMap(...), true)`。
- `src/editor/session.ts` 只保存内存中的 map、past、future、savedHash、changeToken。
- `src/adapters/files.ts` 只有 `readJsonFile()` 与 `downloadMap()`；后者创建 Blob 和临时下载链接，生成含时间戳和随机后缀的新文件名。
- App 中 Ctrl/Cmd+S 调用 `exportCurrent()`，并不是浏览器工程保存。
- `exportCurrent()` 发起下载后即调用 `markExported()`；它表示相对已发起导出的基线没有变化，不表示文件已可靠落盘。
- 有 beforeunload 警告，但没有重启恢复或浏览器工程仓库。
- 输入框、textarea、select、contenteditable 的过滤位于全部快捷键之前，因此焦点在输入区域时，应用不会接管 Ctrl/Cmd+S。下一版应让全局保存快捷键先处理，同时保留文本框自己的撤销、删除等行为。

### 3.2 设施不是完全没有模型，而是没有被启用为可编辑对象

Schema 和生成类型已有 `facilities`、`zones`、`accessPoints`、`servicePoints`、`assets`、`backgroundLayers`，以及路口、转向和资源集合。

`src/domain/capabilities.ts` 对非空设施、区域、入口、服务点、底图等集合生成不支持原因，使整图只读。这是 M1 防止破坏尚未支持语义的保护，不应直接删除。

`src/domain/commands.ts` 的 Selection、MapCommand 与复制/删除闭包目前只实现 nodes/roads；`src/adapters/contracts.ts` 的 SceneSnapshot 和 `src/compiler/scene.ts` 也只输出节点道路。

因此 M2 不是只增加几个 Canvas 多边形，而是需要模型/命令/引用/场景快照/渲染/编辑/持久化/测试的完整交付。

### 3.3 道路和物理参数

- 节点坐标、起终点引用和内部折点分离，长度由几何派生，符合继续扩展的方向。
- 道路方向可编辑；宽度、净高、承载和速度已有字段但属性面板明确保留原值，不提供编辑。
- 未知值保留 unknown，是合理边界；下一版不能自动补成任意实测值。
- 在道路中部用节点工具点击时，MapCanvas 只调用 onAddNode，没有拆分原道路。几何重合不代表连接已建立。当前未自动连接是合理的，但实际制图需要显式“插入节点并拆分道路”，以及未解释相交/近邻的检查。

### 3.4 验证与未来接口

`src/validation/validate.ts` 已实现结构、引用、ID、部分方向/归属一致性与基础几何检查。它明确报告 polygon_geometry、crossing_classification、turn_reachability、resource_execution 等未检查项，并拒绝非 draft 发布配置。

SimulationAdapter 和 RenderAdapter 是类型契约，不是已经实现的仿真器和三维引擎。下一版应继续保持真实能力声明，不把 draft 有效当作运输安全。

## 4. 下一阶段：直接交给 Codex 的执行任务

以下是新的开发要求，不是当前仓库已存在的实现。

### 4.1 先处理阶段与基线

先读取 AGENTS.md、当前 Schema、M0/M1 契约和已有测试。记录当前分支、提交、工作区状态；若已超出上述提交，先对照新增代码更新本报告结论，不覆盖用户改动。

上一轮“仅完成 M0+M1”的限制在本轮推进任务中解除。本轮目标为 M1.1 保存与恢复 + M2A 设施/区域/入口/服务点。保留坐标、领域数据独立、稳定 ID、显式拓扑、校验和未实现能力声明等长期约束。

先实际运行可运行的基线命令。不要只引用旧阶段报告。不能运行的项目明确记录原因。

### 4.2 P0：建立浏览器工程保存

建议新增持久化端口及 IndexedDB 适配器，不向纯领域模块引入浏览器依赖。路径可随现有组织调整，例如：

- `src/editor/projectController.ts`：工程生命周期、恢复及保存状态协调。
- `src/adapters/projectStore.ts`：浏览器存储适配器。
- `src/adapters/localFiles.ts`：可选的已授权本地文件写回。
- `src/ui/ProjectMenu.tsx`：新建、最近项目、打开、保存、另存为。

继续复用 loadMap、validateMap、serializeMap、contentHash 和编辑会话，不另写一套宽松解析器。

必须实现：

1. 项目命名、多项目、最近项目、浏览器保存与恢复；不以下载为必要条件。
2. 自动草稿在成功提交地图编辑后防抖保存；视图变化单独处理；恢复完成前禁止自动写空地图。
3. Ctrl/Cmd+S 在画布和输入控件焦点下均调用应用保存；文本 Ctrl+Z、删除不被地图快捷键劫持。
4. 区分地图已提交状态与尚未应用的属性输入；有未应用输入时提示用户，不把仅存在表单中的改动声称已经保存。
5. 保存状态区分：浏览器草稿未保存/保存中/已保存/失败；本地文件未关联/有未写回变化/写回成功/冲突；导出仅显示已发起下载。
6. 不再用单个 savedHash 混合表示导出、浏览器持久化、本地文件写回。保留清晰的各存储目标确认基线。
7. IndexedDB 事务成功提交后才更新对应保存基线。异步保存完成时，不得把保存期间产生的新修改标为已保存。
8. 工程切换、导入、清空必须保留上一个已成功保存版本；失败或取消不破坏旧数据。
9. 两个标签页并发编辑应检测冲突。不要只把地图 revision 用作存储版本；撤销及外部 JSON 编辑并不保证它单调增长。用独立存储版本/比较更新机制。
10. 底图二进制将来单独存储，不塞进 map.json 的 Base64 字段。图片保存成功与地图引用保存保持可恢复的一致关系。
11. 浏览器保存不等于永久备份；保留 JSON 和工程 ZIP 导出入口，界面说明浏览器数据的使用边界。

### 4.3 P0/P1：本地文件写回（按能力渐进增强）

在支持并已授权的浏览器上，可关联 map.json 或工程目录，后续保存写回同一目标。其他环境仍可使用浏览器保存与导出，不得锁死应用。

必须在写入并成功关闭可写流后更新文件保存基线；用户取消、权限拒绝和写入失败均保留当前地图。

重新聚焦、显式重新载入和写回前检查外部内容变化；Codex 修改磁盘 JSON 时不能静默覆盖。发生双侧修改时提供重载、保留当前恢复副本、另存为、明确确认覆盖。

不承诺普通浏览器文件API具有跨应用原子比较写入能力。写前检查与备份能降低风险，但检测到的冲突必须诚实处理。

### 4.4 P1：设施、区域、入口和服务点

先沿用现有 Schema 的 Facility、Zone、AccessPoint、ServicePoint，不平行创建 buildings[]、canvasShapes[] 等第二份领域模型。若必须改变契约，显式升级 schemaVersion 并添加旧文件迁移；不得直接编辑 model.generated.ts。

功能：矩形/多边形设施，作业/缓冲/等待/水域/障碍区域，米制数值输入、移动、旋转、顶点编辑、多选、复制、删除、撤销/重做。

入口与服务点继续通过 nodeId 使用权威坐标，避免在入口对象和节点中各存一份可独立修改的位置。设施的 accessPointIds/servicePointIds 与点的 facilityId 要在一个事务内维护。

移动设施前明确关联入口/服务点是否一起移动；共享道路节点会影响相邻道路时提供明确行为与预览。复制设施时明确复制闭包，不能无意把整张路网一起复制；与外部路网的连接必须有声明的处理策略。

同步扩展：

- `src/domain/commands.ts`：命令、选择、复制/删除引用规则。
- `src/domain/capabilities.ts`：只开放已实现并通过测试的实体；继续保护未知行为和未支持对象。
- `src/adapters/contracts.ts` 与 `src/compiler/scene.ts`：场景快照、边界和缺失能力。
- `src/renderers/2d/MapCanvas.tsx` 或拆分后的图层：只读取领域投影，不另存语义。
- `src/ui/PropertyPanel.tsx`：按实体类型拆分面板。
- `src/validation/validate.ts`：多边形基本有效性和新增引用规则。
- 导入导出、持久化、撤销、单元/集成/浏览器测试。

不能仅删除 capabilities 中的设施只读判断后宣告 M2 完成。

### 4.5 P1：道路制图能力

添加显式插入/拆分道路命令、网格和节点吸附，必要时显示近邻未连接提示。道路交叉不自动连通；用户明确确认后才建立拓扑。

拆分需维护 from/to、内部折点、方向、属性、来源及引用；对尚不支持安全重写的 movement/resource/extension 引用，应拒绝并解释。用映射记录原道路与新道路的对应关系，而不是任意复用一个 ID 给两个对象。

在属性面板增加 widthM/heightLimitM/massLimitKg/speedLimitMps 的状态和值编辑，沿用现有 PhysicalValue 四种状态。无来源的参数明确标为设计假设或未知。

### 4.6 M2B 与 M3，随后执行

M2B：底图导入、图层、控制点/尺度/方向、标定变换、资源保存和 ZIP 工程往返。默认重新标定只调整底图变换，不静默移动已有地图几何。

M3：显式路口转向、资源发布配置、服务点接入/可达性、地图网络编译和路线预览。只有此时才引入对应 simulation-ready 发布结果；未做扫掠、净空和运动学验证时不得声称车辆物理安全。

本轮不做三维、VR、复杂调度算法、云账号体系或装饰性车辆动画。

## 5. 必须新增的验收场景

### 保存与恢复

- S01：绘图后不下载，确认浏览器保存成功，刷新/关闭重开恢复。
- S02：两套项目独立打开、修改、保存，名称、对象和保存目标不串项目。
- S03：数据库恢复尚未完成时，不出现空地图覆盖旧记录。
- S04：保存A进行中产生编辑B；A完成不能使B显示已保存。
- S05：存储异常、配额失败、权限拒绝、取消文件选择均不虚报成功，不破坏上次已保存版本。
- S06：两标签页出现冲突，不采用无提示的最后写入覆盖。
- S07：Codex外部修改JSON后，重新载入采用共同导入/校验管线；双方均有改动时不静默覆盖。
- S08：输入框内Ctrl/Cmd+S进入应用保存；文本撤销/删除仍作用于文本。
- S09：导出发起不等于浏览器草稿或磁盘工程确认保存；三个状态独立。
- S10：存在未应用属性表单输入时，保存行为明确，不误导用户。

### 空间编辑

- G01：绘制60m×30m厂房，缩放/平移视图及保存重开后尺寸不变。
- G02：增加设施入口与服务点，相关引用往返保存无损；从JSON重新导入可编辑，而不是整图只读。
- G03：移动、复制、删除设施及关联点，按明确闭包处理，失败事务不留悬空引用。
- G04：一次设施拖动是一条撤销记录；撤销/重做坐标、关联和ID一致。
- G05：多边形闭合、重复点、自交、孔洞基本规则按声明检查；未支持的复杂几何不返回伪成功。
- G06：显式拆分道路前后长度守恒（容差明确）、方向保留、引用有效；普通相交不自动连接。
- G07：旧M1样例可加载；不支持的扩展/高级语义仍保持受保护状态。
- G08：去掉底图资源后矢量地图仍能加载；缺失资源提示，不删除实体。
- G09：物理参数unknown等状态往返无损，不被默认为0或任意真实值。
- G10：核心规则、校验与场景投影无需DOM/Canvas即可测试。

## 6. 执行与报告要求

先基线、再保存、再空间实体；每阶段形成可运行的端到端结果。不要只更新文档或只画一个厂房示意图。

仓库已有命令，应实际执行并报告：

```bash
npm ci
npm run schema:check
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
npm run test:e2e
npm run map:validate -- examples/M1_synthetic.map.json
```

先遵守 package.json 的 Node 引擎要求。新增功能补测试，不通过删减原有断言换取通过。

原生文件授权/写回不能完全自动化时，区分mock测试、浏览器实际测试和待用户执行的手动步骤；不把mock通过当作磁盘实测通过。

完成后给出：变更文件、实际测试结果、未完成内容、仍然未验证的物理能力。开发失败时报告具体原因和保留状态，不空返回成功。

## 7. 主要源码依据（均固定到本次提交）

- [主界面与快捷键](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/ui/App.tsx)
- [文件适配器](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/adapters/files.ts)
- [编辑会话](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/editor/session.ts)
- [命令与复制删除](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/domain/commands.ts)
- [能力门禁](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/domain/capabilities.ts)
- [地图Schema](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/schemas/map.schema.json)
- [属性面板](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/ui/PropertyPanel.tsx)
- [二维交互](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/renderers/2d/MapCanvas.tsx)
- [校验](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/validation/validate.ts)
- [适配器契约](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/adapters/contracts.ts)
- [场景快照](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/src/compiler/scene.ts)
- [浏览器关键路径测试](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/tests/e2e/M1_editor.spec.ts)
- [仓库原有M1报告](https://github.com/NCR7777/Shipyard-Map-Generation/blob/a8e7b03b083c7f187e5920ed0ddb043efe4acad1/docs/M1_STAGE_REPORT.md)

浏览器存储技术依据：
- https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
- https://developer.chrome.com/docs/capabilities/web-apis/file-system-access
