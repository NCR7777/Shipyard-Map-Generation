#!/usr/bin/env python3
"""Bound static exports; never runs the legacy generator, router or simulator.

conda run -n paper python scripts/MQ01_exports.py MAP CORE_REPORT NEW_DIRECTORY
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import platform
import re
import sys
from pathlib import Path

import pyproj
import shapely
from pyproj import CRS, Transformer

MAX_JSON_BYTES = 10 * 1024 * 1024
PLANNING = 'sr02.planning'
LEGACY_HASHES = {
    'analyze_map.py': '331f822bd7dc2ec90cfb3c1f332e4b7792e5c8cc38b94ab38791dd2ef9317653',
    'finalize_maps.py': 'eb5954591877a3dfb6483c09e94edc328f5ca1ce16a1a8003e030b8bd4a4502f',
}
COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'zones',
               'accessPoints', 'servicePoints', 'resources', 'sources', 'assets', 'backgroundLayers']


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_json(path):
    if not path.is_file() or path.stat().st_size > MAX_JSON_BYTES:
        raise ValueError('MQ_INVALID_INPUT_SIZE: ' + str(path))
    raw = path.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError('MQ_INVALID_INPUT_SIZE: ' + str(path))
    return json.loads(raw.decode('utf-8-sig')), sha(raw)


def road_points(m, road):
    return [m['nodes'][road['fromNodeId']]['position'], *road['shapePoints'],
            m['nodes'][road['toNodeId']]['position']]


def graph_export(m, binding, legacy):
    graph, _, _ = legacy.compile_graph(m, binding['mapFileSha256'])
    graph.update(contentHash=binding['contentHash'], revision=m['revision'], derivedOnly=True)
    # Preserve every declaration, including resource appliesTo and unknown extensions.
    graph['declarations'] = m
    issues = []
    for aid, arc in graph['arcs'].items():
        road = m['roads'][arc['roadId']]
        points = road_points(m, road)
        if arc['direction'] == 'backward':
            points = list(reversed(points))
        length = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(points, points[1:]))
        speed = road['speedLimitMps']
        arc.update(centerlineLocalM=points, lengthM=length,
                   nominalTravelTimeS=length / speed['value'] if speed['state'] == 'known' and speed['value'] > 0 else None,
                   role=road.get('extensions', {}).get(PLANNING, {}).get('role'))
    for rid, road in m['roads'].items():
        pointer = '/roads/' + rid.replace('~', '~0').replace('/', '~1')
        if road['direction'] == 'unknown':
            issues.append({'code': 'UNKNOWN_DIRECTION_NO_ARCS', 'pointer': pointer + '/direction'})
        for field in ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps']:
            if road[field]['state'] != 'known':
                issues.append({'code': 'PHYSICAL_VALUE_' + road[field]['state'].upper(), 'pointer': pointer + '/' + field})
        if road.get('corridorPolygon') is not None:
            issues.append({'code': 'ROAD_BAND_NOT_EVALUATED', 'pointer': pointer + '/corridorPolygon'})
        if len({point[2] for point in road_points(m, road)}) > 1:
            issues.append({'code': 'NONPLANAR_GEOMETRY_HORIZONTAL_LENGTH_ONLY', 'pointer': pointer})
    allowed = set()
    unsupported = []
    denied = {tuple(pair) for pair in graph['forbiddenTransitions']}
    for mid, movement in m['movements'].items():
        if not movement['allowed']:
            continue
        pair = tuple(legacy.arcid(movement[key]['roadId'], movement[key]['direction'])
                     for key in ['incomingArc', 'outgoingArc'])
        junction = m['junctions'][movement['junctionId']]
        arcs = [graph['arcs'].get(aid) for aid in pair]
        reason = None
        if not all(arcs):
            reason = 'ARC_DIRECTION_UNAVAILABLE'
        elif junction['model'] != 'explicit_movements' or len(junction['nodeIds']) != 1:
            reason = 'JUNCTION_TRANSITION_NOT_COMPILED'
        elif movement.get('internalPath'):
            reason = 'INDEPENDENT_MOVEMENT_PATH_NOT_COMPILED'
        elif arcs[0]['toNodeId'] != arcs[1]['fromNodeId']:
            reason = 'NONCONTIGUOUS_TRANSITION'
        if reason:
            unsupported.append({'movementId': mid, 'arcIds': pair, 'code': reason})
        elif pair not in denied:
            allowed.add(pair)
    graph['allowedTransitions'] = sorted(allowed)
    graph['unsupportedTransitions'] = unsupported
    graph['limitations'] = {
        'issues': issues,
        'coreCapabilitiesRequired': True,
        'unknownExtensions': 'Preserved verbatim; not interpreted by this static exporter.',
        'resources': 'Declarations, movement resourceIds, junction resourceIds and appliesTo retained; no implicit inheritance or reservation simulation.',
        'serviceArrival': 'Service declarations retained; this export does not replace owner/arrival-aware path preflight.',
        'boundary': 'Static declared graph, not a simulation-ready or physical safety certificate. Missing turns remain missing.'}
    return graph


def geojson_export(m, binding):
    anchor = m['coordinateFrame'].get('geographicAnchor')
    if not anchor or not re.fullmatch(r'EPSG:32[67](0[1-9]|[1-5][0-9]|60)', anchor.get('crs', '')):
        raise ValueError('MQ_UNSUPPORTED_ANCHOR: WGS84 export requires declared WGS84 UTM anchor')
    if anchor.get('coordinateOrder') not in ['easting,northing,up', 'E,N,Z']:
        raise ValueError('MQ_UNSUPPORTED_COORDINATE_ORDER')
    transformer = Transformer.from_crs(CRS(anchor['crs']), 4326, always_xy=True)
    c, s = math.cos(anchor['rotationRad']), math.sin(anchor['rotationRad'])
    origin = anchor['origin']

    def coordinate(p):
        # Same rotation/translation as legacy finalize_maps.exports, no rounding.
        lon, lat = transformer.transform(origin[0] + c * p[0] - s * p[1],
                                         origin[1] + s * p[0] + c * p[1], errcheck=True)
        return [lon, lat]

    features = []

    def add(kind, entity_id, entity, geometry, local):
        features.append({'type': 'Feature', 'id': kind + ':' + entity_id, 'geometry': geometry,
                         'properties': {'id': entity_id, 'entityType': kind, 'name': entity.get('name'),
                                        'mapId': m['mapId'], **binding, 'provenance': entity.get('provenance'),
                                        'localGeometryM': local,
                                        'ownerEntityId': entity.get('ownerEntityId')}})

    def polygon(kind, entity_id, entity, boundary):
        rings = [boundary['outer'], *boundary.get('holes', [])]
        # GeoJSON requires closed rings; authority remains unmodified local vertices.
        coords = [[coordinate(p) for p in ring] for ring in rings]
        for ring in coords:
            if ring and ring[0] != ring[-1]:
                ring.append(ring[0])
        add(kind, entity_id, entity, {'type': 'Polygon', 'coordinates': coords}, boundary)

    if m.get('siteBoundary'):
        polygon('siteBoundary', 'siteBoundary', {}, m['siteBoundary'])
    for kind in ['facilities', 'zones']:
        for entity_id, entity in m[kind].items():
            polygon(kind, entity_id, entity, entity['boundary'])
            for slot in entity.get('extensions', {}).get(PLANNING, {}).get('slots', []):
                polygon('slots', slot['id'], {**slot, 'ownerEntityId': entity_id}, slot['boundary'])
    for rid, road in m['roads'].items():
        points = road_points(m, road)
        add('roads', rid, road, {'type': 'LineString', 'coordinates': [coordinate(p) for p in points]}, points)
    for kind in ['nodes', 'accessPoints', 'servicePoints']:
        for entity_id, entity in m[kind].items():
            point = entity['position'] if kind == 'nodes' else m['nodes'][entity['nodeId']]['position']
            add(kind, entity_id, entity, {'type': 'Point', 'coordinates': coordinate(point)}, point)
    for jid, junction in m['junctions'].items():
        if junction.get('boundary'):
            polygon('junctions', jid, junction, junction['boundary'])
    return {'type': 'FeatureCollection', 'binding': binding, 'features': features,
            'coordinateAccuracy': 'Declared anchor transformation only; reference-based, not independently surveyed. Z is local metadata, not WGS84 altitude.',
            'unrenderedDeclarations': ['logical resources', 'movements without standalone geometry', 'assets', 'backgroundLayers', 'other extensions'],
            'authoritativeMap': 'Use bound map.json for complete declarations; GeoJSON is derived, not editable authority.'}


def export_map(map_path, core_path, output, legacy_root=None):
    map_path, core_path, output = Path(map_path).resolve(), Path(core_path).resolve(), Path(output).resolve()
    if output.exists():
        raise FileExistsError('MQ_OUTPUT_EXISTS: ' + str(output))
    m, map_sha = read_json(map_path)
    core, core_sha = read_json(core_path)
    if (core.get('format') != 'MQ01_core_report_v1' or core.get('normalizedFileSha256') != map_sha
            or any(core.get(key) != m.get(key) for key in ['mapId', 'schemaVersion', 'revision', 'coordinateFrame'])
            or not re.fullmatch('[0-9a-f]{64}', core.get('contentHash', ''))
            or core.get('validation', {}).get('ok') is not True):
        raise ValueError('MQ_CORE_BINDING_MISMATCH')
    legacy_root = Path(legacy_root) if legacy_root else Path(__file__).resolve().parents[3] / 'projects/Map_Refinement_20260912/tools'
    sources = {Path(__file__).resolve(): sha(Path(__file__).read_bytes())}
    for filename, expected in LEGACY_HASHES.items():
        path = legacy_root / filename
        actual = sha(path.read_bytes())
        if actual != expected:
            raise ValueError('MQ_LEGACY_TOOL_CHANGED: ' + str(path))
        sources[path.resolve()] = actual
    spec = importlib.util.spec_from_file_location('mq01_legacy_analyzer', legacy_root / 'analyze_map.py')
    legacy = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(legacy)  # Definitions/imports only; never main/analyse.
    binding = {'mapFileSha256': map_sha, 'contentHash': core['contentHash']}
    graph = graph_export(m, binding, legacy)
    graph['coreCapabilities'] = core.get('capabilities')
    template = {'format': 'shipyard_static_binding_template_v1', 'mapId': m['mapId'],
                'schemaVersion': m['schemaVersion'], 'revision': m['revision'], **binding,
                'coordinateFrame': m['coordinateFrame'], 'entityIds': {key: sorted(m[key]) for key in COLLECTIONS},
                'slotIds': [slot['id'] for key in ['facilities', 'zones'] for owner in m[key].values()
                            for slot in owner.get('extensions', {}).get(PLANNING, {}).get('slots', [])],
                'scenario': None, 'plan': None, 'runtime': None,
                'status': 'static_only_requires_explicit_consumer_preflight_and_new_binding'}
    values = {'transport_graph.json': graph, 'features_wgs84.geojson': geojson_export(m, binding),
              'binding_template.json': template}
    def verify_inputs():
        for path, expected in {map_path: map_sha, core_path: core_sha, **sources}.items():
            if sha(path.read_bytes()) != expected:
                raise ValueError('MQ_INPUT_CHANGED: ' + str(path))
    verify_inputs()
    output.mkdir(parents=True, exist_ok=False)
    hashes = {}
    for filename, value in values.items():
        raw = (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
        with (output / filename).open('xb') as handle:
            handle.write(raw)
        hashes[filename] = sha(raw)
    verify_inputs()
    receipt = {'format': 'MQ01_static_export_receipt_v1', 'status': 'exported_static_not_simulation_approval',
               'input': {'path': str(map_path), **binding}, 'coreReport': {'path': str(core_path), 'sha256': core_sha},
               'sourceFilesSha256': {str(k): v for k, v in sources.items()}, 'coreSource': core.get('source'),
               'environment': {'python': sys.version, 'platform': platform.platform(), 'pyproj': pyproj.__version__,
                               'PROJ': pyproj.proj_version_str, 'shapely': shapely.__version__},
               'outputsSha256': hashes, 'originalUnchanged': True}
    with (output / 'export-receipt.json').open('x', encoding='utf-8', newline='\n') as handle:
        json.dump(receipt, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('map'); parser.add_argument('core_report'); parser.add_argument('output')
    parser.add_argument('--legacy-tools-root')
    args = parser.parse_args()
    try:
        result = export_map(args.map, args.core_report, args.output, args.legacy_tools_root)
        print(json.dumps({'status': result['status'], 'outputsSha256': result['outputsSha256']}))
        return 0
    except (OSError, ValueError, KeyError) as error:
        print(json.dumps({'status': 'rejected', 'error': str(error)}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
