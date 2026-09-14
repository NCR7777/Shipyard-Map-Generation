# FAST01 执行与验收

> 完成性复核：提交 5a337f5 的主体流程和 T01—T20 已覆盖，但当时遗漏完整规范的量距 M、任意已选道路批量改宽、一次草稿的直—曲—直接续、局部拆段变宽和叠放循环选择。五项现均已补齐并经过真实底图操作验证；本报告采用补齐后的最终生产回归，不沿用先前过早的完成结论。

## 结果与基线

已在原 React/Konva 编辑器完成 F1—F4 及上述补齐。新增无表单连续描图、统一直/曲线路径、Codex 文件补类和外部调度结果展示，继续使用原地图、命令事务、撤销、ProjectController、IndexedDB 与文件保存入口。没有新增运行依赖、内置求解器、第二套地图/历史/存储。

- 开工 HEAD：`ee1ae27d040876b40ba1edc8df314f2ca56cdba6`，分支 `codex/rf00-rf01`；与指导基线 `bcf4ac4ceefedfcbbc769f694211acacb98542b8` 的地图子树一致。
- 四份用户任务文档实际位于 `docs/`，原文保留：CODEX_START_PROMPT、FAST_TRACE_SPEC、CURVES_AND_EXCHANGE、ACCEPTANCE。UI_DEMO 未用于实现或验收。
- Windows / PowerShell 7，Node 22.18.0、npm 10.9.3、Chrome 152.0.7977.83。所有本次数字均来自本轮运行。
- 原始地图、影像与冻结 SHA 未改。用户已有论文修改、附件增删和其他未跟踪资料不纳入提交。不推送 main。

## 改动与约定

| 阶段 | 已实现内容 | 主要入口 |
|---|---|---|
| F1 | 连续绘路/建筑/区域、量距/叠放选择、任意已选道路批改、自动 ID 与端点、12 m 双向设计默认、斜矩形/复制、原子接入和升级副本 | drawingDefaults、commands、App、原 SpatialLayer/MapCanvas |
| F2 | Schema 0.3；line/cubic 混合路径、真实长度/最近点/拆分/反向/相交、同一 R/C 草稿、控制柄和米制宽柄、一次拆段变宽、统一编译图 | roadPath、roadBand、topologyEditing、routing、map-compile |
| F3 | 含原图的补标 ZIP、限字段版本绑定补丁、人工锁定、选定目标批量接入、分级输入检查 | codexPackage、semanticPatch、researchAccess、CompletionPanel |
| F4 | 本地场景/计划/事件/指标导入、曲线弧长车辆回放、任务条/倍率/筛选、A/B 口径校验 | results、ResultsPanel、原 MapCanvas 运行叠加 |

正式中文字段、迁移和数值合同见 [FAST01_EXCHANGE.md](FAST01_EXCHANGE.md)。0.1/0.2 保持原版本往返；首次启用新能力时一次显式升级。旧 shapePoints 原值搬到内部 anchors，各段为 line，实体 ID/框架/引用/来源保留。升级副本解除原文件关联，须另存新文件。

几何版本 `world-metre-0.01-1e-4-flat0.05-v1`；长度预算 max(0.01 m, 1e-4 × 初始上界)，默认展平空间误差 0.05 m。道路带/人工走廊临界候选细化至 0.0001 m，不能证明就保留 uncertain。数值误差与影像精度不同。编译版本 FAST01.1，逻辑弧保留方向许可 true/false/null、资源、来源、owner 和未知扩展；采样点不生成 nodes。

低倍率下弯曲柄与宽柄重叠的问题已修复：宽柄离中心至少 16 CSS px，短引线指向真实道路边缘；拖动扣除显示偏移。零位移不改宽，米制道路带保持原值。正反切向、两侧、0.615/10 px/m 及曲线均有测试。

完整规范补齐：同一草稿中 R/C 接续，局部平滑只改本次草稿的切向；任意所选道路通过原批量命令改宽/方向；“此处开始变宽”复用原精确拆路与引用映射，目标半段改宽，碰撞失败全退；M 量距不写地图/历史；叠放对象循环选择遵循可见图层和真实曲线。方向被人工修改时记录 design_assumption 来源，保留旧来源；锁定仍保护编辑。画布普通选择尊重已收起属性栏，上下文行不随选中对象增高。

固定道路的只读路径按 scene.roads 变化准备一次不可变副本，复用同核弧长表；平交预览在指针停顿 100 ms 后计算，地图/草稿/开关变化立即丢弃旧预览，最终提交仍检查精确几何。未新增 Worker、全局状态管理或第二套几何缓存。

分类仅允许 name/kind。推测用途不会改几何，也不会把承载、净高、产能或通行许可猜成已知；低证据保留通用类别，已有人工类别受保护。研究接入仅使用选定目标和明确可通行陆域，代理服务点声明内部运输假设。切换目标/陆域使旧建议立即失效。

结果在导入时编译并核验绑定；每帧只按当前时间求姿态和展示，不全图验证或改静态地图。缺段显示资料缺口，稀疏事件保持最后观测位置；不补假连续运动。地图改变后旧结果保留但停止覆盖。A/B 需相同地图/已核验场景/编译版本/指标定义、单位、时域与证据类别，缺值保持 null。

## 真实输入与旧新对照

真实输入为 CIMC V02 及其校准 JPEG。UI 在保留框架、厂界和真实底图的工作副本上操作；为隔离绘图动作清空实体，不把人工画出的实验道路或测试用途当作新现场测量。

- 地图原件 SHA256：`0eda616cf8bef738d7e099eb2870ef2698ec0c6378c4f1d2452f0845ac4fe5af`。
- JPEG SHA256：`8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713`，1420 × 1340；实际资产来自 `.cache/BG01/calibrated-cimc/`。
- 9 厂、18 份 GA01 V01/V02 原图副本迁移与 SHA 保护通过；`F1-real-migration.json` 为 18/18，最终集成再次读取同一批冻结输入。
- 完整界面回归还使用冻结 Hanwha 入口地图。尺寸覆盖 1920×1080、1366×768、1093×614。

相同 20 个轮廓、10 次道路绘制、Chrome/1920×1080、录屏开启。旧版需 130 次绘制操作，新版 73 次，减少 43.8%；必填属性表和手填 ID 均为 0。旧版额外 6 次准备动作（选择通用类别、隐藏阻挡点击的厂界等）单列，不计入绘制耗时。旧版未误用 workshop 硬保护来人为增加失败次数。

| 隔离串行测量（每版三轮） | 逐轮绘制耗时 ms | 中位数 ms | 操作数 |
|---|---|---:|---:|
| 开工 HEAD 旧版 | 4672 / 4620 / 4557 | 4620 | 130 |
| 最终 FAST01 生产版 | 2736 / 2737 / 2705 | 2736 | 73 |

本轮先完成全量验证，再单 worker、各三轮串行运行旧版和新版，期间无并发构建/单元测试。对应报告为 `baseline-measured/report.json` 和 `final-measured/report.json`。命令沿用下述两个配置，增加 `--repeat-each=3 --workers=1`，新版用 `--grep "F1 reference-image tracing:"`，并通过 `--output` 和 `PLAYWRIGHT_JSON_OUTPUT_FILE` 分离证据。

这里测量脚本驱动普通 UI 的机械开销，不是人工识图和描绘效率。原始坐标、操作数、逐轮毫秒数与录像均在测量目录；不由单次耗时宣称人工效率或研究性能提升。

## 实际检查与退出码

在 map 目录执行，真实数据根和浏览器路径为：

```powershell
$env:SHIPYARD_TEST_DATA_ROOT=(Resolve-Path '.cache/BG01/data-root').Path
$env:PLAYWRIGHT_BROWSERS_PATH=(Resolve-Path '.cache/BG01/browsers').Path
```

| 命令/检查 | 退出码 | 本轮最终结果 |
|---|---:|---|
| npm run schema:check | 0 | 三版本生成合同一致 |
| npm run lint | 0 | ESLint、核心无 DOM 边界通过 |
| npm run build | 0 | 全库及 core 类型检查、生产构建通过 |
| npm test -- --reporter=json --outputFile=.cache/FAST01/final-unit.json | 1 | 779 / 783 通过，4 项 SR02 缺件 |
| npm run test:integration -- --reporter=json --outputFile=.cache/FAST01/final-integration.json | 1 | 106 / 110 通过，4 项 SR02 缺件 |
| npx vitest run tests/integration/FAST01_compile_cli.test.ts --reporter=json --outputFile=.cache/FAST01/final-boundary.json | 0 | 2/2；真实图 CLI/纯 Node 消费者、禁止覆盖原件、DOM 全局反例 |
| npx playwright test -c playwright.fast01-baseline.config.ts（隔离三轮） | 0 | 3/3 旧版真实底图同任务；新版定向三轮也 3/3 |
| npx playwright test -c playwright.fast01.config.ts | 0 | 38/38；原编辑器、真实底图/地图、全程录像 |
| npx playwright test -c .cache/FAST01/playwright.adapters.config.ts | 0 | 6/6；真实 IndexedDB 升级/配额失败/资产损坏/句柄恢复；开发构建的适配器测试 |
| conda run -n paper python .cache/FAST01/audit_package.py <生产 F3 输出目录> | 0 | ZIP 17 成员、16 文件 SHA、原图 SHA、3 原始裁片、轮廓差异和像素变换独立核对 |
| git diff --cached --check | 0 | 无差异格式错误；提交清单无原图/录像/大型二进制/凭据/符号链接 |

SR02_A/B/C/D 的 `projects/shipyard_simulation_SR02/.../map.json` 缺失，导致单元与集成各 4 项 blocked_input。保留退出码 1，不修改冻结断言、不补造输入；不能宣称整个历史测试库全绿。新增 FAST01 及现有可用输入上的回归通过。

F1/F2 曾分别构建可运行产物，保留在 `.cache/FAST01/F1/dist`、`F2/dist`；最终为 `dist/`。F4 最终之前还执行两轮完整开发版回放，捕获并修复持续播放的 React 更新循环。生产宽柄重叠反例及修复前报告保留在 `production-before-width/`；修复后的最终结果以 `production/report.json` 为准。

## T01—T20 对应证据

| ID | 状态 | 实际覆盖 |
|---|---|---|
| T01 | passed | F1 真实底图 20/10 连续描图；旧/新同坐标机械对照 |
| T02 | passed | F1 默认12→18只影响新建，刷新配置恢复；未知/旧限制保留 |
| T03 | passed | F1 两个端点、内部折角非节点、整条道路一次撤销 |
| T04 | passed | FAST01_drawing / FAST02_topology：显式接路、Alt、异层与禁转 |
| T05 | passed | F1 全厂宽柄、F2 曲线宽柄；preview/保存一致、zoom不改宽、零拖动/undo |
| T06 | passed | 斜矩形四直角、复制/undo；ownerEditing 仅改外轮廓；通用对象保存 |
| T07 | passed | F2 混合路径导出/重开一致；新增同草稿 R/C 连续绘制、局部平滑、一次 undo、C→R 保留吸附身份 |
| T08 | passed | 曲线 T 接入浏览器实操；curve—curve 共端点领域测试，无采样节点 |
| T09 | passed | de Casteljau 拆分形状/长度、正反服务路径与共享容量引用 |
| T10 | passed | 不同 zoom 的几何/诊断/路由长度一致；反向控制与实际车辆 yaw |
| T11 | passed | 曲线道路带内/外误差包络；0.015m 细小越界反例；不改几何求通过 |
| T12 | passed | 18 原图副本精确迁移/往返/undo；旧图真实 UI 一次升级 |
| T13 | passed | F3 实际导出 ZIP；Pillow 独立裁片解码、SHA/变换/ID 轮廓核对 |
| T14 | passed | F3 真实补丁一次应用/undo；过期版本拒绝、人工字段保护、推测来源 |
| T15 | passed | F3 两目标/单条原道路批量接入、单undo；换目标失效与未知陆域拒绝 |
| T16 | passed | 生产 BG01/RF01/M11/SV01 保存/恢复/外部冲突/失败收据/合法入口编辑 |
| T17 | passed | 实际 Node CLI 读取真实图、纯 Node 消费编译弧/转向/服务与未知参数 |
| T18 | passed | F4 真实画布车辆、弧长/反向、等待装卸、时间条/暂停/倍率/筛选 |
| T19 | passed | 地图/场景/编译版本拒绝、旧结果保留、缺段/乱序/冲突与动态 vehicleId |
| T20 | passed | A/B 相同口径/单位/时域；null 显示未提供；synthetic 明确标识 |

关键界面证据位于 `.cache/FAST01/production/browser/`：每项都有 `video.webm`；F1 有 measurement.json、F2 有混合曲线 JSON/截图、F3 有 codex-package.zip 与 independent-package-audit.json、F4 有 f4-external-playback.png 与实际下载/导入的运行文件。它们均来自原编辑器操作，未使用 UI_DEMO。

## 独立审查与剩余边界

实际分工：read_fast01_specs 实现 F1/F3 领域并做独立终审；schema_contract 实现 0.3/曲线核与 F4 领域；f1_ui 接入原工作台及真实操作测试；根代理整合、编译/补标 ZIP、独立几何反例、全量回归与交付。仓库 Ponytail full/review 用于复用与简洁性审查；历史验证指引用于原件保护，未沿用旧阶段停止界限。

独立审查发现并关闭：微小曲线越人工走廊被折线漏判、用途推测误触发厂房硬保护、owner/未知扩展编译信息遗漏、旧目标接入建议可提交、任务条缺失、回放 passive-update 循环、宽度/弯曲柄低倍率重叠及 globalThis DOM 漏检。Ponytail 删除未使用包装函数和纯转发回调；保留必要版本/来源/引用保护，无新增运行依赖。

本次实现文件回放，不提供实时服务或内置优化。带独立内部几何的 turn movement、缺少内部授权语义的 owner 道路活动明确 unsupported；不会默许穿行或用假连接补齐。曲线自相交诊断未作全图穷举，预算不足/临界误差保持未确认。synthetic 协议样例不代表现场运输可行、优化收益、测得产能或完整车辆扫掠。

控制器裁决：F1—F4、T01—T20 与完整规范的五项补充要求通过；最终生产回归 38/38，相关可用原件与新增功能的核心回归通过。历史 SR02 缺件独立标 blocked_input。补齐审查还关闭了静止指针切平交开关残留预览、C 待定吸附终点切 R 丢接路身份两个问题，真实 UI 验证选择/提示不改变画布尺寸。

远程交付规则：自动审批曾拒绝默认 origin 的外发。完整规范指定 NCR7777/Shipyard-Map-Generation，本地单体仓库 origin 却为 NCR7777/Paper-Release-burstiness；发布只可取 map 子树、以指定地图仓库基线为父提交，不携带论文目录和单体仓库历史。非 main 分支的实际交付状态、最终本地 SHA 和应用子树 SHA 记录于本地 `.cache/FAST01/delivery.json`；未执行的推送不得写为成功。

本轮本地验收入口：[完整绘制操作录像](../.cache/FAST01/FAST01_complete_workflow.webm)、[外部结果回放录像](../.cache/FAST01/FAST01_external_playback.webm)、[回放截图](../.cache/FAST01/FAST01_external_playback.png)。底图与录像仅保留本地，不进入源代码提交。适配器 6 项检查在五项补齐前执行，补齐未修改其持久化模块；最终生产保存/底图/工作台回归已全部重跑。
