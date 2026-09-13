"""Static handoff regression; frozen real inputs remain read-only."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('exports', ROOT / 'scripts/MQ01_exports.py')
exports = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exports)


class ExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.map_path = ROOT / '.cache/MQ01/baseline/hudong/map.json'
        cls.core_path = cls.map_path.with_name('core-report.json')
        if not cls.map_path.exists() or not cls.core_path.exists():
            raise RuntimeError('blocked_input: frozen MQ01 Hudong baseline required')
        cls.m, cls.sha = exports.read_json(cls.map_path)
        cls.core, _ = exports.read_json(cls.core_path)

    def test_bound_export_preserves_geometry_resources_slots_and_originals(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / 'new'
            receipt = exports.export_map(self.map_path, self.core_path, out)
            graph = json.loads((out / 'transport_graph.json').read_text('utf-8'))
            geo = json.loads((out / 'features_wgs84.geojson').read_text('utf-8'))
            template = json.loads((out / 'binding_template.json').read_text('utf-8'))
            self.assertEqual(graph['declarations'], self.m)
            self.assertEqual(graph['resources'], self.m['resources'])
            for arc in graph['arcs'].values():
                expected = exports.road_points(self.m, self.m['roads'][arc['roadId']])
                self.assertEqual(arc['centerlineLocalM'], expected if arc['direction'] == 'forward' else list(reversed(expected)))
                self.assertEqual(arc['lengthM'], sum(math.dist(a[:2], b[:2]) for a, b in zip(expected, expected[1:])))
            slots = [s for kind in ['facilities', 'zones'] for owner in self.m[kind].values()
                     for s in owner.get('extensions', {}).get('sr02.planning', {}).get('slots', [])]
            self.assertEqual(sum(f['properties']['entityType'] == 'slots' for f in geo['features']), len(slots))
            self.assertEqual(sorted(template['slotIds']), sorted(s['id'] for s in slots))
            for key in ['scenario', 'plan', 'runtime']:
                self.assertIsNone(template[key])
            for filename, digest in receipt['outputsSha256'].items():
                self.assertEqual(exports.sha((out / filename).read_bytes()), digest)
            self.assertEqual(exports.sha(self.map_path.read_bytes()), self.sha)
            with self.assertRaisesRegex(FileExistsError, 'MQ_OUTPUT_EXISTS'):
                exports.export_map(self.map_path, self.core_path, out)

    def test_rotated_utm_holes_and_local_z_are_not_wgs84_altitude(self):
        m = copy.deepcopy(self.m)
        m['coordinateFrame']['geographicAnchor'].update(crs='EPSG:32631', origin=[500000, 0, 42], rotationRad=math.pi / 2)
        m['nodes'] = {'n': {'position': [1000, 0, 7]}}
        m['roads'] = {}; m['accessPoints'] = {}; m['servicePoints'] = {}; m['junctions'] = {}
        m['facilities'] = {}; m['zones'] = {}
        m['siteBoundary'] = {'outer': [[0, 0, 7], [2000, 0, 7], [2000, 2000, 7], [0, 2000, 7]],
                             'holes': [[[10, 10, 7], [20, 10, 7], [20, 20, 7], [10, 20, 7]]]}
        geo = exports.geojson_export(m, {})
        point = next(f for f in geo['features'] if f['properties']['entityType'] == 'nodes')
        self.assertAlmostEqual(point['geometry']['coordinates'][0], 3, places=10)
        self.assertAlmostEqual(point['geometry']['coordinates'][1], 0.009047313695227, places=10)
        self.assertEqual(len(point['geometry']['coordinates']), 2)
        self.assertEqual(point['properties']['localGeometryM'][2], 7)
        rings = geo['features'][0]['geometry']['coordinates']
        self.assertEqual(len(rings), 2)
        self.assertTrue(all(r[0] == r[-1] and len(r) == 5 for r in rings))
        m['coordinateFrame']['geographicAnchor']['coordinateOrder'] = 'E,N,Z'
        self.assertEqual(exports.geojson_export(m, {}), geo)
        m['coordinateFrame']['geographicAnchor']['coordinateOrder'] = 'northing,easting,up'
        with self.assertRaisesRegex(ValueError, 'MQ_UNSUPPORTED_COORDINATE_ORDER'):
            exports.geojson_export(m, {})
        del m['coordinateFrame']['geographicAnchor']
        with self.assertRaisesRegex(ValueError, 'MQ_UNSUPPORTED_ANCHOR'):
            exports.geojson_export(m, {})

    def test_stale_binding_rejected_before_creating_output(self):
        with tempfile.TemporaryDirectory() as directory:
            core = copy.deepcopy(self.core)
            core['normalizedFileSha256'] = '0' * 64
            path = Path(directory) / 'core.json'
            path.write_text(json.dumps(core), encoding='utf-8')
            out = Path(directory) / 'new'
            with self.assertRaisesRegex(ValueError, 'MQ_CORE_BINDING_MISMATCH'):
                exports.export_map(self.map_path, path, out)
            self.assertFalse(out.exists())

    def test_unknown_direction_and_unsupported_transition_are_not_permission(self):
        legacy_root = ROOT.parent.parent / 'projects/Map_Refinement_20260912/tools'
        spec = importlib.util.spec_from_file_location('legacy_test', legacy_root / 'analyze_map.py')
        legacy = importlib.util.module_from_spec(spec); spec.loader.exec_module(legacy)
        m = copy.deepcopy(self.m)
        mid, movement = next((k, v) for k, v in m['movements'].items() if v['allowed'])
        rid = movement['incomingArc']['roadId']
        m['roads'][rid]['direction'] = 'unknown'
        graph = exports.graph_export(m, {'mapFileSha256': self.sha, 'contentHash': self.core['contentHash']}, legacy)
        self.assertFalse(any(a['roadId'] == rid for a in graph['arcs'].values()))
        self.assertTrue(any(i['movementId'] == mid for i in graph['unsupportedTransitions']))
        self.assertEqual(graph['declarations']['roads'][rid]['direction'], 'unknown')
        self.assertTrue(any(i['code'] == 'UNKNOWN_DIRECTION_NO_ARCS' for i in graph['limitations']['issues']))


if __name__ == '__main__':
    unittest.main()
