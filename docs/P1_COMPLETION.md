# P1 完整工程显示与安全编辑

状态：P1 已完成。修复独立审查问题后，全量浏览器 79/79、单元 388/388、集成 42/42 通过；本批停止，不进入 P2—P4。

## P0 当前事实与兼容边界

- 主代理核对：分支 master，基线 HEAD 9abbf73；HEAD:map 与专用发布树 b29a2c3 对应树 90b7539d0685dbde26a9b3077dbd77028f9ee045 相同。论文 9 个 tracked 改动、其他 untracked、map 旧 ZIP 删除和新任务书属于既有用户工作，本批不覆盖。
- 主代理基线命令 npm run test：310/310，退出 0。本文件作者未重跑该基线，不把转述记为独立检查。
- 已读取 map/AGENTS.md、项目内 Ponytail full/review、任务书 P0/P1/A02—A06 和现有导入、命令、验证、场景与保存路径。
- 本批沿用严格 0.1.0/0.2.0 Schema、米制 JSON、稳定 ID、共享 loadMap/validate/serialize/command 路径，不改原件。下列 16 份原件均已实读，全部为 0.2.0、revision=0；imports/connected 的 siteBoundary 为显式 null，SR02/SR03 才声明厂界多边形。真实输入 helper 固定相对路径与 SHA；缺文件或 SHA 不同直接 blocked_input，禁止跳过或替换为简化图。
- 旧场景显示节点、道路、设施、区域、入口与服务点；SR02/SR03 的 siteBoundary、junctions、movements、resources 及行为扩展未完整渲染，旧能力判断会因它们锁全图；imports/connected 不因显式 null 厂界锁图。来源仅目录资料；无资产/背景层不等于验证过现实厂区。16 图均没有二进制底图，本批不补造。

## 冻结输入 manifest

路径相对工作区根目录（map 的 ../../）；不复制用户数据入仓库。counts 顺序：nodes, roads, facilities, zones, accessPoints, servicePoints, junctions, movements, resources, sources, assets, backgroundLayers，最后为已声明扩展槽位数。资源引用不重复计为新的槽位对象。原件本身及其来源声明保留；历史模拟结果仍绑定原摘要，编辑后不自动成为新图结果。

| 输入 | 原始文件 | SHA-256 | 字节 | mapId | 12 集合 + slots |
|---|---|---|---:|---|---|
| imports_A | projects/shipyard_editor_imports/YARD_A.map.json | 9426d3f21f77fc756a2da71e194cd76d4ca35b141a9880a9fa4ac8926f24cf9d | 97179 | map_YARD_A | 20/21/16/0/16/0/0/0/0/8/0/0/0 |
| imports_B | projects/shipyard_editor_imports/YARD_B.map.json | 6d5ed3b06417e3c0f14db819195beabe66d93049592a9c42a56653e1cc75b3ed | 129072 | map_YARD_B | 27/29/21/0/21/0/0/0/0/8/0/0/0 |
| imports_C | projects/shipyard_editor_imports/YARD_C.map.json | 3772943bf8ae866e0588be449a9542e7b50fb1ff153767ac8fa19c312873b8ad | 83471 | map_YARD_C | 17/18/13/0/13/0/0/0/0/8/0/0/0 |
| imports_D | projects/shipyard_editor_imports/YARD_D.map.json | 2d0127da81f7b2bbd7f66179286c8b205286cb03090a5c6c10b08d42138a338f | 108594 | map_YARD_D | 22/24/17/0/17/0/0/0/0/8/0/0/0 |
| connected_A | projects/shipyard_editor_connected/YARD_A.map.json | 0bbd11f175cc268560aaba73a2f9f4bb53edc439c0dc63c7810208c77b8434cc | 148517 | map_YARD_A_connected | 25/25/16/0/16/0/0/0/0/9/0/0/0 |
| connected_B | projects/shipyard_editor_connected/YARD_B.map.json | f55d71108fe1acfd4807e9c7d7a856b17f6ecf46f7ae06391b672c2815ec3def | 200144 | map_YARD_B_connected | 32/33/21/0/21/0/0/0/0/9/0/0/0 |
| connected_C | projects/shipyard_editor_connected/YARD_C.map.json | 7990f77b11d5c1d53ad61be3779b055bd14859810198332ed6c697f6e39181ce | 136252 | map_YARD_C_connected | 24/25/13/0/13/0/0/0/0/9/0/0/0 |
| connected_D | projects/shipyard_editor_connected/YARD_D.map.json | c319cf5d5ba94d3ee61d44e622fdfebf7f11c467e4e037abacee8c5aff19b212 | 179600 | map_YARD_D_connected | 30/33/17/0/17/0/0/0/0/9/0/0/0 |
| SR02_A | projects/shipyard_simulation_SR02/SR02_A/map.json | ded6923c802b360497e4c19caf10a000b86fc96dfdaec8d83c3bd9aac6aa9bd4 | 593574 | SR02_A_synthetic | 72/85/4/8/8/14/68/260/141/5/0/0/159 |
| SR02_B | projects/shipyard_simulation_SR02/SR02_B/map.json | ccc88578adc30cb4d7a0524b8233134ef917349892e10a3c65ec4dc586bb7e86 | 1056207 | SR02_B_synthetic | 143/170/24/13/36/29/137/518/284/4/0/0/142 |
| SR02_C | projects/shipyard_simulation_SR02/SR02_C/map.json | f7da7edddd82221576f23f299082c68dfdc681efcdb65eef4e13b21b81134bed | 690701 | SR02_C_synthetic | 86/101/8/8/14/18/80/308/169/5/0/0/160 |
| SR02_D | projects/shipyard_simulation_SR02/SR02_D/map.json | f635f98c2c5645819d223a970066f23be5dbd020e0a555adec4c3b21397767a3 | 832222 | SR02_D_synthetic | 88/103/8/12/10/20/80/320/173/4/0/0/308 |
| SR03_A | projects/shipyard_simulation_SR03/SR03_A/map.json | f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a | 455833 | SR03_A_synthetic | 59/71/12/5/8/11/56/224/119/2/0/0/48 |
| SR03_B | projects/shipyard_simulation_SR03/SR03_B/map.json | 283d08934e1e0dd6b5c14fdf6569ef622db99ea6ccf6f3e421c38ca581eb1921 | 1134418 | SR03_B_synthetic | 149/175/38/17/34/31/142/526/294/2/0/0/209 |
| SR03_C | projects/shipyard_simulation_SR03/SR03_C/map.json | 01fd0d6075060d846ed30f1362187a90a297a78376688c910ddc90c7a848b125 | 1090629 | SR03_C_synthetic | 129/149/33/24/10/29/117/452/252/2/0/0/318 |
| SR03_D | projects/shipyard_simulation_SR03/SR03_D/map.json | 0fb0d6f565d35431d934ae2dbdfeae63c5948675b40d31ac7641af888abc7622 | 2485964 | SR03_D_synthetic | 207/245/62/27/28/47/188/782/412/2/0/0/1421 |

扩展声明：imports 使用 org.shipyard.source@1.0.0(metadata)；connected 另有 org.shipyard.topology_repair@1.0.0(metadata)；SR02/SR03 使用 sr02.planning@1.0(behavior)。后者相同版本已有不同所在集合与嵌套载荷，不能只凭名称版本白名单取消保护。

## 本批短计划与验收状态

| 项 | 范围 | 状态 |
|---|---|---|
| A02 | SceneSnapshot/目录解释全部核心实体、厂界、资源引用、槽位；四个 SR03 实际载入，最大 D 图操作计时 | 通过（真实 SR03 + 最终回归） |
| A03 | 固定静态 reader，未知行为继续保护；名称与 withStaticContents 刚体联动按完整依赖闭包授权 | 通过（真实 SR03 + 最终回归） |
| A04 | 厂界、路口预留和资源显示不生成连接/容量/通行许可；编辑后旧运行结果无效 | 通过（真实 SR03 + 最终回归） |
| A05 | 类型显隐/锁定、搜索、标签按工程持久化，不影响 map 摘要/历史/校验；间接锁定依赖拒绝 | 通过（真实 SR03 + 最终回归） |
| A06 | 真实 F_001/Z_005 联动、数值旋转、单拖动单历史、保存刷新/导出重导入；保留既有回归 | 通过（真实 SR03 + 最终回归） |

withStaticContents 只做平移/旋转，不做槽位缩放/重排或容量重算。公共锚点保持；无法解释的载荷、跨 owner 共享移动节点、混合路口节点、含未支持几何的接入道路整笔拒绝。固定端连接改变几何不证明新的转向空间可行，不能顺带编造转向或资源。非联动边界编辑不得从数值/控制柄入口绕过上述依赖保护。P2—P4（路网与空间检查、底图/ZIP、统计与交接）不在本批；运行执行始终属于外部系统。

## 实际检查与最终裁决

独立定向实跑：npx.cmd vitest run tests/integration/P1_targets.test.ts：16/16，通过，退出 0，12.26s（.cache/P1/integration-second.txt）；npx.cmd playwright test tests/e2e/P1_completion.spec.ts：Chrome 10/10，通过，退出 0，约 1.5m（.cache/P1/browser-first.txt）。浏览器使用原始文件选择、真实鼠标/数值面板与 IndexedDB；同名重导入也等待真实项目 key 变化，不能由旧同名界面提前通过。全部新测试 lint 退出 0。四图截图保留 .cache/P1/visual/SR03_A-complete.png 至 SR03_D-complete.png。

保留的初期失败：核心模块并行落盘期间首次收集遇 ./planning 不存在，退出 1、0 tests；模块齐备后的首轮集成 8/16 失败，原因是本测试把 imports/connected 的显式 null 厂界误认为多边形。核对原件后修正固定预期 0/1 及本文事实，产品未改，第二轮16/16通过。类型首次运行也只遇并行未完成模块；不将其记为完整类型检查通过。最终全工程检查与分别进行的正确性/Ponytail复审结果见下文；不沿用这些早期失败作为最终结果。

## 已交付的最小支持表

未知行为保护优先于下表。capabilities.editable 只表示无全局禁令，每次操作仍通过 commandSupport 与事务校验。

| 对象 | 展示、选择、定位 | 名称 | 几何与其他操作 |
|---|---|---|---|
| 原有六类对象 | 画布和目录；可隐藏、锁定、搜索 | 可改 | 普通地图保留既有安全编辑；高级依赖图拒绝直接点/道路语义改写 |
| 设施、区域 | 原声明边界及属性 | 可改且引用不变 | 有明确槽位契约用 withStaticContents 平移/旋转；无关联内容可改独立边界 |
| 厂界 | 原声明多边形；用途不明如实提示 | 无此字段 | 本批独立只读 |
| 路口 | 预留边界或声明节点；无边界也可定位 | 只读 | 仅作为批准联动闭包成员移动，不新增转向 |
| 资源 | 目录属性；选中高亮 appliesTo 明确引用几何 | 只读 | 不发明独立面积、容量或运行许可；锁定阻止间接几何变化 |
| 储位、停车位 | 原扩展逐项显示边界和 ID | 保留 ID | 仅随所有者刚体变换，不缩放/重排或重算容量 |
| 转向、来源、扩展 | 原始声明及 JSON Pointer | 只读 | 不猜测逻辑对象的独立几何；未知契约列为未支持 |
| 资产、底图 | 声明目录注明未加载 | 只读 | 本批无标定/二进制保存；16 份原件均无相关声明 |

目录区分可见/隐藏几何、逻辑对象、未支持、独立只读和图层锁定；后两类是操作维度，不与前四类相加。基础设置复用 EditorState，不改 map JSON 或地图历史。高级检查选择与旧编辑选择分开，混合复制/删除整笔拒绝。

## 修改范围与兼容

- 固定 planning.ts reader；复用 commands/capabilities/validation 的操作守卫、完整影响集合和原子事务。仅接受已知 sr02.planning@1.0 所在位置及嵌套字段；未知版本不按旧版解释槽位。reader 不调用 validate/capabilities。
- 扩充既有 SceneSnapshot，compiler/catalog.ts 仅投影原声明；既有 MapCanvas/SpatialLayer 和属性面板接入，不加渲染器或第二份主数据。
- 既有 ProjectController 规范化并复制配置数组，ObjectDirectory 提供目录与图层管理。旧适应地图算法复用为 fitCamera，不接受不可表示的相机。
- 事务冻结 affectedRefs，按钮与快捷键撤销/重做都检查当前图层锁；仅内存历史，不混入地图或编辑器文件。
- 旧 drawingConfig 全对象比较只补新默认字段；一条旧“有资源必须整图只读”断言按批准计划改为名称可改，同时断言资源/引用不变、位置及到达语义继续受保护。没有删除保护测试。
- Schema、依赖清单、锁文件、原始地图不变；没有新运行依赖、平台、Worker 或插件执行器。

## 分开的独立审查

正确性由 save_baseline_tests 只读审查全部生产差异并独立复现，local_file_save 补查命令依赖。已修正：
1. 撤销重做绕过锁定：历史检查冻结的完整影响引用，含资源派生作用范围。
2. 无边界路口漏进影响/预览、反向 overlayOf 漏项：前者纳入闭包，后者明确拒绝，不猜测移动规则。
3. 共享校验遗漏精确警告：保留 PLANNING_*、实体、JSON Pointer；草稿仍可查看，领域编辑受保护。
4. 配置数组别名、搜索清掉未完成绘图：复制接受后的数组；搜索不重置草稿，其余交互配置经过现有未应用输入保护。
5. 极端坐标定位溢出、未来版本被旧 reader 解释：共用有限相机检查；未知版本保留声明而不解释槽位。
6. 首轮全量旧浏览器回归发现空集合 accessPoints-count 元素缺失：目录恢复零计数，原输入保存断言不改。

Ponytail 冗余审查由 local_file_save 按本地 ponytail-review 单独执行。两项建议均落实：八份原件测试复用严格 P1_TARGETS/readP1Target，删除重复路径和可跳过逻辑；commands 复用 namespace 常量，合计约减少 6 行。校验、保存及输入保护未作为冗余删除。

## 最终命令与环境

工作目录 paper01/map，PowerShell 7。依赖未变，复用已有 node_modules，本批未运行 npm ci。

| 实际命令 | 最终结果 |
|---|---|
| npm.cmd run schema:check | 退出 0 |
| npm.cmd run typecheck | 退出 0，浏览器配置及无 DOM 核心均通过 |
| npm.cmd run lint | 退出 0，Core boundaries PASS |
| npm.cmd run test | 退出 0，18 文件 388/388，0 跳过 |
| npm.cmd run test:integration | 退出 0，4 文件 42/42；含 16 真图各 10 次往返 |
| npm.cmd run build | 退出 0；220 模块，主 JS 904.74 kB，gzip 276.98 kB；保留 >500 kB chunk 警告 |
| npm.cmd run test:e2e | 退出 0，79/79，0 跳过，4.9 min；含新增历史锁定与绘制中搜索反例 |
| npm.cmd run --silent map:validate -- <上述16目标路径> | 16/16 分别退出 0，draft valid；仍保留草稿/未检查提示 |
| npm.cmd run --silent map:validate -- examples/M1_invalid.map.json | 退出 1，预期 DANGLING_REFERENCE，/roads/rAB/toNodeId |
| npm.cmd run --silent map:validate -- ../../projects/shipyard_simulation_SR03/SR03_A/map.json --profile transport | 退出 3，明确 unsupported，符合预期 |
| git diff --check -- . | 退出 0，本批 map 范围 |

浏览器使用已安装 Chrome、真实页面和 IndexedDB。既有文件增强回归采用模拟 picker 加真实 OPFS，不冒称人工原生系统对话框验收。Playwright 自动执行 npm run dev -- --port 4178 并关闭服务。

本地日志在 .cache/P1/{unit,integration,lint,build,browser}-final.txt；十六图 CLI 与原件 SHA 在 .cache/P1/cli-final-summary.json。缓存、浏览器复制的原件及截图不进入产品提交。

失败留痕：完整浏览器首轮 76/77、退出 1（零计数 DOM 缺失）；首轮单元 326/327、退出 1（过期资源门禁断言）；扩展旧绘图配置测试时 5 处重复默认字段导致 TS2783、退出 1，已去重复并保留全对象比较；前述 8/16 集成误判 null 厂界也已修正。模块并行落盘期间的未完成模块检查不冒充通过。

## 限制与停止边界

- 只保证声明与引用一致、无损交换和受支持静态操作。固定公共锚点可能改变接入转角；转向、净空、扫掠、车辆适配和运行可行尚未重验，旧外部结果继续绑定旧摘要。
- 逻辑资源只高亮明确引用；转向、来源在目录。人工道路通行带尚未作为可编辑实体显示，相关几何更改受保护。未知底图/扩展完整保留。
- 同步 reader 上限为 4096 槽位、32768 顶点、100 万几何工作量；超限明确只读。未预建 Worker，D 图按本机实测，不宣称跨硬件性能保证。
- A02—A06 使用真实 SR03；其他机器缺原件/摘要变化会 blocked_input，不能以跳过或替身标为通过。
- 未实现项为 P2—P4：显式路网修复/路径与空间检查、尺度底图与 ZIP、可信面积/容量汇总和交接。仿真调度平台不属于本项目。
- origin 是论文仓库，不是地图发布目标。只提交本次 map 文件，不自动推送 main，也不把默认 origin 当地图发布远程。保留用户论文改动、旧 ZIP 删除和原任务书。

最终裁决：正确性独立复审通过，无剩余已知 P1 阻断；Ponytail 最终复审为 Lean already. Ship. 控制器依据全部实际结果确认 A02—A06 通过、P1 完成，交付后停止。没有删除未知语义保护，也没有把草稿校验解释为现实运输认证。

## 最大输入实际观测与最终文件核对

最终 Playwright 开发模式、headless Chrome 152.0.7977.83、Windows 10.0.26200、Intel Core Ultra 9 275HX，四图从文件导入至目录计数/画布初始化完成的单次观测：A 0.96 s、B 2.50 s、C 2.37 s、D 7.46 s。D 2,485,964 字节、1421 槽位；其保存、刷新、下载及重导入完整用例为 22.6 s。D 的加载等待是本批已知交互限制，本批未声称即时或跨硬件性能保证。原始附件提取在 .cache/P1/browser-final-metrics.json。

十六份原件最终 CLI SHA 与上文 manifest 完全一致。工程源文件只涉及上述领域/场景/视图链及测试，原件、任务书、论文和既有 ZIP 删除均未纳入本批提交。标准沙箱执行/图片读取 helper 本轮初始化失败，已用获得批准的 PowerShell 执行文件操作和真实检查；没有因此把未运行的检查标为通过。
