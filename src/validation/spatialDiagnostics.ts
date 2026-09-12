import type { Issue, Polygon, Vec3, YardMap } from '../domain/model';
import { inspectPlanning, PLANNING_NAMESPACE } from '../domain/planning';
import { GEOMETRY_TOLERANCE_M as EPS, validatePolygon } from '../geometry/polygons';
import { geometryBounds, roadPoints, roadWidthBounds } from '../geometry/roads';
import { pointInPolygon, polygonHasArea, polylineWithinPolygon, roundRoadIntersectsPolygon } from '../geometry/relations';
import type { DiagnosticCheck, DiagnosticSection } from './diagnostics';
import { sameValue } from '../domain/value';

type Bounds = NonNullable<ReturnType<typeof geometryBounds>>;
interface Space { kind: 'facilities' | 'zones'; id: string; boundary: Polygon }
const pointer = (id: string) => id.replace(/~/g, '~0').replace(/\//g, '~1');
const bounds = (polygon: Polygon) => geometryBounds(polygon.outer)!;
const overlaps = (a: Bounds, b: Bounds) => a.max[0] >= b.min[0] && b.max[0] >= a.min[0] && a.max[1] >= b.min[1] && b.max[1] >= a.min[1];
const samePlane = (points: readonly Vec3[], polygon: Polygon) => points.every(point => Math.abs(point[2] - polygon.outer[0][2]) <= EPS);
class BudgetExceeded extends Error {}
interface SpatialScope {
  roads: ReadonlySet<string>; owners: ReadonlySet<string>; slots: ReadonlySet<string>; services: ReadonlySet<string>;
}
interface SpatialOptions { maxComparisons?: number; scope?: SpatialScope }
export interface SpatialInspection extends DiagnosticSection { completion: 'finished' | 'budget_exhausted' | 'truncated' }

/** Declaration-level XY checks on an already schema/reference-validated map.
 * No map mutation, traffic execution, inferred building prohibition or clearance claim.
 */
export function inspectSpatial(map: YardMap, options: SpatialOptions = {}): SpatialInspection {
  const scope = options.scope;
  const maximum = options.maxComparisons ?? 2_000_000;
  if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('maxComparisons must be a non-negative safe integer');
  const issues: Issue[] = [], checks: DiagnosticCheck[] = [];
  const planning = inspectPlanning(map);
  const unknown = !planning.supported || Object.entries(map.extensionNamespaces).some(([name, entry]) => entry.category !== 'metadata' && (name !== PLANNING_NAMESPACE || !planning.supported));
  let spent = 0, issueLimit = false;
  const work = (amount = 1) => { spent += amount; if (spent > maximum) throw new BudgetExceeded(); };
  function issue(code: string, kind: string, id: string, path: string, message: string, position?: Vec3, severity: Issue['severity'] = 'error'): void {
    if (issues.length >= 200) { issueLimit = true; return; }
    issues.push({ code, severity: unknown ? 'warning' : severity, entityType: kind, entityId: id, jsonPath: path,
      message: (unknown ? '未知扩展可能改变空间关系；以下仅为候选。' : '') + message,
      suggestedAction: '核对声明边界、引用与来源后明确修改；本诊断不证明车辆净空或现场安全。',
      ...(position ? { location: { position: [...position] } } : {}) });
  }
  const valid = new Map<Polygon, boolean>();
  function usable(polygon: Polygon): boolean {
    const cached = valid.get(polygon); if (cached !== undefined) return cached;
    const count = polygon.outer.length + polygon.holes.reduce((sum, ring) => sum + ring.length, 0);
    work(count * count); const result = validatePolygon(polygon).length === 0;
    valid.set(polygon, result); return result;
  }
  function run(id: string, action: () => { count: number; skipped: number; detail: string }): void {
    if (spent > maximum) { checks.push({ id, status: 'not_checked', detail: '几何比较预算已耗尽，未运行此项。' }); return; }
    try {
      const result = action();
      checks.push({ id, status: result.skipped || unknown ? result.count ? 'partial' : 'not_checked' : 'checked',
        detail: result.detail + ' 已检查 ' + result.count + ' 项；未检查 ' + result.skipped + ' 项。' });
    } catch (error) {
      if (!(error instanceof BudgetExceeded)) throw error;
      checks.push({ id, status: 'partial', detail: '几何比较预算 ' + maximum + ' 已耗尽；已有问题保留，其余候选未检查，不能据此判断无冲突。' });
    }
  }
  const slotIndices = new Map<string, Map<string, number>>();
  const slots = planning.slots.map(slot => {
    const ownerKey = slot.ownerKind + '/' + slot.ownerId;
    if (!slotIndices.has(ownerKey)) {
      const payload = map[slot.ownerKind][slot.ownerId]!.extensions?.[PLANNING_NAMESPACE] as { slots?: { id: string }[] } | undefined;
      slotIndices.set(ownerKey, new Map(payload?.slots?.map((item, index) => [item.id, index])));
    }
    const index = slotIndices.get(ownerKey)!.get(slot.id) ?? -1;
    return { ...slot, box: bounds(slot.boundary), path: '/' + slot.ownerKind + '/' + pointer(slot.ownerId) + '/extensions/' + PLANNING_NAMESPACE + '/slots/' + index + '/boundary' };
  });
  run('spatial.slot_containment', () => {
    let count = 0, skipped = planning.supported ? 0 : 1;
    for (const slot of slots) {
      if (scope && !scope.owners.has(slot.ownerKind + '/' + slot.ownerId) && !scope.slots.has(slot.id)) continue;
      work(); const owner = map[slot.ownerKind][slot.ownerId]!;
      if (!usable(owner.boundary) || !samePlane(slot.boundary.outer, owner.boundary)) { skipped++; continue; }
      count++;
      if (polygonHasArea(slot.boundary, owner.boundary, 'outside', work)) issue('SPATIAL_SLOT_OUTSIDE_OWNER', slot.ownerKind, slot.ownerId, slot.path,
        '槽位 ' + slot.id + ' 的面超出所属区域（含孔洞），边界接触不计越界。', slot.boundary.outer[0]);
    }
    return { count, skipped, detail: '完整槽位面与显式 owner 边界包含；不将父区域包含子区判作重叠冲突。' };
  });
  run('spatial.slot_overlap', () => {
    let count = 0, skipped = planning.supported ? 0 : 1;
    const groups = new Map<string, typeof slots>();
    for (const slot of slots) { const key = slot.ownerKind + '/' + slot.ownerId; const group = groups.get(key) ?? []; group.push(slot); groups.set(key, group); }
    for (const group of groups.values()) {
      if (scope && !group.some(slot => scope.slots.has(slot.id))) continue;
      group.sort((a, b) => a.box.min[0] - b.box.min[0] || a.id.localeCompare(b.id));
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        work(); const a = group[i]!, b = group[j]!;
        if (b.box.min[0] >= a.box.max[0] - EPS) break;
        if (scope && !scope.slots.has(a.id) && !scope.slots.has(b.id)) continue;
        if (!overlaps(a.box, b.box)) continue;
        if (!samePlane(a.boundary.outer, b.boundary)) { skipped++; continue; }
        count++;
        if (polygonHasArea(a.boundary, b.boundary, 'intersection', work)) issue('SPATIAL_SLOT_OVERLAP', b.ownerKind, b.ownerId, b.path,
          '同一 owner 的互斥槽位 ' + a.id + ' 与 ' + b.id + ' 有正面积重叠；接触不冲突。', b.boundary.outer[0]);
      }
    }
    return { count, skipped, detail: '扫描 ' + slots.length + ' 个槽位；精查同 owner 包围盒候选的正面积交；不同 owner 缺少互斥声明，不据此判冲突。' };
  });
  const forbidden: Space[] = Object.entries(map.zones).filter(([, zone]) => zone.passability === 'forbidden').map(([id, zone]) => ({ kind: 'zones', id, boundary: zone.boundary }));
  if (planning.supported) for (const [id, facility] of Object.entries(map.facilities)) {
    const payload = facility.extensions?.[PLANNING_NAMESPACE] as { vehicleAccess?: string } | undefined;
    if (payload?.vehicleAccess === 'forbidden') forbidden.push({ kind: 'facilities', id, boundary: facility.boundary });
  }
  run('spatial.road_forbidden', () => {
    let count = 0, skipped = forbidden.length ? 0 : 1;
    for (const [id, road] of Object.entries(map.roads)) {
      if (scope && !scope.roads.has(id) && !forbidden.some(space => scope.owners.has(space.kind + '/' + space.id))) continue;
      work(); const path = '/roads/' + pointer(id);
      const points = roadPoints(map, id);
      if (scope && !scope.roads.has(id) && (road.corridorPolygon || road.widthM.state === 'known' && road.widthM.value > 0)) {
        const box = road.corridorPolygon ? bounds(road.corridorPolygon) : roadWidthBounds(points, road.widthM).bounds;
        if (!box || !forbidden.some(space => scope.owners.has(space.kind + '/' + space.id) && overlaps(box, bounds(space.boundary)))) continue;
      }
      if (points.some(point => point.some(value => !Number.isFinite(value)) || Math.abs(point[0]) > 1e9 || Math.abs(point[1]) > 1e9)) {
        skipped++; issue('SPATIAL_ROAD_RANGE_UNCHECKED', 'roads', id, path, '道路超出当前几何内核的有限坐标范围，未计算通行带。', undefined, 'warning'); continue;
      }
      const corridor = road.corridorPolygon;
      const width = road.widthM.state === 'known' && road.widthM.value > 0 ? road.widthM.value : null;
      if (corridor && !usable(corridor)) { skipped++; issue('SPATIAL_CORRIDOR_UNCHECKED', 'roads', id, path + '/corridorPolygon', '声明带几何不可用，未改用其他几何替代。', points[0], 'warning'); continue; }
      if (corridor && (!scope || scope.roads.has(id)) && samePlane(points, corridor)) {
        count++;
        if (!polylineWithinPolygon(points, corridor, work)) issue('SPATIAL_CORRIDOR_CENTERLINE_OUTSIDE', 'roads', id, path + '/corridorPolygon', '道路中心线部分位于人工声明通行带之外（含孔洞）。', points[0]);
      } else if (corridor && (!scope || scope.roads.has(id))) { skipped++; issue('SPATIAL_LAYER_UNCHECKED', 'roads', id, path + '/corridorPolygon', '中心线与声明带不共平面，未验证其立体关系。', points[0], 'warning'); }
      const hasBand = corridor !== undefined || width !== null && width / 2 > 0;
      if (!hasBand) { skipped++; issue('SPATIAL_WIDTH_UNCHECKED', 'roads', id, path + '/widthM', '没有可用的声明带或已知正宽度；仅可报告中心线候选，未补默认宽度。', points[0], 'warning'); }
      const box = corridor ? bounds(corridor) : roadWidthBounds(points, road.widthM).bounds;
      for (const space of forbidden) {
        if (scope && !scope.roads.has(id) && !scope.owners.has(space.kind + '/' + space.id)) continue;
        work();
        if (!usable(space.boundary)) { skipped++; continue; }
        if (!box || !overlaps(box, bounds(space.boundary))) continue;
        const planar = samePlane(points, space.boundary) && (!corridor || samePlane(corridor.outer, space.boundary));
        const hit = corridor ? polygonHasArea(corridor, space.boundary, 'intersection', work)
          : roundRoadIntersectsPolygon(points, width === null ? 0 : width / 2, space.boundary, work);
        if (!planar || !hasBand) skipped++; else count++;
        if (hit) issue(planar && hasBand ? 'SPATIAL_ROAD_FORBIDDEN' : 'SPATIAL_ROAD_FORBIDDEN_CANDIDATE', 'roads', id, path + (corridor ? '/corridorPolygon' : '/widthM'),
          '道路' + (planar && hasBand ? '声明通行带与' : ' XY 候选与') + space.kind + '/' + space.id + ' 的明确禁止通行面相交。' + (!planar ? ' 高程不同或非平面，立体净空未检查。' : '') + (!hasBand ? ' 宽度未知，不能确认道路带冲突。' : ''),
          points[0], planar && hasBand ? 'error' : 'warning');
      }
    }
    return { count, skipped, detail: (forbidden.length ? '' : '无明确禁入声明，未确认道路与实际建筑/禁区关系。') + '扫描 ' + Object.keys(map.roads).length + ' 道路 × ' + forbidden.length + ' 明确禁区，包围盒排除不相交候选；人工带优先，否则为中心线半宽胶囊并集（圆端/圆连接，无离散化）。不将建筑、SPMT 排除业务网络或水域名称自动视为禁区。' };
  });
  run('spatial.service_owner', () => {
    let count = 0, skipped = 0;
    for (const [id, service] of Object.entries(map.servicePoints)) {
      if (scope && !scope.services.has(id)) continue;
      work();
      const owner = service.facilityId ? map.facilities[service.facilityId] : service.zoneId ? map.zones[service.zoneId] : undefined;
      const position = map.nodes[service.nodeId]?.position;
      if (!owner || !position || !usable(owner.boundary) || !samePlane([position], owner.boundary)) { skipped++; continue; }
      work(owner.boundary.outer.length + owner.boundary.holes.reduce((sum, ring) => sum + ring.length, 0));
      const outside = pointInPolygon(position, owner.boundary) === 'outside';
      if (service.arrival?.mode === 'explicit_internal') {
        count++;
        if (outside) issue('SPATIAL_SERVICE_OUTSIDE_OWNER', 'servicePoints', id, '/servicePoints/' + pointer(id) + '/nodeId', 'explicit_internal 服务节点位于声明 owner 面外（含孔洞），需要核对端点/边界；不自动推导可通行。', position, scope ? 'error' : 'warning');
      } else {
        skipped++;
        if (outside) issue('SPATIAL_SERVICE_PROXY_UNCHECKED', 'servicePoints', id, '/servicePoints/' + pointer(id) + '/nodeId', '代理或未声明到达语义的服务节点位于 owner 面外；可能是合法抽象，未判为几何错误。', position, 'warning');
      }
    }
    return { count, skipped, detail: '只检查明确内部服务点的 owner 几何位置；入口允许位于边界或外部，不作统一内含断言。' };
  });
  checks.push({ id: 'spatial.declaration_coverage', status: 'not_checked',
    detail: 'XY 谓词采用 ' + EPS + ' m 容差。未声明陆地归属的厂界包含、跨 owner 互斥、立体净空/车辆扫掠、来源真实性与行为执行未检查。' + (unknown ? ' 存在未知行为/几何扩展，结果只为候选。' : '') });
  if (issueLimit) checks.push({ id: 'spatial.issue_limit', status: 'partial', detail: '最多展示 200 条空间问题，其余未逐项展示；不能据此判断问题总数。' });
  return { issues, checks, completion: spent > maximum ? 'budget_exhausted' : issueLimit ? 'truncated' : 'finished' };
}

/** Commit-only checks over changed declarations. Unknown physical conditions stay warnings.
 * No full-map issue subtraction: every changed road/forbidden pair is inspected independently.
 */
export function inspectSpatialEdit(before: YardMap, after: YardMap, options: { maxComparisons?: number } = {}): Issue[] {
  const roads = new Set<string>(), owners = new Set<string>(), slots = new Set<string>(), services = new Set<string>();
  for (const [id, road] of Object.entries(after.roads)) {
    const old = before.roads[id];
    if (!old || !sameValue(old.shapePoints, road.shapePoints) || (old.widthM.state !== road.widthM.state || (old.widthM.state === 'known' ? old.widthM.value : undefined) !== (road.widthM.state === 'known' ? road.widthM.value : undefined))
      || !sameValue(old.corridorPolygon, road.corridorPolygon)
      || !sameValue(before.nodes[old.fromNodeId]?.position, after.nodes[road.fromNodeId]?.position)
      || !sameValue(before.nodes[old.toNodeId]?.position, after.nodes[road.toNodeId]?.position)) roads.add(id);
  }
  for (const kind of ['facilities', 'zones'] as const) for (const [id, owner] of Object.entries(after[kind])) {
    const old = before[kind][id];
    const oldFields = old?.extensions?.[PLANNING_NAMESPACE] as { slots?: { id: string; boundary: Polygon }[]; vehicleAccess?: string } | undefined;
    const fields = owner.extensions?.[PLANNING_NAMESPACE] as typeof oldFields;
    if (!old || !sameValue(old.boundary, owner.boundary) || oldFields?.vehicleAccess !== fields?.vehicleAccess
      || (kind === 'zones' && before.zones[id]?.passability !== after.zones[id]?.passability)) owners.add(kind + '/' + id);
    const previous = new Map(oldFields?.slots?.map(slot => [slot.id, slot.boundary]));
    for (const slot of fields?.slots ?? []) if (!sameValue(previous.get(slot.id), slot.boundary)) slots.add(slot.id);
  }
  for (const [id, service] of Object.entries(after.servicePoints)) {
    const old = before.servicePoints[id];
    const owner = service.facilityId ? 'facilities/' + service.facilityId : 'zones/' + service.zoneId;
    if (!old || old.nodeId !== service.nodeId || old.facilityId !== service.facilityId || old.zoneId !== service.zoneId || !sameValue(old.arrival, service.arrival) || owners.has(owner)
      || !sameValue(before.nodes[old.nodeId]?.position, after.nodes[service.nodeId]?.position)) services.add(id);
  }
  if (!roads.size && !owners.size && !slots.size && !services.size) return [];
  const result = inspectSpatial(after, { ...options, scope: { roads, owners, slots, services } });
  const issues = [...result.issues];
  if (result.completion !== 'finished') issues.push({ code: 'SPATIAL_EDIT_INCOMPLETE', severity: 'error', jsonPath: '',
    message: '受影响空间关系检查未完成：' + result.completion + '；事务未提交。',
    suggestedAction: '缩小编辑影响范围并重新检查；不能将预算耗尽或结果截断当作无冲突。' });
  return issues;
}
