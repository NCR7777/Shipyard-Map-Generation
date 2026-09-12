# GA01 固定坐标框架与有限局部编辑

## 输入和边界

基线 `35c57111572b398d773e049aca8bde288d1243d9`，当时发布地图 `a30a1d1a519f88502af05e5a0f2ade9e8f4d11e2`。按项目 Ponytail full/review 执行，保留已有论文修改、ZIP 删除和未跟踪附件。地图 Schema、依赖锁文件未变。

验收输入为九套 V01 和九套 V02，共18份。冻结路径、SHA256、语义摘要和完整 coordinateFrame 见 `tests/helpers/GA01_targets.ts`；复验入口为 `scripts/GA01-matrix.ts`。威海两版同 mapId，按路径及文件摘要分别识别。测试使用内存/浏览器独立工程或临时副本，原件字节 SHA 前后复核。原图、外层 projects、调度输入及日志不随代码发布。

## GA01-A

- 仅解除 geographicAnchor 全图门禁；未知扩展、底图、资产、不支持的 planning 及原 commandSupport 继续保护。
- 普通事务提交前精确比较整个 coordinateFrame，拒绝 `COORDINATE_FRAME_LOCKED`；不提供重配准或框架编辑命令。
- 实际改变的节点坐标、道路折点、边界及受支持静态槽位字段，原子记录 `design_assumption` 字段来源。保留原始来源/总体类别；无变化、失败、取消不创建来源。既有基础图复制也标记实际偏移字段。仅派生长度变化的道路不标成重新描绘。
- 界面显示锁定框架说明和字段来源。同工程重载、恢复重试及关联文件重载遇框架变化时明确确认；候选过期/被修改/存储已变拒绝，取消保留原历史与关联基线。新工程独立建立基线。
- 真实几何验收采用每图无依赖设施的边界缩小0.1%，不是名称修改。静态槽位所有者依旧按原维护规则拒绝；点路局部放行属于后续 GA01-B。

独立正确性审查发现并修复：Tab/Enter 被确认框错误取消、点击最近列表当前工程可能丢失尚未保存编辑、既有复制后来源遗漏。Ponytail 冗余审查独立进行，结论 `Lean already. Ship.`；未引入新框架、运行依赖、空间引擎或第二套保存队列。

## 复现

PowerShell 7，Node 22.18.0，npm 10.9.3；使用仓库现有锁定依赖，无需重装时不运行 npm ci。新环境先 `npm ci`。

```powershell
# 两个根均包含 projects 子目录；缺失/摘要不符返回 blocked_input，不重建替代原件。
$env:GA01_DATA_ROOT='完整18地图的数据根目录'
$env:SHIPYARD_TEST_DATA_ROOT='历史冻结SR03及SHI等测试数据根目录'
$env:GA01_PHASE='A'
npm run schema:check
npm run typecheck
npm run lint
npm run test
npm run test:integration
npm run build
npm run test:e2e
npm run test:production
npx playwright test -c playwright.ga01.config.ts
npx tsx scripts/GA01-matrix.ts
npm run map:validate -- <真实地图或字节一致副本路径>
npm run map:diagnose -- <真实地图或字节一致副本路径>
```

诊断退出0只表示报告生成成功，不表示无冲突、净空安全或可直接投产。任何地图几何编辑改变内容摘要，旧场景/仿真绑定不会被自动认可。

## 已知限制

- 旧 SR02 四份原件缺失，单元和集成各4项明确 blocked_input；不把全套历史回归写成通过。
- 恒力V02、巨济V02厂界含 -0；既有JSON序列化为0。往返采用现有 sameValue 精确数值相等（仅 -0 与0等价），不使用误差容限或坐标舍入；原文件仍严格校验字节SHA。
- 坐标锚点锁定不等于地理准确性已认证。物理未知值、场地通行、车辆扫掠及现场安全仍需独立依据。
- 18图静态内容联动未发现现有安全规则可放行的槽位所有者；操作矩阵如实保留拒绝。未开展复杂依赖重写、GIS重新配准、调度、3D/VR或新性能改造。
- 浏览器关联文件测试使用真实OPFS文件句柄，模拟选择器授权入口；未验证操作系统权限弹窗。DP1既有未达性能预算不因本批功能测试通过而改判。

## 阶段回执

GA01-A 控制器裁决：限定范围通过。独立审查的真实阻塞已修复；旧 SR02 缺件单独 blocked_input，不宣称全套历史输入齐全。

| 实际检查 | 退出码 | 结果 |
|---|---:|---|
| baseline schema/type/lint/build | 0 | 旧 HEAD 独立归档 |
| baseline unit / integration | 1 / 1 | 474 / 45通过，各4项SR02缺件 |
| baseline E2E / production | 0 / 0 | 102 / 6通过 |
| A schema/type/lint/build | 0 | 最终相关源检查 |
| A unit / integration | 1 / 1 | 493 / 63通过，各4项SR02缺件 |
| A 全量 E2E 首轮 | 1 | 118通过，6项旧来源期望失败 |
| A 矩形、基础复制等定向重跑 | 0 | 26通过，保留原几何断言 |
| A P1 联动定向重跑 | 0 | 12通过，关闭剩余旧来源期望失败 |
| A SR03 production | 0 | 6通过 |
| A 18图加强保存断言 production | 0 | 19通过，含大型图100步预览单事务 |
| A 最后基础复制引用修复后 production smoke | 0 | 中集V01完整闭环1通过 |
| baseline及A每图validate / diagnose | 全0 | 各18+18，共72条CLI |

完整操作表 `GA01_A_operations.csv`：393次独立实际apply（72几何、18名称、18no-op、285拒绝）加3条无槽位不适用。主生产每图Ctrl+S storageVersion 2→3、按钮保存3→4，检查点JSON精确一致。

机器回执与源码SHA见 `GA01_A_receipts.json`。18图生产构建早于最后一处**仅基础图复制**新引用补齐；最终补丁已重跑复制单元、基础复制/矩形浏览器和新构建真实地图冒烟，18图高级复制仍拒绝。这里区分测试构建，不把旧构建截图冒充最后补丁构建。

本地完整日志、截图、导出副本和轨迹位于 `.cache/GA01/`，不向远程上传地图副本。失败过程包含两图-0比较、端口占用、旧来源期望和一次TS类型推断错误，均保留日志；修复后的相关检查见上表。

分工：dependencies负责A核心并独立审查UI，ui负责UI并独立审查核心/输入验收及Ponytail冗余，inputs负责18图冻结与实际验收；控制器整合、修正旧断言和裁决。GA01-A 本地提交：`05b0eae677e19263240057a2f84c446e66d3c061`。GA01-B 在此提交后独立实施。


## GA01-B 实现和操作范围

B仅放行通过依赖检查的局部XY点路操作；整个coordinateFrame继续固定。普通高级图点路旋转、新增、复制、删除和拆路未扩容。独立道路带/登记长度、路口边界、独立转向路径、内部到达路径、槽位所有者及入口服务节点，没有维护规则时保留具体拒绝与JSON Pointer。

道路内部折点只影响该道路及实际依赖；端点用于查找路口，不作为移动节点。新增影响集合包括无movement路口、转向、入口/内部服务路径、owner、槽位、覆盖区、资源。纯ID引用本身不拒绝；间接影响的锁定对象也能阻止整笔提交。

空间检查只在候选事务提交边界执行，复用P2A几何谓词与预算：变化道路对全部明确禁区，变化禁区对相关道路；变化的owner/槽位/服务关系做包含与正面积重叠检查。保持原关系的旧冲突不阻断；本次改变关系中的确定性冲突必须清除。来源或名称变化不触发几何检查。未知宽度、非平面条件、proxy未确认等显示warning；预算耗尽或报告截断返回 `SPATIAL_EDIT_INCOMPLETE`，不按成功处理。不写回资源容量或旧分析结果。

`GA01_B_operations.csv`记录416条逐图操作结果（413次实际apply及3条无槽位不适用），不能把18图闭环通过理解为全操作解锁：

| 操作代表 | 实际结果（18图） |
|---|---|
| 节点XY数值/平移、道路折点 | 各18笔成功 |
| 道路整段平移 | 17成功；恒力V02因相邻内部道路owner依赖拒绝 |
| 宽度、限高、限载、速度显式假设参数 | 各18笔成功；参数仅为隔离验收假设 |
| 无依赖设施/区域边界 | 各18笔成功；原安全平移旋转保持 |
| 本次双向改单向的方向探针 | 18笔 `ARC_DIRECTION_CONFLICT`，未删改原转向 |
| 普通点路旋转、新增、复制、删除、拆路 | 继续拒绝 |
| 槽位所有者静态内容平移 | 15图代表拒绝；3图无槽位；全体owner检查无额外放行 |

巨济V01原探针 `N_GJ_98578c20a5 / R_GJ_f5b5b6d617` 在本次改变关系中触发 `SPATIAL_ROAD_FORBIDDEN`（`zones/Z_GJ002`），节点和折点两条拒绝保留在最终矩阵。另在同一原图选择 `N_GJ_4e23f596d3 / R_GJ_8241f9b21f` 做安全编辑验收；原件和禁区完全不改。旧全图诊断并不保证完整展示所有候选，不能用其未展示某条冲突否定局部精查。

B18图每份依次真实编辑节点、非共线折点、宽度和速度；三笔分别验证一次撤销/重做、精确值、来源和其余声明不变，再对累计结果检查自动保存、CtrlS、按钮检查点、刷新与JSON重导入。真实韩华V02另以100步拖动精确1m，验证一笔事务；锁定路口/资源后实际提交数值表单，`LOCKED_DEPENDENCY`且地图及历史不变。

正确性独立审查修复：未知道路宽度不可用中心线包围盒提前排除；局部新放行仅XY；无movement道路端点路口和覆盖区资源纳入依赖。最终正确性审查无阻塞。Ponytail冗余审查另行完成，结论 `Lean already. Ship.`。

## GA01-B 最终验收与裁决

| 实际命令 | 退出码 | 结果 |
|---|---:|---|
| `npm run schema:check` / `npm run typecheck` / `npm run lint` / `npm run build` | 均0 | 最终产品源码 |
| `npm run test` | 1 | 522通过；4项缺SR02原件，blocked_input |
| `npm run test:integration` | 1 | 63通过；4项缺SR02原件，blocked_input |
| `npm run test:e2e` 首轮 | 1 | 123通过，1项旧服务包含期望失败 |
| `npx playwright test -c .cache/GA01/ui.playwright.config.ts M2A1_serviceTargets.spec.ts` | 0 | 修正合同断言后整文件7通过，18.5秒 |
| `npm run test:production` | 0 | SR03生产回归6通过 |
| `GA01_PHASE=B` 下 `npx playwright test -c playwright.ga01.config.ts` | 0 | 真实18图生产闭环18通过，340.865秒 |
| `npx playwright test -c .cache/GA01/ui.playwright.config.ts GA01_local.spec.ts` | 0 | 韩华V02真实100步拖动及间接锁定1通过 |
| `npm run map:validate -- <map>` / `npm run map:diagnose -- <map>` | 全0 | 最终UI编辑结果18+18条，报告摘要与导出结果一致 |

首轮失败用例将owner边界外的服务点改成explicit_internal，旧期望成功与本批确定性包含保护冲突。仅修正测试：先验证拒绝且地图/历史不变，再通过真实UI扩大owner边界，最后保留50m连续内部路径和禁方向反例。未更改产品来绕过保护；未把首轮全量E2E退出1改写为0。该文件完整重跑7项通过，最终类型和lint复核通过。

18份原件最终字节SHA再次核对全部一致。B源码与18图生产测试构建一致；机器回执 `GA01_B_receipts.json` 记录源码及构建SHA。完整本地轨迹、截图、导出、保存版本与CLI回执在 `.cache/GA01/`，不发布原图或测试数据副本。

GA01-B控制器裁决：**限定范围通过**。18份主验收全部完成；历史SR02缺件仍blocked_input。几何可编辑不等于坐标精度、道路安全或调度可行性认证，矩阵中的依赖拒绝和未知状态保留。正确性审查与Ponytail冗余审查分别完成，无剩余实现阻塞。

B复现时先设置 `$env:GA01_PHASE='B'`。独立UI测试可用已提交基础配置执行 `npx playwright test tests/e2e/M2A1_serviceTargets.spec.ts tests/e2e/GA01_local.spec.ts`；本次4193端口的隔离配置只存本地证据目录。生产18图配置已提交；两类数据根与A相同。

GA01-A地图独立提交为 `0ae0616c03dfc3a0c6d93f44bf727536db508915`。B随后单独提交，按map子树生成发布提交并核验祖先关系，仅以快进方式更新指定地图仓库main；论文、调度、外层projects、原地图与任务附件均排除。提交及远程最终SHA由交付回复记录。本批止于GA01，不进入其他开发阶段。
