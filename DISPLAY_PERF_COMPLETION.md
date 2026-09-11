# DP0／DP1 显示性能与标签交付

本批采用项目 Ponytail full。产品保持 React／TypeScript／Konva；不改变地图模型、调度数据或旧结果，不新增运行依赖。只提交本批 map 文件，不推送。

## 输入与构建身份

- 开工：`master@925e09b98e4644680443ba64b829216c91138624`；`HEAD:map` 树为 `00aa6a613b23b6b4414ff862a5f7ac02884384ea`，与任务书公开基线 `5171889` 一致。
- 使用真正的 `projects/SHI_Geoje_Research_Map_v03/map.json`：4,569,645 字节，SHA-256 `df1d7c6ec5148ef237e9a5ffa8e2b064e984a397e3799bf44f8f2c3117eaaa5a`。590 节点、604 道路、113 设施、33 区域、110 入口、138 服务点、434 路口、1,634 转向、1,308 资源、1,108 槽位。
- 地图语义摘要：`0b765ed33ef3913866dc89d4a22ee49cdc62dec6c5921efb7dec4fd00bd50e47`。原图与 SR03 回归原件保留；冻结 SHA 不匹配或数据缺失返回 `blocked_input`，不替换小样例。
- 旧正常生产 JS SHA：`3b3c1848d87c58b017db04e6eed69a4b86f137a127bdec48ef120da819348d55`。最终正常生产 JS 为 `dist/assets/index-DlaNuCkV.js`，SHA-256 `267cbe238cc8d5b4e01f23908ff7e8a2d25b215ba59ac5671b1b2e6b24e750e6`；最后一次 build 与冻结测量产物一致。56 项构建输入以规范化 LF 摘要比对一致，原始测量字节摘要同时保留，避免 Git CRLF 转换造成误认。完整源码／构建／指标身份见 `docs/evidence/DP1/metrics.json`；本报告与这些源码同一提交，可用 `git log -1 -- DISPLAY_PERF_COMPLETION.md` 定位。
- 开工已有论文改动、旧矩形 ZIP 删除和用户附件均保留，不纳入本批提交。

## 实际改动

相机输入用一个有效相机和一个待执行 RAF 累积；每个滚轮事件保留原 1.15 比例与自己的锚点。点击、绘图和拖动起止在必要时同步相机与命中画布。中键平移按增量叠加到当前相机；fit、定位、恢复、Esc 和失焦使旧任务失效。保存同步取得有效相机。

光标更新留在画布 HUD。保留已有地图级 memo，并隔离目录、属性、问题和诊断面板。显示索引只依赖当前不可变场景，先做保守包围盒筛选，再投影候选；道路范围包含半宽。槽位、路口和普通节点按屏幕尺寸分级，焦点、绘图和拖动对象有明确例外；隐藏和锁定继续优先。

标签统一为 `auto / focus / off / debug_all`，自动模式使用短 ID、有界候选、跨类型避让和面内检查。普通预算为每 800,000 CSS 像素 80 条、最多 200，候选最多四倍，每条最多四个位置，测量缓存最多 2,048 项。复杂面检查超过工作预算则省略普通标签，完整信息仍在属性面板。导航期间保留主体，最后输入后 150ms 启动当前尺度恢复。`off` 同时关闭悬停卡；`debug_all` 明示允许重叠，不纳入默认性能验收。

仅 EditorState 迁移：旧 `showLabels=false` → `off`，true／缺失 → `auto`，有效 `labelMode` 优先，非法枚举拒绝；规范化后只保存 `labelMode`。地图 JSON、revision、contentHash、资源及场景绑定不由显示操作修改。

## 测量方法与归因

参考机器：Windows 10.0.26200，Intel Core Ultra 9 275HX，24 逻辑 CPU，约 32 GiB RAM；Chrome 152.0.7977.83，Node 22.18.0。页面 1440×1000，画布 918×495 CSS 像素，DPR=1。浏览器实际 ANGLE renderer 为 NVIDIA GeForce RTX 5070 Ti Laptop／Direct3D11；2D canvas、合成、光栅化启用。

参考测量使用 Chrome `--fake-vsync-rate=60`，空闲 RAF 实际约 17.7–18.1ms。这是浏览器 VSync 模拟，不是物理 60Hz 显示认证。原生刷新检查单列。正常 minified 生产计时、轻量输入至绘制探针和 React／CPU 详细剖析分开；不把探针耗时冒充正常构建帧率。

同地图、同相机、同输入轨迹，旧标签开／关与新 auto／focus 各预热一轮、正式五轮：每轮放大、反向缩小、中键平移。每段约 10 秒，保存连续 RAF、输入和相机轨迹；轻量构建另记录对应 scene／hit 绘制完成。未采集物理屏幕呈现帧。旧基线中极少段因原定时器提前不足 1ms，原始持续时间保留；后续脚本明确等待至少 10,000ms，未重写旧回执。冻结预算为 RAF p95≤33.3ms、输入至对应相机绘制提交 p95≤50ms、停止恢复 p95≤300ms。

旧生产平移 RAF p95 五轮中位数：标签开 1,016.9ms、关 766.1ms。关闭文字仍明显慢。单独 profile 确认 React 更新占较多成本；原有摘要、校验和场景 memo 已有效，导航计数为零，不能把它们说成原来的主要瓶颈。

第一版 DP1 平移降至 36.0ms，仍超预算。新剖析显示 Konva 事件反复解绑／绑定与属性提交占主耗时，几何纯计算占比较小。先稳定道路回调后平移脚本耗时再降约 13%，p95 仍 35.1–35.2ms；随后把同一机制用于其他现有图形。全部共享后事件重绑计时从约 1,509ms 降至 7.6ms，挂载对象仍为 2,524 个。共享回调仍读取当前权限、实体 ID 和相机，未缓存旧闭包。未实施世界坐标容器重写、Worker、WebGL、对象 bitmap cache 或目录虚拟化。

后续短测出现环境漂移：新候选两轮 pan p95=72.0／72.1ms；用**同一最新 runner**重跑冻结的道路共享候选，得到 89.6ms，而其早先为约 35ms。浏览器、画布、DPR 和 GPU renderer 相同；供电显示 AC／100%、平衡计划，系统聚合 CPU 频率约 1.8–1.9GHz（不能推断单线程实际时钟）。多类操作的单次耗时同时增长，具体原因未证实。因此早期与晚期速度比只供过程参考，最终结论采用完整后续五轮，并如实判定预算；未拿最快短测替代正式测量。

正式正常生产结果如下，数值是五轮各自 p95 的中位数（ms）：

| 模式 | 放大 RAF p95 | 缩小 RAF p95 | 平移 RAF p95 | 平移 >100ms 次数中位数 |
|---|---:|---:|---:|---:|
| 旧 on | 53.1 | 53.2 | 1016.9 | 20 |
| 旧 off | 35.1 | 35.1 | 766.1 | 25 |
| 新 auto | 18.2 | 18.2 | **72.1** | 1 |
| 新 focus | 18.1 | 18.1 | 18.1 | 0 |

新 auto 正式平移五轮为 72.2／72.0／72.1／72.1／18.1ms；第五轮加速发生在切换 focus **之前**。因此不能把整段速度变化归因于标签模式。默认 auto 平移仍未达到 33.3ms，且正式五轮共有 3 次 >100ms RAF 间隔；这些长停顿保留在逐轮结果和轨迹中。

单独轻量构建的 30 个正式段中，3,307 个有效相机增量全部找到对应绘制完成，非法时钟／未完成输入／恢复失配均为 0。各模式与轨迹组的事件至完整绘制 p95 中位数为 **125.4–130.3ms**，超过 50ms；接收事件后的口径也为 100.1–118.4ms，不能用时钟基准解释通过。恢复 p95 中位数为 **60.3–227.9ms**，全部组低于 300ms；平移松键立即结束导航，故恢复可短于 150ms。此处完成指当前相机对应所有已安排的 scene／hit 绘制返回，同时恢复标签的 ID、文字、位置及字号与本次布局一致，不等于屏幕物理呈现。

轻量构建 10 个有 45 条常驻文字的整厂／平移采样均无 4px 标签框间距冲突。focus 无选中对象和固定空地局部采样中的零标签属于空集，不作非空布局的证明。最终补充真实服务点附近的同相机截图，见证据目录。

## A01—A22 裁决

功能验收使用下列独立证据；最终运行状态见命令表。标为限定覆盖的条目不能外推到任意硬件或所有浏览器内部行为。

| 条目 | 本批裁决 | 证据及边界 |
|---|---|---|
| A01 | 通过 | 生产脚本逐次校验真实 SHI v03 字节 SHA、实体计数、前后语义摘要；SR03 原件检查保持冻结 SHA。 |
| A02 | 通过 | 同相机整厂前后截图；新 auto 主道路、厂界及设施保留，标签有预算。 |
| A03 | 通过 | 三尺度截图＋`DP1_display` 的稳定排序、候选上限和跨类型标签不重叠检查。 |
| A04 | 通过（限定覆盖） | 标签只派生短 ID；`DP1_review` 验证长 ID 的原生完整选区、名称与来源，未写系统剪贴板；真实资源 ID 与关注详情、导出 JSON 保持完整。 |
| A05 | 通过 | 共享节点 ID 去重、不同节点不合并单元反例；真实 SHI 连续 12 个设施多选检查卡片及标签上限，资源定位高亮回归。 |
| A06 | 通过 | 凹面、孔洞、旋转矩形与长 ID 单元反例；旧矩形视觉／几何回归，超预算面省略普通文字。 |
| A07 | 通过 | 100 次混合锚点输入只排一个 RAF；浏览器同任务滚轮、反向滚轮、中键夹滚轮。 |
| A08 | 通过 | 快速滚轮后立即点节点、绘制节点、拉矩形角；按下未到拖动阈值时滚轮被阻止。 |
| A09 | 通过 | mouseup／Esc／blur 和工程替换取消旧任务；停止恢复另见轻量绘制探针。 |
| A10 | 通过 | 节点及矩形一次编辑只产生一个 revision／撤销事务；原件联动、撤销重做回归。 |
| A11 | 通过 | 长线跨视口、包含视口的大面、道路半宽边缘、预览平移和极端数值单元反例，旧道路宽度浏览器回归。 |
| A12 | 通过 | 图层隐藏保持隐藏；真实 SR03_A 槽位缩小到 LOD 阈值以下后点击命中所属设施，目录定位后可选储位；控制柄像素及拖动回归。 |
| A13 | 通过 | 相机累加数学断言＋立即输入命中／米制导出断言＋矩形字号与道路宽度回归。 |
| A14 | 通过（限定覆盖） | 同一有界布局跨类型避让并排除 HUD／手柄框；浏览器用真实手柄坐标确认关注卡不遮挡；轻量探针在各段结束审计当前 SHI 视窗的真实 Text 盒，未穷举所有可能视窗。 |
| A15 | 通过 | 独立 profile 导航期间目录、摘要、校验、reader、scene 和诊断计数为零；保存事件另计。 |
| A16 | 通过 | 四模式刷新、旧 false 迁移、延迟 RAF 后即时 Ctrl+S、同地图不同工程恢复；未应用输入及绘图草稿保留。 |
| A17 | 通过 | 生产轨迹的 mapHash／r0／零历史与原件 SHA 前后相同；浏览器纯显示导出 JSON 等值。 |
| A18 | 通过 | 隐藏和锁定不改 scene／诊断输入；锁定关联节点／资源／槽位拒绝间接编辑及历史操作。 |
| A19 | 通过 | 全量现有 E2E，包含道路拆分、宽度、矩形、服务关联、输入保护、未知扩展、外部文件冲突。 |
| A20 | **未达预算** | **单独按正式逐轮结果和冻结预算裁决；测量成功不等于性能通过。** |
| A21 | 通过（限定覆盖） | 20 轮导航、5 次实际工程切换的 Stage／Text／可交互对象／缓存、RAF／函数 timer／window、document、fonts 监听计数；配合 FrameCamera.dispose 单元检查。页面关闭仅证明文档销毁，未声称完成浏览器／GPU 全内存泄漏证明。 |
| A22 | 通过 | 三尺度同相机前后 PNG、可检查 RAF／输入／相机／绘制轨迹与机器可读结果；空地局部截图明确不作编辑信息证据，另取真实服务点附近视窗。 |


三个稳态视图均以 `SP_A003` 附近为中心，使用真实中键平移和滚轮取得，未注入相机。两版每个尺度的相机数值完全一致：

| 尺度 | 改造前 | 改造后 |
|---|---|---|
| 整厂 | [before-overview.png](docs/evidence/DP1/before-overview.png) | [after-overview.png](docs/evidence/DP1/after-overview.png) |
| 片区 | [before-sector.png](docs/evidence/DP1/before-sector.png) | [after-sector.png](docs/evidence/DP1/after-sector.png) |
| 局部 | [before-local.png](docs/evidence/DP1/before-local.png) | [after-local.png](docs/evidence/DP1/after-local.png) |

局部普通文字之间有界避让不等于图形避让：例如 J_N0060 标签居中时，节点圈与道路仍可能穿过文字。完整制图级线条／图标避让未实现；已要求的选中手柄和 HUD 避让单独验证。连续轨迹见同目录 `before-pan-trace.json`、`after-pan-trace.json`、`draw-pan-trace.json`，完整逐轮汇总及原始回执 SHA 位于 `metrics.json`。

原生正常生产补测退出 0：空闲 RAF p95=4.3ms；两模式正式缩放 p95=4.3ms、平移=20.9ms，正式 >50ms 合计 2 次、>100ms 为 0。不过 auto 预热平移 p95=75ms，仍存在速度漂移；没有据单个快轮更改参考环境的未达裁决。

A21 实际回执退出 0：20 轮导航与 5 次工程切换，共 26 个稳态记录均为 Stage=1、图形节点=2,524、Text=311、可交互对象=2,193；全局／document／fonts 监听计数始终 48，fonts loadingdone 始终 1，RAF 始终 0。导航采样中最多有 1 个未到期函数 timer，切换结束与关页前为 0；文字缓存从 119 项降到 101 项，没有逐轮增长。页面已关闭。轻量构建在同一锚点的整厂／片区／局部实际文字数为 45／25／9，三个视窗的标签框间距冲突均为 0。

## 检查与复现

在 `paper01/map` 运行。依赖沿用原锁文件；本批未安装或升级运行依赖。数据根是包含 `projects/` 的目录，可通过 `SHIPYARD_TEST_DATA_ROOT` 或性能脚本 `--data-root` 指定。

```powershell
$env:SHIPYARD_TEST_DATA_ROOT = (Resolve-Path ../..).Path
npm.cmd ci
npm.cmd run schema:check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
npm.cmd run test:e2e
npm.cmd run map:validate -- ../../projects/SHI_Geoje_Research_Map_v03/map.json
node scripts/DP-performance.mjs --dist dist --output .cache/DP-reproduce --modes auto,focus --rounds 5 --warmup-rounds 1 --refresh-rate 60
node scripts/DP-measurement-build.mjs --source . --output .cache/DP-timing-dist --timing-only
node scripts/DP-performance.mjs --dist .cache/DP-timing-dist --output .cache/DP-timing-reproduce --modes auto,focus --rounds 5 --warmup-rounds 1 --refresh-rate 60
node scripts/DP-measurement-build.mjs --source . --output .cache/DP-profile-dist
node scripts/DP-performance.mjs --dist .cache/DP-profile-dist --output .cache/DP-profile-reproduce --modes auto --rounds 1 --warmup-rounds 0 --kinds pan --profile
node scripts/DP-performance.mjs --dist .cache/DP-timing-dist --output .cache/DP-stress-reproduce --modes auto --stress-only
```

重建旧基线时取本仓库 `925e09b:map` 源码及其锁文件构建，再用当前性能脚本指定该 dist 和 `--modes on,off`。原始测量 runner 和完整文件身份留在 `.cache/DP1`；交付指标保留各轮实际 runner／bundle SHA。

`npm ci` 是新环境复现步骤，本轮未执行，不能标通过。性能输出目录必须不存在，脚本拒绝覆盖旧证据。首次 URL 脚本失败退出 1、缓存快照被 Vitest 重复发现、最初共享回调 TypeScript 类型错误退出 2，以及 Escape 回归失败均保留原回执。最终测试脚本排除 `.cache/**`；Escape 问题由稳定键盘订阅修复，原失败测试未删。新增测试首轮还遇到 Playwright Node ESM 测试入口导入问题，改为直接读取冻结原件声明；SHI 多选测试首次导入后没有 fit，落在空视窗，补上显式“适应地图”后通过。两者均保留失败回执，未更改产品或放宽非空标签断言。补充截图的旧版本首轮探针误把含鼠标坐标的状态栏整体当作历史，退出 1；改为比较真实历史 span 后在新目录重跑退出 0，旧失败目录保留。

| 本轮最终命令 | 退出码 | 实际结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | 生成类型与 Schema 一致 |
| `npm.cmd run typecheck` | 0 | UI 与无 DOM 核心类型检查 |
| `npm.cmd run lint` | 0 | ESLint 与核心依赖边界通过 |
| `npm.cmd run test` | 0 | 23 文件，478/478 |
| `npm.cmd run test:integration` | 0 | 5 文件，49/49 |
| `npm.cmd run build` | 0 | 最终产物 SHA 与测量冻结版一致；保留大块提示 |
| `npm.cmd run map:validate -- ../../projects/SHI_Geoje_Research_Map_v03/map.json` | 0 | 合法草稿，0 错误、142 原有提示；不是通行安全认证 |
| `npm.cmd run test:e2e` | 0 | **102/102，6.2 分钟**；含真实 SHI、SR03 四原件及受影响回归 |
| 正常生产性能：baseline on/off、final auto/focus | 0 / 0 | 各 36 段：两模式×预热1＋正式5×三轨迹；测量完成、预算未全部通过 |
| 轻量绘制探针：final auto/focus | 0 | 36 段，30 正式段；3307 个有效增量全部完成 |
| 独立详细 profile、共享回调对照 | 0 | 不混入正常计时；完整命令在指标中 |
| 真实锚点三尺度前后截图 | 0 / 0 | 每尺度相机完全一致，实际画面已核对 |
| A21 `--stress-only` | 0 | 20 轮导航＋5 次工程切换，清理范围见上文 |
| 原生刷新补测 | 0 | 12 段：预热1＋正式1，两模式三轨迹；不替代五轮参考验收 |
| `npm.cmd ci` | 未运行 | 沿用既有锁定依赖；只列为新环境复现步骤 |

完整命令参数、工作目录、逐轮值、退出码及保存的回执 SHA 见 `docs/evidence/DP1/metrics.json`；最终源码检查输出见同目录 `checks.log`。全量 E2E 使用既有开发服务器；大图性能与截图使用独立 minified 生产构建。

## 独立审查与边界

正确性审查（`dp1_correctness_review`）与 Ponytail 冗余审查（`dp1_ponytail_final`）分别完成，均只读审查，不把它们当作额外运行的浏览器测试。最终正确性结论为无新增产品阻断；Ponytail 结论为 `Lean already. Ship.`。正确性审查发现并推动修复资源焦点不同步、关注卡遮挡手柄、混合滚轮平移覆盖新相机，以及重渲染中键盘监听失效；修复后再次只读核对。Ponytail 审查建议删除三个未使用的显示索引字段，已删除；最终共享回调有多处实际调用，未引入新平台或依赖。

本批功能实现、原件回归及证据整理已完成；最终单元 478/478、集成 49/49、浏览器 102/102 均通过，仅作本地提交。**性能目标未全部达到，不能裁决“DP1 已完全达到显示性能目标”**：默认 auto 平移与输入至完整绘制仍超预算；停止恢复满足已测目标。保留正常构建的明显改善，也保留长停顿和未解释的时间漂移。

没有继续做世界容器变换或目录虚拟化：现有轨迹未确认纯投影或目录是主耗时；共享图形事件回调已沿现有实现局部收敛。未添加 Worker、WebGL、新绘图库、运行依赖、逐对象 cache、低分辨率降级；不删槽位，不关闭校验。后续如继续追求预算，应先在可控性能窗口复核剩余 Konva scene／hit 与 host 属性提交成本，再选择单项局部改造。本批停止，不自动启动新的改造或推送。

已知边界：原生补测不代替五轮参考环境验收；测量不证明物理显示帧、GPU 内存或 OS 剪贴板写入。A21 只审计明确列出的监听及任务类别，页面关闭不等于执行 React 卸载；卸载中的相机任务清理由单元测试验证。生产 build 退出 0，但保留 Vite 对约 951kB minified JS 大块的提示，本批未为消除提示引入分包工程。
