# P1 收尾与 P2A 只读诊断

状态：本批 P1 收尾与 P2A 通过。最终完整浏览器 84/84；正确性与 Ponytail 审查无剩余阻断。P1 保留，不重写。

## 范围与真实输入

开工分支 master，源基线 124c5ec47b639e01deb84fb3d2f12aa2477e3af3；已发布 P1 子树提交 f8c79eb1424bfceac440914e3cdc2aabfdc73fdb，树 dbdf3aadb583c25375f9019f3fcfffed0fd3a465。用户评审 ZIP SHA256：2b8989efb2eb13f8345e6af8d5a6343e587f376142b2871dad01ca6cb5c15657。

已读取三级 AGENTS、项目内 Ponytail full/review、原完善任务书与评审包。仅完成 P1 收尾和 P2A；未进入 P2 自动修复或 P3/P4。用户论文修改、旧 ZIP 删除、未跟踪任务书和评审包保留。本批不自动推送。默认 origin 仍是论文仓库，未将它当作地图发布目标。

执行顺序为：冻结 P1 生产证据 → 原件根目录配置 → D 图测量与局部优化 → 只读网络/空间诊断及路径 → 原件/命名故障回归 → 分别审查 → 本地提交并核对证据。Schema、领域命令、保存格式和运行依赖未变。

## P1 证据与生产性能

旧 SR03 包中 readonlyExpected=true 的截图/回执仍是旧证据，没有改名充当本次验收。新 P1 基线证据位于 ../.cache/P2A/p1-evidence/manifest.json，绑定上述提交、冻结构建、四图输入 SHA、截图、JSON 全等、真实 IndexedDB checkpoint 以及 A/F_001、A/Z_005 联动前后摘要。基线生产验收 6/6，CPU 采样另外 1/1。清单有 35 个文件摘要，清单自身 SHA256 为 1332c5038f61f6d310beb0b305adb52d94307e30173251409a44410f59cb1ae7。

原件测试共用 tests/helpers/P1_targets.ts。SHIPYARD_TEST_DATA_ROOT 指向含 projects/ 的根目录；默认沿用原工作区结构。显式根目录下原件集成 17/17。缺文件、根目录空白或 SHA 不同仍报 blocked_input，不跳过、不新造同名地图。全部 16 份冻结原件继续参加兼容回归。

当前生产版本再跑同一 6 项验收，全部通过，独立保存于 ../.cache/P2A/production-current/，不会覆盖 P1 基线。浏览器为 Chrome 152.0.7977.83，CPU Intel Core Ultra 9 275HX，1440×1000，无头浏览器。

| D 图操作 | P1 基线 | 当前生产版本 |
| --- | ---: | ---: |
| 完整原图导入并适应地图 | 3252.5 ms | 3161.4 ms |
| 搜索 F_001 | 172.7 ms | 137.4 ms |
| 定位 F_001 后 100 步鼠标拖动并提交 | 4904.9 ms | 3351.6 ms |
| 拖动期间 ScriptDuration | 4208.1 ms | 2651.8 ms |
| 超过 50 ms 的 RAF 间隔 | 18 | 2 |
| 修改后保存至 checkpoint | 1673.3 ms | 1376.5 ms |

这是同机同浏览器的单次观测，包含自动化输入、等待绘制、保存轮询开销；100 步输入不等于 100 个渲染帧。没有宣称稳定帧率或跨硬件保证。基线 CPU 采样查到反复摘要计算与 PolygonPanel 能力/规划读取；仅在不可变 session.map、选中对象及策略依赖上复用 React useMemo 和已有 SceneSnapshot 摘要。命令提交、保存回调仍重新校验当前数据。未增加 Worker、空间索引框架或持久化派生缓存。

当前生产 JS SHA256：3b3c1848d87c58b017db04e6eed69a4b86f137a127bdec48ef120da819348d55。最终本地源码提交、构建和所有回执将在 ../.cache/P2A/delivery-manifest.json 对应。

## 已实现的只读范围

- 交点：X/T 候选、同址不同节点 ID、端点近邻、节点靠近道路内部、共线重叠、自交、零长段、孤立节点/服务目标、独立子网及设施缺少入口/服务声明。给出稳定代码、实体、JSON Pointer 和位置；不自动接路。XY 容差 1e-7 m，近邻提示 0.5 m，声明 Z 只提供线索。
- 路径：起终点只能选显式服务点/入口，使用入弧状态搜索。已知允许图与未知条件候选图分别计算；显式禁止转向不会进入任一图。起点沿真实出弧离场，目标 explicit_internal 到达序列必须完整走完，node_proxy 明示其代理假设。不把设施中心当装卸点、不瞬移、不穿过第三方 owner 的内部道路。
- 空间：完整槽位面（含孔洞）与 owner 包含；同 owner 槽位正面积交；明确内部服务节点与 owner 位置；道路声明带与明确禁入面、人工道路带与中心线一致性。包围盒仅筛选，边界接触、合法父子包含不判冲突。道路无人工面时仅从已知正宽度计算圆端/圆连接段胶囊并集。
- UI：复用右侧滚动栏、原生 details、既有 Issue 检查器和定位、Konva 非交互路线覆盖层。诊断包含隐藏/锁定对象，未应用输入不参与但保持。结果绑定完整地图内容摘要；新摘要撤去旧清单/路线/标记，刷新后手动重算。
- CLI：map:diagnose 共用 loadMap、diagnoseMap、previewPath，输入先经原有解析/校验路径。无写文件行为；默认向 stdout 输出 JSON 报告。

路径状态严格分为 found / unconfirmed / disconnected / not_checked。没有任何明确禁区的 A 图，其道路/禁区检查为 not_checked；B/C/D 分别有 8/9/9 个明确禁区。未知行为、未声明条件、多节点路口过渡或独立 movement 内部几何、数值/比较预算耗尽均不冒充已检查。网络最多 200 万比较/500 条清单；空间最多 200 万比较/200 条问题；路径最多 4000 有向弧且总搜索工作有界，达到上限明确降级。

## 四份冻结原图实际结果

真实路径为数据根目录下 projects/shipyard_simulation_SR03/SR03_X/map.json，均 synthetic、Schema 0.2.0。完整冻结 SHA 位于原件 helper 与各 JSON 回执。

| 图 | 文件 SHA 前12位 | 节点/道路 | 槽位 | 无入口/服务声明设施提示 | SP_001 → SP_002 确认长度 |
| --- | --- | ---: | ---: | ---: | ---: |
| A | f0f296242d1a | 59/71 | 48 | 8 | 78.5 m |
| B | 283d08934e1e | 149/175 | 209 | 21 | 283.5 m |
| C | 01fd0d607506 | 129/149 | 318 | 28 | 544.5 m |
| D | 0fb0d6f565d3 | 207/245 | 1421 | 48 | 570 m |

四图没有本批规则发现的 X/T 未连接交点、近邻端点、共线重叠、孤立节点/子网、槽位越界或同 owner 槽位重叠。对已声明禁区的 B/C/D 没有道路带冲突；A 缺少禁区声明，不能作此结论。上述设施提示是声明缺失，不代表本来不参与运输的办公/辅助设施有错误。未为了演示而强称原图存在缺陷。

每图只预览表中一个指定服务点对，没有做全服务点对或现实运输可达认证。四图报告均为 partial，因为现场层高、扫掠、净空、来源真实性、动态资源与作业执行不在本批检查内。来源原件文件 SHA、序列化内容、revision、资源/转向及编辑历史前后均未变。完整报告在 ../.cache/P2A/diagnostics/，同核 CLI 报告在 ../.cache/P2A/cli/。

## 故障反例与拒绝行为

先运行四份原件，再以深复制生成以下明确命名副本，全部位于 ../.cache/P2A/faults/P2A_fault_SR03_A_*.map.json；mapId/name 明示故障注入，不冒充原图。

| 注入后缀 | 实际结果 |
| --- | --- |
| disconnected | 两个公共连接端点改为同址新 ID，显式网络断开；不因相交/同址自动接回 |
| forbidden_turn | 目的入口进入必经到达弧的转向全部显式禁止，返回 disconnected |
| unknown_direction | 源节点两条道路方向 unknown，只返回 unconfirmed 候选 |
| invalid_reference | 删除被引用道路，原有共享导入/CLI 拒绝；不把无效图叫断路 |
| slot_outside / owner_hole | 定位到槽位边界字段，报告越界 |
| slot_overlap | 同 owner 槽位正面积重叠；资源容量和槽位 ID 未修写 |
| forbidden_road | 声明禁入面与道路带相交，报告冲突 |
| width_unknown | 没有默认补宽度，显示道路带未检查 |

独立 synthetic 单测另覆盖合法孔洞/接触、道路带切边、bbox 假阳性、多入弧转向、单向入口另有出口、未知行为、未来 movement 几何、极端坐标/预算，以及重复折点。故障副本 JSON 和报告相互分开，原件 SHA 始终固定。

## 实际命令与回执

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| npm.cmd run schema:check | Schema 生成类型一致，Schema 未改 | 0 |
| npm.cmd run typecheck | 应用及纯核心通过 | 0 |
| npm.cmd run lint | ESLint、核心依赖边界通过 | 0 |
| npm.cmd run test | 21 文件，438/438 | 0 |
| npm.cmd run test:integration | 5 文件，49/49 | 0 |
| npm.cmd run build | 226 模块，JS 935.32 kB / gzip 286.35 kB | 0 |
| npm.cmd run test:production | 当前生产构建 6/6，34.3 s | 0 |
| npm.cmd run test:e2e -- tests/e2e/P2A_diagnostics.spec.ts | 5/5，24.5 s | 0 |
| npm.cmd run test:e2e | Chrome 84/84，5.1 min | 0 |
| node --import tsx scripts/map-validate.ts 原件路径 | 四份 SR03 合法草稿 | 各 0 |
| node --import tsx scripts/map-diagnose.ts 原件路径 --from servicePoints:SP_001 --to servicePoints:SP_002 | 四份只读报告 partial/found，输入 SHA 不变 | 各 0 |
| 同一诊断命令运行 9 份 P2A_fault 副本 | 8 份可解析报告；invalid_reference 被拒绝 | 8×0；1×1（预期） |

诊断 CLI 的 0 只代表报告生成，允许其中包含冲突或未检查；1 是输入无效，2 是文件/参数错误。故意缺参数/文件、重复参数及无效引用由 CLI 实测/回归覆盖。原有发布 profile 继续 unsupported。确切路径参数、stderr、退出码和前后摘要见 ../.cache/P2A/cli/commands.json。其余完整命令日志在 ../.cache/P2A/*-final.txt。

失败均保留：P1 基线首轮 3/6，原因是新测试错误假定导入后已发生自动保存，改为检查实际 checkpoint/version 后 6/6；开发中 lint 首次误扫缓存冻结 bundle，已将 .cache 产物排除；新增 P2A 首轮 4/5 的空 marker 断言改为真实 null 协议。首轮全量浏览器 78/84，新中心面板挤占画布导致六个原交互失败；移入右侧现有滚动栏后六项原断言均通过。新尺寸断言又定位到既有隐藏目录计数逃逸滚动容器，使页面高 10425 px；以 object-list 的局部定位规则修正后，P2A 五项与页面高度断言通过。没有删除旧用例或放松 JSON/坐标/历史断言。

## 独立审查与边界

正确性审查与 Ponytail 冗余审查分别进行。独立正确性审查复现并关闭：把 arrival 反向当唯一出口的错误断路、长道路无量纲容差漏报、重复点假自交、无禁区却显示 checked；最后复核 CLI/hash/缓存/锁定/保存及本批 UI 接线，无剩余阻断。审查者明确未将静态代码检查冒充浏览器运行。

Ponytail 审查结论为 Lean already. Ship. 现有几何、服务解析、Issue、目录、SceneSnapshot、保存、不可变事务均复用；没有新框架、依赖、领域主数据、通用插件/权限/缓存层。该结论仅代表冗余审查，不代替测试裁决。

未实现：自动修复、节点合并、槽位重排、ZIP/底图、用地/产能统计、调度器、3D/VR；没有恢复旧仿真路线。未检查：物理扫掠/净空、实际层高、容量执行、交通排队与现场来源认证。多节点路口过渡和独立转向内部几何仍明确 not_checked。路线优先显示确认结果，候选及其假设列出，不产出可编辑冲突几何。

环境限制：复用现有锁定依赖，本批未重新 npm ci；仅 Chrome，没有 Firefox/Safari 或真实操作系统文件权限手工验收，旧文件回归用真实 OPFS 加模拟 picker。构建仍有 >500 kB 提示，D 图密集标签仍可能相叠，未扩展标签避让。P1 D 与当前 P2A 截图执行目视核对；常规本地图片工具遇 Windows sandbox helper 错误，改为只读内存缩略图查看，截图原文件未改。

本批完成后停止。后续修复或下一阶段须另行明确范围。
