import type { Issue, Vec3, YardMap } from '../domain/model';
import type { DiagnosticSection } from '../validation/diagnostics';
import { GEOMETRY_TOLERANCE_M as EPS, pointOnSegment, segmentsIntersect } from '../geometry/polygons';
import { geometryBounds, roadPoints } from '../geometry/roads';

interface Segment { roadId: string; index: number; a: Vec3; b: Vec3; startNode?: string; endNode?: string }
const NEAR_M = 0.5;
const MAX_PAIRS = 2_000_000;
const MAX_ISSUES = 500;
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const interpolate = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function projection(p: Vec3, a: Vec3, b: Vec3): { point: Vec3; t: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = denominator > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / denominator)) : 0;
  return { point: interpolate(a, b, t), t };
}
function intersection(a: Segment, b: Segment): { point: Vec3; other: Vec3; overlap: boolean } | null {
  if (!segmentsIntersect(a.a, a.b, b.a, b.b)) return null;
  const dx = a.b[0] - a.a[0], dy = a.b[1] - a.a[1], ex = b.b[0] - b.a[0], ey = b.b[1] - b.a[1];
  const denominator = dx * ey - dy * ex;
  if (Math.abs(denominator) > EPS * Math.max(1, distance(a.a, a.b), distance(b.a, b.b))) {
    const t = ((b.a[0] - a.a[0]) * ey - (b.a[1] - a.a[1]) * ex) / denominator;
    const point = interpolate(a.a, a.b, Math.max(0, Math.min(1, t)));
    return { point, other: projection(point, b.a, b.b).point, overlap: false };
  }
  const common = [a.a, a.b, b.a, b.b].filter(p => pointOnSegment(p, a.a, a.b) && pointOnSegment(p, b.a, b.b));
  if (!common.length) return null;
  common.sort((p, q) => projection(p, a.a, a.b).t - projection(q, a.a, a.b).t);
  const point = interpolate(common[0]!, common.at(-1)!, 0.5);
  return { point: projection(point, a.a, a.b).point, other: projection(point, b.a, b.b).point, overlap: distance(common[0]!, common.at(-1)!) > EPS };
}
function nodeAt(segment: Segment, point: Vec3): string | undefined {
  if (segment.startNode && distance(segment.a, point) <= EPS) return segment.startNode;
  if (segment.endNode && distance(segment.b, point) <= EPS) return segment.endNode;
  return undefined;
}

/** Bounded XY candidates with declared Z evidence; geometry never establishes connectivity. */
export function inspectNetwork(map: YardMap): DiagnosticSection {
  const issues: Issue[] = []; const checks: DiagnosticSection['checks'] = [];
  let limited = false; let pairs = 0;
  const emitted = new Set<string>();
  const add = (code: string, kind: string, id: string, suffix: string, position: Vec3, message: string, identity = '') => {
    const key = [code, kind, id, identity].join('|');
    if (emitted.has(key)) return;
    emitted.add(key);
    if (issues.length >= MAX_ISSUES) { limited = true; return; }
    issues.push({ code, severity: 'warning', entityType: kind, entityId: id, jsonPath: '/' + kind + '/' + pointer(id) + suffix,
      location: { position: [...position] }, message, suggestedAction: '核对这些声明及现场依据；本批只读列出候选，不自动连接、合并或修改地图。' });
  };
  const tick = () => { if (++pairs > MAX_PAIRS) { limited = true; return false; } return !limited; };
  const coordinates = Object.values(map.nodes).map(n => n.position).concat(Object.values(map.roads).flatMap(r => r.shapePoints));
  if (coordinates.some(p => p.some(n => !Number.isFinite(n) || Math.abs(n) > 1e9))) {
    return { issues: [], checks: [{ id: 'network_geometry', status: 'not_checked', detail: '坐标超出有限 ±1e9 m 数值检查范围，未确认是否存在交点或断开。' }] };
  }
  const segments: Segment[] = [];
  const adjacency = new Map(Object.keys(map.nodes).map(id => [id, new Set<string>()]));
  const direct = new Set<string>();
  for (const [id, road] of Object.entries(map.roads)) {
    adjacency.get(road.fromNodeId)?.add(road.toNodeId); adjacency.get(road.toNodeId)?.add(road.fromNodeId);
    direct.add([road.fromNodeId, road.toNodeId].sort().join('|'));
    const points = roadPoints(map, id);
    if (road.direction === 'unknown') add('P2A_DIRECTION_UNKNOWN', 'roads', id, '/direction', points[0]!, '道路方向未声明，不能将其默认为双向。');
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i]!, b = points[i + 1]!;
      if (distance(a, b) <= EPS) { add('P2A_ZERO_SEGMENT', 'roads', id, '/shapePoints', a, '道路含 XY 零长或低于数值容差的段，段索引 ' + i + '。', String(i)); continue; }
      segments.push({ roadId: id, index: i, a, b, ...(i === 0 ? { startNode: road.fromNodeId } : {}), ...(i === points.length - 2 ? { endNode: road.toNodeId } : {}) });
    }
  }
  for (let i = 0; i < segments.length && !limited; i++) for (let j = i + 1; j < segments.length && tick(); j++) {
    const a = segments[i]!, b = segments[j]!;
    const aa = geometryBounds([a.a, a.b])!, bb = geometryBounds([b.a, b.b])!;
    if (aa.max[0] + EPS < bb.min[0] || bb.max[0] + EPS < aa.min[0] || aa.max[1] + EPS < bb.min[1] || bb.max[1] + EPS < aa.min[1]) continue;
    const hit = intersection(a, b); if (!hit) continue;
    if (a.roadId === b.roadId && j === i + 1 && !hit.overlap) continue;
    const an = nodeAt(a, hit.point), bn = nodeAt(b, hit.other);
    if (!hit.overlap && an && an === bn) continue;
    const differentZ = Math.abs(hit.point[2] - hit.other[2]) > EPS;
    const kind = hit.overlap ? 'COLLINEAR_OVERLAP' : differentZ ? 'CROSSING_DIFFERENT_Z' : an && bn ? 'ENDPOINT_IDS_DIFFER' : an || bn ? 'T_JUNCTION_CANDIDATE' : a.roadId === b.roadId ? 'SELF_CROSSING' : 'X_CROSSING_CANDIDATE';
    const note = differentZ ? '声明 Z 不同；尚未确认跨越结构、物理层或净空。' : '声明 Z 接近，但不代表测得同层或获得通行许可。';
    add('P2A_' + kind, 'roads', a.roadId, '/shapePoints', hit.point,
      '道路 ' + a.roadId + ' 段 ' + a.index + ' 与 ' + b.roadId + ' 段 ' + b.index + (hit.overlap ? ' 在 XY 共线重叠。' : ' 在 XY 接触/交叉，未显式共享该处节点。') + note,
      b.roadId + '/' + a.index + '/' + b.index);
  }
  const nodes = Object.entries(map.nodes);
  for (let i = 0; i < nodes.length && !limited; i++) for (let j = i + 1; j < nodes.length && tick(); j++) {
    const [id, a] = nodes[i]!, [otherId, b] = nodes[j]!;
    if (direct.has([id, otherId].sort().join('|'))) continue;
    const d = Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]);
    if (d <= NEAR_M) add(d <= EPS ? 'P2A_COINCIDENT_NODE_IDS' : 'P2A_NEAR_UNCONNECTED_NODES', 'nodes', id, '/position', a.position,
      '与节点 ' + otherId + ' 的声明距离为 ' + d.toPrecision(4) + ' m；不同 ID 且无显式直连道路。', otherId);
  }
  for (const [id, node] of nodes) {
    if (limited) break;
    for (const segment of segments) {
      if (!tick()) break;
      if (segment.startNode === id || segment.endNode === id) continue;
      const nearest = projection(node.position, segment.a, segment.b);
      if (distance(nearest.point, segment.a) <= EPS || distance(nearest.point, segment.b) <= EPS) continue;
      if (Math.hypot(...node.position.map((n, axis) => n - nearest.point[axis]!)) <= NEAR_M) add('P2A_NODE_NEAR_ROAD_INTERIOR', 'nodes', id, '/position', node.position,
        '节点距道路 ' + segment.roadId + ' 的内部段 ' + segment.index + ' 不超过 ' + NEAR_M + ' m，但不是该道路端点；几何接近不建立连接。', segment.roadId);
    }
  }
  // Connected components are geometric road attachments only, not directed/turn reachability.
  const seen = new Set<string>(); const components: string[][] = [];
  for (const [id] of nodes) {
    if (seen.has(id)) continue;
    const component: string[] = []; const pending = [id]; seen.add(id);
    while (pending.length) { const current = pending.pop()!; component.push(current); for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); pending.push(next); } }
    components.push(component.sort());
  }
  components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
  for (const [id, node] of nodes) if (!adjacency.get(id)?.size) add('P2A_ISOLATED_NODE', 'nodes', id, '/position', node.position, '节点没有任何道路端点关联；可能是草稿或独立标记，不自动连接。');
  if (components.length > 1) for (const component of components.slice(1)) if (component.some(id => adjacency.get(id)?.size)) {
    const id = component[0]!;
    add('P2A_SEPARATE_COMPONENT', 'nodes', id, '/position', map.nodes[id]!.position,
      '与最大道路端点分量分离的显式节点组：' + component.join('、') + '。可能为独立子网；未判断运行可达性。', id);
  }
  for (const [id, facility] of Object.entries(map.facilities)) if (!facility.accessPointIds.length && !facility.servicePointIds.length) add('P2A_FACILITY_NO_SERVICE', 'facilities', id, '/servicePointIds', facility.boundary.outer[0], '设施未声明入口或服务点；不将面积或中心自动作为运输目标。');
  for (const kind of ['accessPoints', 'servicePoints'] as const) for (const [id, point] of Object.entries(map[kind])) if (!adjacency.get(point.nodeId)?.size) add('P2A_POINT_UNCONNECTED', kind, id, '/nodeId', map.nodes[point.nodeId]!.position, '该点权威节点没有道路端点关联，无法从外部道路进入。');
  checks.push({ id: 'network_geometry', status: limited ? 'partial' : 'checked', detail: 'XY 交点/共线重叠、端点近邻、孤立节点和分量；数值容差 1e-7 m、提示距离 0.5 m。' + (limited ? '达到 200 万候选或 500 条结果预算，清单未完成。' : '') },
    { id: 'crossing_physical_layers', status: 'not_checked', detail: '比较声明 Z 只用于说明；没有跨越结构/物理层证明，不确认真实道路连接、净空或车辆通行。' });
  return { issues, checks };
}
