> 当前工程状态：M0 + M1 + M1.1 + M2A + M2A.1 已完成。支持保存恢复、空间编辑、服务点画布定位、设施/区域显式归属、边界代理/内部路径声明、未应用输入保护及双版本 JSON/CLI。此次实际验证：230 项单元、26 项集成、36 项 Chrome 测试全部通过，Schema/类型/lint/构建通过。见 [M2A.1 阶段报告](docs/M2A1_STAGE_REPORT.md)、[使用指南](docs/M2A1_USER_GUIDE.md)、[Schema 兼容合同](docs/M2A1_SCHEMA_COMPATIBILITY.md) 和 [结构化验证记录](docs/M2A1_VALIDATION_RESULTS.json)。本目录运行 npm ci、npm run dev -- --host 127.0.0.1。当前仅 draft 和局部接路检查；[M3A 是后续实施计划](docs/M3A_IMPLEMENTATION_PLAN.md)，没有装卸仿真/资源执行。底图和 ZIP 属 M2B，3D/VR 未实现。系统文件授权待按[手工步骤](docs/M11_NATIVE_FILE_ACCEPTANCE.md)核验。下方原开发任务包保留为历史。

# 船厂空间布局编辑器：Codex 开发任务包

版本：需求建议版 1.0，2026-09-09。

这是一组开发任务、架构约束与验收标准，不是已经开发完成的软件，也不是已验证的船厂地图。它不包含已经实现的应用、JSON Schema、仿真引擎或三维模型。

## 使用

把本包放入一个新的项目目录。若放入已有仓库，请合并而不是覆盖原 AGENTS.md，先检查现有工程。然后将 CODEX_START_PROMPT.md 的内容发给 Codex。

持久工程规则见 AGENTS.md；完整产品与数据要求见 docs/PRODUCT_SPEC.md；按阶段开发见 docs/IMPLEMENTATION_PLAN.md；可执行验收要求见 docs/ACCEPTANCE_TESTS.md。技术依据和边界见 docs/SOURCES.md。

首次任务只要求完成 M0 和 M1。M1 是一个可运行、可验证的竖向闭环，不代表完整第二层地图工具已经完成。M0 的数据契约应覆盖后续实体，但不应一次实现所有高级功能。

## 最终产品

面向浏览器的船厂空间模型编辑器，用于手工设计、基于参考底图描绘和管理多套船厂布局。地图以框架无关、可直接编辑的 JSON 保存，后续由二维运输仿真、Python/Codex 工具和三维渲染适配器读取。

第一版不建设全栈数字孪生平台，不运行真实派车，不声称大型构件扫掠安全，不需要账户、云数据库、微服务、在线地图服务或 VR 硬件。

## 核心原则

JSON 保存船厂领域模型，不保存画布场景树。空间几何、网络连通、资源规则、运行场景、运行状态、编辑器状态分别定义。

导入参考图不自动等于真实地图；手绘布局不自动等于实测布局；结构校验通过不自动等于真实运输可执行。每一种结果应有准确标签。

## 当前工程入口

上文为初始任务包说明，原文保留。实际工程已在本目录完成 M0/M1、M1.1、M2A 和 M2A.1；当前使用方法见 [M2A.1 使用指南](docs/M2A1_USER_GUIDE.md)，实现状态和限制见 [M2A.1 阶段报告](docs/M2A1_STAGE_REPORT.md)。旧 [M1 能力清单](docs/M1_CAPABILITIES.md) 保留为历史。数据契约见 [M0 字段与坐标文档](docs/M0_DATA_CONTRACT.md)，架构决策见 [M0 ADR](docs/M0_ADR.md)。检查命令和结果以各阶段报告为准。

在本目录运行 `npm ci`、`npm run dev -- --host 127.0.0.1` 启动本地应用；无浏览器验证使用 `npm run map:validate -- examples/M1_synthetic.map.json`。本次地图与消息示例均为 synthetic，不是实测船厂或真实运输记录。
