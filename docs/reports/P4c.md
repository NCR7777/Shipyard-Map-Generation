# P4c 阶段报告：旧版脚本移植（通过）

日期：2026-09-25。执行者：主会话。前置：P3f2 已通过，本地提交 5eff49a。审查：独立审查（rv24）「修正后通过」，无阻断，3 项重要、若干次要，修正见「审查修正」。增量复审「修正后通过」：剩下契约测试漏了控制点一处，由执行者修正、控制器核对 diff 即可，不再全面复审；已修正，见「增量复审」。

## 来由

用户 2026-09-25：「旧版脚本是干什么用的，有用就移植」。只读调研代理逐个读了 `../map` 下的脚本，逐个结论见 reports/P3f2.md「旧版脚本」一节。结论只有两样值得移植：

- `BG01_prepare_raster.py`：有校准文件或投影参数时，仓库里唯一能把浏览器导入不了的影像（带投影、需要摆正或太大）变成可导入格式的工具；整厂 GeoTIFF 多数超出它的上限，由仓库外的 `prepare_tiffs.py` 处理；
- 开发服务器的启动与停止脚本。

其余是已有相同副本的命令行工具（`map:*`、类型生成、边界检查），或 EA01、MQ01、GA01、DP 各阶段一次性的修复、质检、验收与性能脚本。

## 改动

- `scripts/BG01_prepare_raster.py`、`tests/python/test_BG01_prepare_raster.py`：从 `../map` 原样复制。与 `../map` 仓库中已提交的版本逐字节相同（SHA-256 一致）；`../map` 工作区里是 CRLF 检出，复制时按本仓库的 `.gitattributes`（`*.py eol=lf`）存为 LF。
  - 脚本以自身位置定位工具根目录，经 Node 与 tsx 调用 `src/domain/load.ts`、`src/adapters/backgroundCalibration.ts`、`src/adapters/rasterFiles.ts` 复核结果；这三个文件在本工具中路径与内容都与旧版相同（内核目录与 2d21c16 一致，P3f2 只改了 `src/domain/commands.ts` 与新增 `accessSeparation.ts`）。
  - 测试读真实 CIMC 地图 `projects/Map_Refinement_20260912/cimc_v02/map.json`，相对路径与旧版相同（本工具与 `../map` 在同一层）。
- `dev-start.ps1`、`dev-stop.ps1`：从 `../map` 复制，默认端口改为 5180（本工具固定端口），其余不变。原件在 `../map` 中未纳入 git（用户工作区里的本地文件）。
- `docs/BG01_CALIBRATION.md`：移植旧版的说明，开头加一节「什么时候用哪一种」（审查后重写为六条）：
  - 普通图片用 P3d1 的调整与量距定比例；
  - 没有坐标、超过浏览器限制的图片先在本地缩小（本脚本不做单纯缩小）；
  - 已有校准 JSON 时直接添加，太大或要摆正时用 `--calibration` 模式；
  - 带投影的中小影像用本脚本，写明输入与输出上限；
  - 整厂 GeoTIFF 用 `prepare_tiffs.py`；
  - rasterio 的来源（`../map/.cache/TIF-tools`）与借用方式、威海的运行结果、混用 conda 通道的风险。
  - 运行说明改为 map-studio 目录与 `paper` 环境。
- `docs/ADR-003.md`：新增 Python 依赖（NumPy、Pillow、pyproj，GeoTIFF 另需 rasterio）的理由、运行环境与放弃的方案，按 AGENTS「新增依赖需在 ADR 中说明理由」。
- `README.md`：进度更新；命令表加启停脚本；新增「离线底图预处理（Python）」一节。
- `docs/inventory/04_GAPS.md`：原先「待用户确认」的各行按用户 2026-09-25 的答复改写。
- `docs/PLAN.md`：P4c 标为已完成。
- `tests/unit/P4c_bg01CoreContract.test.ts`（审查后新增）：守住脚本依赖的内核接口，见「审查修正」。
- 两个启停脚本的注释（审查后）：写明 `dev-stop` 结束整棵进程树的风险与 `-Port` 的存储分离。

## 运行环境

- Python：conda 环境 `paper`（Python 3.11.15，NumPy 2.4.4，Pillow 12.2.0，pyproj 3.7.2；没有 rasterio）。旧版一直在这里运行。
- 首选的 `paper01` 没有 pyproj；用户的 D4 实验正在 `paper01` 中满载运行，没有向它安装任何包。
- 本阶段没有安装、升级或删除任何包。
- PowerShell 7：本会话工具里的 PowerShell 没有解析到 `pwsh`，用完整路径 `C:\Program Files\PowerShell\7\pwsh.exe` 运行；审查者的环境中 PATH 上有 `pwsh` 7.6.6。
- Node 22.18.0，tsx 4.23.13（开发依赖），PROJ 9.5.1（随 pyproj）。

## 验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| BG01 测试 | 在 map-studio 目录：`& "$env:USERPROFILE\.conda\envs\paper\python.exe" tests/python/test_BG01_prepare_raster.py -v` | 5/5 通过：8 种 EXIF 方向、真实 CIMC 帧上的缩放与 EXIF 保持控制点世界坐标、跨 CRS 逐像素重投影（不是仿射拟合）、超过浏览器字节限制的大图被拒、无校准时不报成功且缺 rasterio 时明确说明 |
| 真实 CIMC 处理 | 同一个 python 运行 `scripts/BG01_prepare_raster.py --image ../../projects/Map_Refinement_20260912/cimc_v02/reference/satellite_local.jpg --map ../../projects/Map_Refinement_20260912/cimc_v02/map.json --georeference …/reference/georeference.json --manifest ../../projects/cimc_v01/manifest.json --reference-map ../../projects/cimc_v01/map.json --out <scratchpad>/p4c/cimc_out` | `status: prepared`，`mode: local_affine_resize`，`sourceFilesUnchanged: true`；输出 `background.jpg`（766,274 字节）、`calibration.json`、`receipt.json` |
| 启停脚本 | 先确认 5180 空闲，再用完整路径的 pwsh 运行 `-NoProfile -File ./dev-start.ps1`；GET http://127.0.0.1:5180/；再次 `dev-start.ps1`；`dev-stop.ps1` | 启动后返回 200（vite 进程监听 5180）；端口被占用时第二次启动拒绝（退出码 1）；停止后端口释放 |
| lint、typecheck | `npm run lint`、`npm run typecheck` | 通过 |
| 内核接口契约（审查后） | `npx vitest run tests/unit/P4c_bg01CoreContract.test.ts` | 2/2 通过 |

运行说明：

- 从本会话的工具里调用 `dev-start.ps1` 时，命令会一直等待。原因推断是后台启动的 vite 继承了调用方的输出管道，管道不关闭。在普通终端中运行时脚本应当立即返回（旧版一直这样用），但这一点没有在本机的普通终端中实测。
- 验证时先检查 5180 是否空闲。当时空闲，才运行启停脚本，以免停掉用户自己开着的开发服务器。

## 审查修正

| 审查项 | 修正 | 核对 |
| --- | --- | --- |
| 重要 1：GeoTIFF 的定位不对，调研漏掉了 `../map/.cache/TIF-tools`（rasterio 1.4.4 / GDAL 3.10.3，九厂 TIF 就是 `prepare_tiffs.py` 用它生成的）；BG01 处理不了大部分整厂影像（9 张源 TIF 中 5 张超过 1 亿像素的输入上限，6 张交付底图超过 4096 的输出上限）；「没有 GeoTIFF 验收记录」不准确，审查者用 TIF-tools 跑通了一张真实威海 GeoTIFF | BG01 文档的「什么时候用哪一种」重写：整厂 GeoTIFF 用 `prepare_tiffs.py`，本脚本用于中小的带投影影像；写明两个上限与超大图的报错；写明 rasterio 的来源（TIF-tools，加到 `sys.path` 即可）、威海的运行结果、`conda install -c conda-forge` 混用通道的风险；ADR-003 与 PLAN 同改。TIF-tools 的迁出列为待用户决定（环境变更） | 文档 |
| 重要 2：「大图」的说法与脚本不符：没有校准也没有投影参数时脚本拒绝（`BG_REPROJECTION_INPUT_REQUIRED`），没有单纯缩小 | README、ADR-003、BG01 文档、PLAN 改为「有校准文件或投影参数时」；BG01 文档加一条：没有坐标的大图先在本地缩小 | 文档 |
| 重要 3：BG01 调用的内核接口不在任何门禁里 | 新增单元测试 `tests/unit/P4c_bg01CoreContract.test.ts`：取出脚本里的 TypeScript 程序原样运行（示例地图、1×1 PNG、校准），核对脚本读取的每个字段与拒绝时的字段；随 `npm run test` 运行 | 变异：改名 `inspectRasterBytes`、改名校准结果的 `imageToWorld`，都被这条测试发现（`scratchpad/p4c/mutate_contract.out`） |
| 次要：`dev-stop.ps1` 的风险只写在报告里；`-Port` 示例没说明存储分开 | README 与两个脚本的注释写明 | — |
| 次要：记录不全（Node、tsx、PROJ 版本，实际命令，pwsh 的说法，「立即返回」是推断） | 已补与更正（见「运行环境」「验证」） | — |
| 次要：ADR 没写验证过的版本与 tsx 是开发依赖；对 Node 方案的说法夸大 | 已补；改为「可以用 proj4js 与 geotiff.js，但要新增依赖并重新验证」 | — |
| 次要：旧版行为没写进文档（半成品输出目录、超大图打印回溯）；测试不读 `SHIPYARD_TEST_DATA_ROOT` | BG01 文档、README 写明 | — |
| 次要：P3f2 调研表措辞（`map-compile.ts`、`MQ01_core.ts`、`MQ01_routes.ts` 只是忽略行尾相同；`BG01-display-performance.mjs` 依赖旧版应用的调试钩子） | P3f2 报告的表格已改；结论不变 | — |
| 次要：BG01 文档第 55 行用裸 `python` | 改为与前两条相同的 `conda run … -n paper python` | — |

## 增量复审

- 结论「修正后通过」：重要 1、2 与次要各项已修正；重要 3 大半已修正。
- 剩下一处：脚本用 `calibration.get('controlPoints', [])` 读控制点，契约测试没有核对这个字段；内核改名或去掉它时，脚本不报错，只会悄悄丢掉控制点。修正：测试的校准文档带两个控制点（拟合、检查各一），断言原样返回；ADR-003 的说法改为「门禁会发现接口与字段的变化；改动校准的语义时仍要跑 Python 测试」。
- 顺手改的次要项：BG01 文档中旧版的「没有真实 GeoTIFF 记录」两段标明是旧版阶段的记录；给出借用 TIF-tools 的可执行命令（追加到 `sys.path` 末尾），并说明 `PYTHONPATH` 会让 TIF-tools 的 NumPy 盖过 `paper` 的、没有验证过；P3f2 调研表里 BG01 那一行、本报告对 BG01 文档的描述、04_GAPS 第 38 行的标签都已改。

## 已知限制

- TIF-tools（rasterio 1.4.4 / GDAL 3.10.3）是 `prepare_tiffs.py` 与本脚本 GeoTIFF 自动读取所用的 rasterio 来源；P4c 提交之后，用户决定把它从 `../map/.cache/TIF-tools` 移到本工具的 `.tools/TIF-tools`（见 P3f3）。
- 真实 GeoTIFF 只有审查者的一次手动运行（威海，借用 TIF-tools），没有写成自动测试。
- `dev-stop.ps1` 会结束监听该端口的整棵进程树，只应在 5180 上是本工具的开发服务器时使用（旧版行为）。
