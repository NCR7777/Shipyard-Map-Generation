# 技术依据与边界

检索日期：2026-09-09。以下是官方/标准维护方资料。它们支持技术约定和工具能力，不证明本需求方案已实现，也不证明地图具有现实准确性。需求中的模块划分、字段组织、分期与验收是本项目的工程建议。

1. OpenAI，Codex Best practices：复杂任务先规划、使用AGENTS.md保存可复用的项目规则。
   https://developers.openai.com/codex/learn/best-practices
2. OpenAI，Custom instructions with AGENTS.md：项目指令文件的发现和使用。
   https://developers.openai.com/codex/agent-configuration/agents-md
3. Konva，Save and Load HTML5 Canvas Stage Best Practices：较复杂应用应保存应用状态，再由状态生成视图；不应把画布序列化视为完整领域模型。
   https://konvajs.org/docs/data_and_serialization/Best_Practices.html
4. Konva，React integration：React二维Canvas组件与事件支持。
   https://konvajs.org/docs/react/index.html
5. JSON Schema，Draft2020-12：JSON结构和校验契约。跨对象引用、几何和业务不变量仍需另外实现。
   https://json-schema.org/draft/2020-12
6. IETF，RFC7946：GeoJSON采用WGS84，经纬度以度为单位，不能直接把本地米制坐标冒充标准GeoJSON。
   https://www.rfc-editor.org/rfc/rfc7946
7. Khronos，glTF2.0规范3.4：右手坐标、+Y向上、长度米、角度弧度。项目内部选择Z-up需通过适配器转换。
   https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
8. MDN，showSaveFilePicker：可用性受浏览器与安全上下文限制，需要普通导入/下载备选，不应承诺任意浏览器静默改本地文件。
   https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker
9. Eclipse SUMO，PlainXML：网络区分节点、边及显式连接，供后续输出适配参考；首版不因此声称完整兼容SUMO。
   https://sumo.dlr.de/docs/Networks/PlainXML.html

浏览器、依赖与官方文档可能变化；Codex实施时应根据实际仓库、兼容性与锁文件核验，不凭本包中的日期固定依赖版本。
