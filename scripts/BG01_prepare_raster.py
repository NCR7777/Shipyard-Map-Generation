"""Prepare a SHA-bound, EXIF-normalized local background in a NEW directory.

Reuse the TypeScript core for the full map/frame and calibration contract. Local
affines compose orientation and resize exactly. CRS reprojection samples through
pyproj at every output pixel centre; no fitted source-pixel affine is substituted.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys

import numpy as np
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
FORMAT = 'BG01_background_calibration_v1'
PIXELS = 'pixel_corner_top_left_x_right_y_down'
MAX_SIDE = 4096
MAX_SOURCE_PIXELS = 100_000_000


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def compose(first, second):
    """Return first(second(pixel)); coefficients are [a,b,c,d,e,f]."""
    a, b, c, d, e, f = first
    g, h, i, j, k, l = second
    return [a*g+c*h, b*g+d*h, a*i+c*j, b*i+d*j, a*k+c*l+e, b*k+d*l+f]


def orientation_to_raw(orientation, width, height):
    return {
        1: [1, 0, 0, 1, 0, 0], 2: [-1, 0, 0, 1, width, 0],
        3: [-1, 0, 0, -1, width, height], 4: [1, 0, 0, -1, 0, height],
        5: [0, 1, 1, 0, 0, 0], 6: [0, -1, 1, 0, 0, height],
        7: [0, -1, -1, 0, width, height], 8: [0, 1, -1, 0, width, 0],
    }[orientation]


def affine_valid(value):
    return (len(value) == 6 and all(math.isfinite(v) for v in value)
            and math.isfinite(value[0]*value[3]-value[1]*value[2])
            and value[0]*value[3]-value[1]*value[2] != 0)


def core_contract(map_path, identity, document_paths, image_path=None):
    """No Python copy of YardMap schema or canonical content-hash rules."""
    node = shutil.which('node')
    if not node:
        raise ValueError('BG_NODE_REQUIRED: install the editor Node dependencies with npm ci')
    program = """
import { readFileSync } from 'node:fs';
import { loadMap } from './src/domain/load.ts';
import { resolveBackgroundCalibration } from './src/adapters/backgroundCalibration.ts';
import { inspectRasterBytes } from './src/adapters/rasterFiles.ts';
const input = JSON.parse(readFileSync(0, 'utf8'));
const loaded = loadMap(readFileSync(input.mapPath, 'utf8'));
if (!loaded.ok || !loaded.report.ok) throw Error('BG_MAP_INVALID: shared core rejected map');
const frame = loaded.map.coordinateFrame;
let rasterHeader = null;
if (input.imagePath) {
  try {
    const bytes = readFileSync(input.imagePath);
    rasterHeader = inspectRasterBytes(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (rasterHeader.width !== input.image.widthPx || rasterHeader.height !== input.image.heightPx) throw Error('RASTER_DIMENSION_MISMATCH');
  } catch (error) { throw Error('BG_OUTPUT_RASTER_REJECTED: ' + (error.code ?? error.message) + '; use a smaller --max-side or explicitly normalize the source'); }
}
const result = input.documents.length ? resolveBackgroundCalibration({image:input.image,coordinateFrame:frame,documents:input.documents}) : null;
console.log(JSON.stringify({coordinateFrame:frame,contentHash:loaded.contentHash,calibration:result,rasterHeader}));
"""
    payload = {'mapPath': str(map_path), 'image': identity, 'imagePath': str(image_path) if image_path else None,
               'documents': [{'name': p.name, 'text': p.read_text(encoding='utf8')} for p in document_paths]}
    environment = {**os.environ, 'TSX_DISABLE_CACHE': '1'}
    result = subprocess.run([node, '--import', 'tsx', '--input-type=module', '-e', program], input=json.dumps(payload),
                            text=True, encoding='utf8', capture_output=True, cwd=ROOT, env=environment)
    if result.returncode:
        raise ValueError('BG_CORE_CHECK_FAILED: ' + result.stderr[-1800:])
    return json.loads(result.stdout)


def reproject(image, source_crs, source_affine, frame, extent, mpp):
    from pyproj import Transformer
    anchor = frame.get('geographicAnchor')
    if not anchor or anchor['coordinateOrder'] not in ('easting,northing,up', 'E,N,Z'):
        raise ValueError('BG_ANCHOR_REQUIRED: reprojection needs a declared easting/northing anchor')
    if not affine_valid(source_affine):
        raise ValueError('BG_SOURCE_AFFINE_INVALID')
    xmin, ymin, xmax, ymax = extent
    if not all(math.isfinite(v) for v in extent) or not xmin < xmax or not ymin < ymax or not math.isfinite(mpp) or mpp <= 0:
        raise ValueError('BG_OUTPUT_GRID_INVALID')
    width, height = math.ceil((xmax-xmin)/mpp), math.ceil((ymax-ymin)/mpp)
    if not 1 <= width <= MAX_SIDE or not 1 <= height <= MAX_SIDE:
        raise ValueError('BG_OUTPUT_PIXEL_LIMIT: choose a larger --mpp; maximum side is 4096')
    transform = Transformer.from_crs(anchor['crs'], source_crs, always_xy=True)
    # Only a projected, metre-based target anchor may be rigidly combined with local metres.
    if not transform.source_crs.is_projected or any(axis.unit_conversion_factor != 1 for axis in transform.source_crs.axis_info[:2]):
        raise ValueError('BG_ANCHOR_UNITS_UNSUPPORTED: target anchor must use projected metres')
    a, b, c, d, e, f = source_affine
    determinant = a*d-b*c
    cosine, sine = math.cos(anchor['rotationRad']), math.sin(anchor['rotationRad'])
    sx, sy = (xmax-xmin)/width, (ymax-ymin)/height
    pixels = np.asarray(image.convert('RGBA'), dtype=np.float32)
    pixels[:, :, :3] *= pixels[:, :, 3:4] / 255  # alpha-aware bilinear interpolation
    source_height, source_width = pixels.shape[:2]
    output = np.zeros((height, width, 4), dtype=np.uint8)
    # Bounded row tiles avoid holding multiple full-size projection grids in memory.
    for first in range(0, height, 256):
        last = min(height, first+256)
        x, y = np.meshgrid(xmin+(np.arange(width)+.5)*sx, ymax-(np.arange(first, last)+.5)*sy)
        east = anchor['origin'][0]+cosine*x-sine*y
        north = anchor['origin'][1]+sine*x+cosine*y
        source_x, source_y = transform.transform(east, north, errcheck=True)
        u = (d*(source_x-e)-c*(source_y-f))/determinant
        v = (-b*(source_x-e)+a*(source_y-f))/determinant
        valid = np.isfinite(u) & np.isfinite(v) & (u >= 0) & (u < source_width) & (v >= 0) & (v < source_height)
        # Pixel-corner coordinates become array sample-centre indices only here.
        u = np.clip(u-.5, 0, source_width-1)
        v = np.clip(v-.5, 0, source_height-1)
        ix, iy = np.floor(u).astype(int), np.floor(v).astype(int)
        jx, jy = np.minimum(ix+1, source_width-1), np.minimum(iy+1, source_height-1)
        fx, fy = (u-ix)[..., None], (v-iy)[..., None]
        rgba = pixels[iy, ix]*(1-fx)*(1-fy)+pixels[iy, jx]*fx*(1-fy)+pixels[jy, ix]*(1-fx)*fy+pixels[jy, jx]*fx*fy
        alpha = rgba[:, :, 3:4]
        rgba[:, :, :3] = np.divide(rgba[:, :, :3]*255, alpha, out=np.zeros_like(rgba[:, :, :3]), where=alpha > 0)
        rgba[~valid] = 0
        output[first:last] = np.clip(np.rint(rgba), 0, 255).astype(np.uint8)
    return Image.fromarray(output), [sx, 0, 0, -sy, xmin, ymax]


def prepare(args):
    source, map_path, destination = args.image.resolve(), args.map.resolve(), args.out.resolve()
    if destination.exists():
        raise ValueError('BG_OUTPUT_EXISTS: choose a new output directory')
    if source.suffix.lower() not in ('.png', '.jpg', '.jpeg', '.tif', '.tiff'):
        raise ValueError('BG_RASTER_FORMAT_UNSUPPORTED')
    if source.stat().st_size > 512*1024*1024:
        raise ValueError('BG_SOURCE_BYTE_LIMIT: maximum source is 512 MiB')
    document_paths = [p.resolve() for p in (args.calibration, args.georeference, args.manifest, args.reference_map) if p]
    snapshots = {p: sha(p) for p in [source, map_path, *document_paths, *(p.resolve() for p in getattr(args, 'source_evidence', []))]}
    with Image.open(source) as raw:
        if raw.width*raw.height > MAX_SOURCE_PIXELS:
            raise ValueError('BG_SOURCE_PIXEL_LIMIT')
        if raw.format == 'TIFF' and raw.mode not in ('L', 'RGB', 'RGBA', 'P'):
            raise ValueError('BG_GEOTIFF_SAMPLE_TYPE_UNSUPPORTED: explicit radiometric preparation required')
        raw_size = raw.size
        orientation = raw.getexif().get(274, 1)
        if orientation not in range(1, 9):
            raise ValueError('BG_EXIF_ORIENTATION_INVALID')
        identity = {'sha256': snapshots[source], 'widthPx': raw.width, 'heightPx': raw.height}
        normalized = ImageOps.exif_transpose(raw).convert('RGBA')
    core = core_contract(map_path, identity, document_paths)
    frame = core['coordinateFrame']
    calibration = core['calibration']
    source_affine, source_crs = args.source_transform, args.source_crs
    if calibration:
        if not calibration['ok']:
            raise ValueError(calibration['code'] + ': ' + calibration['message'])
        transform = compose(calibration['imageToWorld'], orientation_to_raw(orientation, *raw_size))
        mode = 'local_affine_resize'
        if args.extent or args.mpp or source_crs or source_affine:
            raise ValueError('BG_MODE_CONFLICT: local calibration and CRS reprojection are separate input modes')
    else:
        if source.suffix.lower() in ('.tif', '.tiff') and not source_crs and not source_affine:
            try:
                import rasterio
            except ImportError as error:
                raise ValueError('BG_GEOTIFF_DEPENDENCY_MISSING: conda install -n paper -c conda-forge rasterio; actual source GeoTIFF not tested when unavailable') from error
            with rasterio.open(source) as raster:
                if not raster.crs or any(dtype != 'uint8' for dtype in raster.dtypes) or raster.count not in (1, 3, 4):
                    raise ValueError('BG_GEOTIFF_UNSUPPORTED: require CRS and 1/3/4 uint8 bands; explicit radiometric preparation needed otherwise')
                meanings = tuple(band.name for band in raster.colorinterp)
                if meanings not in (('gray',), ('red', 'green', 'blue'), ('red', 'green', 'blue', 'alpha')):
                    raise ValueError('BG_GEOTIFF_COLOR_INTERPRETATION_UNSUPPORTED: require explicit gray/RGB/RGBA bands; palette or undefined colors need radiometric preparation')
                if orientation != 1:
                    raise ValueError('BG_GEOTIFF_EXIF_CONFLICT: normalize conflicting raster orientation before reprojection')
                bands = raster.read()
                rgb = np.repeat(bands[:1], 3, axis=0) if raster.count == 1 else bands[:3]
                normalized = Image.fromarray(np.dstack([np.moveaxis(rgb, 0, -1), raster.dataset_mask()]))
                t = raster.transform
                source_affine, source_crs = [t.a, t.d, t.b, t.e, t.c, t.f], raster.crs.to_string()
        if not source_crs or not source_affine or args.extent is None or args.mpp is None:
            raise ValueError('BG_REPROJECTION_INPUT_REQUIRED: supply --source-crs --source-transform plus --extent and --mpp, or a bound --calibration / legacy document chain')
        source_affine = compose(source_affine, orientation_to_raw(orientation, *raw_size))
        normalized, transform = reproject(normalized, source_crs, source_affine, frame, args.extent, args.mpp)
        mode = 'per_pixel_pyproj_reprojection'
    if not 1 <= args.max_side <= MAX_SIDE:
        raise ValueError('BG_MAX_SIDE_INVALID')
    before_resize = normalized.size
    ratio = min(1, args.max_side/max(normalized.size))
    size = tuple(max(1, round(side*ratio)) for side in normalized.size)
    if size != normalized.size:
        transform = compose(transform, [normalized.width/size[0], 0, 0, normalized.height/size[1], 0, 0])
        normalized = normalized.resize(size, Image.Resampling.LANCZOS)
    if not affine_valid(transform):
        raise ValueError('BG_OUTPUT_AFFINE_INVALID')
    evidence = [{'name': str(path), 'sha256': expected, 'jsonPath': '/coordinateFrame' if path == map_path else ''} for path, expected in snapshots.items()]
    points = []
    if calibration:
        evidence.extend(calibration['sourceEvidence'])
        # Retain supplied control-point worlds/roles while transforming pixel coordinates.
        oa, ob, oc, od, oe, of = orientation_to_raw(orientation, *raw_size)
        determinant = oa*od-ob*oc
        for point in calibration.get('controlPoints', []):
            u, v = point['pixel']
            nx = (od*(u-oe)-oc*(v-of))/determinant
            ny = (-ob*(u-oe)+oa*(v-of))/determinant
            points.append({**point, 'pixel': [nx*size[0]/before_resize[0], ny*size[1]/before_resize[1]]})
    destination.mkdir(parents=True, exist_ok=False)
    unchanged = mode == 'local_affine_resize' and orientation == 1 and size == raw_size and source.suffix.lower() in ('.png', '.jpg', '.jpeg')
    output_image = destination / ('background'+source.suffix.lower() if unchanged else 'background.png')
    if unchanged:
        with source.open('rb') as inp, output_image.open('xb') as out:
            shutil.copyfileobj(inp, out)
    else:
        normalized.save(output_image, format='PNG')
    output_identity = {'sha256': sha(output_image), 'widthPx': size[0], 'heightPx': size[1]}
    document = {'format': FORMAT, 'image': output_identity, 'coordinateFrame': frame, 'pixelConvention': PIXELS,
                'imageToWorld': transform, 'sourceEvidence': evidence, 'controlPoints': points}
    output_calibration = destination/'calibration.json'
    output_calibration.write_text(json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf8')
    checked = core_contract(map_path, output_identity, [output_calibration], output_image)
    if not checked['calibration']['ok']:
        raise ValueError('BG_GENERATED_CALIBRATION_REJECTED: '+str(checked['calibration']))
    if any(sha(path) != expected for path, expected in snapshots.items()):
        raise ValueError('BG_SOURCE_CHANGED_DURING_PREPARATION')
    receipt = {'format': 'BG01_raster_preparation_receipt_v1', 'mode': mode, 'sourceImage': identity,
               'sourceFilesSha256': {str(path): value for path, value in snapshots.items()}, 'sourceFilesUnchanged': True,
               'mapContentHashFromTypeScriptCore': core['contentHash'], 'coordinateFrameUnchanged': frame == checked['coordinateFrame'],
               'exifOrientation': orientation, 'exifNormalized': True, 'sourceImageToNormalizedPixelMapping': orientation_to_raw(orientation, *raw_size),
               'beforeResizeDimensions': list(before_resize), 'outputImage': {'path': output_image.name, **output_identity},
               'outputCalibrationSha256': sha(output_calibration), 'imageToWorld': transform, 'browserRasterHeader': checked['rasterHeader'],
               'sourceCRS': source_crs, 'sourceAffineOnNormalizedPixels': source_affine,
               'sourceTransformMeaning': 'Explicit operator declaration or raster metadata; not independently surveyed' if mode != 'local_affine_resize' else 'SHA-bound legacy or BG01 local calibration',
               'pixelSampling': 'Output pixel centres through the exact inverse CRS transform; source corner coordinate minus 0.5 before interpolation.' if mode != 'local_affine_resize' else 'Resize composes output pixel corners into normalized source pixel corners; no half-pixel translation.',
               'command': sys.argv, 'scriptSha256': sha(Path(__file__)), 'limits': ['No field geolocation accuracy claim.', 'Gray source masks are missing imagery, not traversable land.', 'No map content or namespace added.']}
    (destination/'receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf8')
    print(json.dumps({'status': 'prepared', 'image': str(output_image), 'calibration': str(output_calibration), 'mode': mode, 'sourceFilesUnchanged': True}, ensure_ascii=True))
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True, type=Path)
    parser.add_argument('--map', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--calibration', type=Path)
    mode.add_argument('--georeference', type=Path)
    parser.add_argument('--manifest', type=Path)
    parser.add_argument('--reference-map', type=Path)
    parser.add_argument('--source-evidence', action='append', type=Path, default=[], help='Read-only provenance file for an explicitly declared reprojection, SHA-bound without treating it as a local calibration')
    parser.add_argument('--source-crs')
    parser.add_argument('--source-transform', nargs=6, type=float, metavar=('A', 'B', 'C', 'D', 'E', 'F'))
    parser.add_argument('--extent', nargs=4, type=float, metavar=('XMIN', 'YMIN', 'XMAX', 'YMAX'))
    parser.add_argument('--mpp', type=float)
    parser.add_argument('--max-side', type=int, default=2048)
    args = parser.parse_args()
    try:
        prepare(args)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        parser.exit(2, str(error)+'\n')


if __name__ == '__main__':
    main()
