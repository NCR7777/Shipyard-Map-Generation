> 本地核验补记：实际收到的 ZIP 仅含 AGENTS_APPEND.md、CODEX_TASK.md 和本文件，未附技能。经用户授权，已从下列固定提交安装两份项目技能并补齐 MIT；三种 blob 哈希均匹配。使用的是项目技能，不是完整插件安装。以下保留原来源说明。

# Ponytail 来源与核验

本包包含两份项目级编码技能及其MIT许可证，没有应用运行依赖、MCP服务或生命周期执行脚本。
它不是已重构后的 Shipyard-Map-Generation，不会自动修改你的仓库或 Codex 配置。

上游：https://github.com/DietrichGebert/ponytail
读取提交：356918eba965ee1eac64bd3a7f0dd02108350de5（本次读取时main）
读取日期：2026-09-09

两个SKILL.md及LICENSE使用GitHub连接读取；写入附件后重新计算Git blob SHA-1，与上游返回值逐一一致：

- skills/ponytail/SKILL.md → .agents/skills/ponytail/SKILL.md
  - 6637 bytes；02c0712c86277d49d18a77da3a2b825657bf02d1
- skills/ponytail-review/SKILL.md → .agents/skills/ponytail-review/SKILL.md
  - 2383 bytes；e137a855bd87119a4517895a1000a59b0999e1b8
- LICENSE（分别随两技能附带）
  - 1071 bytes；715d483338cea4365f0d91a27799cf61226d6bcf

项目级技能加载依据：https://developers.openai.com/codex/build-skills
AGENTS长期规则依据：https://developers.openai.com/codex/agent-configuration/agents-md

使用：将本包内容合并入你的项目根目录（包含隐藏目录.agents）；不要覆盖已存在的同名技能/规则，先核对。让Codex先合并AGENTS_APPEND.md，再读取CODEX_TASK.md实际开发。现有会话未发现新技能时重开会话；直接读取技能文件仍须如实区分于完整插件安装。
本包刻意不用自动生命周期hooks；不需要为了此项目执行全局安装，也不要把技能包npm安装成浏览器应用依赖。

代码审查基线：https://github.com/NCR7777/Shipyard-Map-Generation/commit/89044af6cfe97f78c5191dc194805adf22c90b7a
审查重点：SpatialLayer.tsx、useSpatialDrawing.ts、SpatialPropertyPanel.tsx、App.tsx、commands.ts、polygons.ts、factory.ts、model.ts、AGENTS.md，以及M2A1_STAGE_REPORT.md。
本次容器尝试 git ls-remote 失败：Could not resolve host: github.com。未在容器运行项目构建/测试、未安装Codex插件、未修改或推送远程源码。源码事实来自GitHub连接；测试通过数量仅来自仓库报告。

几何参考：
- https://konvajs.org/docs/react/Transformer.html
- https://konvajs.org/docs/select_and_transform/Keep_Ratio.html
- https://konvajs.org/api/Konva.Transformer.html

CODEX_TASK.md 与 AGENTS_APPEND.md 是本次拟议开发规则，不是上游Ponytail原文。
