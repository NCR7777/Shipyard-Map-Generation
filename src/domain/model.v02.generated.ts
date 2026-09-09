/* Generated from schemas/map-0.2.schema.json. Run npm run schema:generate; do not edit. */

/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Id".
 */
export type Id = string;
/**
 * @minItems 3
 * @maxItems 3
 *
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Vec3".
 */
export type Vec3 = [number, number, number];
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "IdList".
 */
export type IdList = Id[];
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "PhysicalValue".
 */
export type PhysicalValue =
  | {
      state: 'known';
      value: number;
      sourceRef?: Id;
    }
  | {
      state: 'unknown' | 'unrestricted' | 'not_applicable';
      reason?: string;
    };
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "ServiceArrival".
 */
export type ServiceArrival =
  | {
      mode: 'node_proxy';
      transferAssumption: 'included_in_service_duration' | 'excluded_from_model';
      note: string;
    }
  | {
      mode: 'explicit_internal';
      entryNodeId?: Id;
      /**
       * @maxItems 2048
       */
      internalPath: ArcRef[];
    };
/**
 * @minItems 2
 * @maxItems 2
 *
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Vec2".
 */
export type Vec2 = [number, number];
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Namespace".
 */
export type Namespace = string;

export interface YardMap {
  schemaVersion: '0.2.0';
  mapId: Id;
  revision: number;
  metadata: Metadata;
  coordinateFrame: CoordinateFrame;
  siteBoundary: Polygon | null;
  nodes: {
    [k: string]: MapNode;
  };
  roads: {
    [k: string]: MapRoad;
  };
  junctions: {
    [k: string]: Junction;
  };
  movements: {
    [k: string]: Movement;
  };
  facilities: {
    [k: string]: Facility;
  };
  accessPoints: {
    [k: string]: AccessPoint;
  };
  servicePoints: {
    [k: string]: ServicePoint;
  };
  zones: {
    [k: string]: Zone;
  };
  resources: {
    [k: string]: Resource;
  };
  sources: {
    [k: string]: Source;
  };
  assets: {
    [k: string]: Asset;
  };
  backgroundLayers: {
    [k: string]: BackgroundLayer;
  };
  extensionNamespaces: {
    [k: string]: ExtensionDeclaration;
  };
  extensions: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Metadata".
 */
export interface Metadata {
  name: string;
  description: string;
  layoutBasis: 'conceptual' | 'synthetic' | 'reference_based' | 'surveyed';
  applicability?: string;
  derivedFrom?: {
    mapId: Id;
    contentHash: string;
  };
  reviewNotes?: string[];
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Extensions".
 */
export interface Extensions {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "CoordinateFrame".
 */
export interface CoordinateFrame {
  kind: 'local_cartesian';
  handedness: 'right';
  groundPlane: 'XY';
  upAxis: 'Z';
  lengthUnit: 'm';
  angleUnit: 'rad';
  massUnit: 'kg';
  timeUnit: 's';
  geographicAnchor?: {
    crs: string;
    coordinateOrder: string;
    origin: Vec3;
    rotationRad: number;
    method: string;
  };
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Polygon".
 */
export interface Polygon {
  /**
   * @minItems 4
   */
  outer: [Vec3, Vec3, Vec3, Vec3, ...Vec3[]];
  holes: [Vec3, Vec3, Vec3, Vec3, ...Vec3[]][];
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "MapNode".
 */
export interface MapNode {
  name: string;
  position: Vec3;
  kind: 'ordinary' | 'junction' | 'access' | 'service';
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Provenance".
 */
export interface Provenance {
  category:
    'surveyed' | 'drawing' | 'imagery_derived' | 'design_assumption' | 'synthetic' | 'unknown';
  sourceRefs?: IdList;
  fieldSources?: {
    [k: string]: Id;
  };
  note?: string;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "MapRoad".
 */
export interface MapRoad {
  name: string;
  fromNodeId: Id;
  toNodeId: Id;
  shapePoints: Vec3[];
  direction: 'unknown' | 'forward' | 'backward' | 'both';
  widthM: PhysicalValue;
  heightLimitM: PhysicalValue;
  massLimitKg: PhysicalValue;
  speedLimitMps: PhysicalValue;
  observedLengthM?: PhysicalValue;
  corridorPolygon?: Polygon;
  resourceIds: IdList;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Junction".
 */
export interface Junction {
  name: string;
  nodeIds: IdList;
  model: 'unknown' | 'explicit_movements';
  boundary?: Polygon;
  resourceIds: IdList;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Movement".
 */
export interface Movement {
  name: string;
  junctionId: Id;
  incomingArc: ArcRef;
  outgoingArc: ArcRef;
  allowed: boolean;
  /**
   * @minItems 2
   */
  internalPath?: [Vec3, Vec3, ...Vec3[]];
  resourceIds: IdList;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "ArcRef".
 */
export interface ArcRef {
  roadId: Id;
  direction: 'forward' | 'backward';
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Facility".
 */
export interface Facility {
  name: string;
  kind: 'workshop' | 'yard' | 'assembly' | 'dock' | 'quay' | 'other';
  boundary: Polygon;
  accessPointIds: IdList;
  servicePointIds: IdList;
  heightM: PhysicalValue;
  assetId?: Id;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "AccessPoint".
 */
export interface AccessPoint {
  name: string;
  facilityId: Id;
  nodeId: Id;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "ServicePoint".
 */
export interface ServicePoint {
  name: string;
  kind: 'loading' | 'unloading' | 'parking' | 'berth' | 'other';
  nodeId: Id;
  facilityId?: Id;
  accessPointId?: Id;
  resourceIds: IdList;
  provenance: Provenance;
  extensions?: Extensions;
  zoneId?: Id;
  arrival?: ServiceArrival;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Zone".
 */
export interface Zone {
  name: string;
  kind: 'work' | 'drivable' | 'forbidden' | 'water' | 'buffer' | 'waiting' | 'obstacle';
  boundary: Polygon;
  passability: 'unknown' | 'allowed' | 'forbidden' | 'explicit_access_only';
  resourceIds?: IdList;
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Resource".
 */
export interface Resource {
  name: string;
  kind: 'road' | 'junction_conflict' | 'parking' | 'loading' | 'other';
  capacityUnit: 'vehicle' | 'kg' | 'area_m2';
  capacity: PhysicalValue;
  controlModel: 'unknown' | 'exclusive' | 'shared_capacity' | 'directional_exclusive';
  appliesTo: EntityRef[];
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "EntityRef".
 */
export interface EntityRef {
  entityType:
    | 'nodes'
    | 'roads'
    | 'junctions'
    | 'movements'
    | 'facilities'
    | 'accessPoints'
    | 'servicePoints'
    | 'zones';
  entityId: Id;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Source".
 */
export interface Source {
  name: string;
  category:
    'surveyed' | 'drawing' | 'imagery_derived' | 'design_assumption' | 'synthetic' | 'unknown';
  description: string;
  uri?: string;
  date?: string;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "Asset".
 */
export interface Asset {
  path: string;
  sha256: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
  sourceRef: Id;
  widthPx?: number;
  heightPx?: number;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "BackgroundLayer".
 */
export interface BackgroundLayer {
  name: string;
  assetId: Id;
  pixelConvention: 'top_left_x_right_y_down_exif_normalized';
  /**
   * @minItems 6
   * @maxItems 6
   */
  imageToWorld: [number, number, number, number, number, number];
  method: 'manual' | 'similarity' | 'affine';
  controlPoints: {
    pixel: Vec2;
    world: Vec3;
    role: 'fit' | 'check';
  }[];
  provenance: Provenance;
  extensions?: Extensions;
}
/**
 * This interface was referenced by `YardMap`'s JSON-Schema
 * via the `definition` "ExtensionDeclaration".
 */
export interface ExtensionDeclaration {
  version: string;
  category: 'metadata' | 'visual' | 'behavior';
  description?: string;
}
