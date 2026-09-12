import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { YardMap, Polygon, Vec3 } from '../../src/domain/model';
import type { MapCommand } from '../../src/domain/commands';
import { sameValue } from '../../src/domain/value';

// V01: GA01 task ZIP inventory. V02: MR01 delivery manifest; frozen bytes, never rewritten.
const frozen = [
  {
    "id": "cimc_v01",
    "path": "projects/cimc_v01/map.json",
    "sha256": "93f4ef7c79286a2748649b4e9a901462bbf631e117931341f2b4b8b8cb8f85a1",
    "mapId": "MAP_CR_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          357626.479447228,
          4161818.306695605,
          0
        ],
        "rotationRad": -0.2792526803190927,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_CR001",
    "nodeId": "N_CR_e4b47e7288",
    "contentHash": "c1a343586664a6a5ae2c4ed11520ea7064c779eb9a41c6cc300bb64417c682d0"
  },
  {
    "id": "cimc_v02",
    "path": "projects/Map_Refinement_20260912/cimc_v02/map.json",
    "sha256": "0eda616cf8bef738d7e099eb2870ef2698ec0c6378c4f1d2452f0845ac4fe5af",
    "mapId": "MAP_CR_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          357626.479447228,
          4161818.306695605,
          0
        ],
        "rotationRad": -0.2792526803190927,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_CR001",
    "nodeId": "N_CR_e6c5d9022b",
    "contentHash": "8bfadd75ad3a3b93897d8c817ac020e7fe4613e3bcf291d25b22fc03165abcdd"
  },
  {
    "id": "dalian_v01",
    "path": "projects/Dalian_Coastal_Shipyard_Map_v01/dalian_v01/map.json",
    "sha256": "6faf4a6e89339224204253420d757adbbfac6595399049948a3ec9bbd19ea36b",
    "mapId": "MAP_DL_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          353266.697971,
          4372658.938757,
          0
        ],
        "rotationRad": 0,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_DL002",
    "nodeId": "N_DL_b3d5453746",
    "contentHash": "2108d02d1f6d43a3817ea037f0fc09548d0b037f8f3875aba8bef70019f9d8ff"
  },
  {
    "id": "dalian_v02",
    "path": "projects/Map_Refinement_20260912/dalian_v02/map.json",
    "sha256": "a06fa3910079d74e3e90f1b23fd840c64640500097d7ae8a057ad82293187656",
    "mapId": "MAP_DL_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          353266.697971,
          4372658.938757,
          0
        ],
        "rotationRad": 0,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_DL027",
    "nodeId": "N_MR_5f726b8f2fdd",
    "contentHash": "426e53625e714a656f7dae75357ec0685df66364c0bb58eee0dacd740d4d651f"
  },
  {
    "id": "geoje_v01",
    "path": "projects/Geoje_Harbor_Shipyard_Map_v01/geoje_v01/map.json",
    "sha256": "2c921a8a4bc00302026f40e5a642ed5de7e136c25ff4d555cdb5bc0ea7399f9b",
    "mapId": "MAP_GJ_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          461152.461265,
          3861519.177004,
          0
        ],
        "rotationRad": 0,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_GJ002",
    "nodeId": "N_GJ_98578c20a5",
    "contentHash": "86b4070c1e3cfbe5cce229c094b7e08c0f307d6de99f209f89187e1e4c54a514"
  },
  {
    "id": "geoje_v02",
    "path": "projects/Map_Refinement_20260912/geoje_v02/map.json",
    "sha256": "6313e6cff2bda3fe418d3cf9b51c0fe413495f088d882892c58ac60ef827e0e9",
    "mapId": "MAP_GJ_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          461152.461265,
          3861519.177004,
          0
        ],
        "rotationRad": 0,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_GJ_MR_032",
    "nodeId": "N_MR_7ed7a13646cb",
    "contentHash": "2743a340c6ec0aa539469ff6ec4a4cfc604e468e9ea80da0b8c7a86d314f3285"
  },
  {
    "id": "hanwha_v01",
    "path": "projects/hanwha_v01/map.json",
    "sha256": "095c6553c437bb9e5b6df7cafe2e2e04a8061c3aec0db4b739104a2cd0f2a3f9",
    "mapId": "MAP_HW_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          471314.7910503206,
          3858937.265533189,
          0
        ],
        "rotationRad": -0.6806784082777885,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_HW103",
    "nodeId": "N_HW_7874b56b34",
    "contentHash": "91e655cef4ef298b6a3617b18973210580c298ae4de3ce0a894e8ef108682143"
  },
  {
    "id": "hanwha_v02",
    "path": "projects/Map_Refinement_20260912/hanwha_v02/map.json",
    "sha256": "d9b3b76bf075e3e802088231b4af0c17d48dd8751c1c89bb1a66f82feada7d1d",
    "mapId": "MAP_HW_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          471314.7910503206,
          3858937.265533189,
          0
        ],
        "rotationRad": -0.6806784082777885,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_HW103",
    "nodeId": "N_HW_7874b56b34",
    "contentHash": "031c37f0f1a73eb09e2674d3b36ed966e7f8478cf2e6cf7514bf3adb270a9bee"
  },
  {
    "id": "hudong_v01",
    "path": "projects/hudong_v01/map.json",
    "sha256": "4ca9e2ea2e58b9e720dac9cc3800bdaddeee3bb464cd3fec79be1b4e95f269ba",
    "mapId": "MAP_HD_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          363040.0849339296,
          3460750.595370739,
          0
        ],
        "rotationRad": -0.4276056667386107,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_HD003",
    "nodeId": "N_HD_efd47bf0d5",
    "contentHash": "2592ebab804451554fea37b822fc0e2048d1a82afc80aa5e0f9f1c927c1d30a3"
  },
  {
    "id": "hudong_v02",
    "path": "projects/Map_Refinement_20260912/hudong_v02/map.json",
    "sha256": "7f0cfb8a235830c7d42e5cd807a9d5f85fd87a57063484c65568617ac5a71cd1",
    "mapId": "MAP_HD_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          363040.0849339296,
          3460750.595370739,
          0
        ],
        "rotationRad": -0.4276056667386107,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_HD003",
    "nodeId": "N_HD_efd47bf0d5",
    "contentHash": "4d3843bb5923467b32cf1f96772575738e4b3ab896f8b601f2f9e156196e243b"
  },
  {
    "id": "newtimes_v01",
    "path": "projects/newtimes_v01/map.json",
    "sha256": "5cfc58038be77059bca888232fb72a788e7a06748b674c9105e589d9d32bbb60",
    "mapId": "MAP_NT_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          255729.84365172414,
          3548294.5501175453,
          0
        ],
        "rotationRad": 0.5846852994181004,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_NT010",
    "nodeId": "N_NT_976f00da59",
    "contentHash": "f719aec9b95fb92c453b2d182ca7da53d133c9a4a7c7abaefa5359df0654c342"
  },
  {
    "id": "newtimes_v02",
    "path": "projects/Map_Refinement_20260912/newtimes_v02/map.json",
    "sha256": "101d6882283caa6af8c5afde0b3173f7fc47ebd8189cdb6dcea6a2a6be39fff1",
    "mapId": "MAP_NT_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          255729.84365172414,
          3548294.5501175453,
          0
        ],
        "rotationRad": 0.5846852994181004,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_NT010",
    "nodeId": "N_NT_976f00da59",
    "contentHash": "06a11a95e4f2276bc04aa09a2127e1c521d19b19c6aed3b44e31ed768af61fc0"
  },
  {
    "id": "samho_v01",
    "path": "projects/samho_v01/map.json",
    "sha256": "283b1f88257b56bde37161f0a726fbbd766a5a166502da2a9a5c3638801dbb59",
    "mapId": "MAP_SH_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          258057.51252251945,
          3847035.236849599,
          0
        ],
        "rotationRad": -0.4363323129985824,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_SH020",
    "nodeId": "N_SH_9bdd2f744a",
    "contentHash": "a5903c1d692140da8dc9435dc8a97773adc94b5890cd32a4d677019cdcabec08"
  },
  {
    "id": "samho_v02",
    "path": "projects/Map_Refinement_20260912/samho_v02/map.json",
    "sha256": "bfd98ddde9da61625e85e43b54805d146a8c8f6ceba543043b172550fea1463e",
    "mapId": "MAP_SH_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32652",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          258057.51252251945,
          3847035.236849599,
          0
        ],
        "rotationRad": -0.4363323129985824,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_SH020",
    "nodeId": "N_SH_9bdd2f744a",
    "contentHash": "e9b0c61946a7f9f0792614bf2145413dc547df8956e940e454c7883aac997d38"
  },
  {
    "id": "weihai_v01",
    "path": "projects/Weihai_Shipyard_Map_v01/Weihai_Shipyard_Map_v01/map.json",
    "sha256": "b24b19d744552c4dd88a39a977f8f3b5a306e319c7f477b1ab0f3030cf78cefb",
    "mapId": "WH_CM_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "E,N,Z",
        "origin": [
          432090.20795435127,
          4145526.5014962973,
          0
        ],
        "rotationRad": 0.013250110122183578,
        "method": "EPSG3857 to WGS84 UTM51N, then rigid local grid aligned with visible long haul aisle. Satellite-georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_RD",
    "nodeId": "N_0102",
    "contentHash": "997db6299aa1d7208f019d4fb3b0e293974959c77bd74815b7160130bd2afbfa"
  },
  {
    "id": "weihai_v02",
    "path": "projects/Map_Refinement_20260912/weihai_v02/map.json",
    "sha256": "420dcf275a16664a34d68bc8371ddce8012954eb5ce6a28c29a6793e7a28e545",
    "mapId": "WH_CM_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "E,N,Z",
        "origin": [
          432090.20795435127,
          4145526.5014962973,
          0
        ],
        "rotationRad": 0.013250110122183578,
        "method": "EPSG3857 to WGS84 UTM51N, then rigid local grid aligned with visible long haul aisle. Satellite-georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_RD",
    "nodeId": "N_0102",
    "contentHash": "f2bd53b861a7b69d5b90533cc86f08a317f133e7196c85056c082961b5535c7c"
  },
  {
    "id": "xinyangzi_v01",
    "path": "projects/xinyangzi_v01/map.json",
    "sha256": "9576f15e37ad3e680fd34f88c14d8997628d08b585f89a43190ff10d347dc6a5",
    "mapId": "MAP_XY_REFERENCE_V01",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          230932.58044282676,
          3537221.824444401,
          0
        ],
        "rotationRad": 0.13962634015954636,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_XY039",
    "nodeId": "N_XY_c28e352ead",
    "contentHash": "4d219e8e2780fa8c8cd427015e239a9a832966c12a3c7472b243379982b51fa0"
  },
  {
    "id": "xinyangzi_v02",
    "path": "projects/Map_Refinement_20260912/xinyangzi_v02/map.json",
    "sha256": "8679a1b5807351f2a7d1c5e6c7ec3dbe5338a751932522df6a924104ae7a3fbd",
    "mapId": "MAP_XY_REFERENCE_V02",
    "coordinateFrame": {
      "kind": "local_cartesian",
      "handedness": "right",
      "groundPlane": "XY",
      "upAxis": "Z",
      "lengthUnit": "m",
      "angleUnit": "rad",
      "massUnit": "kg",
      "timeUnit": "s",
      "geographicAnchor": {
        "crs": "EPSG:32651",
        "coordinateOrder": "easting,northing,up",
        "origin": [
          230932.58044282676,
          3537221.824444401,
          0
        ],
        "rotationRad": 0.13962634015954636,
        "method": "GeoTIFF EPSG3857 -> UTM; local grid aligned to visible production axes. Georeferenced, not independently surveyed."
      }
    },
    "facilityId": "F_XY049",
    "nodeId": "N_MR_bbe938799550",
    "contentHash": "f74618b640336d506189faf2e191a7ee7bb00a0a324c1059e12fee8c3db10b1c"
  }
];
export const GA01_TARGETS = frozen.map(target => ({ ...target, absolutePath: resolve(process.env.GA01_DATA_ROOT ?? fileURLToPath(new URL('../../../../', import.meta.url)), target.path) }));
export type GA01Target = typeof GA01_TARGETS[number];
export async function readGA01Target(target: GA01Target): Promise<YardMap> {
  let bytes: Buffer;
  try { bytes = await readFile(target.absolutePath); } catch (cause) { throw new Error('blocked_input: ' + target.absolutePath, { cause }); }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), target.sha256, 'blocked_input: frozen SHA mismatch ' + target.id);
  const map = JSON.parse(bytes.toString('utf8')) as YardMap;
  assert.equal(map.mapId, target.mapId); assert.deepEqual(map.coordinateFrame, target.coordinateFrame);
  return map;
}
export function GA01Boundary(map: YardMap, target: GA01Target): Polygon {
  const boundary = map.facilities[target.facilityId]!.boundary;
  const vertices = boundary.outer.slice(0, -1);
  const cx = vertices.reduce((s, p) => s + p[0], 0) / vertices.length;
  const cy = vertices.reduce((s, p) => s + p[1], 0) / vertices.length;
  const shrink = (p: Vec3): Vec3 => [cx + (p[0] - cx) * 0.999, cy + (p[1] - cy) * 0.999, p[2]];
  return { outer: boundary.outer.map(shrink) as Polygon['outer'], holes: boundary.holes.map(ring => ring.map(shrink) as Polygon['outer']) };
}
export function GA01Command(map: YardMap, target: GA01Target, phase = 'A'): MapCommand {
  if (phase === 'B') { const p = map.nodes[target.nodeId]!.position; return { type: 'updateNode', id: target.nodeId, patch: { position: [p[0] + 0.01, p[1], p[2]] } }; }
  return { type: 'updateFacility', id: target.facilityId, patch: { boundary: GA01Boundary(map, target) } };
}
export function assertGA01Change(before: YardMap, after: YardMap, target: GA01Target, phase = 'A'): void {
  const kind = phase === 'B' ? 'nodes' : 'facilities'; const id = phase === 'B' ? target.nodeId : target.facilityId;
  const field = phase === 'B' ? 'position' : 'boundary';
  assert.equal(after.revision, before.revision + 1);
  assert.deepEqual(after.coordinateFrame, before.coordinateFrame);
  const oldEntity = before[kind][id]!, entity = after[kind][id]!;
  const oldData = oldEntity as unknown as Record<string, unknown>, data = entity as unknown as Record<string, unknown>;
  assert.notDeepEqual(data[field], oldData[field], 'real geometry must change');
  const source = entity.provenance.fieldSources?.[field]; assert.ok(source, 'geometry source is required');
  assert.equal(after.sources[source]!.category, 'design_assumption');
  assert.equal(entity.provenance.category, oldEntity.provenance.category, 'original evidence category must remain');
  assertGA01Equal(entity.provenance, { ...oldEntity.provenance, sourceRefs: entity.provenance.sourceRefs, fieldSources: { ...oldEntity.provenance.fieldSources, [field]: source } }, 'non-target provenance and fieldSources must remain');
  if (phase === 'B') {
    const command = GA01Command(before, target, 'B');
    if (command.type !== 'updateNode') throw new Error('unexpected B command');
    assertGA01Equal(data[field], command.patch.position, 'B must apply the exact requested XYZ');
  }
  for (const [sourceId, value] of Object.entries(before.sources)) assert.deepEqual(after.sources[sourceId], value);
  for (const ref of oldEntity.provenance.sourceRefs ?? []) assert.ok(entity.provenance.sourceRefs?.includes(ref));
  const normalized = structuredClone(after); normalized.revision = before.revision; normalized.sources = structuredClone(before.sources);
  (normalized[kind] as Record<string, unknown>)[id] = { ...entity, [field]: structuredClone(oldData[field]), provenance: structuredClone(oldEntity.provenance) };
  assertGA01Equal(normalized, before, 'all other IDs, fields, slots, resources and metadata remain exact');
}

export function assertGA01Equal(actual: unknown, expected: unknown, message = 'exact declared value equality'): void {
  // Existing JSON serialization emits -0 as 0. Only JS numeric equality applies; no tolerance or rounding.
  if (!sameValue(actual, expected)) assert.deepEqual(actual, expected, message);
}
