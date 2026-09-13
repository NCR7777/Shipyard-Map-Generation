# MQ01 交付与复现说明

本批使用用户确认的 `projects/Map_Refinement_20260912/*_v02/map.json` 九图，全部另存，保留原 `mapId`、完整 `coordinateFrame` 和旧场景/运行绑定。任务书实际位置为本目录 `MQ01_MAP_AUDIT_REPAIR_TASK.md`。四处疑似重复通道按用户后续确认留待下一批。

## 结果与边界

| 工作图 | 节点前→后 | 道路前→后 | 本批实改 |
|---|---:|---:|---|
| 中集来福士 cimc | 94→94 | 98→98 | 水域边界移除 1 个严格共线顶点 |
| 大连 dalian | 79→79 | 81→81 | 无满足证据和语义保护的确定修复，保留几何 |
| 三星巨济 geoje | 141→141 | 145→145 | 保留几何及未声明掉头条件 |
| 韩华 hanwha | 400→386 | 428→414 | 14 笔二度节点抑制 |
| 沪东 hudong | 170→162 | 179→171 | 8 笔二度节点抑制 |
| 新时代 newtimes | 248→238 | 260→250 | 10 笔二度节点抑制 |
| 三湖 samho | 238→237 | 250→249 | 1 笔二度节点抑制 |
| 威海 weihai | 157→157 | 168→168 | 保留孔洞，清理区域 2 点、厂界 2 点 |
| 新扬子 xinyangzi | 90→89 | 88→87 | 删除无业务引用的 6.736518827m 末端支路及依赖转向 |

共 37 笔领域命令事务：33 笔道路表示清理、3 笔边界清理、1 笔 B 类研究模型修正。必要道路弯折保留为 shapePoints，不把道路强行拉直。新扬子删除支路的原完整道路带与声明水域重叠 11.342358238㎡；原中心线未进入水域。该修正是影像约束、无业务用途末端的研究简化，不是测绘认证。

九图全部设施、区域面积、资源容量、入口和服务点原声明不变。共有 27,510 个业务服务点有向组合；共同局部候选 OD 也完成两种条件的全量对比。业务 OD 可达状态和最短长度保持（最大数值差 1.819e-12m）。韩华 3 对、沪东 1 对 OD 改选了原本合法的等长路径，因此实际择路资源序列可变；没有把这种变化写成全部原路径不变。独立审计把新弧展开回原道路，核对相同路径的许可和资源序列。

大连原有 100/702、新扬子原有 532/1,056 个服务 OD 跨分量断开。大连 25＋2 个服务点、新扬子 19＋14 个服务点各组成两个分量，分量内部全部声明可达；当前只能分别研究子图，跨分量运输不可用。大连裁片间缺影像覆盖，新扬子最近公共端点直连会穿建筑，不能从影像虚构运营连接。巨济 13 对服务 OD 的方向候选与声明转向最短路存在绕行差异，涉及同一未声明掉头，未自动放开。

## 明确保留和未检查

- 沪东两簇、三湖一簇涉及独立独占路口资源；大连一簇涉及 10m/14m 宽度和不同设施接入。用户已明确本批保留，单列下一批。影像疑似同路不等于可自动统一容量或入口。
- 近邻/短边/平行清单是候选，不是已确认错误数量；合法业务点、属性变化、资源边界和不能维护的依赖保持。逐条记录定位、证据和拒绝/未确认原因。
- 207 条道路缺确定宽度，完整道路带检查为 not_checked；不填默认宽度。净空、承载、扫掠、执行资源容量和现场通行未获认证。
- node_proxy 边界交接及 explicit_internal 通道按原声明解释。道路端帽或侧楔触及建筑时不挖屋顶、不缩宽度；不把语义代理解释为实体建筑可穿越。
- 原始 GeoTIFF 未找到。八厂现有校准 JPEG 的变换及数值一致性已复核，时相/绝对精度未知。威海无独立校准影像，仅提供清楚标注的矢量前后图。
- 两轮全图几何/语义/路线复查记录一致，再跑自动修复零变更；这证明本批结果稳定，不证明全部物理条件已确认。

## 最小源码增量

复用现有 loadMap、commands、suppressDegree2Node、事务、来源、planning、serviceConnections 和 pathPreview。新增仅用于本批的受控 corridor 元数据等价策略、无参数厂界共线清理和准备一次的批量路径查询。未改地图 Schema、未新增运行依赖、未重构 UI。

`MQ01_core.ts` 计划绑定原文件 SHA、语义 contentHash、保护 sidecar、预期结果；apply 重新核对候选、完整坐标框架、锁文件和最终输入。输出目录必须不存在。命令拒绝、不变更、过期候选和中途锁变化均不产生修复副本。来源记录和修复同时撤销。

离线 `MQ01_scan.py` 使用环境中已有 Shapely 完整枚举候选及已声明空间关系，补足编辑器有限预算诊断；它不修改地图，不用其候选直接建连接。`MQ01_routes.ts` 复用仓库路径算法，方向候选明确忽略转向许可且不能当作许可路线。`MQ01_exports.py` 复用冻结旧 compile_graph 的纯函数，补充完整声明/折点/未知状态，重投影输出 GeoJSON；绑定模板的 scenario/plan/runtime 均为空，未运行调度器。

## 文件使用

各厂独立 ZIP 位于工作区 `projects/MQ01_Repair_20260913/`。解压后在编辑器选择根 `map.json` 导入为新工程；ZIP 是交付容器，未增加编辑器 ZIP 导入功能。`baseline/` 和浏览器回归导出的微调图是证据，不是当前交付地图。

每厂附修复台账、逐项裁决、ID 沿革、前后指标、匹配新摘要的 graph/OD/GeoJSON/binding、带完整宽度的同尺度影像、测试和审查回执。清单保存实际成员 SHA；封包后逐成员与目录实物比较。旧 scenario/plan/runtime 不自动换绑。

## 复现命令

在 `paper01/map`、当前受测源码工作树执行。Node 22.18.0、npm 10.9.3；Python 3.11.15（paper），Shapely 2.1.2、pyproj 3.7.2、Pillow 12.2.0、NumPy 2.4.4、NetworkX 3.6.1。npm 精确版本以实际回执为准，未重新安装依赖。

```powershell
npm.cmd run schema:check
npm.cmd run typecheck
npm.cmd run lint
$env:SHIPYARD_TEST_DATA_ROOT = (Resolve-Path '.cache/GA01/data-root').Path
npm.cmd run test
npm.cmd run test:integration
npm.cmd run build
# INPUT 是解压工程 map.json；每个 NEW_* 路径必须不存在，父目录需存在。
node --import tsx scripts/MQ01_core.ts scan INPUT NEW_SCAN
python -B -X utf8 scripts/MQ01_scan.py NEW_SCAN/map.json --core-report NEW_SCAN/core-report.json --out NEW_INVENTORY.json
node --import tsx scripts/MQ01_routes.ts NEW_SCAN/map.json NEW_ROUTES.json --inventory NEW_INVENTORY.json
python -B -X utf8 scripts/MQ01_exports.py NEW_SCAN/map.json NEW_SCAN/core-report.json NEW_DERIVED
node --import tsx scripts/MQ01_core.ts plan INPUT NEW_PLAN command-evidence.json
node --import tsx scripts/MQ01_core.ts apply INPUT NEW_APPLIED NEW_PLAN/plan.json
node --import tsx scripts/MQ01_simplify.ts INPUT NEW_A_COPY
npm.cmd run map:validate -- INPUT
npm.cmd run map:diagnose -- INPUT
python -B -X utf8 scripts/MQ01_scan_test.py
python -B -X utf8 -m unittest discover -s tests/python -p test_MQ01_exports.py
```

CLI diagnose 退出 0 仅表示报告生成，partial/not_checked/conflict 仍需阅读。新几何扫描拒绝 normalizedFileSha256 不匹配的地图，不能将旧扫描换 hash 充当新结果。默认自动 A 清理不替用户选择 C 类资源/通道模型。

浏览器本批实际命令与完整路径、SHA 在 `checks/testing-summary.json` 和浏览器回执。生产构建 `index-VfSdtWEX.js`；截图、轨迹和微调 JSON 对应该包，不能只凭 Git HEAD 对应未提交源码。

## 验证与审查

详细命令、退出码和数量见交付 `checks/testing-summary.json`。本批生产九图 9/9；Schema、类型、lint、build 退出 0。受影响旧生产浏览器回归 140/140、退出 0；本批九图另 9/9，共 149 项。最终单元 590 通过、4 因冻结 SR02 缺件失败；集成 86 通过、4 同因缺件失败，均退出 1。未替换或跳过缺件来声称历史测试全通过。Python 扫描 7/7、导出 4/4。

正确性与 Ponytail 冗余审查独立完成。正确性修复了发布前保护文件重读及威海已声明 `E,N,Z` 顺序兼容；Ponytail 结论为 `Lean already. Ship.`。原工程编辑代码、冻结地图和外部绑定保护核对见回执；没有自动推送或改写旧实验结果。
