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

分工：dependencies负责A核心并独立审查UI，ui负责UI并独立审查核心/输入验收及Ponytail冗余，inputs负责18图冻结与实际验收；控制器整合、修正旧断言和裁决。GA01-B 尚未实施，下一提交独立记录。
