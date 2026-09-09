# M0 阶段报告

日期：2026-09-09。控制器：root；范围：数据契约、纯核心、CLI 与工程最小验证。M1 编辑界面尚未完成，本报告不将技术冒烟标为编辑验收。

## 输入与保护边界

已读取三级 AGENTS.md，以及 map/docs/PRODUCT_SPEC.md、IMPLEMENTATION_PLAN.md、ACCEPTANCE_TESTS.md、SOURCES.md。实际仓库为 paper01，当前 master；开始时 map 只有需求包。修改范围限定 map。原有需求文件保留；论文未提交改动、data/raw 及其他研究目录未修改。

技术环境：Windows / PowerShell 7.6.5 / Node 22.18.0 / npm 10.9.3；Chrome 152.0.7977.76。默认沙箱进程及后续部分 apply_patch 遇 helper_unknown_error；经允许的 require_escalated PowerShell 完成同一工作区内操作，没有将启动错误当作测试通过。

## 代理分工与审查

- m0_core：Schema、生成类型、工厂、解析/校验/序列化、能力清单、道路几何、SceneSnapshot 和适配器契约、合法/非法样例。
- m0_tests：独立单元断言及 CLI 集成、map:validate 实现；保留失败断言，不通过修改期望掩盖缺陷。
- m0_docs：四份中文契约文档；独立只读审查未由其编写的核心，执行摘要、扩展、只读模式和 Scene 隔离断言。
- root：依赖锁定、工程配置、纯核心边界检查、坐标变换与测试、真实浏览器技术冒烟、综合复核与阶段裁决。

审查发现并修复：Ajv 类型守卫与控制字符 lint 问题、负深度预扫描、非有限派生长度、中文资产相对路径、字典原型伪引用、服务点与入口设施归属冲突。未实现的多边形几何、平交分类、路径可达、物理/资源执行和资产真实性明确列入 missingChecks。

## 实际命令与结果

工作目录均为 paper01/map。

| 命令 | 实际结果 |
|---|---|
| npm install --no-audit --no-fund | 退出 0；新增 166 个包并生成 package-lock.json |
| npm ci --no-audit --no-fund | 退出 0；锁文件可重复安装 |
| npm ls --depth=0 | 退出 0；精确版本依赖树无无效 peer |
| npm run schema:check | 退出 0；Schema 生成类型一致 |
| npm run typecheck | 退出 0；应用与无 DOM 纯核心配置均通过 |
| npm run lint | 退出 0；Core boundaries: PASS |
| npm run test | 首轮因缺少待生成例图失败；例图生成后通过；最终数量见下方裁决 |
| npm run test:integration | 14 passed；CLI 退出码 0/1/2/3 和结构化输出均验证 |
| npm run build | 退出 0；存在单包超过 500 kB 的 Vite 提示，未调整阈值掩盖 |
| npx playwright test tests/e2e/M0_smoke.spec.ts | 本机 Chrome：1 passed，React/Konva 无 pageerror |
| npm run map:validate -- examples/M1_synthetic.map.json | 退出 0；synthetic 草稿可装载，保留未知参数/缺少检查警告 |
| npm run map:validate -- examples/M1_invalid.map.json | 预期退出 1；DANGLING_REFERENCE，/roads/rAB/toNodeId，附实体/空间位置 |

样例声明摘要：18facc15d9bc37177935af5867b11b0138f4caed35ba45ad65227102a80c3560。摘要不等于格式化下载文件的字节哈希。

## 交付与限制

已交付 schemas/map.schema.json、src 纯核心、scripts 生成/校验入口、tests 的 M0 测试、examples 两份样例，以及 M0_ADR / M0_DATA_CONTRACT / M0_TEST_PLAN / M0_ADAPTER_CONTRACT。

没有实现 M1 交互闭环，也没有进入底图配准、ZIP、设施编辑、路由编译、外部仿真、三维或 VR。SimulationAdapter 为 documented_interface；非 draft 配置明确 unsupported。现有技术冒烟页面只是 M0 工具链验证，必须在 M1 替换。

## 控制器裁决

M0 通过。最终单元测试 51 passed，CLI 集成 14 passed，真实浏览器技术冒烟 1 passed；类型、lint、Schema 一致性和构建均通过。独立审核代理复测服务点归属冲突及合法对照后确认无 M0 阻塞。允许进入 M1，实现基础编辑与 JSON 往返闭环。

Git 说明：阶段前 master 已比 origin/master 领先一条既有 ENG01 审查提交 46737da；本次新增提交的变更范围仅 map。按已批准的当前分支推送方案保留该既有历史。

