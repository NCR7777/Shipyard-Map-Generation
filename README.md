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

## 边界直接编辑

单选设施或区域时，从权威边界识别矩形，显示四角控制柄。拖动固定对角，沿自身局部坐标轴独立改变宽高，旋转后的矩形仍保持直角；不默认等比。新尺寸下限为 0.01 m，越过对角时夹至下限。右侧“矩形宽/高”和“固定对角”使用同一算法；宽高为派生值，不另存一套尺寸。鼠标精度受浏览器原生指针事件限制；需要精确的米制宽高时使用数值输入，程序不会隐式吸附或反复舍入 JSON。

不规则多边形及孔洞显示真实顶点控制柄。矩形若需自由变形，先明确选择“自由多边形”；不会按任意四边形猜测矩形，也不会自动删除孔洞或重排原顶点。编辑模式只属于会话，重新导入按实际边界识别。

拖动中仅预览，松开提交一次已有领域事务；Esc、窗口失焦或编辑上下文变化取消预览，非法几何回退并报错。缩放和顶点调整只改边界，不移动入口、服务点或道路节点。整体平移/旋转继续使用原有的关联点策略。保存只包含已提交地图；未应用输入保护继续生效。

## 开发与核验

采用项目级 [Ponytail full](.agents/skills/ponytail/SKILL.md) 与 [冗余审查](.agents/skills/ponytail-review/SKILL.md)，固定上游提交 `356918eba965ee1eac64bd3a7f0dd02108350de5`；直接读取技能文件执行，未安装全局插件、hooks、MCP 或应用运行依赖。两份技能及 MIT 许可证 blob 已与 [来源说明](UPSTREAM.md) 中的哈希核对。本次 ZIP 实际只有三份说明，技能由安装工具从该固定提交补齐。

本次只复用选择枚举、已有几何校验/坐标转换及 updateFacility/updateZone 提交链；专用控制柄不缩放现有含文字的图形组。没有新框架或第二套历史/持久化引擎。原校验、输入保护、数据恢复和回归测试保留。

本批验证（2026-09-09，Windows / PowerShell 7，Node 22.18.0，npm 10.9.3）：

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
- [本次任务](CODEX_TASK.md)、[工程规则](AGENTS.md)。旧 [M3A 计划](docs/M3A_IMPLEMENTATION_PLAN.md) 已停止执行，仿真适配器仍仅为接口合同。
- 系统原生文件权限/任意磁盘写回须按[手工验收](docs/M11_NATIVE_FILE_ACCEPTANCE.md)核验；自动化 OPFS 不能代替它。相邻标签可能重叠；无现场几何、安全或工程可行性认证。
