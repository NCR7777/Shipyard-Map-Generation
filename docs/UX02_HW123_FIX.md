# UX02 补丁：韩华 HW123 专用入口移动

本补丁接续本地 `7e6f3fc`，只修复已有编辑器的有限归属判断和拒绝提示。没有修改地图 Schema、原图、外部结果或历史验收回执，不推送。

## 用户报告与真实原因

对象为韩华 `F_HW123`（陆侧码头作业带）、`AP_HW123`（模拟接入点）和 `SP_HW123`（内部交接点）。V01、V02 和 MQ01 中这一局部结构一致。

```text
公共节点 N_HW_fed23d71eb（固定）
  → 外部接入支路 R_HW_f02bcea773
  → 入口节点 N_HW_7aa9ceb679
  → 明确归属 F_HW123 的内部道路 R_HW_a63b9b5150
  → 交接点节点 N_HW_f68dfea91a
```

旧规则仅允许连接一条道路的专用入口随动。HW123 入口有两条道路，虽然一条已明确归属同一设施，仍被保守归入公共节点。实际修前：入口各方向移动均 `OWNER_PUBLIC_NODE`；作业带横移因入口被固定触发 `OWNER_ENTRANCE_REPOSITION_REQUIRED`，向负 X 移动还出现 `OWNER_INTERNAL_ROAD_OUTSIDE`。沿 Y 整体移动有些候选原本就可以通过；不能误报整个作业带所有方向都不可动。

这处属于上一批没有覆盖的关联组合。两条道路相接并不自动证明它是应固定的公共交叉口。

## 修复范围

- `src/domain/ownerEditing.ts`：有明确业务归属、只有一条无归属外部支路、其余道路均显式归属同一设施的入口，可在原规则下编辑。
- `src/domain/commands.ts`：整体移动使用相同判定。入口和内部交接点随设施平移，外部支路另一端固定；保留其权威端点引用，不新造道路主数据。
- `src/ui/App.tsx`：入口、作业点、设施及区域被依赖或锁定拒绝时，在当前属性面板显示具体中文原因，技术代码和路径可展开。复用原 commandSupport，不另建权限判断。
- `tests/unit/UX02_ownerEditing.test.ts`：补充专用接入＋内部路的正例，以及真正公共、跨归属、无归属和折点反例。
- `tests/e2e/UX02_HW123.spec.ts`：真实韩华原图验收。可用 `UX02_MQ01_ROOT` 指定 MQ01 根目录；缺输入返回 `blocked_input`，不替换冻结 SHA。

不从名称、影像包含或 metadata 推断 owner。两条以上外部道路、其他所有者或无归属业务点、人工道路带、登记长度、多节点路口和独立转向几何仍按原保护处理。入口独立移动仍需保持原有边界关系；不允许随手拖离边界后制造无效接入。

## 实际结果

真实原图 `projects/MQ01_Repair_20260913/hanwha/map.json`，SHA `026bf0c409b151aa005fe59d50e0aeda294eca83a5fbccf9b5927b9190cb4749`，前后逐字节一致。

真实编辑器完成：入口沿边界移至 `[1888,2175,0]`；入口移至 `[1889,2175,0]` 被拒绝且状态不变；撤销恢复后整体将作业带平移 `[1,1,0]`，入口与内部交接点同移，公共端点固定。全部 roads、movements、resources、arrival、ID 和 coordinateFrame 深度保持；仅实际几何及对应来源改变。鼠标拖动使用 100 次原生移动步骤，不声称是 100 个已绘制帧。

一次撤销、重做、浏览器保存、刷新、JSON 导出重导入均通过。同图 `AP_HW068` 仍因两条外部道路保持公共节点保护，且右侧直接显示原因；真实拖动不会改变地图或历史。

| 实际命令 | 退出码 | 结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | Schema 一致 |
| `npm.cmd run build` | 0 | 内含类型检查；既有大 chunk 警告保留 |
| `npm.cmd run lint` | 0 | 含领域依赖边界 |
| `npm.cmd run test` | 1 | 656 通过；4 项缺 SR02 原件 |
| `npm.cmd run test:integration` | 1 | 86 通过；4 项缺 SR02 原件 |
| `npx.cmd playwright test -c playwright.ux02.config.ts tests/e2e/UX02_HW123.spec.ts` | 0 | HW123 新验收 1/1 |
| `npx.cmd playwright test -c playwright.ux02.config.ts --grep-invert 'real Hanwha HW123'` | 0 | 原 UX02 10/10 |
| `npx.cmd playwright test -c playwright.production.config.ts --workers=1 --output=.cache/UX02/HW123/production/artifacts --reporter=json` | 0 | SR03 生产验收 6/6 |
| `node node_modules/tsx/dist/cli.mjs .cache/UX02/HW123/correctness-probes.ts` | 0 | 独立正确性探针 20 项，包括真实正例和拒绝反例 |

浏览器设置 `SHIPYARD_TEST_DATA_ROOT=.cache/BG01/data-root`；前两条浏览器命令分别设置 `UX02_RUN_DIR=.cache/UX02/HW123/ui` 与 `.cache/UX02/HW123/ux02-regression`，保留本轮证据。全量 146 项旧浏览器套件没有在这个小补丁后全部重跑。功能回归存在并行运行，不作为新的性能验收。

正确性审查与 Ponytail 冗余审查分别完成，均无未解决发现。原有公共依赖保护及反例保留。用户本地 `http://127.0.0.1:5173/src/domain/ownerEditing.ts` 返回 200，并已包含新的唯一外部接入段规则。

最终生产 JS：`index-CTZTjoTu.js`，SHA `edc606deaf10162a18fef88a5479f654594abbb20fd18965d5a20d3aa4ad886c`。

[源码与命令回执](../.cache/UX02/HW123/delivery.json) · [真实 UI 回执](../.cache/UX02/HW123/ui-receipt.json) · [正确性审查](../.cache/UX02/HW123/correctness-review.json) · [Ponytail 审查](../.cache/UX02/HW123/redundancy-review.json)

[编辑前](../.cache/UX02/HW123/ui/artifacts/UX02_HW123-UX02-real-Hanwh-cef07-ic-anchor-and-complete-JSON-chrome/hanwha-before.png) · [移动后](../.cache/UX02/HW123/ui/artifacts/UX02_HW123-UX02-real-Hanwh-cef07-ic-anchor-and-complete-JSON-chrome/hanwha-after.png) · [保存刷新后](../.cache/UX02/HW123/ui/artifacts/UX02_HW123-UX02-real-Hanwh-cef07-ic-anchor-and-complete-JSON-chrome/hanwha-restored.png)
