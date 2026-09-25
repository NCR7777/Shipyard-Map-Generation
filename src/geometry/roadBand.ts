import type { Polygon } from '../domain/model';
import { flattenPath, type ResolvedPath } from './roadPath';
import { pointInPolygon, polylineBoundaryDistance, polylineWithinPolygon, roundRoadIntersectsPolygon, type GeometryWork } from './relations';
import { GEOMETRY_TOLERANCE_M } from './polygons';

export interface RoadBandIntersection { status: 'clear' | 'intersects' | 'uncertain'; errorM: number }
/** Round cap / round join sweep. The outer envelope excludes, the inner envelope proves overlap. */
export function inspectRoadBand(path: ResolvedPath, radiusM: number, polygon: Polygon, work: (amount?: number) => void = () => {}): RoadBandIntersection {
  for (const tolerance of [0.05, 0.002, 0.0001]) {
    const flat = flattenPath(path, tolerance), points = flat.samples.map(sample => sample.position);
    work(points.length);
    if (!flat.converged) return { status: 'uncertain', errorM: flat.errorM };
    if (flat.errorM === 0) return { status: roundRoadIntersectsPolygon(points, radiusM, polygon, work) ? 'intersects' : 'clear', errorM: 0 };
    if (!roundRoadIntersectsPolygon(points, radiusM + flat.errorM, polygon, work)) return { status: 'clear', errorM: flat.errorM };
    if (radiusM > flat.errorM && roundRoadIntersectsPolygon(points, radiusM - flat.errorM, polygon, work)) return { status: 'intersects', errorM: flat.errorM };
    if (tolerance === 0.0001) return { status: 'uncertain', errorM: flat.errorM };
  }
  return { status: 'uncertain', errorM: Infinity };
}

export interface PathContainment { status: 'inside' | 'outside' | 'uncertain'; errorM: number }
/** A chord inside a corridor does not prove its curve is inside.
 * Exact curve samples prove an exit; a complete chord path with boundary clearance
 * larger than its certified deviation proves containment. Boundary cases refine.
 */
export function inspectPathContainment(path: ResolvedPath, polygon: Polygon, work: GeometryWork = () => {}): PathContainment {
  let errorM = Infinity;
  const boundaryCount = polygon.outer.length + polygon.holes.reduce((sum, ring) => sum + ring.length, 0);
  for (const tolerance of [0.05, 0.002, 0.0001]) {
    const flat = flattenPath(path, tolerance), points = flat.samples.map(sample => sample.position);
    errorM = flat.errorM;
    work(points.length * boundaryCount);
    // These vertices lie on the authoritative path, unlike chord interiors.
    if (points.some(point => pointInPolygon(point, polygon) === 'outside')) return { status: 'outside', errorM };
    if (!flat.converged) return { status: 'uncertain', errorM };
    const chordsInside = polylineWithinPolygon(points, polygon, work);
    if (errorM === 0) return { status: chordsInside ? 'inside' : 'outside', errorM };
    if (chordsInside && polylineBoundaryDistance(points, polygon, work) > errorM + GEOMETRY_TOLERANCE_M) return { status: 'inside', errorM };
  }
  return { status: 'uncertain', errorM };
}
