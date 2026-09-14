# SV01：原文件保存与编辑误拦截修复

基线：`codex/rf00-rf01@ec6506acbbc92d7976900242e0341f3b92980902`。本批只修改地图编辑器、必要测试和文档；保留论文修改、用户附件、九份原地图及其冻结摘要。复用现有事务、保存控制器和 React/Konva，未增加依赖或地图 Schema。

## 已修复

1. **保存到原文件。** 主“导入 JSON”在支持授权的浏览器中取得原生文件句柄；同一 IndexedDB v3 按工程保存句柄及已确认双摘要。刷新、关闭重开和切工程后恢复原关联，普通保存与 Ctrl+S 写回该文件，不再默认另存。
2. **旧工程接回原文件。** 对以前用普通 input 导入的工程，选择“保存到文件 → 选择原文件并写回”，选择原件、核对 ID/完整坐标框架、备份并确认一次；当前编辑不会被旧文件替换。随后直接保存。不同文件身份不凭文件名猜测；“保存为新文件”仍为显式操作。
3. **失败保护。** 权限拒绝、取消、原件变更和坏 JSON 保留当前地图。文件写成功但浏览器确认点失败时，不持久推进文件基线，避免刷新后的旧地图覆盖新文件。Schema 解绑失败不先丢失内存关联。“仅保存已提交地图”仍保留未应用表单。
4. **两处厂房移动误拦截。** 真实巨济 `F_GJ_MR_045`、`F_GJ_MR_061` 的内部作业点原来就在所属边界外。整体刚体移动不改变该相对关系，原越界继续作为警告，不再冒充本次新冲突。独立移动、新越界、边界修改和新道路带碰撞继续检查。既有韩华 HW123 专属入口移动保持可用。

涉及实现：`src/adapters/localFiles.ts`、`projectStore.ts`，`src/ui/App.tsx`、`useEditorInteraction.ts`，`src/domain/commands.ts`、`src/validation/spatialDiagnostics.ts`。

## 九图实际编辑审计

在九份冻结 MQ01 地图上逐个对全部 **1500** 个设施/区域/入口/作业点执行独立候选事务：**1312 接受、188 拒绝**。设施/区域尝试 `[0.25,0.125,0]m` 整体移动；入口尝试沿原边界的小位移，普通作业点尝试局部 XY 位移。1500 次候选各自从本图同一不可变原件会话独立分叉；成功项检查单事务及坐标框架、资源、转向、入口/作业点声明保持，失败项检查会话不变。撤销/重做与 JSON 往返逐项覆盖前置 191 个抽样候选中的 140 个成功事务，以及两处真实设施的 4 个平移/旋转事务；不将这些抽样结论冒称全量 1500 次 JSON 往返。九份源文件 SHA 全部不变。

表中为本次具体动作“成功/尝试”，不是对象任意拖动的许可证。其他角度、方向或更大位移须按提交时依赖与空间检查判定。

| 地图 | 设施整体移动 | 区域整体移动 | 入口移动 | 作业点移动 |
|---|---:|---:|---:|---:|
| 中集来福士 | 27/33 | 5/5 | 12/32 | 26/32 |
| 大连 | 24/28 | 3/3 | 3/27 | 21/27 |
| 三星巨济 | 52/56 | 8/8 | 3/55 | 48/55 |
| 韩华海洋 | 121/124 | 10/10 | 105/110 | 110/110 |
| 沪东 | 57/58 | 1/1 | 42/42 | 42/42 |
| 新时代 | 76/77 | 10/10 | 49/57 | 56/57 |
| 三湖 | 66/68 | 6/6 | 55/56 | 56/56 |
| 威海 | 38/38 | 9/9 | 37/37 | 43/43 |
| 新扬子 | 54/58 | 4/4 | 5/33 | 28/33 |

每个拒绝对象 ID、JSON Pointer 和原因见 [机器可读审计](SV01_EDIT_AUDIT.json)。另完成 2312 次支持预检及 191 个节点/道路/业务候选抽样；不将预检允许数当成实际提交成功数。

保留的限制：共享公共路网节点不能通过拖入口连带移动；跨所有者共享点需明确拆分/重接方案；移动厂房导致公共入口不再落边界时需要重新布置入口；有折点等复杂接入段仍受既有维护能力限制；新禁区、道路带碰厂房、独立作业点越界仍拒绝。没有删除 owner、arrival、转向、资源、槽位或未知扩展来通过。

## 实际检查

环境：Windows、PowerShell 7、Node 22.18.0、npm 10.9.3、Chrome 152；使用现有锁定依赖，无新增安装。真实 SR03 通过 `SHIPYARD_TEST_DATA_ROOT=.cache/BG01/data-root` 指定已核对 SHA 的输入。运行记录保留于本机 `.cache/SV01/`，不上传原地图、测试影像或缓存。

| 实际命令/检查 | 退出码 | 结果 |
|---|---:|---|
| `npm.cmd run schema:check` | 0 | Schema/生成类型一致 |
| `npm.cmd run typecheck` | 0 | 最终 UI、全部新增测试及纯核心通过 |
| `npm.cmd run lint` | 0 | eslint 与核心依赖边界通过 |
| `npm.cmd run build` | 0 | 生产构建成功；保留既有大块体积提醒 |
| `npm.cmd run test` | 1 | 667 通过；4 个 SR02 原件缺失 `blocked_input` |
| `npm.cmd run test:integration` | 1 | 86 通过；4 个 SR02 原件缺失 `blocked_input` |
| 定向 `M11_localFiles` 单元 | 0 | 27/27 |
| 定向 `UX02_ownerEditing / GA01_spatial / TE01_spatial` 单元 | 0 | 32/32 |
| `npx.cmd playwright test tests/e2e/SV01_fileBinding.spec.ts tests/e2e/BG01_assets.spec.ts --output=.cache/SV01/adapter-browser/artifacts --reporter=json` | 0 | 同库迁移、真实句柄和底图存储 6/6 |
| `npx.cmd playwright test --config=.cache/SV01/playwright.save.config.ts`，再单跑 `--grep 'failed binding removal'` | 0 / 0 | 保存 12/12＋升级故障 1/1；真实韩华临时原文件两次写回通过 |
| `npx.cmd playwright test --config=.cache/SV01/playwright.edit.config.ts` | 0 | 两处真实巨济设施 2/2，保存刷新/撤销/JSON 通过 |
| `npm.cmd run test:ux02`，`UX02_RUN_DIR=.cache/SV01/ux02` | 0 | UX02 全部 11/11 |
| `node.exe node_modules/@playwright/test/cli.js test -c playwright.production.config.ts --output=.cache/SV01/production/artifacts --reporter=json` | 0 | SR03 生产检查 6/6 |
| 下述既有生产回归命令 | 1 | 145/146；唯一底图长流程被通用 45 秒超时中断 |
| 底图长流程按原有 BG01 240 秒配置重跑 | 0 | 1/1（30.4 秒），无产品改动；首次失败记录保留 |
| `node.exe node_modules/tsx/dist/cli.mjs scripts/map-validate.ts <九图路径>` | 每图 0 | 9/9 草稿有效，含既有警告，不等同实际运输安全认证 |

既有回归精确命令（`UX02_RUN_DIR=.cache/SV01/regression`）：

```powershell
node.exe node_modules/@playwright/test/cli.js test -c playwright.ux02-regression.config.ts 'M0_smoke|M1_editor|M11_|M2A|DP1_|GA01_|P1_completion|P2A_diagnostics|RF01_workbench|TE01_|drawingConfig|rectangleEditing|roadWidth|BG01_editor'
node.exe node_modules/@playwright/test/cli.js test -c playwright.bg01.config.ts --grep 'BG01 real calibrated editor' --output=.cache/SV01/bg01-original-timeout/artifacts --reporter=json
```

前置失败也保留：编写中测试的三处 TypeScript 可空类型导致首次 build 退出2；修复类型后构建通过。首次 Windows `npx.cmd` 对上述正则竖线的转发失败退出255，改为直接执行同一 Node CLI 后正常运行。真实韩华首测因未设置既有 1m 网格而得到 2175.08m，与断言 2175m 不符；补显式网格设置后整套12项通过，不修改原数据或放松坐标断言。

本批保存/编辑浏览器唯一用例共15项通过（含2项旧 M11 回归）；迁移6项、UX02 11项与其他套件分别报告，不把重复用例累加为覆盖数量。真实截图包括 `.cache/SV01/browser-verified/artifacts/` 下韩华 `hanwha-original-written.png`、`hanwha-refreshed-written-again.png`，以及 `.cache/SV01/editor-browser/artifacts/` 下两个巨济设施截图与 trace。

正确性审查与 Ponytail 冗余审查分别完成。正确性审查发现的“只保存已提交输入”“解绑失败半状态”“文件成功/浏览器失败后的旧图覆盖”三项均修复并验证；当前无未关闭发现。冗余审查结论 `Lean already. Ship.`。补充文档审查纠正了全量1500尝试与抽样撤销/JSON覆盖的混写。

生产包 `dist/assets/index-N-lwgxVW.js` 的 SHA-256 为 `191d33baff965e1327e7d27f7f250cf9d38734c18345fb83392db22073470fa5`。源码摘要、测试命令、输入冻结摘要及失败回执见 [机器可读交付记录](SV01_TEST_RECEIPT.json)。本批交付范围达到；旧 SR02 回归保留缺件限制，OS 权限弹窗仍未自动验证。


## 边界

- 浏览器文件验收使用真实 Chrome OPFS 句柄、写入流、IndexedDB；只有选择器及失败由测试控制。真实韩华地图使用隔离临时文件，未改源地图。OS 原生文件授权弹窗未自动验证；失去权限时仍需用户授权，程序不能静默取得任意磁盘文件权限。
- 无文件授权 API 的浏览器继续使用 JSON 下载；下载不等于原路径写回。关联按当前浏览器站点保存，清空站点数据后需重新关联。
- 单 JSON 仍不包含底图图片字节。未增加 ZIP、调度、3D/VR、自动合并或自动修复。
- 本次没有重新执行独占显示性能预算测试；功能用例耗时不作为性能达标证明。旧 SR02 四图缺件继续 `blocked_input`。
