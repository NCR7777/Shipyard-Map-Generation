# BG01：底图显示、对照与调整

## 使用

在原编辑器工具栏点击 **底图**，再点 **添加底图**。可一次选择 PNG/JPEG/WebP 与匹配的校准 JSON，也可先选图片、再在导入候选中选校准资料。检查结果显示后点“添加此底图”；未校准图片只在地图附近初始显示，不能当成准确配准。错误身份、尺寸、像素约定或完整坐标框架不会被自动采用。

选择“调整底图”后矢量编辑暂停。拖动影像平移，拖四角时固定对角点；默认保持当前长宽比，明确取消比例锁后才允许非等比缩放。圆柄绕影像中心旋转；界面正角度为世界 XY 逆时针。X/Y 对应图片左上像素角点，单位米。数值宽高是仿射两条像素基向量的地面长度，已有剪切保留。旋转中心为图片中心；单独改 X/Y 不重构线性四元组。方向键每次 0.1 m、Shift 为 1 m，仅在调整模式且非文本输入时生效。

完成调整后锁定底图。底图始终不进入普通矢量选择集；滚轮缩放、中键平移及“适应底图／地图”仅改变相机。一次完整拖动提交一次事务；Esc、失焦、工程变化取消未提交预览。

透明度 0—100%、显隐、锁定和影像对照均为工程显示偏好。对照模式减淡设施、区域及道路带填充；底图在全部矢量与控制柄下方，厂界只描边。图片本身不推导通行、容量、道路节点或道路安全净空。

## 保存与数据契约

- 原 `assets`、`backgroundLayers.imageToWorld`、`sources` 是唯一权威声明；没有另存位置、宽高、角度或 Konva JSON。
- 六参数 `[a,b,c,d,e,f]` 表示 `X=a*u+c*v+e`、`Y=b*u+d*v+f`。EXIF 归一后左上像素角点为 `(0,0)`，像素 Y 下、世界 Y 上；典型未旋转变换行列式为负。
- 添加、变换、替换、删除均走 `applyMapCommand`、共享校验及原 session 历史。整个 `coordinateFrame`、矢量、槽位和物理值不被底图命令修改。来源与控制点保留；人工调整后 `method=manual`，不认可旧残差或旧精度结论。
- EditorState 增加可选 `backgrounds`，按底图 ID 保存显隐／透明度／锁定，并保存工程对照模式。旧配置仍兼容；显示变化不改地图 hash、revision 或几何历史。
- IndexedDB 升到 v2，保留原三个 store，新增 `assetBlobs`。图片按工程及 SHA 保存原始字节，事务完成后才确认。JSON 重导入可复用本地已经重验的同 SHA 字节；项目切换使用异步代次隔离。
- **单 JSON 不包含图片字节**。本批未新增 ZIP。请保留图片与校准资料；跨设备导入后使用“重新关联同一图片”，SHA 不同会拒绝，必须明确走“替换底图图片”。删除底图仍保留资产字节用于撤销。
- 缺图和损坏图片保留矢量及资产引用。已支持的栅格声明不再触发整图只读；未知扩展、复杂引用、不支持的资产／变换和 GA01 坐标框架保护继续有效。

## 修改文件

| 范围 | 实际文件 |
|---|---|
| 核心命令、保护、仿射几何 | `src/domain/backgrounds.ts`、`commands.ts`、`capabilities.ts`，`src/geometry/backgrounds.ts`，`src/validation/validate.ts` |
| 校准资料核对与真实离线处理 | `src/adapters/backgroundCalibration.ts`、`scripts/BG01_prepare_raster.py`、`docs/BG01_CALIBRATION.md` |
| 字节存储与显示恢复 | `src/adapters/rasterFiles.ts`、`projectStore.ts`、`src/editor/projectController.ts`、`src/ui/useBackgroundAssets.ts` |
| 原界面与画布 | `src/ui/App.tsx`、`BackgroundPanel.tsx`，`src/renderers/2d/BackgroundCanvas.tsx`、`MapCanvas.tsx`、`SpatialLayer.tsx`，`src/compiler/catalog.ts` |
| 回归 | `tests/unit/BG01_*.test.ts`、`tests/python/test_BG01_prepare_raster.py`、`tests/e2e/BG01_assets.spec.ts`、`BG01_editor.spec.ts`、`tests/fixtures/BG01/`；旧测试的固定 IDB v1 读取改成版本无关，旧合法底图只读断言精确更新 |

地图 Schema、npm 运行依赖、旧相机及保存队列保留。Ponytail 审查删除了控制柄与父画布重复的临时预览状态。

## 验收证据与命令

原件：CIMC V02 `map.json` 文件 SHA `0eda616cf8bef738d7e099eb2870ef2698ec0c6378c4f1d2452f0845ac4fe5af`；轻量 JPEG SHA `8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713`，1420×1340。Dalian 使用有原 SHA 依据的源像素网格，逐像素跨 CRS 重投影为 2048×1691 PNG，SHA `f1bf6afe8adc89d9216e6cfdbd519127229adb19929728f9728ca7fa4c85c616`。没有修改原始地图、影像或校准资料。

真实编辑器测试通过用户界面导入文件、拖动、填数值、撤销、保存和刷新；存储故障注入测试单独标为开发服务适配器测试，不冒充生产界面验收。录屏、截图、trace 和机器可读报告保存在本地 `.cache/BG01/`，不默认发布原始影像。

运行新环境前：`npm ci` 安装锁定依赖。本轮已有依赖未变化，未重复安装；测试录屏所需 ffmpeg 仅装入 `.cache/BG01/browsers`。Python 预处理使用现有 `paper` 环境，命令和输入身份链见 [校准文档](BG01_CALIBRATION.md)。

```powershell
npm run schema:check
npm run typecheck
npm run lint
$env:SHIPYARD_TEST_DATA_ROOT = (Resolve-Path .cache/BG01/data-root).Path
npm run test
npm run test:integration
npm run build
# BG01 生产配置已提交；全量生产回归配置保留在本机证据目录。
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path .cache/BG01/browsers).Path
npm run test:bg01
npm run test:e2e -- BG01_assets.spec.ts
npx playwright test --config .cache/BG01/playwright.regression.config.ts
```

本轮最终数量与退出码见末尾收口记录。冻结测试根仅保存逐字节原件副本；不存在的 SR02 A—D 仍返回 `blocked_input`。不能把单元／集成整体退出 1 写成全绿。

## 明确范围

浏览器限制每张≤32 MiB、≤24,000,000 像素；PNG/JPEG/WebP 魔数和头尺寸先验，实际解码再核对。动画、未归一 EXIF、不支持的像素格式明确拒绝并指向本地处理。没有直接浏览器 TIFF、在线地图服务、影像上传、GIS 重配准平台、自动控制点拟合、ZIP、调度、3D 或 VR。

已有八厂轻量影像不等于八厂精度验收：六套旧资料有可闭合身份链，两套需要非线性重投影；威海没有可信独立底图。当前校准验收主要使用 CIMC，性能用 Dalian。原图的影像缺口、灰色掩膜和布局估计仍保持原含义。

原始 GeoTIFF 本轮缺件，且本机没有可选 rasterio；**未验收真实 GeoTIFF 自动读取成功路径**。已实跑轻量影像复制、缩放／EXIF、合成跨 CRS、真实 Dalian 跨 CRS、超限拒绝。正确性审查修复了超 32 MiB 产物误报成功及未支持调色板颜色的准入问题。

本批仅本地提交，不自动推送。性能只比较本轮相同地图、相机和输入轨迹的有无底图成本；不把既有 DP1 全局预算未达标改报为通过。

## 本轮性能与审查

生产构建 `index-BVGtgQTl.js`（SHA `0a41be83c20c1dfde94879f11243cd489989397672f78119084121b2305478d9`），Chrome 152.0.7977.83、Node 22.18.0、Windows 10.0.26200；1440×1000 页面、900×844 画布、DPR 1。浏览器 `--fake-vsync-rate=60` 是 VSync 参考源，不是物理屏幕 60 Hz。原始指标与轨迹：`.cache/BG01/performance-production-02/report.json`。

大连 V02 隐藏／显示底图交错各三轮，每轮真实收到活动输入均超过 10 秒，且实际相机平移和缩放均变化。RAF p95 中位数均为 **18.1 ms**，正式轮最大间隔均 **18.8 ms**；导航中 decode、blob 创建及回收增量均为 0。输入到下一 RAF 时间戳 p95 中位数为 17.8／17.7 ms；这不是绘制完成或屏幕呈现延迟。可见预热有一次 **196.1 ms** 间隔，已保留，原因未确证。仅能结论本输入稳态未见明显退化，不能据此裁决所有图片或 DP 全局预算。

正确性审查和 Ponytail 冗余审查分别执行。正确性修复并复核了：弹窗期间“应用后保存”的草稿提交、数值编辑保留未修改仿射精度、同图重复添加复用资产、超限转换产物准入和不支持的 TIFF 调色板拒绝。冗余审查移除了底图控制柄与父画布重复的预览状态，复用原事务、相机和持久化。性能回执另经独立只读复算。

一个可实际导入的文件副本位于外层 `projects/BG01_Background_Ready_20260914/cimc_v02/`：`map.json` 来自真实编辑器的校准导出，`assets/` 保存同 SHA JPEG，另有校准 JSON 和逐步说明。它只增加底图声明，未修改原件；新增底图会改变地图摘要，旧场景与运行绑定必须重新预检。该数据副本与本地录屏不进入源码提交。

## 最终验收与实际退出码

BG01 六项生产浏览器案例全部通过。对应用户十条验收：

| 验收 | 本轮实际证据 | 裁决 |
|---|---|---|
| 1 校准放置 | 真实 CIMC 图片、原 SHA/尺寸/完整 frame 和标准校准核对，T 精确相等 | 通过 |
| 2 调整、撤销重做 | 真实 100 步平移、固定对角等比缩放、旋转圆柄、数值调整；保留已有剪切及未修改的浮点分量 | 通过 |
| 3 不动矢量/框架 | 完整 JSON 比较只允许背景、资产、来源、revision 差异 | 通过 |
| 4 显示偏好独立 | 0/35/68/100% 透明度、显隐与锁定、对照：hash/revision/历史不变；0% 实际像素全透明 | 通过 |
| 5 矢量仍可编辑 | 锁定底图上真实节点、道路折点及设施边界数值编辑，保留底图变换 | 通过 |
| 6 影像对照 | 原编辑器真实截图，设施/区域与道路带减淡，厂界不遮蔽影像 | 通过 |
| 7 保存/恢复 | 严格 checkpoint 版本 2→3；刷新、工程切换返回、JSON 重导入、关闭页面后重开恢复 | 通过 |
| 8 无漂移/翻转 | 四种真实相机缩放/平移，独立已知 `(u,v)→(u,1340-v)` 像素参考对照，通道误差≤1 | 通过 |
| 9 故障隔离 | 错校准、坏图/超限、缺图、错误 SHA 拒绝；存储坏字节/删除后同 SHA 原图恢复，map/历史不变；迟到结果有开发服务 hook 浏览器证据 | 通过，迟到不冒充生产 UI 全流程 |
| 10 受影响回归 | 原 145 项的最终通过回执齐全，另加恢复案例；历史 SR02 缺件单独列出 | BG01 范围通过；历史缺件仍阻塞 |

| 实际命令（map 目录） | 退出码 | 结果 |
|---|---:|---|
| `npm run schema:check` | 0 | Schema 生成一致 |
| `npm run typecheck` | 0 | 浏览器及无 DOM 核心严格检查 |
| `npm run lint` | 0 | ESLint 与核心依赖边界通过 |
| `npm run test` | **1** | **618 通过、4 失败**；四份 SR02 原件缺失 |
| `npm run test:integration` | **1** | **86 通过、4 失败**；同四份 SR02 原件缺失 |
| `npm run build` | 0 | 生产构建成功；>500kB chunk 提示保留 |
| `npx playwright test --config .cache/BG01/playwright.assets.config.ts` | 0 | 5/5；真实 IDB 迁移、坏字节、配额中断、实际解码、异步代次与 URL 回收 |
| `npx playwright test --config .cache/BG01/playwright.regression.config.ts` | **1** | 首轮 **142/145**；两项 JSON 文件定位歧义及一项标签 canvas 序号过时 |
| `npx playwright test --config .cache/BG01/playwright.recheck.config.ts BG01_editor.spec.ts GA01_reload.spec.ts rectangleEditing.spec.ts` | 0 | **20/20**；含修正后三项及新增成功恢复用例 |
| `python -m unittest discover -s tests/python -p test_BG01_prepare_raster.py -v`（paper 环境） | 0 | 5/5 |
| `npm run map:validate -- ../../projects/BG01_Background_Ready_20260914/cimc_v02/map.json` | 0 | 校准底图工程经过共享 CLI 草稿校验；CLI 不声称读取图片字节 |
| `node scripts/BG01-display-performance.mjs --output .cache/BG01/performance-production-02 --start-signal .cache/BG01/performance-start-20260914.txt` | 0 | 真实大连生产对照，隐藏/显示各3轮 |

生产回归按“文件＋用例名”合并最新结果，共 **146 项去重通过**；这不是声称单次 146/146 执行。初轮失败回执原样保留。仅修正测试的 JSON 输入定位及新增栅格层后的标签画布定位，原颜色、字体大小、几何、坐标框架、锁定、保存和事务断言均保留；产品构建未变化，因此未重跑全部已经通过的用例。独立审查已复核定位依据。

生产回归明确排除历史独立 `MQ01_repaired.spec.ts` 数据修复批次；`BG01_assets.spec.ts` 另在开发服务运行以加载适配器。单元最终输入根为 `.cache/BG01/data-root`；集成回执使用 `.cache/GA01/data-root`，两根中重合输入逐字节相同。SR02 缺件未替换为合成图或删除测试。原件末次复查 **37 份文件 SHA 全部一致**，包括九份 V02 地图、现有影像及所用校准资料。

早期运行中出现过缺 ffmpeg、测试入口模块导入、重复控件定位、原生鼠标整数坐标与计划小数坐标不一致、错误测试数据根、旧底图只读断言等失败；回执保留于 `.cache/BG01/`，修复的是实际问题或精确测试前提，没有关闭校验换取通过。

[机器回执](BG01_TEST_RECEIPT.json) 固定源码内容 SHA（文本统一 LF）、最终生产 JS SHA、命令、退出码、报告和图片摘要。截图及录屏为本机证据，不包含在 Git 源码提交：

- [校准底图叠加](../.cache/BG01/delivery/01-calibrated-overlay.png)
- [影像对照模式](../.cache/BG01/delivery/02-image-comparison.png)
- [保存恢复](../.cache/BG01/delivery/03-restored-image-and-map.png)
- [底图上的矢量编辑](../.cache/BG01/delivery/04-vector-editing.png)
- [同 SHA 重关联后关闭重开](../.cache/BG01/delivery/07-relinked-and-reopened.png)
- [连续真实编辑录屏](../.cache/BG01/delivery/real-editor-workflow.webm)

正确性回执：`correctness-domain-storage.json`、`inputs-final-handoff.json`、`acceptance-closure.json`、`regression-review.json`；冗余回执：`ponytail-final-review.json`，均在 `.cache/BG01/`。后续只停止本批，不扩展 GIS 或调度功能。
