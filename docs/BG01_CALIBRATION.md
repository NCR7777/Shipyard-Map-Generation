# BG01 底图校准与离线预处理

底图只提供空间参考，不改变地图 frame、道路、通行许可或物理约束。文件与变换匹配通过不代表现场定位精度。

浏览器调用 `resolveBackgroundCalibration({image, coordinateFrame, documents})`：`image` 是实际图像字节 SHA-256 与解码宽高，`documents` 为用户选中的 `{name,text}` JSON。成功返回完整六参数、原 frame、来源 SHA/JSON pointer、已有控制点与说明；失败返回 `uncalibrated`、`refused` 或 `preprocess_required`，不会返回假成功。

标准校准 JSON：

```json
{
  "format": "BG01_background_calibration_v1",
  "image": {"sha256": "实际图片的64位小写SHA256", "widthPx": 1420, "heightPx": 1340},
  "coordinateFrame": {"此处放地图完整coordinateFrame对象": "不可只复制原点和旋转"},
  "pixelConvention": "pixel_corner_top_left_x_right_y_down",
  "imageToWorld": [1, 0, 0, -1, 0, 1340],
  "controlPoints": [],
  "sourceEvidence": [{"name": "原georeference.json", "sha256": "实际源文件SHA256", "jsonPath": "/referenceImage"}]
}
```

以上带中文占位值，仅说明字段，不能直接作为有效输入。六参数顺序是 `[a,b,c,d,e,f]`，`X=a*u+c*v+e`、`Y=b*u+d*v+f`，不是 GDAL 的六项顺序。像素坐标采用图像左上**角点**；左上像素中心为 `(0.5,0.5)`。地图 `BackgroundLayer.pixelConvention` 仍使用已有 schema 的 `top_left_x_right_y_down_exif_normalized`，调用层必须保留这里的角点说明，不能暗换成中心。

比较包含全部坐标单位、轴、手性和完整 geographicAnchor，包括 method。标准文档有控制点时保留 `pixel/world/role`；不会拟合或自动把检查点改成拟合点。旧源投影拟合残差只作为原文档证据，不冒充当前 JPEG 或现场精度。

旧 CIMC 等 local JPEG 的 `referenceImage.imageToWorld` 可以接受，但需要额外身份链：manifest 同时绑定实际 JPEG、georeference、含完整 frame 的原 map JSON。也支持显式 source-register 同时给出 `providedImage` 的 path/SHA/尺寸、`georeferenceSha256` 和完整 `coordinateFrame`。只给文件名、原点/角度或缺 SHA 的旧 georeference 不够。CIMC V01 manifest 与原 map 可用于其 V02，因为 JPEG/georeference 字节相同、完整 frame 相同；当前地图内容无需降回 V01。

Dalian/Geoje 的 `sourceBounds -> EPSG3857 -> UTM -> local` 是非线性投影，浏览器返回 `preprocess_required`。`pixel_to_local` 最小二乘拟合不能替代精确重投影。

## 预处理命令

在 `map` 源码目录、已安装 Node 锁定依赖及 Python `paper` 环境下运行。输入只读，`--out` 必须是不存在的新目录。

真实 CIMC 原 JPEG 复制与校准迁移：

```powershell
conda run --no-capture-output -n paper python scripts/BG01_prepare_raster.py --image ../../projects/Map_Refinement_20260912/cimc_v02/reference/satellite_local.jpg --map ../../projects/Map_Refinement_20260912/cimc_v02/map.json --georeference ../../projects/Map_Refinement_20260912/cimc_v02/reference/georeference.json --manifest ../../projects/cimc_v01/manifest.json --reference-map ../../projects/cimc_v01/map.json --out NEW_CIMC_DIR
```

已有标准校准的旋转/EXIF 归一及缩放：

```powershell
conda run --no-capture-output -n paper python scripts/BG01_prepare_raster.py --image INPUT.png --map MAP.json --calibration CALIBRATION.json --max-side 2048 --out NEW_DIR
```

显式源 CRS 与角点仿射的 PNG/JPEG 重投影：

```text
python scripts/BG01_prepare_raster.py --image INPUT.png --map MAP.json --source-crs EPSG:3857 --source-transform A B C D E F --extent XMIN YMIN XMAX YMAX --mpp 1 --out NEW_DIR
```

源 CRS/仿射是操作者明确提供的声明，不推断图像来源或调查精度。目标范围始终是原 map 的本地米制坐标；每个输出像素中心经完整 local→anchor CRS→source CRS 逆变换采样，包含旋转，不做仿射拟合。缩放合成实际整数输出尺寸的比例；控制点像素随 EXIF/缩放变换，世界值及角色保持。

GeoTIFF 自动读取需要 `rasterio`；安装命令为 `conda install -n paper -c conda-forge rasterio`。安装后可省略 `--source-crs/--source-transform`，仍须给 `--extent/--mpp`。自动模式支持有 CRS 的 1/3/4 波段 uint8 栅格并保留 nodata/alpha，其余样本类型明确拒绝，需先做显式辐射处理。

本轮 `paper` 已有 PIL、NumPy、pyproj；没有 rasterio/GDAL，也未获得九厂原始 GeoTIFF。实际运行的是：真实 CIMC 轻量 JPEG 复制、合成 PNG EXIF/缩放、合成 PNG 跨 CRS 重投影，以及 GeoTIFF 缺依赖拒绝。**没有真实 GeoTIFF 成功验收记录。**

输出为 `background.jpg`（无需改采样时原字节复制）或 `background.png`、`calibration.json` 和 `receipt.json`。回执保留输入/输出 SHA、TS 核心内容摘要、frame、实际尺寸与仿射、原件前后不变检查；不在 Python 重写地图 schema 或规范化摘要。源图灰色掩膜仍表示缺少影像，不表示可通行地面。

GeoTIFF 自动元数据路径仅接受明确标记为 gray、RGB 或 RGBA 的 uint8 波段；palette 与未声明颜色含义的波段明确拒绝，需先做辐射/色彩准备。已有本地仿射校准的调色板图仍由 Pillow 正确展开颜色。当前环境缺 rasterio，未声称该可选路径经过真实 GeoTIFF 验收。

显式 CRS 重投影可重复传入 `--source-evidence PATH`：这些原始资料只以文件 SHA 保留在 sourceEvidence / receipt，不作为本地仿射校准接受；`--source-transform` 仍是源 CRS 的像素角点网格，不能传入 pixel→local 拟合。
