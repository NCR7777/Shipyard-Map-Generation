# 项目工程规则（map-studio）

## 定位与授权

map-studio 是船厂地图编辑器的重写版，2026-09-24 经用户授权在独立文件夹中进行全仓重写。`../map` 是仍在使用的旧版工具：不修改、不删除、不依赖其运行时代码。两者必须能互相打开对方保存的地图文件。

本工具是轻量的船厂拓扑/空间地图绘制、服务点标注、保存与 JSON 交换工具，定位为后续调度与仿真系统的数据准备工具。编辑器只导出地图及派生数据、只读导入外部计划与运行结果；不在本仓库建设调度求解、装卸仿真、3D/VR，除非用户以后明确授权。

架构决定见 `docs/ADR-001.md`，分阶段计划与验收标准见 `docs/PLAN.md`。

## 领域模型优先（沿用 map 规则）

- 权威数据是版本化 YardMap JSON（schemas/ 下 0.1.0/0.2.0/0.3.0），不是画布场景树或渲染对象。
- `src/domain`、`src/geometry`、`src/topology`、`src/validation`、`src/compiler` 为内核：不得导入 DOM、React、Konva、`src/app`、`src/editor` 或 `adapters/files`，必须可在 Node 中无界面运行（`npm run lint` 中的 check-boundaries 检查）。
- 世界坐标为本地米制右手系，XY 地面、Z 向上，角度 rad、时间 s、质量 kg；屏幕 Y 向下的转换只在渲染层。
- 节点位置为权威，道路几何由节点与锚点推导；派生长度、包围盒、采样点不得成为第二份主数据。
- ID 稳定且与名称分离；复制生成新 ID 并原子重映射引用。只有显式引用定义连通，相交或接近不等于连接。
- 颜色、图层、隐藏与锁定不改变通行或资源语义。

## 兼容性

- 读写 0.1.0/0.2.0/0.3.0，不静默升级；迁移显式执行、保留原件。
- contentHash 算法、规范化序列化格式、扩展命名空间载荷、编辑器分配的 ID 与来源 ID 命名必须与 `../map` 一致。
- 内核行为以 `npm run golden:check`（examples 与 projects 下全部地图的快照）和单元/集成测试为准。golden 区分「内核输出漂移」（退出码 1）与「输入集变化」（退出码 3，用户编辑了地图时会出现）。有意改变内核行为时，必须说明差异，用 `npx tsx scripts/golden.ts write` 更新快照，并在阶段报告中列出。

## 编辑与交互

- 所有业务编辑经命令接口提交；拖拽、滑块、连续输入只预览，结束时提交一个可撤销事务。
- 删除、拆分、合并、整体移动要么更新引用，要么整笔拒绝；失败保留输入与当前有效地图。
- 草稿绑定工程与地图版本，过期不能提交；相机移动不使草稿失效。
- 所有操作只定义一次（操作注册表），菜单、工具条、快捷键、命令面板和帮助共用该定义。

## 工程实现

- TypeScript strict + React + Vite；画布为单张原生 canvas，按样式批量绘制（ADR-002），不引入图形库或第二套渲染引擎。
- 编码前读取 `.agents/skills/ponytail/SKILL.md`（full）；提交前读取 `.agents/skills/ponytail-review/SKILL.md` 做冗余审查，并另外做正确性检查（来源见 `.agents/skills/UPSTREAM.md`）。不上新框架、不做推测性平台；新增依赖需在 ADR 中说明理由。
- 浏览器输入、JSON、图片视为不可信输入；本地优先，不上传、不加遥测。
- 与 `../map` 的浏览器存储隔离：开发与预览固定 5180 端口，浏览器数据库名 `shipyard-map-studio`；不得改回 5173 或旧库名，否则会读写旧工具的工程与底图。
- 重计算进入 Worker 时保留纯计算接口、任务 ID，并丢弃过期响应。

## 验证与交付

- 以 package.json 为准维护命令。每阶段至少运行：schema:check、typecheck、lint、test、test:integration、golden:check；有界面后加 build 与 test:e2e。
- 新功能配验收测试；不通过修改或删除失败测试掩盖问题。报告实际执行的命令与结果，区分通过、失败、未运行；缺数据导致的 blocked_input 单独列出。
- 依赖阶段未通过审查和提交，不开始下一阶段（沿用 paper01 规则）。每个阶段由独立审核者做只读审查（冗余与正确性），修正并复审后在本地提交。
- 推送：当前分支 d4/rasc 没有上游，推送会在远端新建分支，属于 paper01 规则中的「改动远端」，不推送。用户 2026-09-26 授权「每个阶段通过后都自动推送」：阶段通过审查并在本地提交后，把该提交的 `map-studio` 目录作为新提交快进推送到 GitHub 仓库 Shipyard-Map-Generation 的 main。
  - 方法：`git commit-tree <本地提交>:map-studio -p <远端 main 当前提交> -m <中文说明>`（不带 `-m` 会从标准输入读说明），`git push https://github.com/NCR7777/Shipyard-Map-Generation.git <新提交>:refs/heads/main`，推送后 `git ls-remote` 核实；本地 `publish/map-studio-YYYYMMDD` 分支指向当天最后一次推送的提交（同一天再推时用 `git update-ref` 带旧值前移）。阶段报告在被推送的目录里，写不进自己的推送 SHA，所以推送 SHA 记在下一阶段报告的「前置」一行，并在交付说明里告诉用户。
  - 只快进，不强推；推送前 `git ls-remote` 看到的 main 必须等于本地最新的 `publish/map-studio-*` 分支所指提交（即本阶段报告「前置」记下的上一次推送），不一致时停下报告。
  - 该仓库是公开的（未登录可访问），推送的每个阶段报告都会公开。推送前检查树中没有原始数据、密钥、受限明细、未授权源码、本机绝对路径。受阻如实记录 `GIT_PUSH_PENDING`，不把本地提交称为已推送。
  - 与 paper01 AGENTS「阶段通过后……推送当前工作分支」的差异：用户的自动推送指的是 Shipyard-Map-Generation（此前的推送都是它）；推 d4/rasc 会在论文仓库 Paper-Release-burstiness 新建分支并带出 D4/RASC 研究提交，仍需另行指示。Shipyard main 上只有每个阶段的目录快照，逐阶段的开发提交留在本地 d4/rasc。

## 数据真实性

手绘或合成布局标 synthetic/conceptual；有底图但未核验标 reference_based；不自动标 surveyed。未知物理值不填虚构实测值。运行状态、任务时刻与仿真结果不写回静态地图；地图变更后旧结果仍绑定旧摘要。
