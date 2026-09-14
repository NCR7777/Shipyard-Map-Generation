# HW099 移动复查与拒绝反馈修复

基线 `39f562a`，2026-09-14，Ponytail full。保留原件、冻结 SHA、已有论文修改；没有重建编辑器或改变领域移动许可。

## HW099 的真实原因

韩华 `F_HW099` 是露天作业/堆放设施，边界 X=2010～2043m、Y=2062～2227m。入口 `AP_HW099` 引用公共节点 `N_HW_a96cfdfffb=(2020,2192.2,0)`，连接两条公共道路；内部路 `R_HW_4a32db1f1e` 连到 `SP_HW099` 的私有节点 `(2012,2192.2,0)`。没有槽位。

真实原编辑器中向 +X 拖 5m 成功，公共节点保持原位、私有服务点及边界随动；接入段长度重新派生。最终浏览器在该5m保存版本上再拖 +X 20m 被拒绝；领域定向测试从原图尝试 +X 20m 或 -X 30m 时，固定入口落到新轮廓外，原本位于设施内的内部道路随之越界，返回 `OWNER_ENTRANCE_REPOSITION_REQUIRED` 与 `OWNER_INTERNAL_ROAD_OUTSIDE`。V01、V02、MQ01 三个韩华版本的小位移与大位移定向结果一致。这不是整图锁定，也不表示任意方向/距离都可移动；整体迁移需要先维护入口与接路，不能连带拖走公共路网。

已确认的程序缺陷是：拒绝原因藏在折叠检查器里，画布只说“操作被拒绝”。本次修复共享错误展示，立即显示具体对象、节点及位置关系；可关闭提示或打开原检查器定位。当前操作错误排在检查器前面；提示高度最多6rem，可滚动，不主动抢焦点或改变相机。关闭仅清除当前操作提示，不修改地图、历史或保存状态。

产品改动仅 `src/ui/App.tsx` 和 `src/validation/ownerEditing.ts`，新增真实浏览器回归 `tests/e2e/HW099_move.spec.ts`；无新依赖、Schema、地图数据或持久化系统。

## 九图完整候选审计

每个设施、区域、入口、作业点分别尝试 +X/-X/+Y/-Y 1m，共1500个对象、6000笔独立候选事务：4046接受、1954拒绝。727个对象四向接受，592个部分接受，181个四向拒绝；四向拒绝不证明任意方向都不可移动。逐对象原因及冻结摘要见 [机器清单](HW099_MOVE_AUDIT.json)。

| 地图 | 对象 | 尝试 | 接受 | 拒绝 |
|---|---:|---:|---:|---:|
| 中集来福士 | 102 | 408 | 233 | 175 |
| 大连 | 85 | 340 | 145 | 195 |
| 三星巨济 | 174 | 696 | 307 | 389 |
| 韩华海洋 | 354 | 1416 | 1032 | 384 |
| 沪东 | 143 | 572 | 421 | 151 |
| 新时代 | 201 | 804 | 593 | 211 |
| 三湖 | 186 | 744 | 586 | 158 |
| 威海 | 127 | 508 | 440 | 68 |
| 新扬子 | 128 | 512 | 289 | 223 |

成功项检查单次历史、完整 coordinateFrame、resources、movements、accessPoints、servicePoints 未改；失败项检查返回原 session 对象，未半提交。九份文件末尾 SHA 与冻结摘要相同。此6000笔没有逐项执行撤销/重做或JSON往返，也没有逐笔断言所有几何数值；完整精确几何、保存及往返由 HW099 浏览器专项验证。另核对 MQ01+V02 的18份输入身份，V02 没有全量重跑操作。

拒绝类型包括固定/共用入口、内部道路或服务点越界、新道路带/建筑/明确禁区冲突、零长道路、多归属共享，以及接入段人工折点的维护能力未实现。独立复核按10种错误代码各抽1例，使用Shapely验证几何关系：新时代一处16m道路带距离禁区由8.321m变为7.322m；沪东一处1m接入路缩为0；大连一处含人工折点，属于能力限制。样本未发现明显误拒绝，不能据此声称1954次拒绝全部独立证明正确。

## 实际命令与结果

Windows / PowerShell 7、Node 22.18.0、npm 10.9.3、Chrome 152；复用锁定依赖，未重装。

新增HW099测试支持 `UX02_MQ01_ROOT` 指定包含 `hanwha/map.json` 的根目录，默认 `../../projects/MQ01_Repair_20260913`；缺件或SHA不符报 `blocked_input`，不跳过。

| 命令 | 退出码及结果 |
|---|---|
| `npx.cmd tsx .cache/HW099/all-business.ts` | 0；6000笔审计；从既有SV01清单读取并核对9份冻结输入 |
| `npx.cmd tsx .cache/HW099/targeted-extended.ts` | 0；韩华三版定向动作，不改原图 |
| `node.exe node_modules/vitest/vitest.mjs run tests/unit/UX02_ownerEditing.test.ts tests/unit/GA01_spatial.test.ts tests/unit/TE01_spatial.test.ts tests/unit/M11_localFiles.test.ts tests/unit/M11_projectController.test.ts tests/unit/RF01_interaction.test.ts --exclude '.cache/**'` | 0；6文件137/137 |
| `npm.cmd run typecheck`、`npm.cmd run lint`、`npm.cmd run build` | 最终均0；保留原大包警告 |
| `npx.cmd playwright test tests/e2e/HW099_move.spec.ts tests/e2e/SV01_save.spec.ts --config=playwright.ux02-regression.config.ts` | 0；15/15，输出根 `UX02_RUN_DIR=.cache/HW099/final-ui` |
| `npx.cmd playwright test --config=playwright.ux02.config.ts` | 0；11/11，输出根 `.cache/HW099/ux02-regression`；`SHIPYARD_TEST_DATA_ROOT=(Resolve-Path '.cache/BG01/data-root').Path` |
| `npx.cmd playwright test tests/e2e/HW099_move.spec.ts --config=playwright.ux02-regression.config.ts` | 0；最终1/1，输出根 `.cache/HW099/final-bounded-ui-corrected` |

15项及11项使用 `index-RshCjoYk.js`，最后仅补 `display:block` 使高度限制生效；最终 `index-D2qmJKRG.js` 单项重新完成全部HW099闭环，横幅61px≤6rem78px，错误出现/关闭前后画布bbox与相机数值相同。测试写临时副本/OPFS，未替代系统原生权限对话框手工验收。没有全量重跑历史所有测试或所有节点/道路编辑。

失败过程保留在 `.cache/HW099`：初次基线取证对隐藏错误的定位断言失败，后续主动展开检查确认根因；新增测试曾有多边形元组类型错误，复用现有 transformPolygon 修正；最终测量器曾误找不存在的子span而超时，改为测实际提示容器后通过。工具审批服务多次因容量故障拒绝执行命令，未执行的不计测试结果。此前失败回执未覆盖。

主代理实现并整合；`save_default_tests` 独立审计与浏览器测试；`save_default_review` 分别完成正确性、Ponytail及有界拒绝原因复核。正确性审查发现的提示盒高度问题已修复。结论：拒绝反馈缺陷已修复，HW099受支持移动闭环通过；公共节点/复杂接入等限制如实保留。大范围入口重接、折点接入段联动不在本批新实现范围，不宣称全部对象均可任意移动。
