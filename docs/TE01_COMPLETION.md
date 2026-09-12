# TE01：显式路网拓扑编辑

本批从本地 `82e139c`（地图发布 `849981c`）继续，按用户新授权扩大 GA01 的局部拓扑编辑范围。复用原 Schema、命令、几何、校验、保存和 React/Konva；没有新增运行依赖或应用模块。十八份 V01/V02 原图、论文和外层工程保持不变。

## 已实现与使用方法

| 目标 | 操作入口 | 实际语义与边界 |
|---|---|---|
| 道路中插入节点 | 选道路 →「拆分道路」→输入距起点距离，或「在画布上拾取切分点」 | 沿中心线生成节点和两段道路，保留全部折线几何、物理值和来源；重映射明确引用 |
| 删除道路或节点 | 选对象 →「删除」→查看影响清单，必要时明确勾选「允许删除关联道路和转向」 | 节点级联删除其关联道路和转向；空的单节点纯引用路口可清理。资源实体和容量保留，失效 appliesTo 显式清理；服务依赖等不能维护时拒绝 |
| 去掉二度节点、保留道路 | 选节点 →「保持道路连通删除节点」→选择保留道路 | 只允许两段方向、物理值、资源和扩展兼容且已有明确直通许可的道路；原节点坐标成为内部折点，不把弯道擅自拉直 |
| 合并两个节点 | Shift 多选两节点 →「合并节点」→选择保留节点 | 保留目标 ID 和坐标，重定向明确引用；方向兼容的新接续须明确批准，已有禁转不覆盖 |
| 拖节点形成交叉路口 | 勾选「拓扑吸附」，选单节点，拖到另一道路中心线或节点；松开后确认 | 一次事务完成移动、拆路、共享节点及批准的转向。候选为同 Z、可见且未锁定对象，阈值 12 CSS 像素；普通网格/节点吸附不会改变连通 |

插点产生的原道路直通连接延续原方向；分支转向默认不批准。模态框列出方向兼容候选，勾选表示批准所列候选，暂不提供逐个转向的独立编辑器。选择带入口/服务标记的底层节点后，标记保留显示而由节点接收拖动；未命中拓扑目标仍按原普通移动规则检查。

每次确认产生一次撤销事务；重做复用 ID。取消、失败、未应用输入和过期候选不会半提交。候选保存地图对象身份和 changeToken，工程切换不会误提交旧操作。锁定检查修改前、修改后及保留目标的完整依赖集合，包含间接路口和资源。

## 数据契约与保护

- 整个 coordinateFrame 固定；改图后 revision/contentHash 正常更新，原场景和运行绑定不会自动改成新图。
- 道路拆分保留单一中心线来源，按方向重映射 movement 弧、完整 service internalPath 和 resource.appliesTo。纯几何等价细分/拼接不把旧的未改空间关系变成本次新冲突；实际移动分支仍检查相关禁区和服务包含。
- 独立道路带、登记长度、不同高程、独立路口/转向几何、内部归属关系、自环、重复道路等无安全维护规则时返回具体代码和 JSON Pointer。未知行为继续全局保护；不删除扩展或资源换取通过。
- 字段来源写入 design_assumption；原总体类别、来源记录以及被替换的字段来源都保留关联。拼接也保留第二段仅 fieldSources 声明的来源。
- 沿用 `org.shipyard.editor.lineage@1.0.0` 元数据命名空间，保留 roadSplits，并增加可选 topologyEdits 记录删除与保留 ID。旧沿革条目仍可读取，未知字段拒绝覆盖。
- 不自动合并全图近邻、平行道路，不补物理参数、不重算资源容量，不实现调度、仿真或 GIS 配准。网络声明可用不等于现场运输安全。

## 真实输入与验收范围

冻结身份复用 `tests/helpers/GA01_targets.ts`，新代表命令在 `tests/helpers/TE01_targets.ts`。同 mapId 的威海两版按路径和 SHA 分开。

十八份原图分别在独立副本上执行拆路、去除刚插入的二度节点、节点合并及接路，检查 coordinateFrame、ID/引用、原来源、容量、单次撤销/重做、序列化与重载。原生二度节点的已尝试拒绝保留记录；不能把“新插节点可去除”写成“所有原生路口都能去除”。实际 merge/connect 代表偏移只用于软件验收，不是建议改变船厂布局。

用户指出的韩华 V01 `R_HW_c96d6ef567` 已在真实浏览器副本中删除：精确删除 1 条道路和 8 条关联转向，两个路口资源及所有无关内容保持。还验证节点级联删除、入口内部路径拆分、未批准/批准/禁转路径预览反例；服务节点真实鼠标拖动及目标侧路口/资源锁定均有独立浏览器用例。

生产浏览器覆盖画布拾取、真实拖动、取消、隐藏、锁定、未知扩展、一次撤销/重做、自动保存、Ctrl+S/按钮保存、刷新和 JSON 导出重导入。完整受影响回归包括矩形、服务关联、相机合帧、标签、输入保护、文件冲突、P1/P2A 和十八图 GA01-B。生产回归中的耗时只作运行记录；本批没有重新裁决 DP1 性能预算。

## 实际命令与结果

| 实际命令 | 退出码 | 最终结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | Schema 生成类型一致 |
| `npm.cmd run typecheck` | 0 | 浏览器和纯核心类型检查通过 |
| `npm.cmd run lint` | 0 | ESLint 和纯核心依赖边界通过 |
| `npm.cmd run test` | 1 | 550 通过，4 项因 SR02 A—D 原件缺失失败，裁决 blocked_input |
| `npm.cmd run test:integration` | 1 | 86 通过，4 项同样缺 SR02 原件；本批 TE01 23/23 通过 |
| `npm.cmd run build` | 0 | 生产构建成功 |
| `npm.cmd run test:e2e -- --workers=2 --output .cache/TE01/final-full-e2e-results` | 0 | 130/130 通过，9.5 分钟，两个 worker |
| `npx.cmd playwright test -c playwright.topology.config.ts` | 0 | 最终生产构建 6/6 通过，53.2 秒 |
| `npm.cmd run test:production` | 0 | 真实 SR03 A—D、F_001/Z_005 联动 6/6 通过，32.7 秒 |
| `node --import tsx scripts/map-validate.ts <file> --profile draft` | 每次 0 | 18 原图 + 18 接路副本，共 36/36 valid |

首次完整单元有 5 项旧契约断言失败，随实现和精确断言更新修复；集成首次有 19 项沿革/引用断言待更新，后续保持全量无关字段和资源断言后全部修复。早期浏览器脚本暴露折叠控件/保存等待问题；关联节点拖动另暴露预览影响集合为空导致回弹，已修复并保留真实鼠标反例。生产 SR03 首次退出 1 是测试配置继承同时启动 4178 开发服务器导致端口冲突，未运行用例；改为仅启动指定的生产 preview，后续 6/6 通过。完整浏览器首轮退出 1（127 通过、3 失败）：新增选择态提示使画布尺寸/位置随选择变化，导致画点和点选失败。将原提示与端点按钮移到右侧属性区，未改相机或旧期望；原 3 项及旧 8＋新 6 项定向复验通过后，重新执行全套回归。上述失败日志保留在 `.cache/TE01/`，不沿用早期通过替代最终结果。

最终来源修复后重新执行 Schema、类型、lint、单元、集成、build、6 项拓扑生产浏览器和 6 项 SR03 生产回归。选择态提示布局修复后，完整 130 项浏览器又按文件分配给两个独立 worker 重跑；同一文件内仍串行，地图和浏览器存储隔离。最终生产结果不作为性能预算验收。

可机读摘要为 `docs/TE01_VALIDATION.json`。本地完整证据包括 `.cache/TE01/frozen-codes.json`、`delivery-*.log`、`final-full-e2e.log`、`production/report.json`、`TE01_cli_receipts.json`；生产 PNG、连续 Playwright trace 和 JSON 下载位于 `.cache/TE01/production/results`。真实地图及大日志不加入发布。

复现时先使用锁定依赖（已有 node_modules 本批未重装；新环境执行 `npm ci`）。本批 Node 22.18.0、npm 10.9.3、Windows/PowerShell 7.6.6、Chrome 152.0.7977.83。设置 `GA01_DATA_ROOT` 为包含九图 projects 的数据根目录；`SHIPYARD_TEST_DATA_ROOT` 为历史 SR03/SR02 等输入根目录，冻结 SHA 不变。本环境后者为 `.cache/GA01/data-root`，SR03 齐全、SR02 A—D 仍缺失。

```powershell
$env:GA01_DATA_ROOT = '<包含 projects 的原始数据根目录>'
$env:SHIPYARD_TEST_DATA_ROOT = '<包含历史 projects 的数据根目录>'
$env:GA01_PHASE = 'B'
npm.cmd run schema:check
npm.cmd run typecheck
npm.cmd run lint
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
npm.cmd run test:e2e -- --workers=2 --output .cache/TE01/final-full-e2e-results
npx.cmd playwright test -c playwright.topology.config.ts
npm.cmd run test:production
npm.cmd run map:validate -- '<map.json>'
```

原件测试必须使用真实文件；缺件返回失败/blocked_input，不能将本批有限接受写为全部历史回归通过。

## 独立审查和裁决

- dependencies 实现纯领域拓扑，ui 接入已有交互，inputs 独立审计真实数据并执行集成/浏览器验收，主代理整合来源、空间范围及旧回归。
- **正确性审查独立完成**：ui 审查核心，dependencies 审查 UI、来源、空间范围和依赖闭包。发现并修复了目标侧锁定闭包、关联标记拦截拖动、跨工程过期候选、浮点切分一致性、JSON Pointer 转义、两处仅字段来源的证据链丢失；定向反例已运行。
- **Ponytail full/review 独立完成**：删除两处拓扑死分支和一处不可达旧拆路分支，复用既有命令与保存链；最终没有新增必要删减项。正确性结果与冗余结论分开记录。
- 控制器裁决：本批 TE01 声明范围通过，停止扩展。原生复杂依赖保持明确拒绝；SR02 缺件单独裁决 blocked_input，不声称全部历史回归通过。源码与实际构建/验收对应关系见 TE01_VALIDATION.json 的 gitBlob/SHA；只发布 map 代码与测试文档，不发布原始地图、外层 projects、论文或调度工程。
