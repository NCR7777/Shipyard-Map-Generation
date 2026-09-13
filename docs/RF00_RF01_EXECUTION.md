# RF00 / RF01 执行报告

状态：RF00 完成；RF01 本期限定功能与回归满足退出条件。性能预算未整体达到，SR02 缺件继续单列。停止在 RF01；未提交、未推送、未进入 RF02。

2026-09-13补充：下述完整139项回归对应RF01阶段构建 `index-MAB1NtZs.js`；最新侧栏可达性修补及其增量验证见文末，不将旧构建结果冒充新构建重跑。

## 起点与范围

- 从本地最新 HEAD `a98ed050d662ed850afdcb38255877bff40cc43e` 建立 `codex/rf00-rf01`。原分支 `master`；未回退、未提交或推送。
- 指导 SHA `6f8b0bea59e6277f4452d102a109ccacfedd3757` 是拆分仓库根；应比较其根树与 HEAD 的 `map` 子树，两者均为 `7eb7113f1a9fa53f7b3f21bf51809200c68156f3`，差异退出 0。
- 唯一范围见 [CURRENT_SCOPE.md](CURRENT_SCOPE.md)。原有 GA01、TE01、DP1 相机/标签链保留。
- 起始工作树的 26 项状态全部保留，包括论文修改、附件、既有 ZIP 删除；校对记录 [worktree-preservation.json](../.cache/RF01/worktree-preservation.json)。这是状态核对，并非此前未记录字节的逐文件哈希追溯。
- GA01 18/18 原始文件冻结 SHA 匹配；历史 SR03 4/4 匹配；SR02 A–D 缺失，`blocked_input`。没有替换输入、修改冻结断言或写回原图。SR03 数据本身为 synthetic，不代替十八图 reference_based 输入。

## RF00 基线

| 检查 | 退出码 | 实际结果 |
|---|---:|---|
| Schema、类型、lint、build（计划轮） | 0 | 均通过，build 有体积提示 |
| unit（计划轮） | 1 | 550 通过，4 项 SR02 缺件 |
| integration（计划轮） | 1 | 86 通过，4 项 SR02 缺件 |
| SR03 production（计划轮） | 0 | 6/6 |
| 独立 HEAD 全 E2E | 0 | 130/130 |
| 独立 HEAD GA01-B production | 0 | 18/18 |
| 独立 HEAD TE01 production | 0 | 6/6 |
| 独立 HEAD build | 0 | 与 219 个 tracked 文件 Git blob 核对一致 |

完整 RF00 命令、数据根、退出码和隔离源码身份见 [baseline-results.json](../.cache/RF00/baseline-results.json)。首次归档从子目录调用导致空 ZIP 和 npm ENOENT（-4058），已从仓库根归档修正；该环境失败记录保留。

三个当前任务在三个视窗留下 21 张真实截图、3 条 trace，见 [基线测量](../.cache/RF00/baseline-current-tasks-verified.json) 与 `.cache/RF00/baseline-current-tasks-v2/`。原画布 1920/1366/1093 分别为 1398×543、844×231、633×200；小窗页面高 660，未应用提示会使画布下移 29px。CIMC `F_CR001` 真实设施边界精修成功；`SP_CR002` 类型配置被 `OPERATION_DEPENDENCIES_UNSUPPORTED` 拒绝且 hash 不变；画直路必须预建端点。没有把受限任务记为已完成能力。

## F01–F15 本地复核

| ID | 本地事实及本期处理 |
|---|---|
| F01 | App 编排仍复用原会话；迁出工作台壳、互斥交互状态和活动草稿注册，不机械拆分领域逻辑。 |
| F02 | 原常驻机制按钮/提示占用画布；改为菜单、工具行、可调侧栏和默认收起检查抽屉。 |
| F03 | 基线小窗画布不足、辅助文字偏小；正文14px/辅助12px与三窗、真200%缩放实测。 |
| F04 | 空白两点直路仍不支持，必须已有端点；RF02范围。 |
| F05 | 高级图创建/复制等全图依赖限制保持，未删除保护。 |
| F06 | owner道路、服务、独立路口等复杂几何仍按既有局部能力拒绝；保留GA01/TE01已支持事务。 |
| F07 | 服务内部路径仍通过既有字段/道路ID选择；业务向导未实施。 |
| F08 | TE01候选转向批准保留；独立逐转向编辑器未实施。 |
| F09 | 厂界、资源、槽位的目录检查保留；未新增通用编辑命令。 |
| F10 | 底图/ZIP闭环未实施，相应保护不变。 |
| F11 | 诊断仍使用同步纯内核；本期只移入抽屉，不引入Worker。 |
| F12 | 外部编译/调度仍为现有合同边界，未建立服务器或第二套系统。 |
| F13 | 唯一contentHash算法、revision排除规则不变，地图摘要与原件文件SHA分别检查。 |
| F14 | CURRENT_SCOPE.md与本报告为当前范围及执行事实；README链接当前入口并修正诊断路径，PRODUCT_SPEC仅更新顶部历史说明；历史报告正文未改写。 |
| F15 | 缺SR02仍使unit/integration退出1；没有跳过或放宽冻结门禁。 |

## 本期需求与验收状态矩阵

状态按本期具体子能力填写；跨阶段编号不能由一个旧套件通过自动整体改判。

| 编号 | 本期能力与证据 | 状态 | 未覆盖部分 |
|---|---|---|---|
| R01 / T01–T03 | 18原件SHA、完整frame、稳定ID/引用/来源，0.1/0.2保存往返；GA01/生产回归 | passed | 不证明原输入为实测图 |
| R02 / T06–T07 | 三窗、真200%、画布稳定、模态/输入/IME；RF01专项与UI脚本 | passed | 未作全面WCAG认证 |
| R03 / T05、T08–T10部分 | 草稿隔离，既有选择/Shift多选、平移缩放及快缩后命中；RF01/DP1/R07 | passed | T08框选、T09新增重叠轮选、T10 Space临时平移为not_run（RF02） |
| R12部分 | 目录搜索一次选择定位，既有图层/属性入口与离开保护 | passed | T20新多选批改为not_run（RF02+） |
| R15 / T04、T42–T45 | 三种草稿保存选择、取消/失败/no-op、跨项目迟到、配额/权限、外改/CAS、多标签冲突与部分成功 | passed | 原生picker被注入，OPFS/IDB真实；OS授权对话框为not_run，ZIP为RF03 |
| 既有T13、T15–T18、T21–T23、T31、T35、T46子能力 | GA01/TE01已支持的几何、引用事务、矩形孔洞、未知保护及同步诊断回归 | passed | 不表示RF02–RF05完整新功能已实现；限制仍按命令支持条件 |
| R22 / T56 | 当前入口、同源码同构建、真实工作流JSON/截图/trace、命令退出码 | passed（功能证据） | 性能独立记录，未以测试数量替代任务成功 |
| SR02原件门禁 | unit/integration各4项缺件，退出1 | blocked_input | 不替换输入、不修改冻结SHA |
| 后续R04–R11未交付部分、R13–R14、R16–R21 | 两点道路/新约束、完整设施服务资源编辑、底图ZIP、诊断修复、交接消费者 | not_run（本期未实施） | T11、T12新增部分、T20、T25、T30、T32、T36–T40、T50–T55等归RF02–RF06 |
| 其余跨阶段T14、T19、T24、T26–T29、T33–T34、T41、T47–T49 | 只有旧套件明确覆盖的子能力保留回归证据 | not_run（完整需求未独立验收） | 不因旧套件总绿而整体判通过 |

## RF01 实际修改

- `Workbench.tsx` / `workbench.css`：48px菜单、40px工具行、40px上下文命令行、28px状态栏；240/300px默认侧栏，可鼠标/键盘调整。低于1280px使用覆盖面板，选中搜索结果自动收起左目录并显示属性。命令行移出画布，检查抽屉仅覆盖可见中心，提示/警告/选择/模态不改变画布边界。
- `editor/workbench.ts` / `projectController.ts`：布局与保存目标偏好进入原 `EditorState`，旧记录补默认值并保留显式 false/0；地图 Schema、存储控制器和 CAS 逻辑不变。
- `useEditorInteraction.ts`：一个活动工具/绘制状态和一个判别联合对话框；草稿绑定工程ID、changeToken、地图摘要，相机不使草稿失效。保留渲染器内部瞬时拖动。
- `editor/drafts.ts` 与三个属性面板：只有活动脏表单注册；普通“应用属性”和“应用后保存”调用同一原解析/命令链，失败保留输入；地图名称也走同一注册。未完成绘图不自动闭合。
- `App.tsx` / `useProjectWorkspace.ts`：按钮、Ctrl+S、菜单复用保存编排；从sessionRef同步获取应用后的快照，两目标分别确认。已关联文件写回并保存浏览器恢复；未关联时选择目标、记住偏好。下载只报告发起下载，不标记文件写回。原生picker在用户事件、首次await之前启动。
- 新导入按已有画布尺寸适应地图；刷新恢复原工程保存的相机。搜索结果单击完成选择与定位，仍经未应用输入离开保护；Shift加选保留相机，以免已选对象在继续拖动前离开视野。
- `Modal.tsx` 与按键路由：IME、输入框原生撤销/Delete、单模态焦点/返回、Esc分层取消；恢复故障仅显示恢复模态，原隔离保护保留。

领域命令、MapCommand→editSession/applyMapCommand、两套既有保存控制器、DP1 renderer/geometry和冻结目标文件均未改。旧UI测试只迁移真实菜单/设置/抽屉入口；道路像素夹具显式使用原倍率4，保留48/96px等断言；DP08只把滚轮锚点放在目标附近并加屏内断言，保留同任务点选和1e-8相机断言。GA01额外检查最终重导入后的目标投影在画布内且实际命中Canvas，无测试补点Fit。R07加选相机不变新增精确断言，宽度/拖动夹具明确原有倍率或原生滚轮视窗，使原位移仍在画布内。GA01恢复故障夹具通过隔离浏览器的普通导入入口获取规范摘要，不另写hash算法；DP性能脚本仅将已移除的页面元数据定位迁为计时外JSON导出，保留完整frame、revision、hash、原件SHA与undo/redo断言。

## 审查与修复证据

独立正确性审查发现并修复两项P2：未应用时浏览器另存意图丢失，改经原离开保护后创建副本；UI恢复异常时两个模态叠加，改为恢复界面接管。新增副本隔离及单模态断言。

Ponytail复审确认没有第二套地图、历史或存储架构；同步ref用于同事件保护有实际用途。删除未读取的PropertyDraft.dirty字段及两条无效CSS，不删除安全校验。

联调失败记录均保留：旧完整E2E首轮107通过/23失败（退出1），包含旧菜单定位与真实遮挡/按键回归；定向修复轮9通过/6失败（退出1）；首轮生产3通过/3旧设置入口失败（退出1）。RF01专项先6通过/1紧凑侧栏遮挡失败，后真实三窗和9项专项通过。过渡构建B8JNu2yO的GA01 18/18、TE01 6/6、production 6/6通过；最终出口以最终同构建结果为准。最后一轮开发完整回归为136通过/3失败（退出1）：R07暴露Shift加选相机改变，W03/W10暴露导入适应后的旧像素夹具视窗前提；修复产品加选定位并明确夹具倍率/屏内条件后，定向4/4退出0，最终生产139/139退出0。另一次定向收集因Node静态导入序列化器的Ajv模块加载失败（0项、退出1），改用普通浏览器导入获取同源摘要后通过，未添加第二种hash算法。

## 最终验证

以下均为实际执行结果。最终浏览器回归使用同一冻结生产构建；完整E2E 139/139、独立GA01 18/18、TE01 6/6、SR03 production 6/6、RF01专项9/9全部通过。独立套件与完整E2E有重叠，不相加冒充独立用例数。命令均在 `paper01/map` 执行，数据环境为：

```powershell
$env:GA01_DATA_ROOT=(Resolve-Path '..\..').Path
$env:SHIPYARD_TEST_DATA_ROOT=(Resolve-Path '.cache\GA01\data-root').Path
$env:GA01_PHASE='B'
```

$env:RF01_EXPECTED_BUNDLE='index-MAB1NtZs.js' 用于完整生产E2E和RF01专项。配置来自现有Playwright配置，完整套件使用preview 4178与3 workers，专项使用preview 4202；均读取同一dist，不用开发热更新。

| 实际命令 | 退出码 | 实际结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | Schema生成一致 |
| `npm.cmd run typecheck` | 0 | 通过 |
| `npm.cmd run lint` | 0 | 通过 |
| `npm.cmd run test` | 1 | 553通过，4项SR02缺件 |
| `npm.cmd run test:integration` | 1 | 86通过，4项SR02缺件 |
| `npm.cmd run build` | 0 | 构建成功，保留体积提示 |
| `npx.cmd playwright test --config=.cache/RF01/playwright.full-production.config.ts --reporter=list --output=.cache/RF01/e2e-production-accepted` | 0 | 完整139/139，5.4分钟 |
| `npx.cmd playwright test -c playwright.ga01.config.ts --fully-parallel --workers=2 --output=.cache/RF01/ga01-complete --reporter=list` | 0 | 18/18，3.6分钟 |
| `npx.cmd playwright test -c playwright.topology.config.ts --output=.cache/RF01/te01-complete --reporter=list` | 0 | 6/6 |
| `npm.cmd run test:production -- --output=.cache/RF01/production-complete --reporter=list` | 0 | 6/6 |
| `npx.cmd playwright test -c .cache/RF01/production.config.ts --output=.cache/RF01/acceptance-complete` | 0 | RF01专项9/9，trace全开 |
| `node --import tsx .cache/RF01-ui/final-complete.mts` | 0 | 三视窗真实UI检查 |
| `node --import tsx .cache/RF01-ui/zoom-complete.mts` | 0 | 原生Chrome 200%缩放 |
| `node --import tsx .cache/RF01-ui/perf-complete.mts` | 0 | 最大目标图30次搜索选择+30次工具切换 |
| `node --import tsx .cache/RF01-ui/command-perf-complete.mts` | 0 | 最大图30次属性命令提交，每次撤销恢复原图 |
| `node scripts/DP-performance.mjs --output=.cache/RF01/performance-complete --dist=dist --data-root=.cache/GA01/data-root --modes=auto --kinds=pan --rounds=30 --warmup-rounds=1 --refresh-rate=0 --port=4183` | 0 | DP1固定大图1轮预热+30轮连续平移 |

机器可读命令与日志入口：[final-commands.json](../.cache/RF01/final-commands.json)。完整浏览器证据：[browser-regression-evidence.json](../.cache/RF01/browser-regression-evidence.json)。本地证据保存在.cache，没有上传。

最终JS为 `index-MAB1NtZs.js`，SHA256 `d6dd066452f56e68c0f53a80751bab7a309fa5eef543be1f58018f30abd678db`；CSS为 `index-B7sIKuN1.css`，SHA256 `a9904caeb0e13db5cad56f129758b2f24959734035f2157962bb314916503ad6`。完整回归记录9份实际加载asset URL，执行前后132项src/tests/dist无差异；根验收另外覆盖135项src/schema/tests/性能脚本/dist及18原件，见 [final-integrity.json](../.cache/RF01/final-integrity.json)。

## 真实界面证据

| 视窗 | 画布CSS尺寸 | 实际截图 |
|---|---|---|
| 1920×1080 | 1380×924 | [工作台](../.cache/RF01-ui/production-complete/final-1920x1080.png) |
| 1366×768 | 826×612 | [工作台](../.cache/RF01-ui/production-complete/final-1366x768.png) |
| 1093×614 | 1093×458 | [工作台](../.cache/RF01-ui/production-complete/final-1093x614.png) |
| Chrome原生200% | CSS960×540，DPR2 | [缩放](../.cache/RF01-ui/production-complete/zoom200-actual.png)、[模态](../.cache/RF01-ui/production-complete/zoom200-modal.png) |

截图来自冻结生产构建和真实Hanwha V02。三窗选择、无效表单、警告、模态和抽屉前后画布位置尺寸不变；上下文命令在画布外。200%通过Chrome设置页真实切换，非CSS transform或deviceScaleFactor伪装；最大双侧栏下抽屉宽180px，收起仍可达，地图摘要不变。测量及15项布尔行为断言见 [measurements-final.json](../.cache/RF01-ui/production-complete/measurements-final.json)，缩放见 [zoom-receipt.json](../.cache/RF01-ui/production-complete/zoom-receipt.json)。

完整编辑收据、保存前后JSON与trace位于 [RF01专项证据](../.cache/RF01/acceptance-complete/)。三个视窗CIMC V02均通过普通入口完成节点几何修改，revision 2→3；撤销/重做、刷新/重导入几何、完整coordinateFrame、ID/引用/来源通过精确断言，最终目标在Canvas上可见。十八图对应每份输出与最终截图路径列于浏览器证据清单；验收依据是事务与持久化结果，截图只佐证界面。

## 性能与证据边界

最大十八图输入为Hanwha V02（3,225,848字节），历史DP1固定输入为SHI v03（4,569,645字节），各自冻结SHA不变。最大图独占暖态采样30次搜索选择p95=132.21ms，30次工具切换p95=46.36ms，hash不变且pageerror为空。搜索选择高于100ms设计目标；计时包含Playwright动作、等待及状态断言，不能直接当纯浏览器输入延迟。Win32 10.0.26200，Core Ultra 9 275HX/24逻辑CPU，约31.46GiB内存，Headless Chrome 152.0.7977.83，CSS1920×1080。60个原始值见 [performance-final.json](../.cache/RF01-ui/production-complete/performance-final.json)。没有同方法的优化前配对数据，不声称性能提升百分比。

普通命令另用同一Hanwha V02获准目标N_HW_7874b56b34，将X从239改为239.01m；计时外填写，计时内点击应用并确认hash变化与一次历史。排除1次暖场后的30次提交p50=486.40ms、p95=507.10ms，未达300ms设计目标。每次通过普通JSON导出校验revision 2→3及完整字段，再普通撤销和导出确认恢复原图revision 2；源SHA不变。计时包含Playwright操作和断言，不等于纯命令函数耗时。新空存储浏览器上下文单次app ready=335.94ms、首次导入并浏览器保存=3600.38ms、合计3936.34ms；没有清OS缓存，不称系统冷启动基准。见 [命令与首次打开测量](../.cache/RF01-ui/production-complete/command-performance/command-performance.json)。

SHI v03 连续平移复用现有DP脚本和原10秒/600输入轨迹，labels=auto，1轮预热排除、30轮正式。CSS视窗1440×1000，画布900×844，实际ANGLE NVIDIA RTX5070Ti Laptop GPU，未设置fake-vsync刷新率。各轮RAF p95为25.0–29.1ms，30轮中位数25.0ms；合并25,006个间隔p50=8.4ms、p95=25.0ms，最大83.4ms，超50ms共26个、超100ms为0。该auto/pan场景的30/30轮p95≤33ms；RAF只反映浏览器调度，不证明物理呈现或Konva绘制完成。18,000次请求、15,571次接收与12,786次相机更新分别记录，均不当帧数。完整frame/revision/地图/原件SHA/历史保持，errors为空。结果状态为MEASURED，见 [原始汇总](../.cache/RF01/performance-complete/summary.json) 与 [分布汇总](../.cache/RF01/performance-complete/analysis.json)，每轮原始数据保留在同目录。未扩为DP所有标签模式、缩放、profile或压力场景重新认证。

保留历史 `FUNCTIONAL_PASSED_PERFORMANCE_BUDGET_NOT_MET` 裁决；本期功能通过不改判DP1性能预算。构建JS为1,016.93kB（gzip312.63kB），大于500kB的体积提示未隐藏。OS文件选择器由测试注入；OPFS文件流和IndexedDB是真实读写，配额/权限故障有明确模拟标注，不声称完成操作系统权限对话框端到端验证。

## 剩余限制与退出

SR02四份缺件继续blocked_input。空白两点绘路、底图/ZIP、高级依赖通用编辑、服务/转向向导、调度交接都未进入。本期不证明实测几何、安全净空或运输可行性；声明宽度与视觉相交不创建拓扑。

最终出口：**RF00完成；RF01本期限定功能退出条件满足。** 十八图完整真实工作流、三视窗/200%、状态/保存故障与受影响完整生产回归均通过，无新增回归失败。SR02 A–D是同一组缺失输入，分别导致unit/integration各4项失败，保留exit 1，不能称全项目全绿。性能实测已记录：搜索选择与普通命令提交超设计目标；只有此次auto/pan RAF指标满足33ms，不改变历史整体性能预算未达标结论。

**不是全产品或全性能验收通过。** 框选/重叠轮选/Space临时平移、空白两点道路、底图ZIP、高级依赖编辑与调度交接仍按矩阵未实施。本轮不为达到预算删除验证或追加下一阶段优化。停在本地codex/rf00-rf01工作树，HEAD仍为开工SHA；等待用户后续确认，不提交、不推送、不进入下一阶段。


## 2026-09-13：长对象目录下的设置可达性修补

用户实际使用发现对象列表过长，绘图设置在目录后方，必须滚到底才能开启拓扑吸附。只调整App左栏内容排列和工作台3条局部CSS：上部设置区、下部目录区独立滚动，设置最多占左栏一半；绘图设置排首位，拓扑吸附、节点吸附和网格吸附移到设置前部。现有组件持续挂载，地图信息默认展开、所有处理函数/解析/草稿注册/保存和拓扑命令保持。没有增加tab状态、复制设置入口或改变地图系统。

新构建：`index-Cv8Yq1cU.js` / `index-CGqa2asX.css`。`npm.cmd run build`（含typecheck）退出0；`npm.cmd run lint`退出0。增量正确性与Ponytail复审通过；两文件改前副本、日志与本次证据保存在`.cache/RF01-sidebar/`。浏览器增量验证全部完成：以下命令退出0，RF01工作流/绘图配置/拓扑拖动共21/21通过，30.4秒。

```powershell
$env:RF01_EXPECTED_BUNDLE='index-Cv8Yq1cU.js'
# GA01_DATA_ROOT、SHIPYARD_TEST_DATA_ROOT、GA01_PHASE与前述数据环境一致
npx.cmd playwright test --config=.cache/RF01/playwright.full-production.config.ts tests/e2e/RF01_workbench.spec.ts tests/e2e/drawingConfig.spec.ts tests/e2e/TE01_linkedDrag.spec.ts --output=.cache/RF01-sidebar/e2e --reporter=list
node --import tsx .cache/RF01-sidebar/sidebar-check.mts
```

UI脚本退出0：实际Hanwha V02对象目录约360,121 CSS像素长，原生wheel滚到底后设置入口位置不变；三视窗及真实Chrome原生200%（有效960×540、DPR2）每窗11项断言通过，设置区独立滚动、拓扑开关直接可操作、未应用地图名和网格值保持、菜单搜索/正常选择可用。画布分别1380×924、826×612、1093×458、960×384，展开/滚动前后bbox与mapHash不变。200%设置区高171px，下方设置仍须在该区域内滚动，已与长对象目录分离。

[命令与SHA记录](../.cache/RF01-sidebar/results.json)、[四窗测量](../.cache/RF01-sidebar/verification/sidebar-receipts.json)、[1366设置展开](../.cache/RF01-sidebar/verification/settings-expanded-1366x768.png)、[目录滚到底](../.cache/RF01-sidebar/verification/directory-bottom-1366x768.png)、[真实200%](../.cache/RF01-sidebar/verification/settings-expanded-native200.png)。产品增量严格只有App.tsx与workbench.css，18原件SHA再次匹配；没有重跑与本次布局无关的完整139/十八图全量/性能基准，不把旧证据计为本构建结果。仍未提交、未推送，未进入RF02。
