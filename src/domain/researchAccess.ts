import type { Issue, Polygon, Source, Vec3, YardMap } from './model';
import type { MapCommand, SplitMapping } from './commands';
import { newAccessPoint, newServicePoint } from './factory';
import { contentHash } from './serialization';
import { sameValue } from './value';
import { sourceId } from './geometrySources';
import { allocateMapIds, runQuickTrace, type QuickTraceConnection } from './drawingDefaults';
import { roadOwner } from './ownerEditing';
import { TopologyError } from './topologyEditing';
import { projectPolyline, roadLength } from '../geometry/roads';
import { flattenPath, getRoadPath, projectToPath } from '../geometry/roadPath';
import { polylineEntersPolygon, polylineWithinPolygon } from '../geometry/relations';
import { inspectServiceConnection, zoneServicePointIds } from '../topology/serviceConnections';
import { preparePathPreview } from '../topology/pathPreview';
import { validateMap } from '../validation/validate';

export interface ResearchTarget { kind: 'facilities' | 'zones'; id: string }
export interface ResearchAccessOptions {
  landZoneIds: string[]; maxDistanceM?: number; widthM?: number;
  transferAssumption?: 'included_in_service_duration' | 'excluded_from_model'; note?: string;
}
export interface ResearchAccessCandidate { position: Vec3; roadId: string; distanceM: number; connectionPoint: Vec3; lengthM: number; landZoneId: string }
export interface ResearchAccessProposal {
  mapId: string; baseMapContentHash: string; targets: ResearchTarget[]; options: ResearchAccessOptions;
  items: { target: ResearchTarget; status: 'ready' | 'existing' | 'unresolved'; reason: string; candidate?: ResearchAccessCandidate }[];
}
export interface ApplyResearchAccessCommand { type: 'applyResearchAccess'; proposal: ResearchAccessProposal; acceptedTargetIds?: string[] }
export interface ResearchInputReport { level: 'spatial' | 'routing' | 'scheduling'; ready: boolean; issues: Issue[]; assumptions: string[]; targets: { target: ResearchTarget; status: string }[] }
type SplitRoad = (map: YardMap, command: Extract<MapCommand, { type: 'splitRoad' }>) => SplitMapping;
const EPS = 1e-6;
const targetKey = (target: ResearchTarget) => target.kind + '/' + target.id;
const accessSource: Source = { name: '研究接入：边界交接代理', category: 'design_assumption', description: '用户批量接受的研究假设：选定目标边界与明确可行驶陆域上的短接线；不识别真实门位、不生成设施内部路线、不估算真实产能或车辆净空。' };
function fail(code: string, message: string): never { throw new TopologyError(code, message); }
function services(map: YardMap, target: ResearchTarget): string[] { return target.kind === 'facilities' ? map.facilities[target.id]?.servicePointIds ?? [] : zoneServicePointIds(map, target.id); }
function targetAllowed(map: YardMap, target: ResearchTarget): boolean {
  const entity = map[target.kind][target.id];
  if (!entity) return false;
  if (target.kind === 'zones') return !['water', 'forbidden', 'obstacle'].includes(entity.kind) && map.zones[target.id]!.passability !== 'forbidden';
  return (entity.extensions?.['sr02.planning'] as { vehicleAccess?: string } | undefined)?.vehicleAccess !== 'forbidden';
}
function normalizeOptions(options: ResearchAccessOptions): ResearchAccessOptions {
  if (!options || !Array.isArray(options.landZoneIds) || options.landZoneIds.some(id => typeof id !== 'string') || options.landZoneIds.length > 4096 || Object.keys(options).some(key => !['landZoneIds', 'maxDistanceM', 'widthM', 'transferAssumption', 'note'].includes(key))) fail('RESEARCH_ACCESS_OPTIONS', '接入只接收明确陆域、距离、设计宽度和场内转运假设。');
  const result = { landZoneIds: [...new Set(options.landZoneIds)].sort(), maxDistanceM: options.maxDistanceM ?? 50, widthM: options.widthM ?? 12, transferAssumption: options.transferAssumption ?? 'excluded_from_model' as const, note: options.note ?? '' };
  if (!Number.isFinite(result.maxDistanceM) || result.maxDistanceM <= 0 || result.maxDistanceM > 1000 || !Number.isFinite(result.widthM) || result.widthM <= 0 || !['included_in_service_duration', 'excluded_from_model'].includes(result.transferAssumption) || typeof result.note !== 'string' || result.note.length > 2048) fail('RESEARCH_ACCESS_OPTIONS', '接入距离须为 0 至 1000 米的正数，设计宽度与转运假设必须有效。');
  return result;
}
function selectedTargets(targets: ResearchTarget[]): ResearchTarget[] {
  if (!Array.isArray(targets) || targets.length > 1024 || targets.some(target => !target || !['facilities', 'zones'].includes(target.kind) || typeof target.id !== 'string' || !target.id || Object.keys(target).some(key => !['kind', 'id'].includes(key)))) fail('RESEARCH_TARGETS', '研究目标必须是明确选定的设施或区域 ID。');
  return [...new Map(targets.map(target => [targetKey(target), { ...target }])).values()];
}

/** A bounded candidate search; sampling proposes positions, exact path projection and polygon segments decide acceptance. */
export function prepareResearchAccess(map: YardMap, targets: ResearchTarget[], input: ResearchAccessOptions): ResearchAccessProposal {
  const options = normalizeOptions(input), selected = selectedTargets(targets);
  const proposal: ResearchAccessProposal = { mapId: map.mapId, baseMapContentHash: contentHash(map), targets: selected, options, items: [] };
  const land = options.landZoneIds.filter(id => map.zones[id]?.kind === 'drivable' && map.zones[id]?.passability === 'allowed');
  for (const target of selected) {
    const entity = map[target.kind][target.id];
    const item: ResearchAccessProposal['items'][number] = { target, status: 'unresolved', reason: '没有可证明处于明确陆域且不穿越建筑/水域的短接线。' };
    proposal.items.push(item);
    if (!entity) { item.reason = '所选目标不存在。'; continue; }
    if (!targetAllowed(map, target)) { item.reason = '该目标已声明禁止车辆接入，或属于水域、禁入、障碍区域。'; continue; }
    const existing = services(map, target);
    if (existing.length) { item.status = 'existing'; item.reason = '保留已有服务点与到达语义：' + existing.join('、') + '；可在分级检查中核对可达性。'; continue; }
    if (!land.length) { item.reason = '未选定 kind=drivable 且 passability=allowed 的陆域，不能凭邻近自动接路。'; continue; }
    let workCount = 0;
    const work = (amount = 1) => { workCount += amount; if (workCount > 300_000) fail('RESEARCH_ACCESS_COMPLEXITY', '候选搜索超过本目标工作预算，保留未完成并缩小目标/陆域范围。'); };
    try {
      const boundary = entity.boundary, candidates: ResearchAccessCandidate[] = [];
      const vertices = boundary.outer.slice(0, -1), seeds = [...vertices, ...vertices.map((point, i): Vec3 => { const next = boundary.outer[i + 1]!; return [(point[0] + next[0]) / 2, (point[1] + next[1]) / 2, point[2]]; })];
      for (const [roadId, road] of Object.entries(map.roads).sort(([a], [b]) => a.localeCompare(b))) {
        work(); if (roadOwner(map, roadId) || road.direction === 'unknown') continue;
        const path = getRoadPath(map, roadId);
        if ([...path.anchors, ...path.spans.flatMap(span => span.kind === 'cubic' ? [span.control1, span.control2] : [])].some(point => point[2] !== vertices[0]![2])) continue;
        const flat = flattenPath(path, 0.25); if (!flat.converged) continue;
        const positions = [...seeds];
        // Samples never enter the graph; they only supply alternative boundary candidates.
        for (const sample of flat.samples) { work(boundary.outer.length); const projection = projectPolyline(sample.position, boundary.outer); if (projection) positions.push(projection.position); }
        const seen = new Set<string>();
        for (const position of positions) {
          const key = position.join(','); if (seen.has(key)) continue; seen.add(key); work(path.spans.length);
          const projection = projectToPath(path, position);
          if (!projection.converged || projection.ambiguous || projection.offsetM > options.maxDistanceM! || projection.point[2] !== position[2]) continue;
          const points = [position, projection.point];
          const landZoneId = land.find(id => { const area = map.zones[id]!.boundary; return [area.outer, ...area.holes].every(ring => ring.every(point => point[2] === position[2])) && polylineWithinPolygon(points, area, work); });
          if (!landZoneId || !clearSegment(map, target, points, boundary, work)) continue;
          candidates.push({ position: [...position], roadId, distanceM: projection.sM, connectionPoint: [...projection.point], lengthM: projection.offsetM, landZoneId });
        }
      }
      candidates.sort((a, b) => a.lengthM - b.lengthM || a.roadId.localeCompare(b.roadId) || a.distanceM - b.distanceM);
      if (candidates[0]) { item.candidate = candidates[0]; item.status = 'ready'; item.reason = `建议 ${candidates[0].lengthM.toFixed(1)} 米短接线至 ${candidates[0].roadId}；目标边界设研究交接代理，门位与设施内转运不作为实测事实。`; }
    } catch (error) { item.reason = (error as Error).message; }
  }
  return proposal;
}
function clearSegment(map: YardMap, target: ResearchTarget, points: Vec3[], boundary: Polygon, work: (amount?: number) => void): boolean {
  if (polylineEntersPolygon(points, boundary, work)) return false;
  for (const facility of Object.values(map.facilities)) if (polylineEntersPolygon(points, facility.boundary, work)) return false;
  for (const [id, zone] of Object.entries(map.zones)) if (!(target.kind === 'zones' && id === target.id) && (zone.passability === 'forbidden' || ['water', 'forbidden', 'obstacle'].includes(zone.kind)) && polylineEntersPolygon(points, zone.boundary, work)) return false;
  return true;
}

/** Applies an accepted preview through existing split/merge commands; no second history, map or storage. */
export function runResearchAccess(map: YardMap, command: ApplyResearchAccessCommand, split: SplitRoad): { geometryPreservedRoadIds: string[] } {
  const proposal = command.proposal;
  if (!proposal || proposal.mapId !== map.mapId || proposal.baseMapContentHash !== contentHash(map)) fail('RESEARCH_ACCESS_STALE', '接入建议与当前地图版本不一致，请重新预览。');
  const verified = prepareResearchAccess(map, proposal.targets, proposal.options);
  if (!sameValue(verified, proposal)) fail('RESEARCH_ACCESS_PROPOSAL_CHANGED', '接入建议内容与当前可复核结果不同，请重新生成。');
  const accepted = command.acceptedTargetIds;
  if (accepted && (!Array.isArray(accepted) || accepted.some(id => typeof id !== 'string' || !verified.items.some(item => id === item.target.id || id === targetKey(item.target))))) fail('RESEARCH_ACCESS_SELECTION', '接受项必须来自本次选定目标。');
  const selected = verified.items.filter(item => item.status === 'ready' && (!accepted || accepted.includes(item.target.id) || accepted.includes(targetKey(item.target))));
  const cuts = new Map<string, SplitMapping & { distanceM: number }>(), preserved = new Set<string>();
  const splitTracked: SplitRoad = (candidate, cut) => { const mapping = split(candidate, cut); cuts.set(mapping.oldRoadId, { ...mapping, distanceM: cut.distanceM }); preserved.delete(mapping.oldRoadId); mapping.newRoadIds.forEach(id => preserved.add(id)); return mapping; };
  function resolve(roadId: string, distanceM: number): QuickTraceConnection {
    const cut = cuts.get(roadId);
    if (cut) { if (Math.abs(distanceM - cut.distanceM) <= EPS) return { kind: 'node', nodeId: cut.nodeId }; return distanceM < cut.distanceM ? resolve(cut.newRoadIds[0], distanceM) : resolve(cut.newRoadIds[1], distanceM - cut.distanceM); }
    const road = map.roads[roadId]!;
    if (distanceM <= EPS) return { kind: 'node', nodeId: road.fromNodeId };
    if (distanceM >= roadLength(map, roadId) - EPS) return { kind: 'node', nodeId: road.toNodeId };
    return { kind: 'road', roadId, distanceM };
  }
  for (const item of selected) {
    const candidate = item.candidate!, target = item.target, entity = map[target.kind][target.id]!, connection = resolve(candidate.roadId, candidate.distanceM);
    let nodeId: string, connectorId: string | undefined;
    if (candidate.lengthM <= EPS) {
      if (connection.kind === 'node') nodeId = connection.nodeId;
      else { const allocate = allocateMapIds(map); nodeId = allocate('node_research_'); splitTracked(map, { type: 'splitRoad', id: connection.roadId, distanceM: connection.distanceM, nodeId, newRoadIds: [allocate('road_research_'), allocate('road_research_')] }); }
    } else {
      const result = runQuickTrace(map, { type: 'quickTraceRoad', points: [candidate.position, candidate.connectionPoint], defaults: { widthM: proposal.options.widthM ?? 12, direction: 'both', connectNewCrossings: false }, endConnection: connection }, splitTracked);
      connectorId = result.entityId; nodeId = map.roads[connectorId]!.fromNodeId;
    }
    const sourceRef = sourceId(map, 'source_research_boundary_proxy', accessSource); map.sources[sourceRef] ??= structuredClone(accessSource);
    const provenance = { category: 'design_assumption' as const, sourceRefs: [sourceRef], note: '边界研究交接点，不代表影像识别或现场核验的真实门位。' };
    if (connectorId) { const road = map.roads[connectorId]!; road.provenance = { ...provenance, sourceRefs: [...new Set([...road.provenance.sourceRefs ?? [], sourceRef])], fieldSources: { ...road.provenance.fieldSources, direction: sourceRef } }; map.nodes[nodeId]!.provenance = structuredClone(provenance); }
    const allocate = allocateMapIds(map), serviceId = allocate('service_research_');
    let accessId: string | undefined;
    if (target.kind === 'facilities') { accessId = allocate('access_research_'); map.accessPoints[accessId] = { ...newAccessPoint(target.id, nodeId, entity.name + '边界交接'), provenance: structuredClone(provenance) }; map.facilities[target.id]!.accessPointIds.push(accessId); map.facilities[target.id]!.servicePointIds.push(serviceId); }
    const point = newServicePoint(nodeId, entity.name + '研究服务', 'loading', target.kind === 'facilities' ? target.id : undefined, accessId);
    point.provenance = structuredClone(provenance);
    if (target.kind === 'zones') point.zoneId = target.id;
    point.arrival = { mode: 'node_proxy', transferAssumption: proposal.options.transferAssumption ?? 'excluded_from_model', note: '边界交接研究代理；真实门位未知，未建立设施内部运输路线。' + (proposal.options.note?.trim() ? ' ' + proposal.options.note.trim() : '') };
    map.servicePoints[serviceId] = point;
  }
  return { geometryPreservedRoadIds: [...preserved].filter(id => !!map.roads[id]) };
}

/** A requested batch check, never a per-frame validator or a physical feasibility certificate. */
export function checkResearchInput(map: YardMap, level: ResearchInputReport['level'], targets: ResearchTarget[], originNodeId?: string): ResearchInputReport {
  const report: ResearchInputReport = { level, ready: true, issues: [], assumptions: ['空间描图只要求坐标、数据、引用和来源有效；缺少调度配置不阻止绘图。'], targets: [] };
  const selected = selectedTargets(targets), validation = validateMap(map);
  report.issues.push(...validation.issues.filter(issue => issue.severity === 'error'));
  const add = (code: string, message: string, target?: ResearchTarget) => report.issues.push({ code, message, severity: 'warning', jsonPath: target ? '/' + targetKey(target) : '', suggestedAction: '仅在对应研究阶段补齐并复核；可继续空间描图。', ...(target ? { entityType: target.kind, entityId: target.id } : {}) });
  if (!['spatial', 'routing', 'scheduling'].includes(level)) fail('RESEARCH_CHECK_LEVEL', '未知研究检查级别。');
  if (level !== 'spatial') {
    if (!selected.length) add('RESEARCH_TARGETS_EMPTY', '尚未明确选择本次研究目标。');
    const origin = originNodeId ?? services(map, selected[0] ?? { kind: 'facilities', id: '' }).map(id => map.servicePoints[id]?.nodeId).find(Boolean);
    const prepared = origin && map.nodes[origin] ? preparePathPreview(map) : null;
    if (!prepared) add('RESEARCH_ORIGIN_MISSING', '需要有效研究起点或至少一个已有服务点的选定目标。');
    else report.assumptions.push(`从节点 ${origin} 检查所有选定服务点的声明路由；不同目标之间的方向和任务序列需由场景另行核对。`);
    for (const target of selected) {
      const serviceIds = services(map, target); let status = 'unresolved';
      if (!map[target.kind][target.id] || !serviceIds.length) add('RESEARCH_TARGET_ACCESS_MISSING', '目标缺少明确服务点与到达语义。', target);
      else {
        const reports = serviceIds.map(id => inspectServiceConnection(map, id));
        const local = reports.some(result => result.arrivalMode !== 'undeclared' && result.status !== 'blocked');
        if (!local) add('RESEARCH_TARGET_ACCESS_INVALID', '已有服务点接路或到达声明不完整。', target);
        else if (prepared) {
          const routes = serviceIds.map(id => prepared.preview({ kind: 'nodes', id: origin! }, { kind: 'servicePoints', id }, { mode: 'declared' }));
          status = routes.some(route => route.status === 'found') ? 'found' : routes.some(route => route.status === 'unconfirmed') ? 'unconfirmed' : 'unresolved';
          if (status !== 'found') add('RESEARCH_TARGET_ROUTE_UNCONFIRMED', '选定起点到该目标没有已确认的声明路由；请检查方向、禁转及断路。', target);
        }
      }
      report.targets.push({ target, status });
    }
  } else for (const target of selected) { report.targets.push({ target, status: map[target.kind][target.id] ? 'present' : 'missing' }); if (!map[target.kind][target.id]) add('RESEARCH_TARGET_MISSING', '所选实体不存在。', target); }
  if (level === 'scheduling') add('RESEARCH_SCENARIO_REQUIRED', '调度还需绑定外部场景中的车辆、任务、速度、日历、服务时间与资源容量；地图本身不足以认定调度输入完整。');
  report.ready = report.issues.length === 0;
  return report;
}
