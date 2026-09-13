# 03｜架构与数据重构

## 1. 保留什么，改变什么

保留当前技术栈、JSON Schema、MapCommand/applyMapCommand、editSession/undo/redo、ProjectController、LocalFileController、纯几何/拓扑/诊断内核、SceneSnapshot和DP1显示优化。[S02–S17]
不为了“完整重构”换React、引入第二个画布引擎、搭建微服务、通用插件权限系统或另建历史/持久化数据库。

重点改变：App中的操作编排、交互状态与界面壳；commands中的领域规则组织；补齐已知类型命令与资产生命周期；将声明接口变成可测试外部交接。

## 2. 目标依赖边界

```text
ui/workbench、ui/panels、ui/dialogs
           ↓
editor/interaction、selection、operationDispatch、drafts
           ↓
domain/commands（唯一提交边界）→ geometry / topology / validation
           ↓                                     ↓
editor/session + projectController          compiler（派生输入/场景）
           ↓                                     ↓
adapters/files/storage/assets            adapters/external（外部合同）

renderers/2d 只接 SceneSnapshot + InteractionPreview + ViewState + 回调
runtimeOverlay 只读，不能成为编辑命令隐式数据源
```

文件组织是建议，不强制创建每个空目录。拆分时保留现有公共导出路径作为兼容门面；先迁出纯函数，再迁有状态逻辑，不同时改全套Schema与UI。

建议：
- `ui/App.tsx`仅负责组装Workbench、Provider/容器和项目入口；不承担画路引用维护。
- `ui/workbench/`包含顶部菜单、上下文工具条、对象面板、属性面板、问题抽屉、状态栏。
- `editor/interaction/`含一个判别联合状态与事件reducer；允许本地hook包装，不为此默认引入状态机大依赖。
- `editor/operations/`统一action registry、命令请求、影响预览、确认、提交；它不是第二个命令执行器。
- `domain/commands/`按nodeRoad、spatial、service、resource、slot、asset分组，通过同一个事务门面调用。
- 当前 `topologyEditing.ts`拆路/合并规则按需要分文件保留；移除重复代码前先建立特征测试。
- MapCanvas对`ui/useFrameCamera`等反向依赖可移到editor或共享view模块，保持renderer不决定产品业务。

不以“App必须少于300行”验收。验收是互斥状态可枚举、职责明确、逻辑可测试、减少重复取消/保存/授权处理。

## 3. 单一提交链

所有入口（菜单、工具条、右键、快捷键、属性、诊断修复）提交同一种action，再构造同一种MapCommand。

```text
输入草稿
 → 解析有限数值/单位
 → commandSupport/影响闭包/候选验证（复用现有）
 → 必要时影响预览与用户确认
 → 校验工程ID与changeToken仍一致
 → applyMapCommand
 → 固定coordinateFrame断言 + 语义/空间约束检查
 → 更新来源/沿革 + 一次事务
 → 失效派生缓存 + 恢复保存队列
```

已有 `commandSupport` 对部分拓扑操作会试运行候选，这不是必须推翻的问题。应测量是否重复大量计算，再考虑复用不可变的PreparedOperation；不得缓存可修改对象后绕过最终验证。
所有PreparedOperation都必须绑定基础地图身份/版本以及命令内容，提交时过期拒绝。预览分配的ID由提交/重做复用，不在mousemove或React render中反复生成。

建议支持结果分为：allowed；requires_confirmation；blocked。结果含稳定错误码、中文摘要、JSON Pointer、受影响实体、可执行建议。UI只翻译和呈现，不自行重写领域判定。

## 4. 能力与保护

显示、选择、查看属性、编辑、删除、发布分别判断。对象类型非空不能直接锁住无关已知对象，但未知全局行为扩展可能依赖整个图，不能以“扩展字段没变”证明安全。

既有几何锚定限制已修复，应增加回归而非再造一套：普通命令前后整个coordinateFrame深度相等。外部导入不同框架是明确替换/新项目流程，不属于普通编辑。fit/pan/zoom/视图旋转都不修改世界数据。

层锁定属于编辑权限；隐藏属于显示，两者不改变通行或参与诊断的集合。拓扑操作检查修改前和修改后依赖，特别是被合并保留的目标节点、目标路口和资源。

未取得安全规则的复杂几何操作保留限制，但必须为常见类型实现可用替代：内部道路在所有者内精修、服务点受约束移动、厂界调整、槽位更新。不能把所有有资源引用的图永久限制为改名称。

## 5. 数据、哈希与版本

`map.json`唯一静态主数据；保持0.1.0/0.2.0兼容。界面变化、动作菜单变化不需要升级地图Schema。
只有新增无法用当前语义正确表达的内容才做显式Schema/已知扩展版本增量，同时给出迁移、保留原件与降级限制。不得借用unknown metadata扩展实现未验证行为。

当前contentHash是递归排序对象键、保留数组顺序的紧凑JSON SHA-256，排除顶层revision；其他声明仍参加，包括来源、底图等。[S15]
当前字节SHA-256与contentHash分开命名。不能为了减少重算静默修改hash算法；可在内部建立geometry/topology依赖缓存，但发布身份仍使用原mapContentHash。

每种版本各司其职：schemaVersion；mapId；revision；mapContentHash；compilerVersion；rulesVersion；profileVersion；packageVersion；scenarioId/version/hash；runId；协议版本。不要把日期/文件名当唯一身份。

手工调整后保留原始总来源，字段级新增design_assumption或明确manual_edit来源记录，不能继续声称新坐标直接来自原影像。沿用geometrySources与lineage，限制日志膨胀，避免一次mousemove一条来源。

## 6. 草稿、空间错误与发布

结构/引用损坏不能变成有效工程；解析失败保留原文件和当前有效图，不自动补造节点。
可解释的未完成信息允许保存草稿。例如未知宽度、未声明转向、待确认入口。不能为保存或导出自动补为40m/全通/容量1。
已存在的空间冲突应可列示；新编辑的检查规则需要明确“是否产生或扩大相关冲突”。复用GA01/TE01对几何等价拆分的处理，避免原图别处问题阻止无关重命名。
声明发布配置按外部消费者需要检查，草稿校验不承担所有运行语义。建议把检查计算与发布决策分离，复用现有Issue和诊断内核。

## 7. 性能策略

先记录18图/最大图/明确标synthetic的放大夹具的操作基线，再优化。
已有useFrameCamera、createDisplayIndex/selectDisplay、标签布局及memo回调必须保留。不能为清晰命名而退回每个鼠标事件全图React更新。
拖动时仅改交互预览，结束后验证提交；地图哈希仅在提交/需要时更新，不在每帧serializeMap。
高代价诊断、编译、ZIP和栅格解码使用异步/Worker的条件是实测或明确不能阻塞的I/O；结果带taskId、projectId、mapHash、规则版本，取消或失配丢弃。不要让过期返回覆盖当前图。
历史当前保留100条包含before/after的快照事务。[S16] 测量内存后可在同一session机制增加字节预算、共享结构或检查点；不默默丢历史、不另建第二套Undo引擎。
对象列表/转向表可虚拟化；显示裁剪不能裁掉选中对象、正被编辑的控制点或诊断定位标记。
