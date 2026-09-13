"""Synthetic transform checks plus real CIMC frame; no original imagery modified."""
import argparse
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from PIL import Image, ImageOps
from pyproj import Transformer

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'scripts'))
import BG01_prepare_raster as bg

MAP = ROOT.parent.parent/'projects/Map_Refinement_20260912/cimc_v02/map.json'


def options(image, output):
    return argparse.Namespace(image=image, map=MAP, out=output, calibration=None, georeference=None,
                              manifest=None, reference_map=None, source_crs=None, source_transform=None,
                              extent=None, mpp=None, max_side=2048)


class BG01RasterTests(unittest.TestCase):
    def test_all_exif_orientations_use_pixel_corners(self):
        source = np.arange(24, dtype=np.uint8).reshape(4, 6)
        for orientation in range(1, 9):
            raw = Image.fromarray(source)
            raw.getexif()[274] = orientation
            normalized = np.asarray(ImageOps.exif_transpose(raw))
            a, b, c, d, e, f = bg.orientation_to_raw(orientation, 6, 4)
            for y, x in np.ndindex(normalized.shape):
                u, v = x+.5, y+.5
                self.assertEqual(normalized[y, x], source[int(b*u+d*v+f), int(a*u+c*v+e)])

    def test_real_core_checked_resize_and_exif_preserve_control_world(self):
        frame = json.loads(MAP.read_text(encoding='utf8'))['coordinateFrame']
        with tempfile.TemporaryDirectory(prefix='BG01-synthetic-') as temp:
            folder = Path(temp)
            source = folder/'synthetic.png'
            image = Image.new('RGB', (6, 4), (40, 100, 160))
            exif = image.getexif(); exif[274] = 6
            image.save(source, exif=exif)
            identity = {'sha256': bg.sha(source), 'widthPx': 6, 'heightPx': 4}
            document = {'format': bg.FORMAT, 'pixelConvention': bg.PIXELS, 'image': identity, 'coordinateFrame': frame,
                        'imageToWorld': [2, .3, -.5, -3, 40, 200], 'sourceEvidence': [{'name': 'synthetic.png', 'sha256': identity['sha256'], 'jsonPath': ''}],
                        'controlPoints': [{'pixel': [2.5, 1.5], 'world': [44.25, 196.25, 0], 'role': 'check'}]}
            calibration = folder/'source.json'
            calibration.write_text(json.dumps(document), encoding='utf8')
            args = options(source, folder/'output')
            args.calibration, args.max_side = calibration, 3
            with contextlib.redirect_stdout(io.StringIO()):
                receipt = bg.prepare(args)
            output = json.loads((args.out/'calibration.json').read_text(encoding='utf8'))
            self.assertEqual(output['image']['widthPx'], 2)
            self.assertEqual(output['image']['heightPx'], 3)
            self.assertEqual(output['imageToWorld'], [1, 6, 4, .6, 38, 188])
            self.assertEqual(output['controlPoints'], [{'pixel': [1.25, 1.25], 'world': [44.25, 196.25, 0], 'role': 'check'}])
            self.assertEqual(output['coordinateFrame'], frame)
            self.assertTrue(receipt['sourceFilesUnchanged'])
            with Image.open(args.out/'background.png') as result:
                self.assertEqual(result.getexif().get(274, 1), 1)
            with self.assertRaisesRegex(ValueError, 'BG_OUTPUT_EXISTS'):
                bg.prepare(args)

    def test_per_pixel_different_crs_reprojection_not_an_affine_fit(self):
        frame = json.loads(MAP.read_text(encoding='utf8'))['coordinateFrame']
        anchor = frame['geographicAnchor']
        anchor['rotationRad'] = 0
        east, north = anchor['origin'][:2]
        forward = Transformer.from_crs(anchor['crs'], 'EPSG:3857', always_xy=True)
        mx, my = forward.transform(east, north)
        x, y = np.meshgrid(np.arange(64), np.arange(64))
        image = Image.fromarray(np.stack([x*3, y*3, np.zeros_like(x)+80, np.zeros_like(x)+255], axis=-1).astype('uint8'))
        output, affine = bg.reproject(image, 'EPSG:3857', [2, 0, 0, -2, mx-64, my+64], frame, [0, 0, 30, 30], 1)
        self.assertEqual(affine, [1, 0, 0, -1, 0, 30])
        sx, sy = forward.transform(east+10.5, north+19.5)
        expected = [round(3*((sx-(mx-64))/2-.5)), round(3*(((my+64)-sy)/2-.5)), 80, 255]
        self.assertEqual(list(np.asarray(output)[10, 10]), expected)

    def test_large_output_png_is_rejected_by_actual_browser_byte_contract(self):
        frame = json.loads(MAP.read_text(encoding='utf8'))['coordinateFrame']
        with tempfile.TemporaryDirectory(prefix='BG01-byte-limit-') as temp:
            folder = Path(temp); source = folder/'synthetic-large.png'
            noise = np.random.default_rng(17).integers(0, 256, size=(3000, 3000, 4), dtype=np.uint8)
            Image.fromarray(noise).save(source, compress_level=0)
            self.assertGreater(source.stat().st_size, 32*1024*1024)
            doc = {'format': bg.FORMAT, 'pixelConvention': bg.PIXELS, 'coordinateFrame': frame,
                   'image': {'sha256': bg.sha(source), 'widthPx': 3000, 'heightPx': 3000},
                   'imageToWorld': [1, 0, 0, -1, 0, 3000],
                   'sourceEvidence': [{'name': source.name, 'sha256': bg.sha(source), 'jsonPath': ''}]}
            calibration = folder/'calibration.json'; calibration.write_text(json.dumps(doc), encoding='utf8')
            args = options(source, folder/'output'); args.calibration = calibration; args.max_side = 4096
            with self.assertRaisesRegex(ValueError, 'BG_OUTPUT_RASTER_REJECTED: RASTER_BYTES_LIMIT'):
                bg.prepare(args)
            self.assertFalse((args.out/'receipt.json').exists())

    def test_no_calibration_is_not_reported_as_success_and_missing_geotiff_dependency_is_explicit(self):
        with tempfile.TemporaryDirectory(prefix='BG01-input-refusal-') as temp:
            folder = Path(temp)
            source = folder/'synthetic.png'; Image.new('RGB', (4, 4)).save(source)
            with self.assertRaisesRegex(ValueError, 'BG_REPROJECTION_INPUT_REQUIRED'):
                bg.prepare(options(source, folder/'output'))
            self.assertFalse((folder/'output').exists())
            if importlib.util.find_spec('rasterio') is None:
                tiff = folder/'synthetic.tif'; Image.new('RGB', (4, 4)).save(tiff)
                with self.assertRaisesRegex(ValueError, 'BG_GEOTIFF_DEPENDENCY_MISSING.*conda install'):
                    bg.prepare(options(tiff, folder/'tiff-output'))
                self.assertFalse((folder/'tiff-output').exists())


if __name__ == '__main__':
    unittest.main()
