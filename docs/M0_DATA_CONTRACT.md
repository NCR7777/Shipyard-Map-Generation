# M0 字段、坐标与 JSON 契约

日期：2026-09-09。Schema 版本：`0.1.0`。结构的唯一可执行定义是 `schemas/map.schema.json`（JSON Schema Draft 2020-12）；TypeScript 类型由该 Schema 生成。本文解释字段含义与算法边界，不能替代语义验证。M1 的高级实体可读取并完整保留，不等于可编辑或可供仿真发布。

## 顶层字段

| 字段 | 含义和约束 |
|---|---|
| `schemaVersion` | 文件结构版本；M1 仅接受 `0.1.0`，其他版本拒绝，不降级保存 |
| `mapId` | 稳定地图标识；与显示名称分离，外部坐标修改不更换它 |
| `revision` | 非负整数修订计数；不是内容相等、冲突检测或缓存有效性的依据 |
| `metadata` | 名称、说明、布局依据；synthetic/conceptual/reference_based/surveyed 不因软件验证而自动升级 |
| `coordinateFrame` | 本地右手笛卡尔轴向和 SI 单位约定；没有地理锚点时不能自行称东/北坐标 |
| `siteBoundary` | 厂区或研究范围边界，支持外环及孔洞；没有边界的基础草稿合法 |
| `nodes` | 以稳定 ID 为键的节点字典；节点 position 是道路端点的唯一坐标来源 |
| `roads` | 稳定 ID 字典；fromNodeId/toNodeId、shapePoints 及显式道路属性 |
| `junctions` | 显式路口节点组和模型声明；不从画布重叠自动生成，不自动独占 |
| `movements` | 有方向的入弧—出弧关系与可选内部几何、冲突资源；不从节点共享推断任意转向许可 |
| `facilities` | 设施边界、用途、出入口引用及可选物理属性；中心不自动成为服务点 |
| `accessPoints` | 设施入口与专用网络节点的明确关联 |
| `servicePoints` | 装卸、泊位或停车等服务位置与网络节点/资源关联 |
| `zones` | 作业、候停、可通行、障碍等区域；显式规则独立于颜色、面积和显隐 |
| `resources` | 容量与控制模型声明及作用对象引用；面积不推导容量 |
| `sources` | 原始依据、合成来源、设计假设等来源记录 |
| `assets` | 资源索引、assets/ 相对路径、内容摘要、媒体类型；不保存文件句柄或 blob URL |
| `backgroundLayers` | 资源引用、像素约定和 imageToWorld 变换及标定依据；不代替矢量几何 |
| `extensionNamespaces` | 以反向域名式命名空间为键，声明 version、category 和可选 description；category 为 metadata/visual/behavior |
| `extensions` | 声明的命名空间及其扩展载荷；核心拼写错误不能藏在未知字段中被忽略 |

实体字典键是实体 ID，实体对象内部不再保存另一份可能冲突的 ID；nodes、roads、sources、assets 等全部实体集合的 ID 也必须全图唯一。重命名、平移或修改折点不能改变既有 ID。删除对象先检查引用；M1 对仍被引用的对象拒绝删除。复制选中道路时将其所需端点纳入复制闭包，生成新 ID 并同时改写复制道路的内部引用。

所有顶层字段都必需存在；未使用的字典为 `{}`，未提供厂界为 `siteBoundary: null`。ID 格式为 `^[A-Za-z][A-Za-z0-9_-]{0,127}$`，名称可用中文。扩展命名空间格式为 `^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)+$`，例如 `org.example.notes`；实体级与顶层 extensions 都须引用顶层已声明命名空间。

## 常用实体字段

| 实体 | 必需字段与最小含义 |
|---|---|
| Node | `name`, `position: Vec3`, `kind`（ordinary/junction/access/service）, `provenance` |
| Road | `name`, `fromNodeId`, `toNodeId`, `shapePoints: Vec3[]`, `direction`（unknown/forward/backward/both）, `widthM`, `heightLimitM`, `massLimitKg`, `speedLimitMps`, `resourceIds`, `provenance` |
| Facility | `name`, `kind`, `boundary: Polygon`, `accessPointIds`, `servicePointIds`, `heightM`, `provenance`；可选 `assetId` |
| AccessPoint | `name`, `facilityId`, `nodeId`, `provenance`；无独立位置副本 |
| ServicePoint | `name`, `kind`, `nodeId`, `resourceIds`, `provenance`；可选 `facilityId`, `accessPointId` |
| Junction | `name`, `nodeIds`, `model`（unknown/explicit_movements）, `resourceIds`, `provenance`；可选 `boundary` |
| Movement | `name`, `junctionId`, `incomingArc`, `outgoingArc`, `allowed`, `resourceIds`, `provenance`；弧引用为 `{roadId, direction}`，direction 为 forward/backward；可选 `internalPath` |
| Zone | `name`, `kind`, `boundary`, `passability`（unknown/allowed/forbidden/explicit_access_only）, `provenance`；可选 `resourceIds` |
| Resource | `name`, `kind`, `capacityUnit`（vehicle/kg/area_m2）, `capacity`, `controlModel`（unknown/exclusive/shared_capacity/directional_exclusive）, `appliesTo`, `provenance`；作用引用为 `{entityType, entityId}` |
| Source | `name`, `category`, `description`；可选 `uri`, `date`，只记录文字，不自动下载 |
| Asset | `path`, `sha256`, `mediaType`, `sourceRef`；可选 `widthPx`, `heightPx` |
| BackgroundLayer | `name`, `assetId`, `pixelConvention`, `imageToWorld`, `method`, `controlPoints`, `provenance` |

设施的 accessPointIds/servicePointIds 是显式成员列表，M1 不要求它们穷尽所有反向归属引用；列出的成员必须存在且设施归属一致。服务点同时给出 facilityId 和 accessPointId 时，两者设施归属必须一致，否则报 SERVICE_ACCESS_FACILITY_CONFLICT。

`Provenance` 的必需字段为 `category`，可选 `sourceRefs`、`fieldSources` 与 `note`。`fieldSources` 以对象字段路径为键、Source ID 为值。`observedLengthM` 是可选登记长度，采用 PhysicalValue，可带来源；它不覆盖派生 lengthM。`corridorPolygon` 是可选人工通行带；存在此类 M1 未支持几何时文档只读。

## 坐标和几何

`Vec3 = [x, y, z]`，各分量都是有限数值。长度和坐标单位 m，质量 kg，时间 s，角度 rad。XY 是地面，Z 向上；平面朝向从 +X 逆时针为正。负坐标合法。地面默认 z=0 只定义本地基面，不代表测得海拔。

对道路 `r`，权威折线为：

```text
points(r) = [nodes[r.fromNodeId].position, ...r.shapePoints,
             nodes[r.toNodeId].position]
lengthM(r) = Σ hypot(points[i+1].x - points[i].x,
                    points[i+1].y - points[i].y)
```

`shapePoints` 只存内部折点，按 from→to 保留顺序，不重复端点；编辑器数值编辑必须保持这种含义。M1 长度是二维水平长度，不是随高差增长的三维坡道长度。零长度道路不能作为有效编辑事务提交。道路长度、中心线端点、包围盒与未来有向弧均为派生值，不能作为独立的可编辑主数据。

二维视窗以像素平移量 `(tx, ty)` 和比例 `s`（px/m）投影：

```text
screenX = tx + x * s
screenY = ty - y * s
x = (screenX - tx) / s
y = (ty - screenY) / s
```

屏幕投影不承载 Z，反投影在声明的编辑平面上进行。移动节点时保留既有 Z；新建二维节点位于 z=0。像素命中容差不是几何容差，不能通过缩放视窗改变几何校验判断。相交、接近、重叠的道路没有显式共享节点时仍不连通；共享节点也不自动补全转向关系。

多边形为 `{outer, holes}`，顶点为 Vec3。每个环至少四个顶点，首尾 XYZ 相同；外环按 XY 逆时针、孔洞顺时针。规范化序列化不重排或反转顶点。M1 只实现多边形结构/引用读取，polygon_geometry 明确为未检查；自交、孔洞包含关系和完整几何有效性待 M2，不能称已通过。含多边形文档整图只读，不提供设施穿越或车辆扫掠检查。

## 道路宽度的显示口径（2026-09-10）

`widthM` 沿用既有单值整段道路横向宽度，不是单车道宽度，也不引入第二份可编辑宽度或边界。旧数据没有统一区分铺装宽度与可用净宽，本轮不改写其数值、状态或来源，也不将其重新认证为净宽；使用前应核对来源，必要时由用户明确修正。该值不能直接证明运输车辆可通行。

已知正有限宽度在视图中取中心线两侧各半，屏幕带宽为 `widthM × camera.scale`。端部和折线连接采用圆形，仅是宽度派生的近似道路带，不是测绘路口边界、车道模型或车辆扫掠。选中只变色；普通节点和关联点仍为固定屏幕标记。未知、不适用、无限制保留原状态，显示为辅助虚线并提示，不推定有限物理宽度。显示开关、中心线和点击容差不改变拓扑。

需要分段变宽时先使用既有拆路，再分别修改宽度；原有拆路引用及能力限制仍适用。本轮没有新道路默认宽度配置，仍需显式输入并记录来源。

## 未知值、来源与扩展

物理数值采用带 `state` 的判别形式，含义不得混用：

| 状态 | 含义 |
|---|---|
| `known` | `{state: "known", value: 正有限数}`，可选 `sourceRef`；值严格大于 0，单位由字段定义 |
| `unknown` | 信息尚不清楚；不等于零、无限或可通行 |
| `unrestricted` | 明确声明该约束无限制，不能从缺值推断 |
| `not_applicable` | 对当前对象无此概念，不能代替未知 |

后三种状态可附 `reason`，不能附 `value`。本版复用的 PhysicalValue 用于正宽度、高度、载荷、速度、登记长度和容量；并非任意科学量的通用数值类型。`0` 不用于表达未知、关闭或不限；动态关闭属于独立场景/事件，M1 尚未实现。

道路方向的 `unknown` 也保持未知，不自动转为双向。默认合成地图只提供合成坐标和来源；宽度、承载、高度、速度或资源容量不凭空填入实测值。

每个对象的来源类别表明几何/属性依据；字段级来源引用必须能解析。来源类别为 synthetic 时，只表示产品或回归夹具；design_assumption 表示设计假设；unknown 表示未确认。surveyed/drawing/imagery_derived 必须由用户提供相应依据，不能靠上传图片或 Schema 通过自动获得。

扩展必须声明命名空间、版本和类别，载荷允许未来 JSON 数据且完整往返保留。未知行为扩展、设施/资源/底图等超出 M1 编辑范围的数据触发整图只读，并报告尚未渲染/尚未检查的能力。保存只读文档也不能删掉不认识的载荷。M1 所有非 draft 发布配置均明确 unsupported。

## 底图与资产约定

Asset 的 `path` 以 `assets/` 开头，使用相对路径，禁止绝对路径、反斜杠和 `..` 路径穿越。资源路径支持中文文件名；拒绝空路径段、单点/双点段、盘符及控制字符，M1 不访问该路径。`sha256` 为 64 位小写十六进制；mediaType 只允许 image/png、image/jpeg、image/webp。M1 不读取资源内容，不声称图片字节与摘要已经核对。

底图 `pixelConvention` 固定为 `top_left_x_right_y_down_exif_normalized`：规范化 EXIF 后图像左上为原点，像素 X 向右、Y 向下。`imageToWorld=[a,b,c,d,tx,ty]` 的单位转换为 `X=a*u+c*v+tx`、`Y=b*u+d*v+ty`；Z 由本地平面约定处理。`method` 为 manual/similarity/affine，`controlPoints` 每项含 `pixel:[u,v]`、`world:[x,y,z]` 与 `role:fit/check`。适配器不得改变此数组排列或偷偷应用另一份 Canvas 变换。

M1 可以保留这些声明并检查引用，底图不渲染、标定不执行、残差不计算。M2 实现标定时须检查退化变换与独立检查点；两个点的比例或三个点的零拟合残差都不是实测精度证明。单独 map.json 不含资源字节；缺图时保留全体矢量几何。

## 规范化、摘要和导入

`serializeMap` 递归排序对象键，使用两空格缩进、UTF-8、LF 和末尾换行。具体遵循 ECMAScript JSON 键顺序：整数索引键先按数值升序，其余字符串键按字典序；这一规则也适用于扩展载荷。数组顺序完全保留，坐标不反复舍入。摘要为文档移除顶层 `revision` 后、按相同对象键序规范化、使用紧凑 JSON（无缩进、无末尾换行）得到的 UTF-8 文本 SHA-256。因此不能直接对下载文件字节求哈希来代替 contentHash。包括 metadata、来源、asset 引用、底图变换和 extensions；排除视窗是因为它从不进入地图文件，而不是忽略地图中的某些未知字段。

外部工具可只修改节点位置而不改 revision。重新导入经过同一 parse→validate→derive 路径；摘要变化使派生场景重新建立。地图摘要不证明二进制资源文件本身存在；资产内容变更需要同步其声明摘要，M1 不读取或验证二进制内容。

输入文件与规范化后的两空格 JSON 文档均限制为 10 MiB、最大嵌套 64 层；紧凑输入即使小于上限，规范化展开后超限也会拒绝。命令产生超限文档时拒绝事务，保持原地图和历史；导出也不生成自身无法重新导入的超限文件。解析器拒绝语法错误、重复对象键和溢出的非有限数值。结构错误、未知核心字段、悬空引用等作为 error；草稿缺参数和能力边界作为 warning。Issue 含 `code`、`severity`、`jsonPath`、`message`、`suggestedAction`，适用时含 `entityType`、`entityId` 和 `location`（文本行列或世界坐标）。不能得到坐标的问题保留 JSON Pointer，不伪造空间位置。

导入先验证候选，硬错误不污染当前有效地图。当前有未保存修改时，提供取消、先导出当前版本、明确放弃并重载。M1 通过下载新文件保存，不监听磁盘，也不直接覆盖原始文件。`map.json`、scenario、运行日志/回放和 editor-state 的数据职责独立，M1 不实现后几类文件的持久化。缺少底图只导致背景能力缺失，节点/道路矢量仍可读取和验证。
