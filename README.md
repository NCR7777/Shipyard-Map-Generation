# 船厂地图 map-studio

船厂拓扑与空间地图编辑器的重写版。与 `../map` 读写同一种地图 JSON（schema 0.1.0/0.2.0/0.3.0），两个工具可以互相打开对方保存的文件；`../map` 保持原样可用。

当前进度：P0 基座、P1 工作台外壳与只读画布、P1B 底图显示、P2a 编辑基座（移动、复制、删除、旋转、撤销）、P2b 绘制（节点、道路与弯道、建筑与区域、量距）、P2c 控制柄（矩形角、多边形顶点、道路折点、弯曲、切向与宽度）、P2d 属性编辑（逐字段提交、物理参数与来源、道路批量）、P4a 浏览器工程（自动保存、Ctrl+S 检查点、刷新后恢复、工程列表、多标签页冲突）、P4b 本地文件（打开并关联、写回、另存为、外部修改检测与冲突处理）、P3d1 底图导入与调整（添加图片或校准文件、调整模式、量距定比例、替换与删除）、P3f1 与 P3f2 用户反馈修正（目录默认收起、边中点插点、道路端点直接拖动、轮廓修改带着入口走、拆出入口节点）、P3b1 入口工具、P4c 旧版脚本移植（离线底图预处理、开发服务器启停）、P3f3 与 P3f4 用户反馈修正（拆出入口不建道路；作业点留在路网上，并不再关联拆出的入口）已完成；下一步 P3b2 作业点与接路，之后是 P3 其余业务对象与拓扑。打开或新建的地图保存在本浏览器中；清除浏览器数据会删除它们，重要的地图请用「文件 › 导出副本」另存 JSON。计划见 [docs/PLAN.md](docs/PLAN.md)，架构决定见 [docs/ADR-001.md](docs/ADR-001.md)，工程规则见 [AGENTS.md](AGENTS.md)。

## 命令

需要 Node ≥ 22.18。先执行 `npm ci` 安装依赖。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器，地址 http://127.0.0.1:5180 |
| `./dev-start.ps1` / `./dev-stop.ps1` | 在后台启动开发服务器（日志写到 `.cache/`，端口被占用时拒绝，`-Force` 先停再启）/ 按端口停止它；需要 PowerShell 7。`dev-stop` 会结束监听该端口的整棵进程树，只在它是本工具的开发服务器时用。`-Port` 可换端口，但浏览器存储按端口分开：换了端口就看不到 5180 上的工程，用 5173 则会与旧工具共用存储 |
| `npm run build` / `npm run preview` | 生产构建 / 预览构建结果（同样使用 5180 端口） |
| `npm run schema:check` | 检查生成的类型与 Schema 一致 |
| `npm run typecheck` | 类型检查：应用整体，以及无 DOM 的内核 |
| `npm run lint` | ESLint 与内核依赖边界检查 |
| `npm run test` / `npm run test:integration` | 单元测试 / 集成测试 |
| `npm run golden:check` | 检查内核在真实地图上的输出与快照一致 |
| `npm run test:e2e` | 浏览器端到端测试（Chrome） |
| `npm run perf:compare` | 与 `../map` 背靠背对比平移、缩放的帧间隔；用法见 `tests/perf/compare.perf.ts` 开头的注释（`PERF_MAP`，可选 `PERF_BACKGROUND`） |
| `npm run map:validate -- <map.json>` | 校验地图 |
| `npm run map:diagnose -- <map.json>` | 只读诊断，可加路径预览 |
| `npm run map:compile -- <map.json>` | 生成 compiled-map |
| `npm run map:migrate -- <旧文件> <新文件>` | 显式迁移，保留原件 |

本工具固定使用 5180 端口，浏览器数据库名为 `shipyard-map-studio`；`../map` 使用 5173 端口和 `shipyard-map-projects`。两边的浏览器存储因此完全分开：新工具不会读写旧工具的工程和底图。旧工具里的底图要带过来，可以把原图片和地图 JSON 一起打开（按 SHA-256 自动匹配，文件名不限），或打开旧工具导出的 zip 包。

依赖真实地图的测试与快照从 `SHIPYARD_TEST_DATA_ROOT` 读取原图：该变量应指向包含 `projects/` 的论文工作区根目录，不设置时默认取本目录上两级。GA01 系列测试另读 `GA01_DATA_ROOT`，通常设成同一个目录。缺少原图时，对应测试报 `blocked_input`，这不代表代码有缺陷。

## 离线底图预处理（Python）

有校准文件或投影参数、但浏览器导入不了的影像（浏览器提示需要预处理，或图片太大、方向需要摆正时），先用 `scripts/BG01_prepare_raster.py` 处理成本工具能导入的图片与校准 JSON，再在「添加底图」时一起选；它不做没有坐标的单纯缩小，整厂卫星 GeoTIFF 多数超出它的上限，用 `projects/TIF_可导入底图_20260915/_processing/prepare_tiffs.py`。它在 conda 环境 `paper` 中运行（NumPy、Pillow、pyproj；GeoTIFF 另需 rasterio），并经 Node 调用本工具的内核复核结果。用法、各种输入方式与限制见 [docs/BG01_CALIBRATION.md](docs/BG01_CALIBRATION.md)，为什么放在这里见 [docs/ADR-003.md](docs/ADR-003.md)。测试：`conda run --no-capture-output -n paper python tests/python/test_BG01_prepare_raster.py -v`（它直接读 `../../projects/` 下的 CIMC 地图，不读 `SHIPYARD_TEST_DATA_ROOT`）。脚本依赖的内核接口另有单元测试守着（`tests/unit/P4c_bg01CoreContract.test.ts`，随 `npm run test` 运行）。

`golden:check` 的退出码：0 表示一致；1 表示内核输出漂移；2 表示 blocked_input 或用法错误；3 表示输入集变化，例如有人编辑了地图，此时需要确认后重拍快照。有意重拍用 `npx tsx scripts/golden.ts write`；地图数量变少时须加 `--allow-shrink`。
