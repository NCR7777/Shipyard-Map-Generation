# 08｜证据与检查边界

固定提交：`6f8b0bea59e6277f4452d102a109ccacfedd3757`。以GitHub连接读取的原始内容为依据；设计目标与事实分开。

## 源码来源

- [S01] README与产品范围：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/README.md
- [S02] 全图能力与地理锚点：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/domain/capabilities.ts
- [S03] App状态与界面：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/ui/App.tsx
- [S04] 界面样式：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/styles.css
- [S05] 命令类型/局部依赖/最终门禁：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/domain/commands.ts
- [S06] 领域目录与拓扑拆分模块：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/domain/topologyEditing.ts
- [S07] TE01交付与历史验收报告：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/docs/TE01_COMPLETION.md
- [S08] TE01机器可读记录（本轮未逐项重跑）：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/docs/TE01_VALIDATION.json
- [S09] 服务到达表单：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/ui/ServiceSemanticsFields.tsx
- [S10] 画布与显示交互：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/renderers/2d/MapCanvas.tsx
- [S11] 同步诊断/路径界面：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/ui/DiagnosticsPanel.tsx
- [S12] 外部适配合同：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/adapters/contracts.ts
- [S13] draft之外的profile未实现：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/validation/validate.ts
- [S14] 18图目标声明（按段读取）：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/tests/helpers/GA01_targets.ts
- [S15] 规范化、哈希与JSON安全：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/domain/serialization.ts
- [S16] 编辑会话与撤销机制：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/editor/session.ts
- [S17] 工程约束：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/AGENTS.md
- [S18] 历史产品合同与当前范围说明：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/docs/PRODUCT_SPEC.md
- [S19] compiler目录只有catalog/scene的基线：https://github.com/NCR7777/Shipyard-Map-Generation/blob/6f8b0bea59e6277f4452d102a109ccacfedd3757/src/compiler/
- [S20] 本轮审查固定提交：https://github.com/NCR7777/Shipyard-Map-Generation/commit/6f8b0bea59e6277f4452d102a109ccacfedd3757

S06/S08在本轮主要通过目录/TE01报告定位，未声称逐行审计其全部内容；实施时仍须阅读源码与实测。

## 人机工程参考

- [W01] W3C Target Size (Minimum)：https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- [W02] W3C Dragging Movements：https://www.w3.org/WAI/WCAG22/Understanding/dragging-movements.html
- [W03] Konva性能文档：https://konvajs.org/docs/performance/All_Performance_Tips.html

## 历史需求资料

本轮通过Library读取了 SHIPYARD_EDITOR_COMPLETION_SPEC.md（基线b29a2c3），并检索GA01_CODEX_TASK.md与初始CODEX_START_PROMPT.md。它们用于还原数据主权、显式连接、未知值与外部执行边界；历史“当前实现状态”不能覆盖本轮最新源码。

## 本轮实际完成与未完成

完成：GitHub最新main身份确认、固定版本核心源码/界面结构审查、历史需求检索、重构规格与任务/验收设计、指导包生成。
未完成：本地原项目依赖安装、原编辑器运行、原应用截图、原生全量回归、真实性能计时、代码修改/推送。原因：本轮是指导交付，且直接源码归档下载遇到DNS失败；不能把仓库历史报告当作本轮运行证据。
UI_BLUEPRINT及其截图只展示拟议布局；不存在真实保存、拓扑运算、调度执行或资产加载实现。原型测试仅限原型自身，见checks。
