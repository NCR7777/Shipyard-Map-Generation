# RW01 道路宽度显示与交互验收

日期：2026-09-10。范围：道路宽度显示、既有宽度编辑入口、节点交互和工程显示配置。兼容基线为地图专用仓库 `b514fb7`（宿主仓库 `7cdbbd6` 的 map 子树）。未覆盖原论文改动或四个船厂工程文件。

## 实现与兼容

复用 `widthM`、`PhysicalValue`、`RoadPhysicalFields`、已有领域命令和 `DrawingConfig`。地图 Schema、版本、规范序列化、依赖与锁文件不变；不增加第二份宽度或可编辑道路边界。

| 需求 | 实际实现与验收依据 |
| --- | --- |
| 米制道路带 | SceneSnapshot 完整复制宽度状态/来源/说明；画布带宽为 `widthM × camera.scale`。W01 直接读取实际 Canvas 像素，12 m 在 4/8 px/m 下分别为 48/96 px，选中前后相同。 |
| 近似表达 | 所有道路带先绘制，中心线单独覆盖；圆端、圆形折线连接，不生成路口圆盘，不宣称扫掠或实测路口。 |
| 未知等状态 | unknown/unrestricted/not_applicable 保持原状态，只用辅助虚线及提示；W05 验证无有限宽度带，JSON 完整保留。 |
| 宽路适应视窗 | 派生包围盒含半宽，XY 扩边、Z 不变。W09 用 100000 m synthetic 宽度实际验证浏览器视窗留边；浮点溢出/下溢及极值缩放由 roadWidthScene、M0_coordinates 单元测试验证，并声明数值显示限制。 |
| 宽度编辑与来源 | 宽度位于主要属性区；其他物理参数仍在折叠区。复用四态与数值校验，新增无来源数值登记 design_assumption。W03 验证单事务撤销/重做、刷新、同 revision 外部宽度改动重导入及稳定 ID/引用。 |
| 草稿预览 | 同一投影路径处理节点拖动与有效折点数值草稿；预览绑定地图 hash 和选择，应用/撤销/离开清理。W07 验证预览不改已存地图、100 个拖动帧一次提交及一次撤销。 |
| 点击与节点 | 可见宽路带全部可点击，窄路保留 14 px 命中容差；节点、入口、服务点和控制柄在道路上方，标记保持屏幕尺寸。W02 验证宽边、窄路和关联点选择优先级。 |
| 显式拓扑 | 宽度只影响视图，不创建共享节点或转向。W06 验证道路带相交仍保留分离的端点引用；W10 实际验证入口/服务点的既有节点模式拒绝宽带边缘，新节点模式保留点击位置 `[80,14,0]`，不拆路、不接入原道路，并能一次撤销。 |
| 三个显示开关 | showRoadBands/showRoadCenterlines/showOrdinaryNodes 默认 true，兼容旧 camera-only/六字段记录，明确 false 保留。W04、原绘图配置测试及控制器测试验证独立工程恢复、map/revision/hash/history 不变。 |
| 显示与编辑配合 | 两道路开关全关时隐藏既有道路；未知辅助线只在任一道路开关开启时显示。普通节点隐藏时，选中端点、绘路/选点所需节点及非 ordinary 节点仍显示；W08 验证临时绘路轨迹可见。 |

`widthM` 沿用原有整段道路横向宽度，不等于单车道宽度。旧数据未区分铺装宽度与有效净宽时保留来源并提示核对，未迁移或重新认证旧数值。需要变宽时使用既有拆路，再分别编辑；原有拆路能力限制保留。可选的新道路默认宽度本轮未实现，继续显式填写。

## 已执行检查

环境：Windows、PowerShell 7、Node 22.18.0、npm 10.9.3；浏览器为本机 Chrome，单 worker，临时 Vite 端口 4178。没有安装或升级依赖。

| 实际命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm.cmd run schema:check` | 两版本生成类型一致，Schema 不变 | 0 |
| `npm.cmd run typecheck` | 应用与无 DOM 核心通过；最终 build 再次执行 | 0 |
| `npm.cmd run lint` | ESLint 与核心依赖边界通过 | 0 |
| `npm.cmd run test` | 15 文件，310/310 | 0 |
| `npm.cmd run test:integration` | 3 文件，26/26 | 0 |
| `npm.cmd run build` | 216 模块；JS 866.06 kB、gzip 262.99 kB | 0 |
| `npm.cmd run test:e2e -- tests/e2e/roadWidth.spec.ts tests/e2e/drawingConfig.spec.ts` | 首轮 W01—W09 与原配置 10 项，共 19/19，1.3 min | 0 |
| `npm.cmd run test:e2e` | 最终 Chrome 67/67，3.6 min；原有 57 项及新增 W01—W10 全部通过 | 0 |
| `npm.cmd run --silent map:validate -- examples/M1_synthetic.map.json` | valid 草稿，缺物理信息仍提示 | 0 |
| `npm.cmd run --silent map:validate -- examples/M1_invalid.map.json` | 正确拒绝，DANGLING_REFERENCE 定位 `/roads/rAB/toNodeId` | 1（预期） |

中途失败有记录：新增测试夹具缺少 Source.description、测试未使用类型，均修正；完整单元首轮 307 通过/1 失败，是原 M0 SceneSnapshot 精确断言未包含新增 widthM，按新契约补断言后通过。原有测试没有删除或放宽比较；绘图配置预期只增加新字段。完整 310 项是在极值缩放修复后运行。

像素测试读取真实 Canvas 并合成图层，不检查 Konva 的自报 strokeWidth。8 px/m 使用真实 IndexedDB 的相机记录再刷新；地图经实际 JSON 输入，选中、属性修改和拖动经 UI。主代理已查看 4/8 px/m 截图，节点和宽度主属性可见。截图、像素附件及运行报告保留在本地 `.cache/road_width_visual/`，不提交生成日志或用户地图。

## 审查与边界

project_persistence 实现纯核心，local_file_save 实现 UI/工程配置，save_baseline_tests 编写并执行独立浏览器验收，主代理实现二维渲染、文档并运行最终核心检查。project_persistence 独立审查 UI/配置/渲染；local_file_save 独立审查核心/渲染，各自实现不计入自身独立审查。

两次独立审查均发现同一极值问题：放开适应地图缩放下限后，zoomAt 先逆投影到世界坐标可中间溢出。已改用屏幕偏移比例计算，保留相机合法性检查；新增双向缩放回归并由另一代理只读复核，问题闭合。其余预览生命周期、保存隔离、来源与点击拓扑无阻断项。按项目要求实际使用 Ponytail full 和提交前 ponytail-review；未增加框架、运行依赖、设置平台或第二套历史。

未运行 npm ci（依赖未变），未测 Firefox/Safari、真实船厂测绘精度或实际运输通行安全。构建仍有超过 500 kB 的包体积提示。极端数据受数值和像素精度限制，不作精度保证。宽度带是设计参考；尚无车道系统、调度/车辆动画、3D/VR，也未加入宽度曲线、默认宽度批量覆盖或现场标准认证。


## 最终裁决与文件范围

控制器裁决：RW01 通过。Schema/类型生成、无浏览器核心、保存与 JSON 往返、真实浏览器像素/交互及旧折线、拆路、关联服务点、矩形编辑回归均有本轮实际验证。独立审查发现的问题已经修复并复核，未将通过测试扩大为真实船厂尺度或净空合规结论。

检查输入包括三级 AGENTS.md、PRODUCT_SPEC/IMPLEMENTATION_PLAN/ACCEPTANCE_TESTS、现有物理表单/命令/SceneSnapshot/绘图配置持久化及相关测试。变更为 9 个源码文件（contracts、scene、projectController、coordinates、roads、MapCanvas、App、PropertyPanel、RoadPhysicalFields）、7 个测试文件，以及 README 和 4 份契约/报告文档，共 21 个文件。新文件只有本报告、roadWidthScene 单测和 roadWidth 浏览器测试；未改地图数据、Schema、锁文件或原论文文件。

最终命令与像素记录保存在本地 `.cache/road_width_results.json`、`.cache/road_width_full.txt`、`.cache/road_width_target_results.json` 和 `.cache/road_width_visual/`。提交只含上述相关文本文件，排除测试日志、截图、构建产物及工程数据。依项目 Git 规则提交中文说明，并将 map 子树发布到指定 Shipyard-Map-Generation 的 main，宿主论文远端不作为本轮发布目标。

下一步建议：根据有来源的船厂数据核对道路宽度口径与数值；需要分段变宽时使用已有拆路功能。本阶段结束，不自动开始车道、仿真或三维建设。
