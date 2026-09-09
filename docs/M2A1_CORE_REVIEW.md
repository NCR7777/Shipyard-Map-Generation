# M2A.1 核心实现记录与跨代理审查

日期：2026-09-09。代理：project_persistence。本文件区分自有实现记录与跨代理只读审查，不以作者自查代替独立验收，也不宣称本批最终浏览器通过。

## 自有实现范围

本代理负责双版本 Schema/生成流程、model/factory、commands、validation、serviceConnections、SceneSnapshot、迁移 CLI 和兼容文档。既有 `0.1.0` Schema 与生成文件保留，新增独立 `0.2.0` 契约。`ServicePoint` 增加区域主归属和 arrival 声明，kind 仍是唯一服务能力；没有任务事件引擎或资源发布实现。

区域成员由 servicePoint.zoneId 派生，新增显式区域移动/删除策略。内部道路序列检查 ID 首尾、连续性、方向、引用和已声明禁止转向；没有路径搜索、默认转向或入口瞬移。诊断只返回 blocked/unchecked。复制不隐式带入外部路网，未完整显式选择内部声明道路时拒绝，拆分被引用道路亦拒绝。

升级是只改 schemaVersion/revision 的领域事务；原来源、ID、资产及合法扩展保留。迁移 CLI 同一路径校验与命令执行，拒绝同路径及已有输出，以新文件独占创建，输出实际差异和源/目标摘要。完整合同见 [兼容文档](M2A1_SCHEMA_COMPATIBILITY.md)。

## 本代理实际检查

| 命令或操作 | 结果 |
|---|---|
| `npm.cmd run schema:generate` | 退出 0，按两份 Schema 生成；旧生成文件内容保持 |
| `npm.cmd run schema:check` | 退出 0 |
| `npx tsc --noEmit -p tsconfig.core.json` | 退出 0；多次覆盖契约、命令、诊断与缓存修复后的核心 |
| `npx eslint`，指定 owned core、生成脚本及 map-migrate.ts | 退出 0 |
| `npx vitest run tests/unit/M2A1_connectionCost.test.ts` | 退出 0，2/2，580ms |
| `npm.cmd run --silent map:migrate -- examples/M2A_synthetic.map.json .cache/M2A1_migrated_review_1628.json` | 退出 0；实际生成新版本文件，原输入未写入 |
| 旧示例 load→upgrade→还原版本/revision 再规范化比较 | 规范 JSON 完全相等；旧内容摘要仍为 `d5271ba953bf04cf150533a220896af19b4a2b78ca20c5aa30f6190fcb35f015` |

迁移示例差异为 schemaVersion 0.1.0→0.2.0、revision 10→11。没有用旧阶段通过数字替代本批运行。全量类型、单元、CLI 集成和浏览器回归由 root 与 save_baseline_tests 统一运行、归档并做最终裁决。

## 独立反馈与修正

local_file_save 只读审查发现：每个内部 ArcRef 反复调用 roadLength 会使同路反复往返的声明放大折点遍历成本；原组合预算没有覆盖几何重复计算。本代理修复为每次批量诊断共享短期道路长度缓存，并把总几何线段计入 2000000 的工作预算。缓存不跨地图保留，不成为权威字段。

小样回归用两个服务点各 11 条往返弧、同一条 99 折点道路，断言 bulk 只调用一次道路长度派生且两者均为 1100m；另以 2001 服务点×1000 道路验证超限在展开诊断前明确拒绝。没有运行十亿规模的风险样本。反馈代理独立复验此两项通过并关闭该阻塞。

同次反馈还补齐独立诊断接口的服务 ID own-property 检查、设施/入口悬空和设施归属不匹配诊断。entryNodeId 纳入显式 deleteUnused 候选，但仍有道路、点或其他到达声明引用时保留。相关功能反例由 save_baseline_tests 独立补充；本文不将这些自有改动记作独立自审通过。

## 跨代理只读审查：App 与 M3A 计划

本代理只读审查 root 的 `App.tsx` 新暂存保护、升级协调，以及 `docs/M3A_IMPLEMENTATION_PLAN.md`，未改动这些文件。该次审查未发现剩余实现阻断项，结论须与实际浏览器验收合并使用：

- 升级先执行纯领域预检，浏览器原图备份成功后核对 changeToken，才解除旧文件关联并提交升级事务。失败保留旧图；保存确认哈希取最新会话状态，避免覆盖异步确认。升级期间 ref 阻止地图编辑与导航。
- 暂存保护覆盖对象/工具切换、撤销重做、删除、拖动和空间对象提交；取消保留输入，明确丢弃后才执行捕获的意图。Escape 已从绘制 hook 的直接清除迁移到保护流程，避免先丢草稿再确认。
- 成功工程恢复清理创建点、离开确认、升级与其他旧弹窗，并更新绘制重置 token。已有恢复异常保存隔离机制保留。
- M3A 文档明确是计划，区分 map/scenario/events 权威数据；先合同、路网/转向、必要资源，再无 DOM 单任务与双车竞争，最后接回放。没有因图形可移动就解除资源门禁；服务开始/完成与到达、设备释放与空间离开保持区分。

本次只读判断不替代真实输入、下载、取消/确认、升级备份、撤销重做和刷新恢复测试。系统原生授权、M2B 底图/ZIP、M3A 执行引擎均不在本批实现结论内。
