# M2A 空间编辑阶段报告

日期：2026-09-09。控制器裁决：**M2A 通过**。独立核心、CLI、完整工程检查及真实浏览器复验支持本阶段交付；不是 M2B/M3 或真实运输物理验证通过声明。

## 基线、授权和兼容

本轮任务依据 Shipyard_Source_Review_and_Codex_Next_20260909.md。固定审查基线 a8e7b03 与初始 map 文件树一致。先完成 M1.1 保存门禁（宿主提交 cdb1515，目标独立仓库 main 提交 6fa8d71），其实际结果见 [M1.1 报告](M11_STAGE_REPORT.md)。之后开发 M2A；用户直接确认“允许继续”后恢复先前被自动审批误按旧里程碑限制拦截的图层写入。未绕过审批，也未向目标仓库推送未经裁决的 M2A 半成品。

保留现有 React / TypeScript strict / Vite / Konva 工程和锁定依赖，没有重建项目。所有修改限定 map；宿主论文及未跟踪研究文件没有被本任务修改、暂存或提交。map 通过子目录历史提取推送到 NCR7777/Shipyard-Map-Generation 的 main，宿主 origin 配置保持不变。

沿用 Schema 0.1.0 已声明的设施、区域、入口、服务点及 PhysicalValue，未手改生成类型。增加多边形语义校验意味着旧的非法多边形可能被新校验拒绝；不静默修复旧文件。详细边界见 [领域契约](M2A_DOMAIN_CONTRACT.md)。

## 实际交付

| 部分 | 实现及文件 |
|---|---|
| 权威领域编辑 | commands.ts、factory.ts、capabilities.ts：六类选择、明确移动/复制/删除闭包、关联点正反引用、旋转、物理来源、道路拆分与历史 ID 映射 |
| 几何与校验 | geometry/polygons.ts、validation/validate.ts：闭环、绕序、零边、自交、孔洞及有界复杂度；节点近邻和道路中部未连接提示 |
| 场景投影 | adapters/contracts.ts、compiler/scene.ts：设施/区域与 nodeId 派生点坐标、全部孔洞、包围盒、摘要和缺失能力 |
| 二维交互 | MapCanvas.tsx、SpatialLayer.tsx、useSpatialDrawing.ts：实际矩形/多边形绘制、选择、多选、坐标吸附、孔洞和一次事务拖动 |
| 属性及操作 | App.tsx、PropertyPanel.tsx、SpatialPropertyPanel.tsx、RoadPhysicalFields.tsx、空间样式：逐坐标顶点编辑、数值平移旋转、入口/服务点、复制删除、拆路及四态物理参数 |
| 保存协调 | useProjectWorkspace.ts、App.tsx：继续使用完整 map JSON 持久化；新增操作/绘制暂存提示；恢复回调失败暂停写入与导航，重试恢复当前目标，成功后清理旧弹窗 |
| 示例与验收 | M2A_synthetic.map.json、M2A_invalid_polygon.map.json、generate-M2A-examples.ts、M2A 单元/CLI/浏览器用例及 M1.1 新恢复故障回归 |
| 中文文档 | 本报告、M2A_DOMAIN_CONTRACT.md、M2A_USER_GUIDE.md、M2A_TEST_PLAN.md、README 当前状态入口 |

所有领域修改经过原子命令。拖动中间帧只预览；数值属性、关联引用和物理来源一起校验，失败保留原图和历史。道路起终点仍显式点击节点/关联点；背景吸附只给坐标，不自动结束道路或拆分相交道路。道路拆分采用两个新 ID，保留方向/属性/来源，沿革写入声明的 metadata 命名空间。

设施整体移动/旋转须使用可见策略；直接修改边界顶点只更新边界。设施复制自动包含成员点和所需节点，不隐式复制相邻外部道路。入口/服务点位置只保存在权威节点中；设施面积和中心不产生装卸点。unknown、unrestricted、not_applicable 保持不同状态，无来源的新 known 数值登记为 design_assumption。

## 实际运行记录

环境为 PowerShell 7、Node 22.18.0、npm 10.9.3、本机 Chrome。实际使用 npm.cmd，工作目录 paper01/map。以下为本轮命令结果，不引用旧报告充当本轮重跑。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| npm.cmd ci --no-audit --no-fund | 0 | 最终源码冻结后由锁文件安装 166 包；没有新依赖 |
| npm.cmd run schema:check | 0 | Schema 与生成类型一致 |
| npm.cmd run typecheck | 0 | 全应用和无 DOM 核心均通过 |
| npm.cmd run lint | 0 | ESLint 与 Core boundaries: PASS |
| npm.cmd run test | 0 | 170 项 / 10 文件，1.46s |
| npm.cmd run test:integration | 0 | 17 项 / 2 文件，5.77s |
| npm.cmd run build | 0 | 209 模块；JS 802.41 kB / gzip 246.47 kB，CSS 14.01 kB |
| npm.cmd run test:e2e（首轮） | 1 | 27 通过 / 1 失败；9 项 M2A 全通过，新增恢复故障回归发现弹窗残留 |
| npm.cmd run --silent map:validate -- examples/M1_synthetic.map.json | 0 | 旧 M1 草稿 valid |
| npm.cmd run --silent map:validate -- examples/M2A_synthetic.map.json | 0 | 新 M2A 草稿 valid |
| npm.cmd run --silent map:validate -- examples/M2A_invalid_polygon.map.json | 1 | 故意自交样例 invalid；POLYGON_SELF_INTERSECTION / POLYGON_ZERO_AREA 定位边界 |
| npm.cmd run test:e2e（修复后完整复验） | 0 | **28/28 通过**，1.6 分钟；原有 18 项 + M2A 9 项 + 恢复异常 1 项 |
| npm.cmd run dev -- --host 127.0.0.1 | 持续运行 | 174ms 启动，http://127.0.0.1:5173/ 实际 HTTP 200 |

构建大包提示仍存在，没有提高阈值隐藏。早期未接完 UI 时，全局类型检查和 lint 曾失败，不能用当时已通过的核心检查替代；本轮最终源码已重新检查。调用记录另有两次命令错误：核心检查误指向不存在的 tsconfig.domain.json（TS5058），以及恢复弹窗修复后 npm 在宿主目录执行（ENOENT，未读取到 package.json）；之后均在正确配置/目录实际重跑成功。

首轮浏览器失败是实现问题：故障注入下写入隔离与 B 工程恢复摘要均正确，但“最近项目”弹窗残留遮挡真实节点点击。修复成功恢复时关闭最近项目与存储冲突弹窗；未修改测试绕过遮挡。首轮 trace、截图、error-context 保留于 .cache/M2A_first_run_evidence。

本地证据：.cache/M2A_core_gate.json、M2A_core_final_results.json、M2A_unit_final_run.txt、M2A_unit_final_exit.txt、M2A_cli_final.json、M2A_e2e_first_run.txt、M2A_e2e_final_run.txt、M2A_e2e_final_exit.txt、M2A_browser_final_results.json。早期 M2A_engineering_state.json 是接入中失败快照，不是最终 gate。测试临时产物按 .gitignore 排除；它们不混入 map.json 或运行场景。

## 验收与独立审查

root 负责主界面、持久化集成、文档与阶段裁决；project_persistence 负责纯核心与恢复失败隔离，独立只读复审空间图层；local_file_save 负责图层和属性面板，独立核对现有 Konva 的孔洞填充/命中行为；save_baseline_tests 独立构造测试、运行真实 Chrome 并定位失败。未调用论文类 skill，采用已有工程契约和实际测试流程。独立审查未发现剩余阻断项；测试代理确认无未决失败，控制器核验完整浏览器日志、CLI 输出及实际 G02 截图后通过本阶段。

G01—G10 由核心、CLI 和真实浏览器交叉覆盖：60×30 厂房和区域绘制、尺度及保存重开不变、关联引用往返、复制删除闭包、100 中间帧只产生一个拖动事务、非法多边形拒绝、道路拆分长度/方向/来源保留、旧图兼容及未知行为保护、缺失资源仍保留矢量、物理四态和无 DOM 运行。完整映射见 [测试计划](M2A_TEST_PLAN.md)。

保存测试继续区分真实 IndexedDB / 双标签页 / OPFS 文件流与故障注入。新增恢复异常使用一次定向 Object.freeze 故障，验证真实 UI / 数据库的拒绝写入和重试路径，不声称现场发生同类系统异常。OPFS 测试替换选择器；系统原生文件授权、任意本地磁盘写回仍没有人工实测，见 [明确手工步骤](M11_NATIVE_FILE_ACCEPTANCE.md)。

## 已知限制和下一阶段

未应用表单/未完成绘制不是地图正文；切换选中对象或工具可能舍弃暂存输入，应先应用或完成绘制。撤销历史不跨刷新保存。浏览器数据可能被清理，文件句柄不跨刷新保留，普通文件 API 不具备跨应用原子 CAS；JSON 导出仍是必要备份方式。

同址节点与入口/短距服务点标签可能重叠，未实现标签避让。多边形基本检查具有明确顶点/孔洞/坐标上限；不提供测绘级精度认证、曲面或几何布尔运算。设施高度当前保留并显示；道路四项物理值可编辑。缺失二进制资源报告未解析，不把未读取当成已核验。

M2B：底图与资源保存、尺度/方向标定、完整 ZIP 工程往返；当前 ZIP 入口明确禁用。M3：显式转向、资源发布配置、服务点可达性及路径预览。三维、VR、复杂调度、车辆动画、扫掠/转弯/净空/承载物理验证没有实现。SceneSnapshot 已实际服务二维图层；SimulationAdapter 和未来 RenderAdapter 仍为框架无关类型契约，不是假成功实现。
