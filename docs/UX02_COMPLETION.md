# UX02：直观属性与明确关联编辑

本批在 `codex/rf00-rf01` 的本地 `e1c86701a0bf3c30a31dd20e2c6f29aac9d6c054`（含 BG01）上增量实现。没有回退到任务书的旧发布版本，没有修改地图 Schema 或运行依赖。保留论文修改、附件和旧 ZIP 删除；本批不推送。

## 实际行为

- 普通节点提供 XY、可选名称和连接摘要；道路提供名称、记录宽度、方向和只读长度。限制摘要常驻，ID、Z、来源、折点与引用按需查看。只提交真正改变的字段，显示单位不回写未编辑的精确数值。Enter 应用、Esc 取消属性草稿，中文输入法组合事件不触发这两个动作。
- 拖设施/区域主体使用明确归属的刚体联动。零储位厂房及专用入口也可移动；公共节点固定，受支持接入段只更新私有端。拖角/边只修改边界，内容不缩放。唯一明确的专用入口贴边候选须预览批准；槽位出界、共享节点、多所有者、人工道路带等没有安全维护规则时明确拒绝。
- 在画布添加入口、添加作业点、重新定位业务点及进入“编辑内部”。同一 nodeId 的入口/作业点组合显示，业务 ID 和容量不合并。入口在一次事务中维护专用节点、接入支路、必要拆路与设施反向引用。作业点明确选择入口交接或内部到达，内部路径按已声明归属、方向和连续性选取；绿色为已选、青色为可继续选择的路段。
- 新接入转向默认没有许可，可逐项选择或明确使用驶入/驶出模板；旧禁转保留。作业点可以复用已有资源，容量不变。连续路段批改止于岔口、方向/宽度/所有者/资源变化；显式新路预设只影响后续新建道路，不补进口图的未知物理值。
- 沿用 RF01 保存/草稿冲突、GA01 固定坐标框架、TE01 拆接路、MQ01 原件和 BG01 图片持久化。没有第二份地图、历史或保存系统。候选和拖动中间帧不写地图；提交重新校验上下文及完整受影响锁定集合。

## 修改位置

| 范围 | 文件 |
|---|---|
| 属性与创建 | `src/ui/PropertyPanel.tsx`、`RoadPhysicalFields.tsx`、`SpatialPropertyPanel.tsx`、`PointPropertyPanel.tsx`、`PointCreationPanel.tsx`、`ServiceSemanticsFields.tsx`；新增 `propertyFields.ts`、`ConnectedPointFields.tsx`、`RoadBatchPanel.tsx` |
| 事务与依赖 | `src/domain/commands.ts`、`geometrySources.ts`、`src/geometry/relations.ts`；新增 `src/domain/ownerEditing.ts`、`connectedPoint.ts`、`src/validation/ownerEditing.ts` |
| 原工作台/画布 | `src/ui/App.tsx`、`useEditorInteraction.ts`、`workspace.css`、`src/renderers/2d/MapCanvas.tsx`、`SpatialLayer.tsx` |
| 既有契约 | `src/editor/projectController.ts` 增加可选显示单位；`src/adapters/contracts.ts`、`src/compiler/scene.ts` 提供方向箭头声明；旧快照 direction 可缺省 |
| 验收 | `tests/unit/UX02_*`、`tests/e2e/UX02*.spec.ts`；更新受影响旧 UI 测试的实际详情入口，保留几何、容量、来源、保存和原件 SHA 断言。完整清单见同目录 `UX02_TEST_RECEIPT.json` |

## 真实输入和两条工作流

所有操作在浏览器的临时项目中完成，没有先用脚本修改地图后代替 UI 验收。

1. `projects/MQ01_Repair_20260913/cimc/map.json`，文件 SHA `98f2fe6c3bbb290ac70fb6dde19e64fa2b25dc537e8d66720b0f6e7866273a27`，语义摘要 `8aa49a68458244fd522577e6b59c6c300aff06b90f8be22e72b7f5007909eec3`。配套 1420×1340 底图 SHA `8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713`，校准文件 SHA `f7d3c735f12d891fd20125a7495a274e959de27c496301eda4d34a32446777db`。真实 UI 校正 F_CR002 轮廓、选择同址入口身份并移动 AP_CR002、把相邻道路宽度 8 改为 7.5m，逐步撤销/重做、保存刷新和 JSON 重导入；底图、frame、非编辑字段和公共节点不变。
2. 冻结 synthetic `SR03_A/map.json`，文件 SHA `f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a`。真实 100 次鼠标移动步骤把 Z_005 平移 (-10,+5)m；3 个停车位、8 个私有节点和内部路口边界随动，N_0030/N_0034 固定。不是 100 个保证已绘制的显示帧。资源容量、内部尺寸、ID、arrival 和转向保持，并完成保存刷新/JSON 往返。

九份 MQ01、九份 V02 与 SR03 A 的当前 CLI 共 19 次均退出 0；前后文件 SHA、完整 coordinateFrame 和原语义摘要匹配，回执 `.cache/UX02/originals-final.json`。缺失的 SR02 A—D 仍为 `blocked_input`，没有修改测试或冻结 SHA 来规避。

## 回归中发现的问题

- 修复同址身份被标签去重连带隐藏、局部点位被节点吸附回旧位置、内部范围误分类、批量同值引入新来源、过期拖动提交和属性回调不稳定等问题；反例和独立审查保留在 `.cache/UX02/`。
- 新作业点资源选择曾错误显示在入口表单，现只在作业点显示；原领域入口资源拒绝规则保留。IME Enter/Esc 现在先检查组合输入。
- 旧 P1 的 A/F001 平移 (+10,+5)m 后右边界从 83m 到 93m，进入 x=100m 公共道路的声明宽度范围。实际返回 `OWNER_ROAD_NEW_BUILDING_BAND_CONFLICT`，定位 R_0004_S1/S2。这是新增确定性冲突保护，不是鼠标拖动丢失。保留原动作的拒绝反例；正例采用经核心核验的 (-5,+5)m 并保留原旋转参数。D/F001 原 (+10,+5)m 仍合法。
- 第一轮旧生产回归为 131 通过、15 失败，回执 `.cache/UX02/regression-first.log` 与 `.cache/UX02/regression/` 保留。包括旧控件/详情定位、轮廓拒绝后未取消弹窗就导出、上述真实空间拒绝；不能将首轮写成全通过。

## 复现与判定

PowerShell，工作目录 `paper01/map`。本机 Node 22.18.0、npm 10.9.3、Chrome 152、Windows；新环境先运行 `npm ci`，本批复用已验证的锁定安装，没有重新安装依赖。

```powershell
$env:SHIPYARD_TEST_DATA_ROOT = (Resolve-Path .cache/BG01/data-root).Path
$env:UX02_MQ01_ROOT = (Resolve-Path ../../projects/MQ01_Repair_20260913).Path
$env:UX02_CALIBRATION_DIR = (Resolve-Path .cache/BG01/calibrated-cimc-final).Path
npm.cmd run schema:check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
npm.cmd run test:ux02
npx.cmd playwright test -c playwright.ux02-regression.config.ts
npm.cmd run test:production
npm.cmd run dev -- --host 127.0.0.1
```

测试使用可指定根目录和固定 SHA；缺原件不能通过。`UX02_RUN_DIR` 仅指定各轮浏览器回执目录。受影响浏览器回归配置排除单独运行的 UX02、仅能在开发服务运行的 BG01_assets 和原件数据包专用 MQ01_repaired；不可把这一子集称为全部历史浏览器测试。

### 实际命令与退出码

| 实际执行 | 退出码 | 本轮结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | Schema 生成一致 |
| `npm.cmd run typecheck` | 0 | 最终 build 中再次执行类型检查 |
| `npm.cmd run lint` | 0 | 含纯领域依赖边界检查 |
| `npm.cmd run test` | 1 | 655 通过、4 缺 SR02 原件失败；47 文件 |
| `npm.cmd run test:integration` | 1 | 86 通过、4 缺 SR02 原件失败；7 文件 |
| `npm.cmd run build` | 0 | 最终生产包；保留原有大 chunk 警告 |
| `UX02_RUN_DIR=.cache/UX02/ui-delivery npm.cmd run test:ux02` | 0 | **最终构建 10/10**；含同值状态文字及完整地图不变断言 |
| `npx.cmd playwright test -c playwright.ux02-regression.config.ts --workers=2` | 1 | 144/146；下列两个失败项保留回执后分别修正测试入口/语义分支 |
| 同配置，`P1_completion.spec.ts --grep 'real F_001 rigid' --workers=1` | 0 | 1/1；展开真实检查面板，保留新冲突拒绝及安全移动/旋转完整断言 |
| 同配置，`M2A_spatial.spec.ts -g "G02 rejects undeclared"` | 0 | 1/1；厂房未声明穿越拒绝，再显式把 synthetic 测试对象改为露天场地后通过旧关联往返 |
| `npx.cmd playwright test tests/e2e/BG01_assets.spec.ts --output=.cache/UX02/bg-assets/artifacts --reporter=json` | 0 | 5/5；独立开发服务的图片持久化/输入保护补测 |
| `npx.cmd playwright test -c playwright.production.config.ts --workers=1 --output=.cache/UX02/production-delivery/artifacts --reporter=json` | 0 | **最终构建 6/6**：SR03 四原图与 A/F001、A/Z005 联动保存/恢复 |
| `node node_modules/tsx/dist/cli.mjs scripts/map-validate.ts <原件路径>`，逐一 19 次 | 0 | 全部合法草稿；原件 SHA、frame、语义摘要一致 |
| `git diff --check -- .` | 0 | 只清理了两处空白问题 |

旧 146 项是“一轮 144 项通过，再各补测 1 项通过”，不是一次全部通过。该轮及 BG01_assets 发生在最后同值提示修复之前；最后产品差异仅 App 的状态文字分支及两处空白，领域/保存/几何行为未改变。最终同包完整工作流由 UX02 10 项和生产 6 项复跑确认。完整命令、报告 SHA、截图 SHA、源码及测试清单见 `UX02_TEST_RECEIPT.json`。

生产首轮曾为 5/6：新增拒绝反例错误复用了“必须改变 hash”的成功拖动 helper，已为拒绝分支明确检查 hash 不变；原失败、定向 1/1 和最终 6/6 均保留。UX02 早期两轮各 8/10 的测试坐标/面板定位失败也保留在 `.cache/UX02/ui-release/` 和 `ui-confirmed/`。未跳过、删除冻结原件测试，没有把 SR02 缺件报告为通过。

### U01—U28 范围裁决

| 验收 | 已验证内容与限制 |
|---|---|
| U01—U08 | 常用属性、稀疏提交、隐藏精度/Z/状态保留、单位、取消、单向反转和显式新路预设。预设只覆盖后续新路宽度与方向。 |
| U09—U13 | 零储位厂房/专用入口及带储位堆场可按明确归属整体移动；公共道路固定。共享或有歧义依赖拒绝。 |
| U14—U15 | 矩形轮廓及唯一私有入口修复预览通过；**U15 为有限支持**：储位越界只定位并拒绝，不重排、缩放或自动移到新位置。 |
| U16 | 可编辑已有明确归属的内部点路；新作业点流程可选择明确内部路径并建立接入段。**普通自由绘图不会自动获得 owner，内部模式不开放任意新增点路**。 |
| U17—U20 | 同址业务身份保留；画布入口/作业点原子创建、接路与显式许可；普通点路编辑保留无关几何。驶入模板和单项许可有 UI 记录，未对每个驶出/双向模板组合单列浏览器验收。 |
| U21—U22、U27 | 有界连续道路批改；未知扩展、复杂依赖仍保护；旧冲突与本次新冲突分别处理，不按空间包含推定归属。 |
| U23—U25、U28 | 取消/过期/锁、一次事务、撤销重做、保存刷新、JSON 和完整声明保持；最终同值操作同时验证无事务与正确提示。没有对全厂全部 OD 重新认证路线等价。 |
| U26 | 实际鼠标、输入和现有 DP1 回归已执行；**仍观测到长任务，性能全面达标未验证**，见下列数据。 |

### 最终构建的独立生产观察

最终 JS 为 `dist/assets/index-CX7arPk_.js`，SHA `56bc793322f485c9149a5a76ae79ac3417506ff9d61cdbcea8790e94737d94a8`。旧已测试 `index-BpI0_7qh.js` 的回执保留，没有修改旧回执来匹配新包。

环境：152.0.7977.83，win32 10.0.26200，Intel(R) Core(TM) Ultra 9 275HX，24 逻辑核，视窗 `{'width': 1440, 'height': 1000}`，独立 headless Chrome、生产构建、单 worker。D 原件一次观测：导入并适应视图 **3302 ms**，搜索 **94 ms**，100 次原生鼠标步骤的拖动及提交 **1283 ms**，修改后保存 **808 ms**。拖动最大 RAF 间隔 **584.8 ms**，长任务 `[588]` ms。

计时包含 Playwright 输入/等待、双 RAF 及保存轮询；不是纯绘制耗时，不能定位到某个函数，也不是同条件多轮前后性能比较。首次旧包观测的 536ms 与最终包的 588ms 长任务均记录，不以一次样本判定改善或退化。没有为此添加新空间引擎、缓存平台或 Worker。

### 最终真实编辑器截图

- [CIMC 编辑前](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-MQ01-CIMC-c-f138f-ation-and-sparse-road-width-chrome/cimc-before.png)
- [CIMC 轮廓、入口、道路宽度编辑后](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-MQ01-CIMC-c-f138f-ation-and-sparse-road-width-chrome/cimc-after.png)
- [CIMC 保存刷新后](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-MQ01-CIMC-c-f138f-ation-and-sparse-road-width-chrome/cimc-restored.png)
- [SR03 Z005 编辑前](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-synthetic-S-91adb-al-nodes-in-one-transaction-chrome/sr03-before.png)
- [SR03 私有内容联动后](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-synthetic-S-91adb-al-nodes-in-one-transaction-chrome/sr03-after.png)
- [SR03 保存刷新后](../.cache/UX02/ui-delivery/artifacts/UX02-UX02-real-synthetic-S-91adb-al-nodes-in-one-transaction-chrome/sr03-restored.png)

图片和完整轨迹为本地测试产物，不混入原图或发布源码；换机器须按根目录与冻结输入复跑。

### 两类审查

正确性审查分别由未负责被审模块的代理进行，闭合来源/批量同值、反向链、私有节点、锁定/过期及新建资源表单等反例；最终空操作提示另有差异复核。Ponytail 冗余审查独立执行，复用现有事务及保存系统，没有新增运行依赖；最终结论为无待删除的多余结构。两类审查均不代替浏览器和原件验收，源文件及回执摘要分别保留。


## 明确限制

没有安全维护规则的共享节点、跨所有者依赖、独立转向/路口几何、人工道路带、登记长度或不支持扩展继续受保护；不会清空 owner、arrival、资源或扩展换取可编辑。轮廓调整不重排/缩小储位。新建支路的物理未知值仍未知，转向许可仍需明确选择。高级入口声明可保留旧低层工作流，但不能把已填的普通接路/资源候选静默丢掉后切过去。

图可编辑和静态声明一致不等于现实车辆安全通行；没有新增求解器、动态占用、GIS 重配准、3D/VR 或现场认证。本批只完成 UX02，性能使用真实观测，不将旧 DP1 未达预算改报为通过。

## 后续修复

2026-09-14 的 [HW123 专用入口联动补丁](UX02_HW123_FIX.md) 补上“一条外部接入支路＋明确内部道路”的可移动组合。以上原批次结果与摘要保留；新补丁的范围、构建及验收以该说明为准。
