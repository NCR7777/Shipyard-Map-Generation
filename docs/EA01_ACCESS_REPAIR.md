# EA01：独立入口与九图修复

2026-09-14，基线 `0002685e3a104d2219b6cf2b250c6e646b73f4c4`。采用项目 Ponytail full；保留用户论文修改、附件和旧 ZIP 删除。没有修改地图 Schema、coordinateFrame、原始地图或既有日志。

## 根因与实际修复

韩华 HW099 原件并非完全没有支路：`AP_HW099` 与两条公共道路共用 `N_HW_a96cfdfffb=[2020,2192.2,0]`，另有通向作业点的 8m 私有接入段。入口等于公共节点，使独立入口移动触发公共路网保护；声明道路带又遮住大部分短支路。

增加现有入口属性面板中的“建立独立入口并保留接路”。预览距离和坐标，确认后用现有 TE01 拆路命令把原接入段分成公共连接段和所属设施内部段，入口引用新节点，公共节点固定。HW099 建议距离 7.2m，新入口 `[2012.8,2192.2,0]` 位于已知 14m 主路的声明带外。没有增加主路路口或任意移动作业点。

原入口、服务点和设施 ID 保持；被拆道路的新 ID 与旧 ID 沿革通过既有拓扑来源保留。原允许/禁止转向精确重映射；只有原路连续行驶对应的细分接续，新接续无独占资源。专用 design_assumption 来源保留原道路扩展和来源，解释新段角色；新公共段不继承内部道路的厂房穿越豁免。任何失败、锁定或取消均不产生半提交。

真实浏览器暴露的另一处问题是入口与作业点仅相距 0.8m，作业点标记覆盖已选入口。现在只将已选业务点置于当前可见候选顶层，保留身份、隐藏和锁定规则，能够真实拖动；不合并不同节点。

## 九图交付

原件根：`projects/MQ01_Repair_20260913`。新目录：`projects/EA01_Access_Repair_20260914`，每厂 `map.json` 可直接打开，附 `repair-report.json`、总 `manifest.json` 和保留项清单。九份原件及韩华 V01/V02 原件 SHA 前后完全一致。图片/底图索引在这九份输入中均为空；没有伪造随图影像。

| 船厂目录 | 已独立或未共用，未改 | 本次实际修复 | 保留复杂情况 |
|---|---:|---:|---:|
| cimc | 12 | 12 | 8 |
| dalian | 3 | 19 | 5 |
| geoje | 3 | 46 | 6 |
| hanwha | 105 | 5 | 0 |
| hudong | 42 | 0 | 0 |
| newtimes | 49 | 8 | 0 |
| samho | 55 | 1 | 0 |
| weihai | 37 | 0 | 0 |
| xinyangzi | 5 | 24 | 4 |
| 合计 | 311 | 115 | 23 |

23 项中，21 项为入口与 node_proxy 作业点同节点、没有声明所属内部道路，不能在不改变原交接语义的情况下自动推定新门位与路线。其余两项为中集 `AP_MR_F_CR020` / `AP_MR_F_CR023`，共用公共节点且属于不同设施。它们保留原数据及具体拒绝；不称所有入口均已自由移动。

115 次转换均执行命令、完整撤销重做和 JSON 往返；九图有 921 次入口/所有者移动探针，919 次接受，2 次拒绝：巨济 `AP_MR_F_GJ001` 向 X -1m、`AP_MR_F_GJ_MR_062` 向 Y -1m 会使原外部入口变成内部入口，触发 `OWNER_ENTRANCE_REPOSITION_REQUIRED`。探针不写入交付地图。韩华 V01/V02 各额外验证 HW099 转换及 9 次移动，包括主体 X +20m。

## 操作与范围

- 可直接导入新副本；已有浏览器未导出的编辑请继续保留，在入口面板使用上述按钮处理，不自动重载覆盖。
- 新副本保留原 mapId，内容摘要/revision 因编辑改变。旧场景、运行和外部结果仍绑定原摘要，必须另行预检和显式重新绑定。
- 支持已有单条明确私有接入段的安全细分；人工道路带、登记长度、道路资源、独立转向几何、多所有者或未知行为语义缺少维护规则时继续拒绝。
- 只完成声明拓扑与编辑一致性验证。建议点不是实际门位测绘；道路带外不等于足够净空。大位移可能形成折返，未证明 SPMT 转弯、扫掠或调度可行。
- 命令调用者显式新增实体 ID 若与本次自动来源 ID 恰好相同，事务会完整拒绝；当前 UI UUID 与批量交付 ID 未触发此边界。

## 实际检查

PowerShell 7；Node 22.18.0、npm 10.9.3、Chrome 152；Windows，浏览器生产构建。沿用锁定依赖，没有新增依赖。命令均在 `paper01/map` 执行。历史原件根配置：

```powershell
$env:SHIPYARD_TEST_DATA_ROOT=(Resolve-Path '.cache/BG01/data-root').Path
```

| 命令 | 退出码与实际结果 |
|---|---|
| `npm.cmd run schema:check` | 0 |
| `npm.cmd run typecheck` | 0，浏览器/纯核心严格类型 |
| `npm.cmd run lint` | 0，含核心依赖边界 |
| `npm.cmd run build` | 0，最终脚本 `index-DPoxD1Bx.js`；保留已有大 chunk 警告 |
| `npx.cmd vitest run tests/unit/EA01_access.test.ts` | 0，17/17 |
| `npm.cmd run test` | 1，684/688；4 个 SR02 原件缺失为 blocked_input |
| `npm.cmd run test:integration` | 1，86/90；同 4 个 SR02 原件缺失 |
| `npx.cmd playwright test tests/e2e/EA01_access.spec.ts tests/e2e/HW099_move.spec.ts tests/e2e/SV01_save.spec.ts --config=playwright.ux02-regression.config.ts` | 0，16/16，`UX02_RUN_DIR=.cache/EA01/ui-hit-order` |
| `npx.cmd playwright test --config=playwright.ux02.config.ts` | 0，11/11，`UX02_RUN_DIR=.cache/EA01/ux02-regression` |
| `npx.cmd tsx scripts/EA01_repair_access.ts ../../projects/MQ01_Repair_20260913 ../../projects/EA01_Access_Repair_20260914` | 0，115 次转换；输出目录必须不存在 |
| `npx.cmd tsx .cache/EA01/hw099-versions.ts` | 0，真实 V01/V02 |
| `npm.cmd run map:validate -- ../../projects/EA01_Access_Repair_20260914/<yard>/map.json` | 九厂逐一运行，均 0；草稿有效不等于运输许可 |

重复同一输出目录按预期拒绝，子命令退出 1，原 manifest 不变。新环境先 `npm ci`，提供上述真实数据根；不得用同名替代图绕过 SHA。

失败过程保留在 `.cache/EA01`：初始类型缩窄和测试 helper 类型错误已修；首次 E2E 对 1m 网格吸附的期望值不准确，修正后通过；7.2m 建议暴露真实命中覆盖，修复渲染顺序后最终 16 项通过。新增单元初轮非法双入口夹具导致 16 项失败，修正合法输入后 17 项通过。批处理首轮用引用相等判定撤销错误，改为完整值相等后通过，失败轮未写输出。只读汇总一次遇列表文件误用 dict，修正过滤后核对全部 23 项；不影响地图。审批服务偶发容量失败属于未执行调用，非产品测试通过。

最终实图截图、连续操作 trace、JSON 出口及回执位于 `.cache/EA01/ui-hit-order/artifacts/EA01_access-EA01-separates-47ac0-without-moving-public-roads-chrome/`。`ea01-proposal.png` 为独立入口计划，`ea01-yard-moved.png` 为主体移动后；receipt 绑定实际加载脚本。所有测试日志、源码/输入/输出摘要和最终提交对应见本地 `.cache/EA01/delivery.json`。

## 独立审查与裁决

核心代理实现安全领域命令，数据代理扫描/另存九图并验证保护，主代理接入原 UI、修命中与实际浏览器验收。独立代理分别审查正确性和 Ponytail 冗余。正确性审查发现新公共段错误沿用原内部通行豁免，已修复并由厂房反例验证；命中缺陷也经真实界面复测。Ponytail 未发现应删除的冗余，复用现有拆路、几何、事务、校验、保存与草稿系统。

本批 HW099 和相同可安全拆分类型通过；23 项明确保留。历史 SR02 缺件阻塞对应 8 项检查，不宣称全套历史回归通过。不开展自动门位推断、复杂共享重写或仿真优化。
