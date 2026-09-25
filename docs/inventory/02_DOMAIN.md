# 旧版领域层规格（../map，2026-09-24 盘点）

用途：内核兼容与重构的依据。`文件:行` 相对 `../map`（map-studio 中路径相同）。截至提交 555789e。

## 0. 文件

- Schema：`schemas/map.schema.json`（0.1.0）、`map-0.2.schema.json`、`map-0.3.schema.json`、`spatial-classification-1.0.schema.json`；生成类型 `src/domain/model*.generated.ts`（`scripts/generate-types.mjs`，`schema:check` 校验一致）。
- 命令：`src/domain/{commands,topologyEditing,backgrounds,connectedPoint,accessDetachment,drawingDefaults,researchAccess,semanticPatch,spatialClassification,ownerEditing,planning,geometrySources,upgradeV03,factory,value,serialization,load,capabilities,results}.ts`。
- 校验：`src/validation/{validate,spatialDiagnostics,diagnostics,ownerEditing}.ts`；拓扑：`src/topology/{serviceConnections,networkDiagnostics,pathPreview}.ts`；几何：`src/geometry/{roadPath,roads,polygons,relations,roadBand,rectangles,coordinates,backgrounds,curveEditing,measurement,selectionHits}.ts`。
- 吸附（旧版不在内核内）：`src/renderers/2d/useSpatialDrawing.ts:13`、`MapCanvas.tsx:472-511`、`src/editor/roadDrawing.ts`。
- 真实数据：BG01 数据目录下全部为 0.2.0，多数声明 `sr02.planning@1.0 behavior`，另有 `shipyard.reference`、`org.shipyard.source`、`org.shipyard.topology_repair` 等 metadata 命名空间；最大一张 SHI_Geoje（590 节点、604 道路、1634 转向、1308 资源）。

## 1. 数据模型

### 1.1 顶层（三版相同，required 全必填，additionalProperties:false）

schemaVersion（每版一个 const）；mapId（Id）；revision（0..2^53-1，每次有效提交 +1，commands.ts:1035）；metadata `{name, description, layoutBasis∈conceptual/synthetic/reference_based/surveyed, applicability?, derivedFrom?{mapId, contentHash}, reviewNotes?, extensions?}`；coordinateFrame（除 geographicAnchor 外全为 const：local_cartesian/right/XY/Z/m/rad/kg/s；`geographicAnchor = {crs, coordinateOrder, origin, rotationRad, method}`）；siteBoundary（Polygon 或 null）；nodes、roads、junctions、movements、facilities、accessPoints、servicePoints、zones、resources、sources、assets、backgroundLayers（以 Id 为键）；extensionNamespaces（以 Namespace 为键，`{version, category∈metadata/visual/behavior, description?}`）；extensions（以 Namespace 为键，值任意）。

公共定义：Id `^[A-Za-z][A-Za-z0-9_-]{0,127}$`；Namespace `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$`；Vec3/Vec2 定长；IdList uniqueItems；PhysicalValue `{state:"known", value>0, sourceRef?}` 或 `{state∈unknown|unrestricted|not_applicable, reason?}`；Provenance `{category∈surveyed|drawing|imagery_derived|design_assumption|synthetic|unknown, sourceRefs?, fieldSources?, note?}`（fieldSources 键无约束，编辑器会写入 position、geometry/shapePoints、direction、widthM、extensions/sr02.planning、…slots/N/boundary、org.shipyard.spatial_classification.depthM、appliesTo、accessPointIds 等）；Polygon `{outer: Vec3[≥4], holes: Vec3[≥4][]}`。

实体：MapNode `{name, position, kind∈ordinary|junction|access|service, provenance, extensions?}`；MapRoad `{name, fromNodeId, toNodeId, direction∈unknown|forward|backward|both, widthM, heightLimitM, massLimitKg, speedLimitMps, observedLengthM?, corridorPolygon?, resourceIds, provenance, extensions?}`，0.1/0.2 用 `shapePoints`，0.3 用 `geometry: {kind:"path", anchors(仅内部锚点), spans(line | cubic{control1, control2})}` 且 `spans.length === anchors.length + 1`（ROAD_SPAN_COUNT）；Junction `{name, nodeIds, model∈unknown|explicit_movements, boundary?, resourceIds, provenance, extensions?}`；ArcRef `{roadId, direction∈forward|backward}`；Movement `{name, junctionId, incomingArc, outgoingArc, allowed, internalPath?, resourceIds, provenance, extensions?}`；Facility `{name, kind∈workshop|yard|assembly|dock|quay|other（0.3 加 building）, boundary, accessPointIds, servicePointIds, heightM, assetId?, provenance, extensions?}`；AccessPoint `{name, facilityId, nodeId, provenance, extensions?}`；ServicePoint `{name, kind∈loading|unloading|parking|berth|other, nodeId, facilityId?, accessPointId?, resourceIds, provenance, extensions?}`，0.2 起加 `zoneId?`、`arrival?`（`{mode:"node_proxy", transferAssumption∈included_in_service_duration|excluded_from_model, note}` 或 `{mode:"explicit_internal", entryNodeId?, internalPath: ArcRef[≤2048]}`）；Zone `{name, kind∈work|drivable|forbidden|water|buffer|waiting|obstacle（0.3 加 unclassified）, boundary, passability∈unknown|allowed|forbidden|explicit_access_only, resourceIds?, provenance, extensions?}`；Resource `{name, kind∈road|junction_conflict|parking|loading|other, capacityUnit∈vehicle|kg|area_m2, capacity, controlModel∈unknown|exclusive|shared_capacity|directional_exclusive, appliesTo: EntityRef[], provenance, extensions?}`；Source `{name, category, description, uri?, date?, extensions?}`；Asset `{path:^assets/.+, sha256, mediaType∈png|jpeg|webp, sourceRef, widthPx?, heightPx?, extensions?}`；BackgroundLayer `{name, assetId, pixelConvention:"top_left_x_right_y_down_exif_normalized", imageToWorld[6], method∈manual|similarity|affine, controlPoints[{pixel, world, role∈fit|check}], provenance, extensions?}`，`x = a·px + c·py + e，y = b·px + d·py + f`（geometry/backgrounds.ts:18）。

### 1.2 版本差异

0.1 → 0.2：ServicePoint 加 zoneId、arrival。0.2 → 0.3：道路 shapePoints 换成必填 geometry（可含三次曲线），Facility.kind 加 building，Zone.kind 加 unclassified。其余 $defs 一致。TS：`YardMap = 0.1 | 0.2 | 0.3` 联合，`SCHEMA_VERSION='0.3.0'`，`SUPPORTED_SCHEMA_VERSIONS`，`ENTITY_RECORDS`（12 个集合）。

### 1.3 schema 之外由代码强制的约束

- ID 跨 12 个集合全图唯一（DUPLICATE_ENTITY_ID，validate.ts:125-135），planning 槽位 ID 也须与核心 ID 不同（planning.ts:118）。
- 引用完整性（validate.ts:105-117、144-247）。
- 设施成员双向一致（FACILITY_REFERENCE_CONFLICT、FACILITY_MEMBERSHIP_MISSING，validate.ts:191-215）；区域无成员列表，归属只由 servicePoint.zoneId 表达。
- 转向：arc 方向须被道路方向允许（unknown 视为允许），incoming 末端与 outgoing 起点须属于 junction.nodeIds（validate.ts:172-190）。
- 道路 XY 长度有限且 > 0；曲线长度须收敛；含曲线道路不能有 XY 零长 span。
- 多边形规则见 4.3；扩展命名空间须先声明。
- 限制：MAX_JSON_BYTES 10 MiB（孤立代理按 3 字节）；嵌套 ≤ 64（括号计数，validate 中 keys.length ≥ 64）；拒绝重复键与非有限数；单多边形 ≤ 512 顶点、16 孔，全图多边形顶点 ≤ 8192；坐标绝对值 ≤ 1e9；近邻提示节点 ≤ 2000 且 节点×线段 ≤ 2,000,000，最多 100 条，网格 16 m、单次查询 ≤ 4096 格；服务点连接诊断工作量 ≤ 2,000,000；planning 槽位 ≤ 4096、顶点 ≤ 32768、几何代价 ≤ 1e6、证据 JSON ≤ 100000 节点深度 ≤ 32。

### 1.4 编辑器写入的扩展命名空间（必须能读写）

- `org.shipyard.editor.lineage`（1.0.0 metadata，commands.ts:36,784-796）：`{version:'1.0.0', roadSplits:[{oldRoadId, newRoadIds[2], nodeId, distanceM, originalLengthM}], topologyEdits?:[{operation, removedNodes, removedRoads, removedMovements, removedJunctions, retainedId?}]}`；未知键报 LINEAGE_CONFLICT。
- `org.shipyard.spatial_classification`（1.0 metadata）：根 `{customClasses:[{id:^[a-z][a-z0-9_]{0,63}$, label(≤80), appliesTo}]≤128}`；实体 `{classId, depthM?, depthReference?}`，depthM 只允许 known（需 sourceRef 且 source 存在，并须有 depthReference）或 unknown，只用于 zones；内置 10 个建筑类、14 个区域类。
- `org.shipyard.fast_trace.semantic`（1.0 metadata）：`{fields:{kind|name:{origin∈inferred|manual, locked, sourceRef, evidenceGrade?, evidence?, imageRef?, before?, after?}}}`。
- `sr02.planning`（1.0 behavior）：只读与受限写，见 2.10。
- `shipyard.reference`（1.0 metadata）：只在 MQ01 的 suppressDegree2Node 策略中解读，载荷键恰为 corridorRef/roadClass/widthMeaning。

### 1.5 迁移

- `upgradeMapToV03`（upgradeV03.ts:7-23）：0.3 只深拷贝；否则 shapePoints 原样搬到 geometry.anchors，spans 为 n+1 个 line，schemaVersion='0.3.0'，revision+1，changes 以 JSON Pointer 列出；0.1 可直接升 0.3。
- `upgradeSchema` 命令（commands.ts:982-985）：目标 0.3 调上面函数；目标 0.2 时 0.1 只改版本号，0.2 不变，0.3 报 UNSUPPORTED_MIGRATION（禁止降级）；跳过只读检查但要求输入通过校验。
- `scripts/map-migrate.ts`：CLI 只能升到 0.2.0（:36）；输入输出路径不能相同（Windows 忽略大小写并解析 realpath），输出必须不存在（`wx`）；输入 ≤ 10 MiB 严格 UTF-8；输出为 serializeMap 规范文本；报告源文件 sha256、源与目标 contentHash、changes；退出码 0/1/2。
- 0.1/0.2 可原样读写，不自动迁移；`newMap` 默认建 0.2.0（factory.ts:5），与 SCHEMA_VERSION 不一致。

## 2. MapCommand（commands.ts:40-70，37 种）

### 2.0 统一事务 applyMapCommand（commands.ts:901-1042）

1. validateMap(input) 须 ok。2. commandSupport（:341，inspectSupport :354-573）：能力与只读检查（READ_ONLY_MAP）、依赖闭包与 affectedRefs、策略检查，部分命令在候选图上模拟。3. 在 structuredClone 候选上执行；support 阶段已为同一冻结 map 与同一 command 对象模拟过则复用（模块级 `simulated`，:348）。4. coordinateFrame 不得变化（COORDINATE_FRAME_LOCKED）。5. shareUnchanged 复用未变冻结实体（:582）。6. validateMap(next) 须 ok。7. 输入含 planning 时候选 planning 须仍受支持（STATIC_CONTENTS_INVALID）。8. sameValue(input,next) 时返回 changed:false，不入历史。9. inspectSpatialEdit 与 inspectOwnerGeometryEdit 有 error 即拒绝，warning 随结果返回。10. 来源记账：recordTopologySources（拓扑命令、createConnectedPoint、detachAccessPoint、quickTraceRoad、applyResearchAccess）、recordSiteBoundaryNormalization、recordGeometrySources（所有命令）、recordDirectionSources（updateRoad、updateRoadBatch）。11. revision+1、深冻结、再校验、规范 JSON ≤ 10 MiB（JSON_SIZE_LIMIT）。12. 返回 Transaction{before, after, label, affectedRefs, mapping?, migrationChanges?}。异常转为单条 issue：CommandError / TopologyError / BackgroundError / OwnerEditError / SpatialClassificationError 的 code，其余 INVALID_COMMAND（:571,1007）。

「高级图」门控 advancedMap（:140-143）：已声明 sr02.planning 或存在 junctions/movements/resources（例外 onlySubdivisionJunctions，topologyEditing.ts:624-653：全部为编辑器拆路生成的直通结构）。高级图中：节点道路只能单独平移、不能旋转、不能与设施区域混选；设施区域只能整体变换；字段白名单（:451-455）；禁止 addRoad 与 duplicateSelection（OPERATION_DEPENDENCIES_UNSUPPORTED）；点与路几何修改须保持 Z（LOCAL_NONPLANAR_EDIT）并通过 localGeometrySupport（:307-329）。

物理值来源 physicalSources（:673-699）：新 known 值无 sourceRef 时须提供 designAssumption，否则 KNOWN_SOURCE_REQUIRED；自动建 Source（origin 为 manual_image_estimate 时 imagery_derived，否则 design_assumption），写 fieldSources，旧来源并入 sourceRefs，改为非 known 时删 fieldSources 项。几何来源 recordGeometrySources（geometrySources.ts:62-97）：节点位置、道路几何、facilities/zones/junctions 边界、planning 槽位边界变化时确保 `source_editor_geometry` 并记 fieldSources。拓扑来源（:31-58）用 `source_editor_topology`。来源 ID 分配 sourceId（:22-28）：首选 ID 被不同内容占用时加 `_1`、`_2`…，内容相同复用。

### 2.1 点、路、面的增改

| 命令 | 要点 | 错误码 |
|---|---|---|
| addNode | ID 全局唯一 | DUPLICATE_ENTITY_ID |
| addRoad | roadForMap 归一（0.3 收旧式转 path；0.1/0.2 收 path 报错）；known 宽补来源；高级图禁用 | DUPLICATE_ENTITY_ID、KNOWN_SOURCE_REQUIRED、OPERATION_DEPENDENCIES_UNSUPPORTED |
| updateNode | 移动时 moveNodeWithHandles 同步平移相邻 cubic 端部控制点；受影响道路有 corridor 或 observedLength 拒绝；高级图或有业务归属只能改 XY | UNSUPPORTED_PATCH、ROAD_GEOMETRY_DEPENDENCY、LOCAL_NONPLANAR_EDIT、LOCAL_*、OWNER_SHARED_NODE/OWNER_PUBLIC_NODE |
| updateRoad | shapePoints 与 geometry 互斥；曲线道路改 shapePoints 为 INVALID_COMMAND；geometry 仅 0.3；corridor 禁改几何与宽度；observedLength 禁改几何；方向变化记 source_editor_direction | ROAD_GEOMETRY_CONFLICT、ROAD_GEOMETRY_VERSION、ROAD_GEOMETRY_DEPENDENCY、KNOWN_SOURCE_REQUIRED、LOCAL_NONPLANAR_EDIT |
| updateRoadBatch | ids 1..4096，逐条 updateRoad；batchRoadPatch 去掉与当前值相同的无来源 known 字段；共用一个假设来源 | INVALID_COMMAND、DUPLICATE_ENTITY_ID |
| movePoint | 移动该点节点，节点须唯一私有归属（privateNodeOwner） | OWNER_UNDECLARED、OWNER_SHARED_NODE、OWNER_PUBLIC_NODE |
| addFacility | accessPointIds、servicePointIds 须为空 | FACILITY_MEMBER_COMMAND_REQUIRED |
| updateFacility | kind/name 人工修改写语义锁（origin manual, locked, source_semantic_manual）；有 assetId 或被 overlayOf 引用时高级图中不能改边界；entranceAdjustments 须与边界补丁一起、只能移动本设施专用入口节点 | OWNER_ENTRANCE_REPAIR_INVALID、SPATIAL_CLASSIFICATION_VERSION、KNOWN_SOURCE_REQUIRED |
| addZone / updateZone | 同设施（patch 为 name/kind/boundary/passability） | 同上 |
| addAccessPoint / addServicePoint | newNode.id 须等于点的 nodeId，自动维护设施成员 | POINT_NODE_MISMATCH、DANGLING_REFERENCE |
| updateAccessPoint / updateServicePoint | 成员关系迁移；服务点可把 facilityId/accessPointId/zoneId/arrival 置 null 删除 | 同上 |
| renameMap | 改 metadata.name | schema minLength 1 |
| normalizeSiteBoundary | 无参数；只删除严格共线且位于邻点之间的顶点；before/after 存 Source source_mq01_site_boundary | INVALID_COMMAND |
| setSpatialClasses | 整体替换根类目，现有标注须仍可解析 | SPATIAL_CLASSES_FORMAT、SPATIAL_CLASS_ID/LABEL/SCOPE、SPATIAL_CLASS_REFERENCE、SPATIAL_CLASSIFICATION_VERSION |
| upgradeSchema | 见 1.5 | UNSUPPORTED_MIGRATION |

prepareBoundaryRepair（:1045）构造 updateFacility：原本在边界上、新轮廓下不在的入口投影到最近边；不唯一或 Z 不同报 OWNER_ENTRANCE_REPAIR_AMBIGUOUS/UNSUPPORTED。

### 2.2 选择变换

Selection `{nodes, roads, facilities?, zones?, accessPoints?, servicePoints?}`（去重排序）。translateSelection `{selection, delta, facilityMovePolicy?, zoneMovePolicy?}`；rotateSelection `{selection, pivot, angleRad, …}`（只绕 Z，保留 Z）。策略 boundaryOnly | withAssociatedNodes | withStaticContents；选中设施须显式给策略（FACILITY_MOVE_POLICY_REQUIRED），有服务点的区域同理（ZONE_MOVE_POLICY_REQUIRED）。selectionImpact（:145-241）：非 boundaryOnly 并入成员点与节点、道路端点；withStaticContents 须 planning 受支持（STATIC_CONTENTS_UNSUPPORTED），owner 道路两端都移动为刚体路段、一端移动为接入段（须直线，STATIC_CONNECTOR_SHAPE_UNSUPPORTED）；公共节点固定（STATIC_SHARED_NODE）；多节点路口须整体移动（STATIC_PARTIAL_JUNCTION）；STATIC_OVERLAY_DEPENDENCY、STATIC_MOVEMENT_PATH_UNSUPPORTED、STATIC_EXTERNAL_INTERNAL_PATH、STATIC_ROAD_GEOMETRY_UNSUPPORTED；owner 槽位边界与受影响路口边界随同变换。单个业务点平移走 movePoint。其他：INVALID_SELECTION、INVALID_COMMAND、INVALID_MOVE_POLICY、STATIC_CONTENTS_REQUIRED、OPERATION_DEPENDENCIES_UNSUPPORTED、LOCAL_*。

duplicateSelection `{selection, delta, idMap, associationPolicy?: retainFacility|retainOwner|rejectExternal}`（copySelection :700-744）：闭包含设施成员、区域服务点、服务点的入口与 entryNodeId、点的节点、道路端点，不含外部道路；idMap 须恰好覆盖闭包且目标 ID 全新（INVALID_COPY_ID_MAP）；实体只允许带空间分类扩展（UNSUPPORTED_COPY_SEMANTICS）；涉及路口或转向拒绝（TOPOLOGY_COPY_DEPENDENCIES）；单独复制点保留归属须显式策略（EXTERNAL_FACILITY_ASSOCIATION、EXTERNAL_ZONE_ASSOCIATION）；内部路径未全选报 UNSUPPORTED_COPY_INTERNAL_PATH；高级图禁用。

### 2.3 删除 deleteSelection

`{selection, topologyPolicy?: reject|cascade, facilityPolicy?/zonePolicy?: reject|withAssociatedPoints, orphanNodes?: keep|deleteUnused}`（:745-782 + topologyEditing.ts:119-185）。设施有点须 withAssociatedPoints（FACILITY_HAS_POINTS），区域同理（ZONE_HAS_POINTS）；其他服务点仍引用待删入口报 ENTITY_IN_USE；cascade 删除关联道路、引用它们的转向、单节点无边界且转向全删的路口，并从 appliesTo 清理引用（资源保留）；非 cascade 遇依赖报 TOPOLOGY_DELETE_DEPENDENCIES；拒绝 TOPOLOGY_POINT_DEPENDENCY、TOPOLOGY_SERVICE_PATH_DEPENDENCY、TOPOLOGY_JUNCTION_CONFLICT、TOPOLOGY_JUNCTION_GEOMETRY、TOPOLOGY_JUNCTION_DEPENDENCY、INVALID_TOPOLOGY_POLICY、INVALID_DELETE_POLICY；deleteUnused 删除已无引用的原业务点节点与 entryNodeId；被删 ID 经 rejectOpaqueTopologyReferences（topologyEditing.ts:526-547，除 sr02.planning 与 lineage 外任何扩展字符串值或键等于被删 ID 报 TOPOLOGY_OPAQUE_REFERENCE）；lineage 追加 topologyEdits。

### 2.4 拓扑命令

- splitRoad `{id, distanceM, nodeId, existingNode?, newRoadIds[2]}`：道路无 corridor/observedLength（TOPOLOGY_INDEPENDENT_GEOMETRY），锚点控制点同 Z；XY 弧长里程须在 (1e-6, L-1e-6)（INVALID_SPLIT_POSITION）；曲线用 poseAtDistance + splitPath（de Casteljau），CURVE_LENGTH_NOT_CONVERGED、CURVE_POSITION_NOT_CONVERGED；长度守恒（直线 ≤ 1e-6，曲线 ≤ 三段误差预算 + 1e-6，SPLIT_LENGTH_MISMATCH）；existingNode 须在切点 1e-6 内且非端点（INVALID_SPLIT_NODE），否则新建节点「<道路名> / 拆分点」；新 ID 互异、未占用、不等于 nodeId（INVALID_SPLIT_IDS）；remapSplitReferences（:78-94）：movement 的 arc 映射到靠近路口的一段 `newIds[(incoming)===(forward)?1:0]`，服务 internalPath 一段展开为两段，appliesTo 扩展为两条；preserveSplitContinuation（:549-573）复用切点单节点路口或建 `junction_editor_split`，对允许方向补直行 `movement_editor_split`（unknown 方向不补，已有同 arc 对禁转报 TOPOLOGY_TURN_EXISTS）；lineage 记 roadSplits，返回 SplitMapping。
- splitRoadAndSetWidth `{roadId, distanceM, widthM∈[0.1,1000], direction?, designAssumption?}`：分配 node_width_NNN、road_width_NNN×2、source_width_NNN；默认改切点之后一段，backward 改前一段；INVALID_ROAD_WIDTH、INVALID_WIDTH_DIRECTION。
- mergeNodes `{sourceNodeId, targetNodeId, approvedMovements?}`（:216-287）：同 Z；相关道路无 owner（TOPOLOGY_OWNER_CONNECTION）、无独立几何；只支持单节点无边界路口且两侧 model 与扩展一致（TOPOLOGY_JUNCTION_CONFLICT）；TOPOLOGY_SELF_LOOP、TOPOLOGY_DUPLICATE_EDGE、TOPOLOGY_NODE_CONFLICT；批准转向须来自 enumerateMergeTurns（TOPOLOGY_TURN_NOT_PROPOSED）；重定向点 nodeId、entryNodeId、junction.nodeIds、资源节点引用、movement.junctionId；有批准转向无路口时建 `junction_editor_merge`。
- connectNodeToRoad `{nodeId, roadId, distanceM, newRoadIds, junctionId, approvedMovements}`（:472-518）：节点移到切点（XY 变 Z 不变）再以 existingNode 拆路；批准转向须来自 enumerateConnectionTurns 且方向明确允许（TOPOLOGY_TURN_DIRECTION）；TOPOLOGY_TURN_EXISTS、TOPOLOGY_ALREADY_CONNECTED、TOPOLOGY_OWNER_CONNECTION、INVALID_TOPOLOGY_MOVEMENTS（≤ 4096）。
- suppressDegree2Node `{nodeId, retainedRoadId, metadataPolicy?:'mq01_reference_corridor'}`（:373-471）：恰好两条路（TOPOLOGY_DEGREE_TWO_REQUIRED），方向明确（TOPOLOGY_DIRECTION_UNKNOWN），定向方向、四个物理值、resourceIds、扩展全同（TOPOLOGY_ROAD_CONFLICT）；路口无边界、资源、多节点（TOPOLOGY_JUNCTION_RESOURCE）；节点上转向只能是无资源无几何非掉头允许的直行（TOPOLOGY_MOVEMENT_CONFLICT），且每个允许方向已有显式直行许可（TOPOLOGY_CONTINUATION_UNDECLARED）；拼接路径并重映射外部 movement 与服务 internalPath（须连续穿过两段，TOPOLOGY_SERVICE_PATH_DEPENDENCY）；TOPOLOGY_RESOURCE_DEPENDENCY；MQ01 策略另需 shipyard.reference@1.0、同一走廊族 `C_[A-Z]+_\d{3}_\d{2}`、禁止曲线，被删信息写 `source_mq01_corridor_lineage`。

### 2.5 底图命令（backgrounds.ts:11-143）

addBackground `{id, layer, assetId, asset, source?}`（asset 须过 inspectAsset：路径安全、png/jpeg/webp、有 sha、宽高正整数、无扩展；layer.assetId === assetId；同路径不同声明报 BACKGROUND_ASSET_PATH_CONFLICT）；updateBackgroundTransform `{id, imageToWorld}`（有限非奇异，不得翻转行列式符号 BACKGROUND_MIRROR_REJECTED，method 改为 manual）；deleteBackground `{id}`（过 opaque 检查）；replaceBackgroundAsset `{id, assetId, asset, source?}`。每条写 Source `source_editor_background[_n]`（description 为 JSON：operation、before/after 含 SHA、保留的 controlPoints、calibrationStatus）。错误码 UNSUPPORTED_PATCH、BACKGROUND_UNSUPPORTED、BACKGROUND_TRANSFORM_INVALID、BACKGROUND_SOURCE_MISMATCH、BACKGROUND_SOURCE_REQUIRED、BACKGROUND_ASSET_MISMATCH、BACKGROUND_ASSET_UNSUPPORTED、DUPLICATE_ENTITY_ID。

### 2.6 createConnectedPoint（connectedPoint.ts:10-174）

公共参数 `{pointId, name, source, resourceIds?≤256}`，三种形态：入口（owner 设施、nodeId、position、connectorRoadId、connector{direction, widthM}、connection 为节点或道路{roadId, distanceM, nodeId, newRoadIds}、junctionId、approvedMovements?；position 须在外环边界上，接入目标须有公共道路）；节点代理服务点（arrival node_proxy{accessPointId, transferAssumption, note}，复用入口节点，不产生几何）；显式内部服务点（owner 设施或区域，arrival explicit_internal{accessPointId? 或 entryNodeId?, prefixPath}，prefixPath 须全属该 owner、方向允许、从入口连续到接入点；接入段写 sr02.planning{role:'internal', ownerEntityId, physicalMeaning}，缺声明时补上；internalPath = prefixPath + [接入段 forward]；接入段方向只能 forward 或 both）。实现：临时节点 `node_connected_point_join` 与目标共位，再调 mergeNodes 复用转向检查，返回 proposedMovements。新对象 provenance design_assumption；0.1 禁用（CONNECTED_POINT_SCHEMA）；错误码族 CONNECTED_POINT_*（约 28 个）、LOCAL_NONPLANAR_EDIT、INVALID_TOPOLOGY_MOVEMENTS、STATIC_CONTENTS_UNSUPPORTED。

### 2.7 detachAccessPoint（accessDetachment.ts）

`{id, distanceM, nodeId, connectorRoadId, internalRoadId}`；前置：入口节点只属本设施，恰好一条本设施内部支路（无折点、平面、无 corridor、方向已知、无资源的直线），外部道路至少两条，使用该支路的服务点以它为 internalPath 首段且方向一致。执行：拆分支路，公共侧去 owner 并 role=main、来源 source_editor_access_detachment，私有段保留 owner；入口节点移到新节点；服务 internalPath 删首段、entryNodeId 同步。inspectAccessDetachment 建议距离（0.5–0.95 中第一个落在已知公共路带之外的比例）。ACCESS_DETACH_* 15 个、INVALID_SPLIT_POSITION。

### 2.8 快速描图（drawingDefaults.ts:15-187）

quickTraceRoad `{points(2..4096, 同 Z), geometry?(仅 0.3，anchors = points 去首尾), defaults?{widthM=12, direction='both', connectNewCrossings=true}, startConnection?/endConnection?, disconnect?}`：新路 known 宽与方向，来源 source_quick_trace_defaults_v1（description JSON 含 profile quick_trace_v1），几何来源 source_quick_trace_drawing_v1（drawing）；接入道路时在距端点 >1e-6 处拆路，多处按里程降序；与已有 quick_trace_v1 道路相交时自动拆分并合并节点（只有 direction 的 fieldSources 解析出 profile 为 quick_trace_v1 的道路参与，:75-79）；自动批准 enumerateMergeTurns 转向（movement_trace_NNN）；ID node_trace_、road_trace_、movement_trace_（3 位序号），道路名「道路NNN」；QUICK_TRACE_POINTS/GEOMETRY/DEFAULTS/ZERO_SEGMENT/CROSSING_AMBIGUOUS/CONNECTION/SCHEMA、LOCAL_NONPLANAR_EDIT、INVALID_SPLIT_POSITION。quickTraceBoundary `{kind: building|area, boundary, classification?}`：仅 0.3，生成 facility_trace_NNN（kind building，「建筑NNN」）或 zone_trace_NNN（kind unclassified，「区域NNN」）。

### 2.9 语义补丁与研究接入

- applySemanticPatch（semanticPatch.ts:62-111）：`{formatVersion:'1.0', mapId, baseMapContentHash, patches[1..4096]}`，每项恰 9 键（entityType facilities|zones、entityId、field kind|name、before、after、origin 'inferred'、evidenceGrade high|medium|low、evidence、imageRef 相对路径禁 `..`）；mapId 与 contentHash 须匹配（SEMANTIC_PATCH_STALE），before 须等于当前值（SEMANTIC_PATCH_BEFORE）；状态 ready/protected/low_evidence/semantic_impact/unchanged，只应用 ready；protected：已锁定、manual、字段来源 surveyed、或已被人工改过（kind 不再是 building/unclassified 或名称不符 `^(建筑|区域)\d+$`）；区域 kind 改为 drivable/forbidden/water/obstacle 属 semantic_impact；写 source_semantic_inferred 与语义扩展。
- applyResearchAccess（researchAccess.ts:104-145）：proposal 由 prepareResearchAccess 生成（绑定 mapId、contentHash；landZoneIds 只取 drivable 且 allowed，maxDistanceM 默认 50 上限 1000，widthM 默认 12，transferAssumption，note）；执行时重新生成须完全一致（RESEARCH_ACCESS_STALE、RESEARCH_ACCESS_PROPOSAL_CHANGED）；ready 目标用 quickTraceRoad 建短接线，设施目标另生成 access_research_，生成 service_research_（loading，node_proxy），来源 source_research_boundary_proxy；候选在边界顶点、边中点与道路投影间搜索，短接线须全在陆域且不穿设施与禁入/水域/障碍区；每目标工作量 300,000，目标 ≤ 1024。checkResearchInput（:148）只读。

### 2.10 sr02.planning@1.0（planning.ts，只读解释器）

声明须恰为 `{version:'1.0', category:'behavior'}`（PLANNING_UNSUPPORTED_DECLARATION）。位置与载荷（:135-210）：根 `{assumptionId, role:'synthetic_planning', siteAreaBasis}`；metadata 9 个固定字段（evidenceRegister/referenceRecord/publicFacts 为只读证据）；sources `{evidenceRecord}`；roads `{role∈main|internal, physicalMeaning, ownerEntityId（internal 必填，指向设施或区域）}`；junctions `{rotationSpaceStatus, motionMode?, turningPadBasis?}`；servicePoints `{capability:'loading_and_unloading', handling}` 且 kind=other；facilities/zones 四种形态（储货槽位 owner `{role, dimensionBasis, slotGapM, slotLengthM, slotWidthM, transportAisleWidthM, slots[{id,boundary}], storageResourceId}`；停车槽位 zone `{role:'parking', quantityBasis, motion?, slots[{id,boundary,servicePointId}]}`；区域 dock_exclusion{overlayOf, waterSurface?} 或 process_separation；设施 dry_berth/dry_dock）；resources `{slotAreaM2, slotIds, unitMeaning:'cargo_storage_area'}`。交叉约束：槽位面积 = 长×宽（相对误差 1e-7）、储位资源与 owner 双向唯一且 appliesTo 恰为该 owner、capacityUnit area_m2 且容量 = 槽位数×单槽面积、停车服务点与泊位一一对应。所有 planning 问题为 warning（PLANNING_*），但令 supported=false 从而整图只读；输出 slots 供移动、诊断、ID 分配。

## 3. 校验与诊断问题码

- 解析（serialization.ts:35-79）：JSON_SIZE_LIMIT、JSON_DEPTH_LIMIT、JSON_SYNTAX、DUPLICATE_KEY、NON_FINITE_NUMBER（均 error）。
- validateMap（validate.ts:88-325，Ajv2020 strict/allErrors/ownProperties）顺序：JSON 值检查、版本判定、按版本 schema（失败提前返回）、0.3 span 数、语义检查。error：NON_FINITE_NUMBER、NON_JSON_VALUE、CYCLIC_VALUE、JSON_DEPTH_LIMIT、UNSUPPORTED_SCHEMA_VERSION、UNKNOWN_CORE_FIELD、SCHEMA_ERROR、ROAD_SPAN_COUNT、DANGLING_REFERENCE、UNDECLARED_EXTENSION_NAMESPACE、DUPLICATE_ENTITY_ID、POLYGON_*（MAP_COMPLEXITY_LIMIT、COMPLEXITY_LIMIT、NOT_CLOSED、NONPLANAR、COORDINATE_LIMIT、ZERO_EDGE、DUPLICATE_VERTEX、ADJACENT_OVERLAP、SELF_INTERSECTION、ZERO_AREA、WINDING、HOLE_OUTSIDE、HOLE_OVERLAP）、GEOMETRY_NOT_CONVERGED、ZERO_LENGTH_SPAN（只查含 cubic 的道路）、NON_FINITE_GEOMETRY、ZERO_LENGTH_ROAD、ARC_DIRECTION_CONFLICT、ARC_OUTSIDE_JUNCTION、FACILITY_REFERENCE_CONFLICT、FACILITY_MEMBERSHIP_MISSING、SERVICE_ACCESS_FACILITY_CONFLICT、SERVICE_CONNECTION_COMPLEXITY_LIMIT、UNSAFE_ASSET_PATH、SINGULAR_BACKGROUND_TRANSFORM、服务点连接 error、空间分类 error（SPATIAL_CLASSES_FORMAT、SPATIAL_CLASSIFICATION_FIELD、SPATIAL_CLASS_ID/LABEL/REFERENCE/SCOPE、SPATIAL_CLASSIFICATION_FORMAT、SPATIAL_DEPTH_SCOPE/REFERENCE/VALUE、KNOWN_SOURCE_REQUIRED，载荷非法时整图无效）、UNSUPPORTED_PROFILE。warning：UNKNOWN_PHYSICAL_VALUE、UNKNOWN_DIRECTION、ASSET_NOT_RESOLVED、NEAR_UNCONNECTED_NODES、NEAR_ROAD_UNCONNECTED、PROXIMITY_CHECK_LIMIT、TURN_RULES_UNSPECIFIED、PLANNING_*（20 类）、SPATIAL_CLASSIFICATION_VERSION、UNSUPPORTED_EDIT_CAPABILITY、MISSING_CHECKS。最后为每条补 location.position。
- 服务点连接（serviceConnections.ts:38-137，0.2+）：error DANGLING_REFERENCE、SERVICE_ACCESS_FACILITY_CONFLICT、SERVICE_OWNER_CONFLICT、PROXY_ASSUMPTION_EMPTY、INTERNAL_ENTRY_CONFLICT、INTERNAL_PATH_DIRECTION_FORBIDDEN、INTERNAL_PATH_START_MISMATCH、INTERNAL_PATH_DISCONTINUOUS、INTERNAL_PATH_END_MISMATCH、INTERNAL_TURN_FORBIDDEN；warning SERVICE_OWNER_UNDECLARED、SERVICE_ACCESS_OWNER_UNDECLARED、SERVICE_ZONE_LAND_ACCESS_UNSUPPORTED、SERVICE_ROAD_DIRECTION_UNDECLARED、SERVICE_NODE_UNCONNECTED、SERVICE_NO_INBOUND_ARC、SERVICE_ARRIVAL_UNDECLARED、PROXY_INSIDE_BUILDING、SERVICE_ROUTE_UNCHECKED、INTERNAL_ACCESS_UNDECLARED、INTERNAL_ENTRY_UNDECLARED、INTERNAL_PATH_UNDECLARED、INTERNAL_PATH_DIRECTION_UNDECLARED。
- 空间诊断（spatialDiagnostics.ts）：显式诊断 inspectSpatial，提交时 inspectSpatialEdit（只查变化部分）；预算比较 2,000,000、问题 200（超出 SPATIAL_EDIT_INCOMPLETE 为 error）；存在未知 behavior/visual 扩展时全部降级为 warning。error：SPATIAL_SLOT_OUTSIDE_OWNER、SPATIAL_SLOT_OVERLAP、SPATIAL_CORRIDOR_CENTERLINE_OUTSIDE、SPATIAL_ROAD_FORBIDDEN、SPATIAL_SERVICE_OUTSIDE_OWNER（提交为 error，全图为 warning，刚体整体变换且原本越界时降级）、SPATIAL_EDIT_INCOMPLETE；warning：SPATIAL_ROAD_FORBIDDEN_CANDIDATE、SPATIAL_ROAD_RANGE_UNCHECKED、SPATIAL_CORRIDOR_UNCHECKED、SPATIAL_CORRIDOR_NEEDS_REFINEMENT、SPATIAL_LAYER_UNCHECKED、SPATIAL_WIDTH_UNCHECKED、SPATIAL_ROAD_BAND_NEEDS_REFINEMENT、SPATIAL_ROAD_BUILDING_OVERLAP、SPATIAL_SERVICE_PROXY_UNCHECKED。
- 归属几何提交检查（validation/ownerEditing.ts:14-90）：error OWNER_ENTRANCE_NONPLANAR、OWNER_ENTRANCE_REPOSITION_REQUIRED、OWNER_PARKING_POINT_OUTSIDE_SLOT、OWNER_ROAD_NONPLANAR（刚体为 warning）、OWNER_INTERNAL_ROAD_OUTSIDE、OWNER_ROAD_NEW_BUILDING_CROSSING、OWNER_ROAD_NEW_BUILDING_BAND_CONFLICT、OWNER_GEOMETRY_INCOMPLETE；warning OWNER_ENTRANCE_LOCATION_UNCHECKED。
- 网络诊断（networkDiagnostics.ts，只读，全 warning，候选对 2M、结果 500）：P2A_DIRECTION_UNKNOWN、ZERO_SEGMENT、COLLINEAR_OVERLAP、CROSSING_DIFFERENT_Z、ENDPOINT_IDS_DIFFER、T_JUNCTION_CANDIDATE、SELF_CROSSING、X_CROSSING_CANDIDATE、CURVE_INTERSECTION_UNRESOLVED、COINCIDENT_NODE_IDS、NEAR_UNCONNECTED_NODES、NODE_NEAR_ROAD_INTERIOR、ISOLATED_NODE、SEPARATE_COMPONENT、FACILITY_NO_SERVICE、POINT_UNCONNECTED；diagnoseMap rulesVersion 'P2A-1'，status complete/partial/invalid。
- 路径预览（pathPreview.ts，只读）：PATH_COMPLEXITY_LIMIT（道路×2 > 4000 或工作量 > 1M）、PATH_EXTENSION_UNSUPPORTED、PATH_INPUT_INVALID、PATH_GEOMETRY_UNSUPPORTED、PATH_JUNCTION_TRANSITION_UNSUPPORTED、PATH_MOVEMENT_GEOMETRY_UNSUPPORTED、PATH_MODE_UNSUPPORTED、PATH_ENDPOINT_MISSING、PATH_ENDPOINT_UNSUPPORTED、PATH_ARRIVAL_UNDECLARED、PATH_DISTANCE_OVERFLOW、PATH_CONDITIONS_UNCONFIRMED、PATH_NO_KNOWN_DIRECTION_ROUTE、PATH_NO_DECLARED_ROUTE；以 arc 为状态的 O(A²) Dijkstra，同时算 confirmed 与 candidate；不穿第三方 owner 内部道路，禁转阻断，终点有 internalPath 时须走完整后缀。

## 4. 几何与拓扑算法

- 道路路径（roadPath.ts）：getRoadPath anchors = [from 节点, 内部锚点…, to 节点]，旧式道路 spans 全 line；直线按 1/3、2/3 控制点当三次贝塞尔；长度为 XY 水平弧长；自适应细分 prepare（:165-202，平直度 0.05，容差 max(0.01, 1e-4×上界)，深度 24，叶子 65536，给出 errorM 与 converged）；版本 `GEOMETRY_TOLERANCE_VERSION='world-metre-0.01-1e-4-flat0.05-v1'`；flattenPath 采样点永不成为节点；poseAtDistance、partialLength、splitPath（de Casteljau）、reversePath、pathToRoadGeometry、movePathAnchor（同步平移相邻控制点）、boundsOfPath（导数求根精确包围盒）、projectToPath（容差 0.001，分支定界 + Newton，多极小判 ambiguous）、intersectPaths（容差 0.001，叶子包围盒剪枝，共线重叠或相切 ambiguous，候选对 2M、工作量 131072）；辅助 withRoadAnchors、transformRoadGeometry、roadForMap、roadGeometryAnchors、hasNonlinearGeometry、isStraightRoad。roads.ts：roadPoints、roadLength、polylineLength2D、roadWidthBounds（仅显示）、projectPolyline。curveEditing.ts：curveThroughMidpoint、bendPathSpan（中点移动时两个控制点各移 4/3·Δ）。editor/roadDrawing.ts：草图追加 line/curve，smooth 保持切线连续。
- 路带与包含（roadBand.ts、relations.ts）：inspectRoadBand 用逐级更细展平容差 [0.05, 0.002, 0.0001] 保守判定 clear/intersects/uncertain；inspectPathContainment；pointInPolygon（inside/outside/boundary，计孔）；polygonHasArea（intersection/outside，垂直 slab 精确分解，接触不算）；polylineWithinPolygon、polylineEntersPolygon、roundRoadIntersectsPolygon、polylineBoundaryDistance；都接受 work 预算回调。
- 多边形（polygons.ts）：GEOMETRY_TOLERANCE_M 1e-7；validatePolygon（:53-96）检查顶点孔数上限、闭合、平面（Z 差 ≤ 1e-7）、坐标 ≤ 1e9、无零长边、无重复顶点、相邻边不折返、非相邻边不相交不接触、面积 > 1e-14、外环 CCW 孔 CW、孔严格在外环内且互不相交不嵌套；只报错不修复。polygonFromVertices、rectanglePolygon、transformPolygon、normalizePolygonBetweenVertices、pointInRing、segmentsIntersect、pointOnSegment。
- 矩形、坐标、底图、测量、命中：MIN_RECTANGLE_SIZE_M 0.01；orientedRectangleVertices（三点斜矩形）、rectangleFrame、角点缩放对角固定越界夹紧、顶点移动插入删除（每环 ≥ 3）；worldToScreen `[ox + x·s, oy − y·s]`、screenToWorld、zoomAt、fitCamera（半范围 ≥ 5 m，scale ≤ 10 px/m，边距 100 px）；底图仿射平移、旋转、按固定角缩放、角点拖拽（可保持纵横比），不改变行列式符号；measurement 仅显示；selectionHits 像素容差 12（点标记 14），优先级 servicePoints > accessPoints > nodes > roads > facilities > zones，道路用 projectToPath，cycleSelection 6px 内轮换。吸附（旧版不在内核）：snapPosition（同 Z 最近节点 12px 内优先，否则网格 0/1/5/10 m），traceCandidate 与 topologyCandidate（节点优先，再道路内部投影，距端点 > 1e-6、不 ambiguous、同 Z；Alt 关闭）。
- 拓扑辅助：topologyChangedRefs（逐实体 sameValue 差分）；enumerateMergeTurns / enumerateConnectionTurns（方向允许、不掉头、尚无声明）；continuousRoadIds（ownerEditing.ts:64，沿度 2、方向一致、属性相同扩展，遇业务点停）；nodeOwners / privateNodeOwner。

## 5. 能力、会话、哈希与边界

- mapCapabilities（capabilities.ts:6-28）：editable = 无 reasons；只读原因包括不支持的 asset（缺宽高、带扩展、路径或媒体类型非法）、不支持的 backgroundLayer、category ≠ metadata 的扩展命名空间（sr02.planning 受支持时除外）、sr02.planning 不受支持。unrendered 可含 assets、backgroundLayers、movements_without_display_geometry、roads.corridorPolygon、extensions.<ns>；unchecked 固定含 crossing_classification、turn_reachability、resource_execution、physical_clearance、asset_availability、source_authenticity，有 geographicAnchor 时加 geographic_anchor_accuracy、geographic_reprojection。只读时除 upgradeSchema 外所有命令 READ_ONLY_MAP。canEditBoundary（commands.ts:334）= 可编辑且设施无 assetId 且非 overlayOf。
- 会话（editor/session.ts）：`EditorSession = {map（深冻结）, past, future, acknowledgedHash, changeToken}`，HISTORY_LIMIT 100；editSession 失败会话不变，changed=false 不入历史，成功追加事务、清 future、changeToken+1；undo/redo 切换 before/after 并 changeToken+1；isDirty = acknowledgedHash !== contentHash(map)（哈希不含 revision，撤销回已保存内容即干净）；acknowledgeMap 仅在期望哈希一致时确认，导出不调用；prepareImport（dirty 时返回 conflict）、resolveImport（changeToken 变化 STALE_IMPORT；否则重新校验、规范化、再 loadMap，新建 saved 会话，清空历史）。projectController：StoredProject 三份快照 `{mapJson, contentHash, savedAt}`，storageVersion CAS，恢复 draft → checkpoint → previousCheckpoint，编辑器状态单独存并校验。
- 内容哈希（serialization.ts:115-126）：`sha256_hex(UTF-8(canonicalContent))`；去掉顶层 revision；对象键按 UTF-16 码元字典序，但数组下标形键（`^(0|[1-9]\d*)$` 且 < 2^32−1）排最前并按数值升序；丢弃 undefined；JSON.stringify 无空白，数字为 ECMAScript Number::toString（非 JS 实现须复现，含 -0 输出 0 与指数阈值）；数组保序。被 derivedFrom.contentHash、语义补丁与研究接入 baseMapContentHash、结果与编译 mapContentHash、工程快照、map-migrate 报告引用。serializeMap（:87-93）：先校验，按上述排序 2 空格缩进，末尾换行，≤ 10 MiB；解析时同样检查规范文本字节数。sameValue 忽略键序深比较；freezeDeep / isDeepFrozen 支撑身份缓存（recentFor 保留 4 个）。
- check-boundaries.mjs：core = domain、geometry、topology、validation、compiler；禁止导入 react、react-dom、react-konva、konva、three，禁止 DOM 标识符（window、document、HTMLCanvasElement、CanvasRenderingContext2D，属性名除外），禁止导入路径含 UI 目录、`/editor/`、`adapters/files`；tsconfig.core.json 以 ES2023 无 DOM 编译 core 加 adapters/contracts、editor/session、editor/projectController；不约束 core 内部分层。（map-studio 中 UI 目录为 `src/app`。）

## 6. 重写应避免的设计问题

1. commands.ts 过大（1054 行、96 KB），inspectSupport 与 applyMapCommand 靠模块级单例 lastSupport（:338）与 simulated（:348）共享，依赖对象身份相等；应改为显式 prepare / commit。
2. 一次命令校验多遍（:902、:535、:1011、:1037），inspectPlanning 反复调用，性能靠散落的 WeakMap 身份缓存（validate.ts:60、planning.ts:26、roadPath.ts:77-79、serialization.ts:98,120、scene.ts:15）。
3. 「高级图」启发式门控（:140-143 + onlySubdivisionJunctions）；应改为显式能力或策略模型。
4. 业务状态藏在 Source.description 的 JSON 字符串里（quick_trace 识别、底图沿革、MQ01 证据、厂界规范化、入口拆分）；须能读，新数据不应再这样写。
5. 事后差分记账（recordGeometrySources、recordTopologySources、dependencyRefs :243-293），affectedRefs 同时服务 UI 预览，领域与视图混在一起。
6. 常量与工具重复：12 集合列表至少 9 处（topologyEditing.ts:38 缺 assets 与 backgroundLayers），JSON Pointer 转义 8 处以上，ID 分配 5 种方案。
7. 5 个同构错误类，捕获列表在 :571 与 :1007 重复，TopologyError 被无关模块借用。
8. 模块循环：serialization → validate → serviceConnections → semanticPatch → serialization；commands ↔ topologyEditing 靠回调传入 splitRoad；domain 反向依赖 compiler（load.ts:5、results.ts:4）。
9. 版本联合类型渗透各处（shapePoints 与 geometry 分支）；建议加载时统一为 path、保存时按原版本写回，保证 0.1/0.2 原样往返。
10. 「当前版本」不一致：SCHEMA_VERSION 0.3.0，newMap 默认 0.2.0，schemaUpgradeChanges 默认目标 0.2.0，迁移 CLI 只到 0.2.0。
11. spatial-classification-1.0.schema.json 只在单元测试中使用，运行时手写校验，两者已有细微差异。
12. 重复 issue（SERVICE_ACCESS_FACILITY_CONFLICT、DANGLING_REFERENCE 在 0.2+ 各报两次）；服务点连接检查对 0.1.0 不执行。
13. 规则不一致：ZERO_LENGTH_SPAN 只查含 cubic 的道路；近邻检测两套实现（validate 网格限 2000 节点，networkDiagnostics O(n²) 限 2M 对）；asset 宽高在 schema 中可选却是可编辑的必要条件；put 不检查 planning 槽位 ID。
14. 领域错误信息硬编码中文。
15. commandSupport 同时负责能力、依赖闭包、预览数据与模拟执行；建议拆为 capability、dependency、validation、mutation 四层，每条命令声明触及的字段，provenance 由命令主动写入。

## 7. 兼容性要点（必须逐字复现）

三版 schema 原样保留并按 schemaVersion 分派；ID 全图唯一与设施成员双向一致；contentHash 算法（去 revision、特殊键序、JS 数字格式）与规范化序列化格式（排序、2 空格缩进、末尾换行、10 MiB）；所有扩展无损透传，已知命名空间的严格读取器不覆盖不认识的载荷；lineage、spatial_classification、fast_trace.semantic、sr02.planning 载荷格式；编辑器分配的 ID 与来源 ID 命名（source_editor_geometry、source_editor_topology、source_editor_direction、junction_editor_split、movement_editor_split、*_trace_NNN 等）。
