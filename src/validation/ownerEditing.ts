import type { Issue, Polygon, Vec3, YardMap } from '../domain/model';
import { sameValue } from '../domain/value';
import { pointOwner, roadOwner } from '../domain/ownerEditing';
import { inspectPlanning } from '../domain/planning';
import { roadPoints } from '../geometry/roads';
import { pointInPolygon, polylineWithinPolygon, polylineEntersPolygon, roundRoadIntersectsPolygon } from '../geometry/relations';
import { GEOMETRY_TOLERANCE_M as EPS } from '../geometry/polygons';

const owner = (map: YardMap, id: string) => map.facilities[id] ?? map.zones[id];
const planar = (points: readonly Vec3[], boundary: Polygon) => points.every(point => Math.abs(point[2] - boundary.outer[0][2]) <= EPS);
class OwnerGeometryBudget extends Error {}
/** Commit-only local before/after relations. Existing unrelated quality issues do not block edits. */
export function inspectOwnerGeometryEdit(before: YardMap, after: YardMap, geometryPreservedRoadIds: readonly string[] = [], rigidRoadIds: readonly string[] = []): Issue[] {
  const preserved = new Set(geometryPreservedRoadIds);
  const issues: Issue[] = []; let comparisons = 0;
  const work = (count = 1) => { comparisons += count; if (comparisons > 2_000_000 || issues.length >= 200) throw new OwnerGeometryBudget(); };
  function issue(code: string, kind: string, id: string, message: string, position: Vec3, severity: Issue['severity'] = 'error') {
    issues.push({ code, severity, entityType: kind, entityId: id, jsonPath: '/' + kind + '/' + id,
      message, suggestedAction: '定位该对象，预览调整专用入口或取消本次修改；不自动移动公共路网或缩小内容。', location: { position } });
  }
  try {
    for (const [id, access] of Object.entries(after.accessPoints)) {
      const old = before.accessPoints[id], facility = after.facilities[access.facilityId], oldFacility = old && before.facilities[old.facilityId];
      if (!old || !facility || !oldFacility || old.facilityId !== access.facilityId) continue;
      const position = after.nodes[access.nodeId]!.position, oldPosition = before.nodes[old.nodeId]!.position;
      if (sameValue(position, oldPosition) && sameValue(facility.boundary, oldFacility.boundary)) continue;
      work(facility.boundary.outer.length + oldFacility.boundary.outer.length);
      if (!planar([position], facility.boundary) || !planar([oldPosition], oldFacility.boundary)) {
        issue('OWNER_ENTRANCE_NONPLANAR', 'accessPoints', id, '入口与设施边界不在同一已知水平面，不能确定贴边关系。', position); continue;
      }
      const previous = pointInPolygon(oldPosition, oldFacility.boundary), next = pointInPolygon(position, facility.boundary);
      if (previous === 'boundary' && next !== 'boundary' || previous === 'inside' && next === 'outside' || previous === 'outside' && next === 'inside') {
        issue('OWNER_ENTRANCE_REPOSITION_REQUIRED', 'accessPoints', id, '入口需要重新定位：本次修改改变了原有入口与设施轮廓的关系。', position);
      } else if (previous === 'outside' && next === 'outside') issue('OWNER_ENTRANCE_LOCATION_UNCHECKED', 'accessPoints', id, '入口原本是设施外部的显式接入位置，保留原声明；其现场门位未核验。', position, 'warning');
    }
    const planning = inspectPlanning(after), oldSlots = new Map(inspectPlanning(before).slots.map(slot => [slot.id, slot]));
    for (const slot of planning.slots) if (slot.servicePointId) {
      const service = after.servicePoints[slot.servicePointId]!, oldSlot = oldSlots.get(slot.id), oldService = before.servicePoints[slot.servicePointId];
      const position = after.nodes[service.nodeId]!.position;
      if (!oldSlot || !oldService) continue;
      const oldPosition = before.nodes[oldService.nodeId]!.position;
      if (sameValue(position, oldPosition) && sameValue(slot.boundary, oldSlot.boundary)) continue;
      work(slot.boundary.outer.length + oldSlot.boundary.outer.length);
      if (pointInPolygon(position, slot.boundary) === 'outside') {
        const existed = pointInPolygon(oldPosition, oldSlot.boundary) === 'outside';
        issue('OWNER_PARKING_POINT_OUTSIDE_SLOT', 'servicePoints', slot.servicePointId, '停车作业点位于对应泊位外；本次操作不缩小或移动泊位来通关。', position, existed ? 'warning' : 'error');
      }
    }
    for (const id of Object.keys(after.roads)) {
      const old = before.roads[id], road = after.roads[id]!;
      const points = roadPoints(after, id), oldPoints = old ? roadPoints(before, id) : undefined, moved = !oldPoints || !sameValue(points, oldPoints);
      const widthChanged = !old || !sameValue(old.widthM, road.widthM);
      const ownerId = roadOwner(after, id), region = ownerId && owner(after, ownerId), oldRegion = ownerId && owner(before, ownerId);
      if (region && oldRegion && oldPoints && (moved || !sameValue(region.boundary, oldRegion.boundary))) {
        if (!planar(points, region.boundary) || !planar(oldPoints, oldRegion.boundary)) {
          issue('OWNER_ROAD_NONPLANAR', 'roads', id, '内部道路与归属边界不共面；整体刚体变换保留原有高差，独立局部调整需要明确三维维护规则。', points[0]!, rigidRoadIds.includes(id) ? 'warning' : 'error');
        } else if (polylineWithinPolygon(oldPoints, oldRegion.boundary, work) && !polylineWithinPolygon(points, region.boundary, work)) {
          issue('OWNER_INTERNAL_ROAD_OUTSIDE', 'roads', id, '内部道路超出原本包含它的归属边界；请调整道路或取消轮廓修改。', points[0]!);
        }
      }
      for (const [facilityId, facility] of Object.entries(after.facilities)) {
        const previous = before.facilities[facilityId];
        const boundaryChanged = previous && !sameValue(previous.boundary, facility.boundary);
        if (!previous || facility.kind !== 'workshop' || ownerId === facilityId || preserved.has(id) && !boundaryChanged || !moved && !widthChanged && !boundaryChanged) continue;
        // Explicit internal routes may enter their own workshop; an arbitrary adjacent road may not gain that permission.
        const permittedInternal = Object.values(after.servicePoints).some(point => pointOwner(point) === facilityId && point.arrival?.mode === 'explicit_internal' && point.arrival.internalPath.some(arc => arc.roadId === id));
        if (permittedInternal) continue;
        if (!planar(points, facility.boundary) || oldPoints && !planar(oldPoints, previous.boundary)) continue;
        if (polylineEntersPolygon(points, facility.boundary, work) && (!oldPoints || !polylineEntersPolygon(oldPoints, previous.boundary, work))) {
          issue('OWNER_ROAD_NEW_BUILDING_CROSSING', 'roads', id, '道路新穿过厂房 ' + facilityId + ' 实体轮廓，未声明为其内部通路；请调整接入位置。', points[0]!);
        }
        const doorEndpoint = Object.values(after.accessPoints).some(point => point.facilityId === facilityId && (point.nodeId === road.fromNodeId || point.nodeId === road.toNodeId));
        // A declared doorway endpoint necessarily meets its own footprint; no doorway clearance is inferred.
        if (!doorEndpoint && road.widthM.state === 'known' && road.widthM.value > 0) {
          const hit = roundRoadIntersectsPolygon(points, road.widthM.value / 2, facility.boundary, work);
          const oldHit = oldPoints && old?.widthM.state === 'known' && old.widthM.value > 0 && roundRoadIntersectsPolygon(oldPoints, old.widthM.value / 2, previous.boundary, work);
          if (hit && !oldHit) issue('OWNER_ROAD_NEW_BUILDING_BAND_CONFLICT', 'roads', id, '道路声明宽度新覆盖厂房 ' + facilityId + '；请调整宽度或几何。', points[0]!);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof OwnerGeometryBudget)) throw error;
    issues.push({ code: 'OWNER_GEOMETRY_INCOMPLETE', severity: 'error', jsonPath: '', message: '归属几何检查达到预算，事务未提交。', suggestedAction: '缩小编辑范围后重试。' });
  }
  return issues;
}
