# SV02：保存默认写回原文件

日期：2026-09-14。基于本地 `0fe46418` / 地图发布 `87ac244a`，只修正保存入口；未修改用户原图、地图语义、文件控制器、数据库或撤销系统。

“保存”和 Ctrl+S 直接写回已关联原文件，不再出现保存目标选择；新文件使用“另存为”或“导出 JSON”。旧 EditorState 的 ask/browser/file 值保留兼容，但不影响默认动作。刷新和工程切换沿用 SV01 持久文件关联。

没有可写文件句柄的旧浏览器副本，须主动通过“文件 → 关联原文件”核对并授权一次。未关联时不会弹另存为、下载或谎报写回成功；浏览器恢复快照仍保存。未应用输入、外部文件冲突和浏览器权限错误继续明确处理。

改动文件为 `src/ui/App.tsx`、`src/ui/useEditorInteraction.ts`、`src/editor/workbench.ts`，以及两份保存/工作台浏览器测试及其两个共用助手。删除两层保存选择弹窗和重复按钮，复用现有同步快照、保存队列、冲突与关联逻辑。

## 实际验证

环境：Windows、PowerShell 7、Node 22.18.0、npm 10.9.3、Chrome 152；生产 preview 端口 4194。复用锁定依赖，没有重新安装。

| 命令 | 退出码与结果 |
| --- | --- |
| `npm.cmd run typecheck` | 0；最终源码与测试通过 |
| `npm.cmd run lint` | 0；ESLint 及核心依赖边界通过 |
| `node.exe node_modules/vitest/vitest.mjs run tests/unit/M11_localFiles.test.ts tests/unit/M11_projectController.test.ts tests/unit/RF01_interaction.test.ts --exclude '.cache/**'` | 0；3 文件，105/105 |
| `npm.cmd run build` | 0；最终产物 `index-Dlwf4wc-.js`，保留原有大包提示 |
| `npx.cmd playwright test tests/e2e/SV01_save.spec.ts tests/e2e/RF01_workbench.spec.ts tests/e2e/M11_save.spec.ts tests/e2e/M11_localFileFlow.spec.ts --config=playwright.ux02-regression.config.ts` | 1；35 项中 34 通过，新增用例过早读取仍在关闭的 OPFS 文件流 |
| `npx.cmd playwright test tests/e2e/SV01_save.spec.ts --config=playwright.ux02-regression.config.ts -g SV02` | 0；修正测试等待保存确认后，最终构建新增 3/3 通过 |
| `git diff --check -- .` | 0 |

真实地图输入使用 `$env:SHIPYARD_TEST_DATA_ROOT=(Resolve-Path '.cache/BG01/data-root').Path`；首轮冻结 `$env:RF01_EXPECTED_BUNDLE='index-BV8JD0-b.js'`。首轮输出根为 `$env:UX02_RUN_DIR='.cache/SV02/default-save'`；最终为 `.cache/SV02/final-smoke-valid-selector`。最终测试首次使用过严筛选 `-g '^SV02 '`，无匹配退出 1，记录在 `.cache/SV02/final-smoke`。未吞读取异常或放宽文件内容断言；失败日志均保留。首轮后产品仅删去冗余“保存到文件”按钮，最终三项覆盖此删除；未宣称最终完整 35 项重新运行。

首轮旧 32 项全部通过，包含真实冻结韩华入口及 CIMC V02 三尺寸操作、保存刷新、JSON 往返、跨工程同 mapId 隔离、未改 revision 的外部冲突、待应用输入、延迟关联恢复、文件/浏览器分别失败和 CAS。最终三项验证旧保存偏好不起作用、未关联不选文件不下载，以及显式另存为后 Save/Ctrl+S 和刷新持续写回新目标。原件未改，只写测试临时文件。

截图、trace、机器报告与分离的正确性/Ponytail 审查保存在本地 `.cache/SV02/`。正确性无阻断；冗余审查提出的重复按钮已移除。Chrome 自动化使用真实 OPFS 句柄、stream 和 IndexedDB，选择器由测试控制；未替代 Windows 原生权限对话框的手工验收，也未运行全套历史地图、集成或性能测试。本批到此停止。

分工：主代理修改保存路由并整合，`save_default_tests` 独立修改和运行浏览器测试，`save_default_review` 分别审查正确性与冗余。控制器裁决：本批默认保存修正通过，保留上述环境与验证边界，仅发布 map 改动。
