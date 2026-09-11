# 船厂拓扑地图绘制器

轻量、本地优先的二维地图绘制与外部系统数据准备工具。节点、道路、设施、区域和服务点保存为可由人及 Codex 直接修改的米制 JSON。地图校验不等于现场运输安全认证，synthetic 示例不代表实测船厂。

本仓库停止按历史 M3A 路线建设装卸仿真、调度平台、资源竞争、任务回放、3D 或 VR。已有服务语义、稳定 ID、保存与接入合同保留；运行执行属于外部系统。历史报告保留作参考，不自动授权后续开发。

## 启动与文件

要求 Node >=22.18.0，在本目录执行：

```powershell
npm ci
npm run dev -- --host 127.0.0.1
npm run map:validate -- examples/M2A1_synthetic_service_targets.map.json
```

浏览器支持多工程保存恢复、撤销重做、JSON 导入导出和外部修改冲突保护。新地图为 Schema 0.2.0，0.1.0 原样兼容；升级必须显式执行并保留原件。底图/ZIP 尚未实现，单 JSON 已包含全部矢量语义几何。

## 绘图配置恢复

网格吸附、节点吸附、新建设施/区域类型、两种整体移动策略及三个道路显示开关，随 `projectId` 保存在现有 IndexedDB `editorStates` 中。配置变化单独自动保存（600ms 防抖）；“保存工程”或 Ctrl+S 立即保存完整视窗与绘图配置。仅改配置不会修改地图 JSON、revision、摘要或撤销历史。调整视窗后再保存也会保留全部配置。

“恢复绘图默认配置”仅重置这九项设置。旧 camera-only 记录自动补默认值；损坏配置提示后仍恢复有效地图，保存失败明确显示未保存。刷新回到选择工具，矩形默认自动识别，不恢复临时自由变形模式、弹窗或未完成输入。字段与失败行为见[保存契约](docs/M11_PERSISTENCE_CONTRACT.md)。

## 道路宽度

已知宽度按米制比例显示道路带，中心线单独绘制；选中不增宽。右侧主要属性区可编辑宽度状态、数值与来源，应用后可撤销、保存和 JSON 往返。未知、不适用、无限制显示辅助虚线；圆端和圆形连接是近似表达，不能当作实测路口或车辆扫掠。旧字段不被自动解释为净宽，详见[宽度口径](docs/M0_DATA_CONTRACT.md#道路宽度的显示口径2026-09-10)。

“显示道路带 / 显示中心线 / 显示普通节点”随工程保存。隐藏普通节点时仍显示选中端点、绘路所需节点和入口/服务点；两个道路显示开关都关闭时隐藏已有道路。分段变宽先拆路再编辑。节点拖动和有效折点草稿同步预览，应用前不写地图。验证与限制见[道路宽度阶段报告](docs/RW01_ROAD_WIDTH_REPORT.md)。

## 边界直接编辑

单选设施或区域时，从权威边界识别矩形，显示四角控制柄。拖动固定对角，沿自身局部坐标轴独立改变宽高，旋转后的矩形仍保持直角；不默认等比。新尺寸下限为 0.01 m，越过对角时夹至下限。右侧“矩形宽/高”和“固定对角”使用同一算法；宽高为派生值，不另存一套尺寸。鼠标精度受浏览器原生指针事件限制；需要精确的米制宽高时使用数值输入，程序不会隐式吸附或反复舍入 JSON。

不规则多边形及孔洞显示真实顶点控制柄。矩形若需自由变形，先明确选择“自由多边形”；不会按任意四边形猜测矩形，也不会自动删除孔洞或重排原顶点。编辑模式只属于会话，重新导入按实际边界识别。

拖动中仅预览，松开提交一次已有领域事务；Esc、窗口失焦或编辑上下文变化取消预览，非法几何回退并报错。缩放和顶点调整只改边界，不移动入口、服务点或道路节点。整体平移/旋转继续使用原有的关联点策略。保存只包含已提交地图；未应用输入保护继续生效。

## P1 内容支持与 P2A 只读诊断

P1 保留厂界、路口、逻辑资源、已识别槽位的显示、目录定位、类型显隐/锁定和搜索；设施/区域按批准策略做静态内容刚体联动。未知行为继续受保护，完整数据可导出。当前源码、截图、原件 SHA 及实际验收对应见 [本批报告](docs/P2A_COMPLETION.md)。

在右侧属性栏展开“只读地图诊断 · P2A”，点击运行。检查包含隐藏和锁定对象，清单复用检查器，可点击定位。交点、近邻、重叠和独立子网只是声明候选，不自动接路。所有者包含、槽位正面积重叠及道路带/明确禁区单列覆盖情况；没有声明的条件显示未检查。诊断不会修改地图、revision、撤销历史或资源容量。

选择两个服务点/入口后预览道路方向与转向声明下的路线；视野偏离时点击现有“适应地图”。蓝实线是已声明条件下的路线，橙虚线是含未知条件的候选；各自列出假设。来源服务点沿已有显式出弧离开；到达目标服务点必须走其已声明内部路径。到达声明不自动变成唯一出口。资源占用、车辆扫掠、现实净空及作业完成均不在路径结论内。地图摘要变化后旧清单和路线失效；刷新后手动重新运行。

同核命令（退出 0 仅表示报告生成，不表示无冲突或运输获准；输入无效退出 1，文件/参数错误退出 2）：

    npm run map:diagnose -- path/to/map.json --from servicePoints:SP_001 --to servicePoints:SP_002

真实原件测试默认读取相邻工作区的 projects；独立检出仓库时明确设置其所在根目录：

    $env:SHIPYARD_TEST_DATA_ROOT = '完整数据根目录（内含 projects）'
    npm run test
    npm run test:integration
    npm run test:e2e
    npm run build
    npm run test:production

输入必须匹配冻结 SHA。缺失或被替换会报 blocked_input，不能用简化样例跳过。生产测试默认服务当前 dist；仅 P1 基线取证使用 P1_PRODUCTION_BASELINE=1 和已冻结构建。测试日志、截图和故障副本保存在本地 .cache/P2A，未写回用户原件。

## 开发与核验

采用项目级 [Ponytail full](.agents/skills/ponytail/SKILL.md) 与 [冗余审查](.agents/skills/ponytail-review/SKILL.md)，固定上游提交 `356918eba965ee1eac64bd3a7f0dd02108350de5`；直接读取技能文件执行，未安装全局插件、hooks、MCP 或应用运行依赖。两份技能及 MIT 许可证 blob 已与 [来源说明](UPSTREAM.md) 中的哈希核对。矩形编辑任务 ZIP 实际只有三份说明，技能由安装工具从该固定提交补齐。

矩形编辑批次复用选择枚举、已有几何校验/坐标转换及 updateFacility/updateZone 提交链；专用控制柄不缩放现有含文字的图形组。没有新框架或第二套历史/持久化引擎。原校验、输入保护、数据恢复和回归测试保留。

配置持久化修复验证（2026-09-09，同一 Windows / Node 环境）：

| 实际命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm.cmd run schema:check` | 生成类型一致，地图 Schema 未变 | 0 |
| `npm.cmd run typecheck` | 应用与纯核心通过 | 0 |
| `npm.cmd run lint` | ESLint、核心依赖边界通过 | 0 |
| `npm.cmd run test` | 14 文件，281/281 通过 | 0 |
| `npm.cmd run test:integration` | 3 文件，26/26 通过 | 0 |
| `npm.cmd run build` | 216 模块；JS 861.12 kB，gzip 261.46 kB | 0 |
| `npm.cmd run test:e2e` | Chrome，57/57 通过，2.6 min | 0 |

实施前 `npm.cmd run test:e2e -- tests/e2e/M11_save.spec.ts` 为 10/10；最终定向 `npm.cmd run test:e2e -- tests/e2e/drawingConfig.spec.ts tests/e2e/M11_save.spec.ts` 为 20/20，再运行上表完整检查。控制器定向 `npx.cmd vitest run tests/unit/M11_projectController.test.ts` 为 49/49。本批新增 28 项单元和 10 项浏览器验收；旧浏览器测试未修改。测试实际暂停自动保存验证按钮/Ctrl+S、延迟读取验证恢复前零写入，并覆盖 A/B 延迟保存、配置损坏、故障注入、视窗再保存、配置重置、地图/历史不变和刷新后临时状态清除。

`project_persistence` 实现并测试类型/校验/队列，`save_baseline_tests` 独立执行浏览器和最终门禁，`local_file_save` 只读审查竞态及冗余，主代理接入 App/工作区并裁决。审查发现的冲突计时器、焦点错误晚到、保存提示与队列执行冲突检查均已修复，最终无阻断，本批通过。中途新增测试的类型错误已修正；补最终队列检查时主动中断一轮定向运行（退出 1），未计为验收通过。完整已结束测试无失败。

本次复用现有 `editorStates`、控制器队列与恢复隔离，未新建保存系统、数据库、页面或依赖。命令记录位于本地 `.cache/drawing_config_final_results.json`，日志/trace 不提交。依赖未变，未重跑 `npm ci`；浏览器仅测 Chrome，存储故障为注入验证。构建保留大于 500 kB 的包体积提示，未为此修改构建阈值或扩展本次范围。

矩形编辑批次验证（2026-09-09，早于本次配置持久化修复；Windows / PowerShell 7，Node 22.18.0，npm 10.9.3）：

| 实际命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm.cmd run schema:check` | 两版本生成类型一致 | 0 |
| `npm.cmd run typecheck` | 应用与纯核心均通过 | 0 |
| `npm.cmd run lint` | ESLint 与核心依赖边界通过 | 0 |
| `npm.cmd run test` | 14 文件，253/253 通过 | 0 |
| `npm.cmd run test:integration` | 3 文件，26/26 通过 | 0 |
| `npm.cmd run build` | 216 模块；JS 856.80 kB，gzip 260.31 kB | 0 |
| `npm.cmd run test:e2e` | Chrome，47/47 通过，2.1 min | 0 |
| `npm.cmd run map:validate -- examples/M2A1_synthetic_service_targets.map.json` | 合法草稿，保留未知物理值提示 | 0 |
| `npm.cmd run map:validate -- examples/M2A1_invalid_service_node.map.json` | 按预期拒绝：`DANGLING_REFERENCE`，`/servicePoints/sZoneUnload/nodeId` | 1（预期） |

实施前定向单元回归 `npx.cmd vitest run tests/unit/M2A_commands.test.ts tests/unit/M2A_physicalEquality.test.ts tests/unit/M0_coordinates.test.ts` 为 53/53；新增单元 23 项。实施后先运行 `npm.cmd run test:e2e -- tests/e2e/rectangleEditing.spec.ts tests/e2e/M2A_spatial.spec.ts`，20/20 通过，再执行完整门禁。最终 47 项浏览器测试包含原有 36 项及新增 11 项；实际绘制和百帧拖动覆盖矩形、旋转、孔洞、非法回退、单事务、保存重开和关联节点不变。

失败记录：最初新测试的 Node/Ajv 导入导致未能收集用例，移除不必要的序列化器导入；首轮针对性执行 17/20，修复原生指针精度与夹限后重复反投影，并让输入保护测试显式处理现有确认框，随后 20/20。首次全量 46/47，旧 N07 整体拖动起点命中新角柄；只把起终点移到内部，保留原位移、100 帧和全部断言，单项 1/1 及最终全量 47/47 均通过。旧顶点编辑测试仅增加显式多边形模式选择。未删测试或放宽 JSON 全等检查。

分工与裁决：`project_persistence` 实现纯几何并独立复审 UI/提交链；`local_file_save` 实现控制柄并复审几何；`save_baseline_tests` 独立执行浏览器与工程门禁；主代理整合数值编辑、交互保护、文档并作最终只读核对。数值等价输入残留未应用状态已修复；最终正确性和 Ponytail 冗余审查无阻断，本批通过。输入为任务包及既有源码；新增主体为 `src/geometry/rectangles.ts`、`src/renderers/2d/BoundaryHandles.tsx` 和同名测试，接入现有 App/属性面板/二维图层。Schema、保存模块、适配器及依赖锁文件未变。

命令与退出码留存本地 `.cache/rectangle_final_results.json`，失败首轮单独保留；运行日志、失败 trace 和检查截图不提交 Git。本次复用锁定依赖，未重新执行 `npm ci`；Chrome 测试自动启动 Vite，未运行 Firefox/Safari 或系统原生文件权限手工验收。鼠标坐标有浏览器精度限制，精确尺寸使用数值入口。下一步仅维护绘制/数据交换与修复反馈，不自动恢复历史仿真路线。

## 接口和已有说明

- [数据字段与坐标](docs/M0_DATA_CONTRACT.md)、[双版本兼容合同](docs/M2A1_SCHEMA_COMPATIBILITY.md)、[保存与服务点使用](docs/M2A1_USER_GUIDE.md)。
- [矩形编辑任务来源](CODEX_TASK.md)、[工程规则](AGENTS.md)。旧 [M3A 计划](docs/M3A_IMPLEMENTATION_PLAN.md) 已停止执行，仿真适配器仍仅为接口合同。
- 系统原生文件权限/任意磁盘写回须按[手工验收](docs/M11_NATIVE_FILE_ACCEPTANCE.md)核验；自动化 OPFS 不能代替它。相邻标签可能重叠；无现场几何、安全或工程可行性认证。
