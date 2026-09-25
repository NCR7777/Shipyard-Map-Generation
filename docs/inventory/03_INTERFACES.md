# 旧版持久化与对外接口，以及 Python 端如何使用地图（2026-09-24 盘点）

用途：P4（工程与文件）与 P5（对外接口）的依据。路径前缀：MAP = `paper01/map`，WS = `paper01`，PRJ = 工作区 `projects/`。只读盘点。

## 0. 结论

- 编辑器的权威数据只有 map.json（读写 0.1.0/0.2.0/0.3.0，写出保持原版本）。其余都是派生物：compiled-map、SceneSnapshot、路径预览、诊断报告，都用 mapContentHash 绑定地图；mapContentHash 是去掉 revision 后规范化 JSON 的 SHA-256，文件字节摘要另称 fileSha256。
- 浏览器持久化：IndexedDB 库 `shipyard-map-projects` v3，5 个 store；升级只建缺失的 store，无记录级迁移；工程记录 formatVersion 1。
- 本地文件用 File System Access 选择器，句柄经结构化克隆存 IndexedDB（没有 OPFS 存储；OPFS 只出现在测试模拟里）。
- 已实现的交换格式：compiled-map（protocolVersion 1.0，compilerVersion FAST01.1，profile declared-network-v1）、Codex 补标 ZIP（manifest 1.0）、semantic_patch 1.0、BG01 底图校准文档、FAST01 结果协议 1.0（scenario、plan、events.jsonl、summary 四个文件，只导入回放）。
- 仿真适配接口 SimulationAdapter 与 RuntimeStateMessage 0.1.0 只有类型定义，代码中注明 contract only。
- Python 端只有两处读编辑器 map.json，且都只认 0.2.0 加折线道路：`WS/scheduling/I1_*`（调 Node 版 loadMap，交给固定 SHA 的 SR03 执行器）与 `MAP/scripts/MQ01_exports.py`（调遗留 analyze_map.py）。SR03 执行器目录与 I1 交付目录都不在工作区，I1 当前会 blocked_input。
- 论文主线（VISTA benchmark/mechanism、vista_oe_v41、R1 数据代码、v1 数据管线、research_redesign）完全不读编辑器输出，都从数据集 CSV（road_network.csv、site_nodes.csv、area_capacity.csv 等）自建有向图，heapq Dijkstra，自写事件堆仿真；paper01 内没有 simpy 与 networkx（networkx 只在 PRJ 的 analyze_map.py 中）。

## A. 编辑器的持久化与集成面

### A1 IndexedDB 工程库（MAP/src/adapters/projectStore.ts）

`indexedDB.open('shipyard-map-projects', 3)`（17、23 行）。store：projects（keyPath projectId，StoredProject）；metadata（固定键 lastProjectId）；editorStates（外键 projectId，经 validateEditorState 校验）；assetBlobs（keyPath [projectId, sha256]，sha256 索引，`{projectId, sha256, mimeType, width, height, bytes}`）；localFileBindings（外键 projectId，`{handle, contentHash, rawHash}`）。版本史：v1 三个 store，v2 加 assetBlobs，v3 加 localFileBindings。onupgradeneeded 只建缺失 store，onblocked 报 PROJECT_STORAGE_BLOCKED，onversionchange 关闭连接。CAS：commit 要求新 storageVersion = 期望 + 1，同一 readwrite 事务读比较写，版本不符 PROJECT_CONFLICT，只有 oncomplete 才算成功。底图字节写入前用 rasterBytes 重算 SHA、尺寸、MIME；读取时本工程没有则按 SHA 从其他工程复用并复制。

### A2 工程控制器（MAP/src/editor/projectController.ts）

StoredProject（85–95）：formatVersion 1、projectId、name、storageVersion（与 map.revision 无关）、createdAt、updatedAt，三个快照 draft / checkpoint / previousCheckpoint（`{mapJson 规范全文, contentHash, savedAt} | null`）。save(map, kind)（393–431）：调用时先捕获地图 A 再入串行队列；draft 只换 draft；checkpoint 同时换 draft 与 checkpoint，原 checkpoint 移到 previousCheckpoint；地图提交后再写 lastProjectId 与 editorState，失败报 PROJECT_AUX_SAVE_FAILED 但不回滚地图。recover（280–308）按 draft → checkpoint → previousCheckpoint 取第一个能 loadMap 且哈希一致的快照，损坏只警告。prepareOpen / acceptOpen（311–348）用 navigation 计数防过期；create 不写库；backup 写独立恢复副本；checkExternalVersion 比较 storageVersion，只报冲突不替换内存地图。EditorState `{camera, drawing, workbench?, backgrounds?, propertyUnits?}`，validateEditorState 拒绝未知字段并兼容旧的 camera-only 与 drawing.showLabels。DrawingConfig（12–34，默认 35–42）：hidden/lockedTypes、labelMode、objectSearch、snapGrid 0/1/5/10、snapNodes、roadWidthM 12、roadDirection、connectNewCrossings、道路显示开关、三种填充透明度、分类 ID、facilityKind/zoneKind、两种移动策略。BackgroundPreferences、PropertyUnits（默认 t / km/h / deg），WorkbenchPreferences（editor/workbench.ts:1-33，saveTarget 为遗留字段）。

### A3 工作区 hook（MAP/src/ui/useProjectWorkspace.ts）

首选工程：sessionStorage `shipyard.activeProjectId` → metadata lastProjectId → `create('project_'+UUID)`。地图哈希与已存草稿不同时 600ms 防抖存草稿，编辑状态另 600ms；窗口获焦检查其他标签页。显式保存 / Ctrl+S = persist('checkpoint')（先编辑状态后地图）；切换、新建、打开前自动 checkpoint。恢复失败进入隔离，写入暂停；「仅内存继续」；界面地图与编辑状态与恢复目标一致后才重新允许写入。

### A4 本地文件（MAP/src/adapters/localFiles.ts、files.ts）

showOpenFilePicker / showSaveFilePicker，只接受 .json，另存建议名 `${mapId}.map.json`。LocalFileBinding `{handle, contentHash, rawHash}`；App 恢复关联（App.tsx:221-224）与写入关联（545），升级 schema 后解除关联（412）。open 返回 token，acceptOpen 后才关联；check 只查权限不弹窗、比较 rawHash；write 先读回，rawHash 变了返回冲突 token，只有带同一 token 且文件 rawHash 未再变、外部文件本身能 loadMap 时才覆盖；saveAs 目标已有无效内容时拒绝。上限 10 MiB。普通导入 readJsonFile，导出 downloadMap（文件名 `${mapId}-r${revision}-${ISO时间}-${uuid8}.map.json`）。

### A5 底图（rasterFiles.ts、backgroundCalibration.ts、useBackgroundAssets.ts）

只接受 PNG/JPEG/WebP，≤ 32 MiB、≤ 2400 万像素，拒绝动画与非标准 EXIF 旋转。地图只存引用（assets、backgroundLayers）。校准文档 `BG01_background_calibration_v1`：`{format, image{sha256, widthPx, heightPx}, coordinateFrame(须与地图完全一致), pixelConvention 'pixel_corner_top_left_x_right_y_down', imageToWorld[a..f], sourceEvidence[{name, sha256, jsonPath}], controlPoints?}`，另兼容 manifest 与 register 两种旧 georeference 链；生产者 `MAP/scripts/BG01_prepare_raster.py`（同时输出 BG01_raster_preparation_receipt_v1）。

### A6 Codex 补标包（codexPackage.ts、storedZip.ts）

buildCodexPackage 生成不压缩 ZIP（≤ 256 MiB），文件名 `${mapId}-${hash前10位}-codex.zip`；条目 map.json、compiled-map.json、sources.json、drawing-defaults.json（`{profile 'quick_trace_v1', drawing, source 'design_assumption'}`）、assets/*、overview/<layer>.png、calibration/<layer>.json、crops/<layer>/<entity>.raw.png 与 .outline.png、unclassified.json、semantic_patch.template.json、README.txt、manifest.json（formatVersion '1.0'、mapId、baseMapContentHash、coordinateFrame、classificationScope、assets、crops、unclassified、missing、files[{path, byteLength, fileSha256}]）。消费方为外部 Codex/LLM，回传 semantic_patch（说明见 MAP/docs/FAST01_EXCHANGE.md）。

### A7 适配器契约（contracts.ts）

SceneSnapshot（14–28，compiler/scene.ts 生成，渲染器使用）；RuntimeStateMessage（30–42，protocolVersion '0.1.0'：mapId、mapContentHash、scenarioId、scenarioVersion、entityId、sequence、simulationTime、occurredAt、observedAt、pose{position, yawRad}，示例 MAP/examples/M1_simulation_message.fixture.json）；SimulationInput（50–58）；SimulationAdapter / RenderAdapter（61–72，contract only）。

### A8 与调度直接相关的地图字段

PhysicalValue；MapNode；MapRoad（方向、四个物理值、observedLengthM?、corridorPolygon?、resourceIds、几何）；Junction / Movement（转向限制）；ServicePoint（kind、nodeId、归属、arrival）；Facility / AccessPoint / Zone（passability）/ Resource（capacityUnit、capacity、controlModel、appliesTo）；扩展 sr02.planning（储位与停车槽位、道路 role/owner、路口转向空间、服务点能力）、org.shipyard.spatial_classification、org.shipyard.fast_trace.semantic。详见 02_DOMAIN.md。

### A9 编译器（compiler/routing.ts、scene.ts、catalog.ts）

版本：COMPILER_VERSION 'FAST01.1'，COMPILE_PROFILE 'declared-network-v1'，GEOMETRY_TOLERANCE_VERSION 'world-metre-0.01-1e-4-flat0.05-v1'。CompiledMap（20–30）：protocolVersion '1.0'、mapId、mapContentHash、compilerVersion、geometryToleranceVersion、profile、units{m, s}；原样透传 extensionNamespaces、extensions、facilities、zones、sources、coordinateFrame、nodes、movements、junctions、resources、servicePoints、accessPoints；新增 routingStatus 'declared'|'unsupported_extensions'、`arcs: Record<'roadId:forward|backward', CompiledArc>`、serviceConnections、warnings。CompiledArc（12–19）：id、roadId、direction、fromNodeId、toNodeId、allowed（true/false/null，方向 unknown 或有未支持扩展时 null）、path、lengthM、lengthErrorM、samples、spatialErrorM、ownerEntityId、provenance、extensions?、corridorPolygon?、四个物理值原样、resourceIds。先 validate，不合法抛错；每条道路固定两个方向弧；unknown 物理值只写 warnings。不输出：名义行驶时间、邻接表、允许/禁止转向列表、资源 appliesTo 反向索引、槽位解析表。ServiceConnectionSummary（serviceConnections.ts:6-17）。sceneCatalog 为纯派生目录。

### A10 路径预览（topology/pathPreview.ts）

端点 `{kind servicePoints|accessPoints|nodes, id}`，模式 declared 或 direction_only；报告 mode、complete、mapId、mapContentHash、from、to、status（found/unconfirmed/disconnected/not_checked）、confirmed 与 candidate（`{arcs, lengthM, points, assumptions}`）、issues、assumptions、unchecked（7 项，含资源执行、物理净空、车辆扫掠）。带入弧状态的 O(A²) Dijkstra，按中心线长度；上限 4000 弧、100 万步；遵守方向、转向、owner、explicit_internal 后缀；拒绝多节点路口与带独立几何的转向。使用者：map:diagnose、checkResearchInput、MQ01_routes.ts。

### A11 外部调度结果导入与回放（domain/results.ts、ui/ResultsPanel.tsx；MAP/docs/FAST01_RESULTS_CONTRACT.md 未纳入 git）

RunBinding：protocolVersion '1.0'、runId、mapId、mapContentHash、scenarioId、scenarioHash、compilerVersion（须为 'FAST01.1'）。scenario.json：protocolVersion、scenarioId、units、vehicles[{id, name?}]、tasks[{id, name?, originNodeId?, destinationNodeId?, dueS?}]、timeWindow、assumptions、parameters?；scenarioHash 为递归排序紧凑 JSON 的 SHA-256。plan.json：绑定字段、source synthetic|external、name?、activities（travel{roadId, direction, s0M, s1M} 或 wait|load|unload{nodeId}，带 vehicleId、t0、t1、taskId?）；使用的弧须 allowed === true 且不是内部 owner 道路；经过显式禁转拒绝，未声明转向警告。events.jsonl：绑定字段、entityType 'vehicle'、entityId、seq、simTimeS、state travel|wait|load|unload|idle，位置三选一（nodeId；roadId+direction+sM；position+yawRad?），道路里程与坐标并存须声明 poseAuthority；最多 100000 行。summary.json：metrics[{key, value|null, unit, definition, window, source}]。compareSummaries 做 A/B；makeSyntheticRunFiles 生成合成示例包。当前地图哈希与绑定不一致时停止叠加；导入顺序 scenario → plan → events/summary。目前没有 Python 程序按此协议输出。

### A12 研究输入提案（semanticPatch.ts、researchAccess.ts，界面 CompletionPanel.tsx）

语义补丁与研究接入格式见 02_DOMAIN.md 2.9；模板 MAP/docs/examples/semantic_patch.template.json。ResearchInputReport 级别 spatial/routing/scheduling；scheduling 级别总会加 RESEARCH_SCENARIO_REQUIRED 警告，因此永远不会 ready。

### A13 命令行与脚本

| 命令 | 输入 | 输出 | 说明 |
|---|---|---|---|
| map:diagnose | map.json，可选 --from/--to | stdout `{diagnostics, path?}`（diagnostics：mapId、mapContentHash、rulesVersion 'P2A-1'、status、issues、checks） | 0 只表示报告已生成，不是可用性判定；1/2 输入错误 |
| map:validate | map.json [--profile draft] | ValidationReport + mapId、mapContentHash、capabilities | 0 通过、1 不合法、2 参数/IO、3 不支持；非 draft profile 一律 UNSUPPORTED_PROFILE |
| map:migrate | 旧文件、新文件（须不存在） | 新文件 + `{status, sourceFileSha256, sourceContentHash, targetContentHash, changes}` | 硬编码只升到 0.2.0 |
| map:compile | map.json [--out] [--profile] | CompiledMap（stdout 或不覆盖写文件） | 失败退出 1 |
| schema:generate/check | schemas/*.json | src/domain/model*.generated.ts | — |
| MQ01_core.ts scan|plan|apply | map.json、新目录，plan/apply 另需证据或计划 JSON；读旁路 editor-state.json、map-protection.json | map.json、core-report.json（MQ01_core_report_v1）、plan.json（MQ01_repair_plan_v1） | — |
| MQ01_routes.ts | map、新输出、可选 --inventory | MQ01_routes_v1（全部服务点对 × 两种模式） | — |
| MQ01_scan.py / MQ01_exports.py | map、core report、输出 | full inventory；transport_graph.json、features_wgs84.geojson、binding_template.json、export-receipt.json | MQ01_exports 只支持 0.2，依赖固定 SHA 的遗留 analyze_map.py |
| EA01_repair_access.ts | 输入根、输出根 | 修复后地图 + manifest（EA01_access_repair_v1） | 9 个厂输入 SHA 固定 |
| BG01_prepare_raster.py | --image --map --out --calibration|--georeference | 正规化图像、校准文档、receipt | — |

另有 MQ01_simplify.ts、MQ01_adjudicate.py、MQ01_imagery.py、GA01-matrix.ts、generate-M2A*-examples.ts、DP-*.mjs、BG01-display-performance.mjs、check-boundaries.mjs。

### A14 文档与代码不一致

M11_PERSISTENCE_CONTRACT.md 仍写数据库版本 1、snapNodes 默认 false、facilityKind 默认 workshop，代码实际为 v3、true、building；FAST01_RESULTS_CONTRACT.md、FAST01_SCHEMA_MIGRATION.md、docs/examples/ 未纳入 git；06_SCHEDULING_CONTRACT.md 中 MapRef/CompiledRef、三档发布配置、场景 pickup/dropoffServicePointId 均未实现。

## B. Python 研究工作区如何使用地图与路网

### B1 读编辑器 map.json 的模块

- `WS/scheduling/I1_core.ts`（Node 桥）：import 编辑器 loadMap 等；inspect 计算 mapContentHash 与 mapFileSha256，Ajv 校验场景，核对场景 mapBinding{mapId, mapContentHash, mapFileSha256}；强制 schemaVersion 0.2.0；槽位须为无孔矩形且边长与声明一致；move 子命令只批准 SR03_A 的 F_001 平移 5 m。
- `WS/scheduling/I1_profile.py`（SR03 执行器支持范围）：道路 shapePoints 须为空（0.3 会 KeyError 并按 I1_PROFILE_INPUT 拒绝），无 corridor，方向显式，四个物理值须为已知正数；movement 无 internalPath、不重复、不支持原路掉头；路口只能单节点 explicit_movements；服务点 arrival 须 explicit_internal；区域 passability 不能 unknown；资源：道路/转向/服务点使用的资源单位须 vehicle 且消费者在 appliesTo 内，路口资源须显式写进每个 allowed movement，area_m2 只归属储位 owner，停车位需专属资源；非直行转向需资源且路口有无孔边界。
- `WS/scheduling/I1_handoff.py`：按固定 SHA 加载 SR03 工具（`<data-root>/projects/shipyard_simulation_SR03/tools/SR03_validate.py`）；routes.json 为每件货物、每个相邻阶段、每辆车求 emptyApproach、loaded、emptyReturn 三段（`paths{sourceServiceId, targetServiceId, arcs[{roadId, direction, resourceIds, incomingMovement{movementId, resourceIds}}], sourceResourceIds, targetResourceIds, distanceM, freeFlowTimeS}`），目标为自由流时间；handoff.json `schemaVersion 'I1.handoff/1.0'`，单位 m/s/kg/rad，时间零点为场景 releaseTimeS；运行输出 report.json、network.json、events.jsonl、legs.csv、cargo_summary.csv、resource_usage.csv；SR03 场景 `sr02.scenario/1.0`（vehicles 尺寸自重载荷 homeServiceId；cargo 尺寸质量 releaseTimeS 与 stages[{servicePointId, storageResourceId, dwellS}]；assumptions 空载/载重速度、装卸时长、转向时长、安全余量、排队策略、maxDrainTimeS；experiments[{id, closedRoadIds, releaseScale}]；seed、mapBinding）。
- 遗留 `PRJ/Map_Refinement_20260912/tools/analyze_map.py`（各 *_v01/tools 有副本）：networkx、shapely、jsonschema；compile_graph 弧 ID `roadId__F/__B`；输出 transport_graph.json（`shipyard_transport_adapter_v1`，弧含 lengthM、nominalTravelTimeS、四项物理值、resourceIds、role、ownerEntityId，顶层 allowedTransitions、forbiddenTransitions、services、resources）、service_routes.json、od_distances.csv（sourceServicePointId, targetServicePointId, lengthM, nominalTravelTimeS, physicalFeasibility）、twin_bindings.json（`shipyard_twin_binding_template_v1`）；MQ01_exports.py 在此基础上算名义时间并生成允许/不支持转向列表。

### B2 论文主线（读数据集 CSV，不读编辑器输出）

| 模块 | 路网来源 | 字段与建图 |
|---|---|---|
| `WS/scripts/vista_benchmark/episodes.py:94-233`、`regime_episodes.py` 约 300–320 行 | R1 角色表 reference.roads/nodes/area_capacity/fleet/norms/cranes（`vista_mechanism/io.py:97-116`） | 道路 road_id、from_node、to_node、length_m、width_m、speed_limit_kmh、one_way → 有向边 `{edge_id 'road_id:f/r', length_m, physical_resource_id, capacity 1, width_proxy_m, speed_limit_kmh}`；接收点 `{receiver_id, slot_count, handling_servers, receive_open_min, closed_windows}`；车辆 capacity_t、width_m、home_node、max_speed_laden_kmh；装卸时长来自 norms |
| `vista_benchmark/engine.py:136-146, 270-287` | episode roads | 有向邻接 + Dijkstra，边权 length_m / min(车速, 限速) × 0.06（分钟）；width_proxy_m ≥ 货宽 + 余量才可走；按 physical_resource_id 容量加锁（per_edge 或 whole_route）；时钟分钟/tick |
| `vista_benchmark/public_context.py:42` | 同上 | 公开给策略的道路字段白名单 ROAD_FIELDS |
| `vista_mechanism/mechanism.py:75-120`（NominalRoadGraph） | R1 nodes/roads | node_id；one_way、width_m、length_m、speed_limit_kmh |
| `WS/shipyard_R1_modeling_data/code/common.py:30-59` | `data/YARD_*/reference/road_network.csv`、`site_nodes.csv` | width_m（+1.5 余量）、clearance_m、bearing_capacity_t_per_axle、length_m、one_way；节点 turning_radius_m；同目录 area_capacity、stations、crane_register、transport_control_rules、working_calendar、operation_norms |
| `WS/vista_oe_v41/src/vista_oe/data/P01_stores.py:40-52`、`P01_adapter.py` | `vista_oe_v41/data_raw/P00_received_ledger/data/YARD_*/reference/*.csv`（同目录 map.json 为 `shipyard-coarse-map/1.0`，非编辑器格式，P01 明确不用） | road_network：road_id、from/to_node、length_m、usable_width_m、clearance_m、approved_gross_t、max_grade_pct、road_class、one_way、speed_limit_kmh、traffic_resource_id；site_nodes：node_id、x_m、y_m、role、turning_pad_diameter_m；areas：area_id、role、gate_node_id、usable_area_m2、entry_width_m、entry_height_m、support_interface、capacity_basis、rect_json；storage_slots：slot_id、area_id、slot_length_m、slot_width_m、approved_block_mass_t、stacking_allowed、x_m、y_m；时间窗类表 working_calendar、dock_schedule、marine_transfer_windows、slot_access_notices |
| `WS/scripts/data_audit/ENG01_physical_audit.py:34-93`、`data_pipeline/common.py:38-53`、`v10/run_v10_research_pipeline.py:432-440`、`experiments/24_…`、`29_…` | `WS/data/raw/<10 个场景>/road_network.csv`、`capacity_segments.csv` | road_network：road_id、road_name、from/to_node、length_m、width_m、gradient_pct、ground_bearing_t_per_m2、turning_radius_m、clearance_height_m、passing_zones、num_lanes、speed_limit_kmh、source、confidence；capacity_segments 单位 tasks_per_hour 带 time_window；无节点坐标表 |
| `WS/research_redesign_20260907/R32_transport_pilot.py:28-95`（R33 同源） | `paper01_data/data/<场景>/04_道路资料.csv` 等中文表 | 道路编号、起终点编号、登记长度_m、可用宽度_m、限高_m、通行方向、限速_kmh；每经过中间节点加固定转向时间并占用 node: 资源；道路按路段独占预约；停用窗口来自 07_停用记录 |

### B3 PRJ 中由地图派生的网络与仿真输入（只列名称）

cimc_v01、hanwha_v01、hudong_v01、newtimes_v01、samho_v01、xinyangzi_v01（map.json；data/ 下 transport_graph.json、service_routes.json、od_distances.csv、route_examples.json、twin_bindings.json、features_wgs84.geojson、facility_register.csv；checks/；tools/analyze_map.py；schemas/map-0.2.schema.json）；Dalian、Geoje、Weihai 同类文件；MQ01_Repair_20260913/<9 个厂>（baseline、derived、checks、tools/legacy、<厂>_MQ01.zip、delivery-manifest.json）；Map_Refinement_20260912；EA01_Access_Repair_20260914；只含底图的 BG01_Background_Ready_20260914、TIF_可导入底图_20260915、9 个船厂米制底图 ZIP。缺失：shipyard_simulation_SR03、shipyard_scheduling_I1。

## C. 缺口与建议

### C1 事实性缺口

1. 格式不通：主线 Python 只读节点–边 CSV，编辑器只产出嵌套 JSON；没有表格导出，也没有 Python 读取器。
2. 版本断层：编辑器写 0.3.0（anchors/spans 曲线），I1/SR03、MQ01_exports、analyze_map 只认 0.2.0 + shapePoints（SR03 还要求无折点）；map:migrate 只能升到 0.2.0，0.3 没有降级导出。
3. Python 不能复算 mapContentHash（依赖 JS 规范化与数字格式），I1 只能调 Node 子进程；没有跨语言黄金样例。
4. Python 在用而 schema 没有的字段：道路坡度、承载（t/轴、t/m²、总重）、路面、等级、车道数、会车区；节点转弯半径或转盘直径；节点与区域角色（upstream、assembly、coating、buffer、dock、depot）；区域出入节点、入口宽高、可用面积、槽位数、最大占地、支承方式、可否堆放、槽位承重；起重机（swl、跨度、吊钩高度）、工位、节点装卸服务台数；道路按时段容量（tasks/h）。
5. 时间维完全没有：工作日历、交接班禁行、接收关闭窗、码头与海运窗、封路、槽位可用通知；FAST01 场景只有 timeWindow 与 dueS，没有能引用 roadId、resourceId 的不可用窗口结构。
6. 三套场景语义不一致：FAST01 用 origin/destinationNodeId；SR03 用 servicePointId + storageResourceId + dwellS，车辆有 homeServiceId；VISTA 用节点名加 receivers。
7. 编译产物缺调度常用派生数据：名义行驶时间、有向边表与邻接表、允许/禁止转向列表与转向耗时、资源 appliesTo 反向索引、槽位表、服务点 → owner → 储位资源映射、OD 矩阵；unknown 物理值原样透传。
8. 单位与 ID 约定不统一：编辑器 m/s、kg、秒，主线 km/h、t、分钟；弧 ID `road_id:f|r`（VISTA）、`roadId:forward|backward`（编辑器）、`roadId__F|__B`（遗留）。
9. 结果回放缺适配器：只能回放 FAST01 格式；SR03 与 VISTA 的输出（分钟、edge_id）没有转换器；RuntimeStateMessage 与 RunEvent 两套并存，SimulationAdapter 未实现。
10. 「可用于路由/调度」判定未实现：validateMap 只有 draft；routing_input_v1 / scheduling_input_v1 未实现；checkResearchInput('scheduling') 永不 ready；map:diagnose 退出 0 不等于可用。
11. 外部依赖缺失：SR03 执行器与 I1 交付目录不在工作区，I1 与 MQ01_exports 依赖固定 SHA 的旧工具。
12. 文档不一致（见 A14）。

### C2 建议的最小接口（以 Python 实际需求为准，待用户确定消费者后再定）

- 导出（一次发布产出一个目录或 ZIP，不回写地图）：manifest.json（mapId、schemaVersion、mapContentHash、mapFileSha256、compilerVersion、profile、geometryToleranceVersion、units、coordinateFrame、工具版本、每文件 sha256、checked/not_checked、结论 ready/ready_with_assumptions/blocked、与 Python 现有列名的映射表）；map.json 原样；compiled-map.json（保留现有字段，加 arcs[].nominalTravelTimeS（仅限速已知时）、physicalResourceIds、transitions[{fromArc, toArc, status, movementId, resourceIds, turnTimeS?}]、resourceIndex、serviceIndex、slots）；表格化路网 nodes、edges（有向）、turns、areas、service_points、storage_slots、resources（列名尽量沿用 Python 现有写法）；可选 OD 矩阵（复用 pathPreview 与 MQ01_routes）与 WGS84 GeoJSON（需 geographicAnchor）。
- 导入：scenario（mapRef 绑定，按 servicePointId、nodeId、roadId、resourceId 引用；closures、日历、接收窗口、车辆、任务、假设；编辑器只校验引用与摘要）；results（沿用 FAST01 1.0，SR03 与 VISTA 各写转换器，或在协议中显式允许 edgeId 与 timeUnit）。
- 配套：Python 读取器与 mapContentHash 跨语言黄金样例（或由 Node 生成的 receipt 以 fileSha256 绑定）；真正实现 routing_input_v1 / scheduling_input_v1 的 map:publish。
- 需要新增到 schema（或带版本的 behavior 扩展）的内容：节点转弯半径或转盘直径；道路坡度、承载、路面、等级、车道数；区域角色、出入节点、容量；起重机与工位；时变不可用或容量窗口（原则上放在 scenario，区分静态设计值与场景时间窗）。
