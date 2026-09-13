import type { ArcRef, Issue, Movement, Vec3, YardMap } from '../domain/model';
import { contentHash } from '../domain/serialization';
import { inspectPlanning, PLANNING_NAMESPACE } from '../domain/planning';
import { polylineLength2D, roadPoints } from '../geometry/roads';
import { inspectServiceConnection } from './serviceConnections';

export interface PathEndpoint { kind: 'servicePoints' | 'accessPoints' | 'nodes'; id: string }
export interface PathRoute { arcs: ArcRef[]; lengthM: number; points: Vec3[]; assumptions: string[] }
export type PathPreviewMode = 'declared' | 'direction_only';
export interface PathPreviewOptions { mode?: PathPreviewMode }
export interface PreparedPathPreview {
  readonly mapId: string; readonly mapContentHash: string;
  preview(from: PathEndpoint, to: PathEndpoint, options?: PathPreviewOptions): PathPreviewReport;
}
export interface PathPreviewReport {
  mode: PathPreviewMode;
  /** Search completed within budget for this mode; unchecked physical/operational conditions remain. */
  complete: boolean;
  mapId: string; mapContentHash: string; from: PathEndpoint; to: PathEndpoint;
  status: 'found' | 'unconfirmed' | 'disconnected' | 'not_checked';
  confirmed: PathRoute | null; candidate: PathRoute | null;
  issues: Issue[]; assumptions: string[]; unchecked: string[];
}
interface Arc { ref: ArcRef; key: string; start: string; end: string; length: number; points: Vec3[]; known: boolean; permitted: boolean; owner?: string }
interface Endpoint { node: string; entry: string; path: Arc[]; owner?: string; assumptions: string[] }
const pointer = (id: string) => id.replace(/~/g, '~0').replace(/\//g, '~1');
const key = (arc: ArcRef) => `${arc.roadId}:${arc.direction}`;
const pair = (a: Arc, b: Arc) => `${a.key}>${b.key}`;
// ponytail: bounded O(A²) incoming-arc Dijkstra, avoiding a second graph/heap framework.
const MAX_ARCS = 4000;
const MAX_WORK = 1_000_000;
class Unchecked extends Error {
  constructor(readonly code: string, readonly jsonPath: string, message: string) { super(message); }
}
function issue(code: string, jsonPath: string, message: string): Issue {
  const [, kind, id] = jsonPath.split('/');
  return { code, jsonPath, message, severity: 'warning', suggestedAction: '补齐并核对声明数据后重新检查；本结果不证明车辆或作业可执行。',
    ...(kind && id ? { entityType: kind, entityId: id.replace(/~1/g, '/').replace(/~0/g, '~') } : {}) };
}

/** Read-only declared-network preview. Callers import maps through the shared validator first.
 * Missing turns are possible in the upper graph, never permissions in the lower graph.
 * Resource occupancy, vehicle geometry and business completion are outside this result.
 */
export function previewPath(map: YardMap, from: PathEndpoint, to: PathEndpoint): PathPreviewReport {
  return prepare(map).preview(from, to);
}

/** A private immutable input snapshot and one graph per caller-owned batch. No global cache. */
export function preparePathPreview(map: YardMap): PreparedPathPreview {
  return prepare(structuredClone(map));
}

function prepare(map: YardMap): PreparedPathPreview {
  let mapContentHash = ''; let planningPresent = false; let preparationFailure: unknown;
  const preparationIssues: Issue[] = [];
  const arcs = new Map<string, Arc>(); const outgoing = new Map<string, Arc[]>();
  const turns = new Map<string, Movement[]>();
  const endpoints = new Map<string, { value?: Endpoint; issues: Issue[]; error?: unknown }>();
  try {
    mapContentHash = contentHash(map);
    if (Object.keys(map.roads).length * 2 > MAX_ARCS || Object.keys(map.movements).length > MAX_WORK)
      throw new Unchecked('PATH_COMPLEXITY_LIMIT', '/roads', '网络超过本次同步路径预览上限。');
    const planning = inspectPlanning(map); planningPresent = planning.present;
    if (!planning.supported) { preparationIssues.push(...planning.issues); throw new Unchecked('PATH_EXTENSION_UNSUPPORTED', '/extensionNamespaces', '规划扩展未受支持，不能推断路径。'); }
    for (const [namespace, declaration] of Object.entries(map.extensionNamespaces)) {
      if (declaration.category !== 'metadata' && namespace !== PLANNING_NAMESPACE)
        throw new Unchecked('PATH_EXTENSION_UNSUPPORTED', `/extensionNamespaces/${pointer(namespace)}`, '未知行为或几何扩展可能改变通行，未检查路径。');
    }
    let geometryWork = 0;
    for (const [id, road] of Object.entries(map.roads).sort(([a], [b]) => a.localeCompare(b))) {
      geometryWork += road.shapePoints.length + 2;
      if (geometryWork > MAX_WORK) throw new Unchecked('PATH_COMPLEXITY_LIMIT', '/roads', '道路折线几何超过路径预览上限。');
      if (!['unknown', 'forward', 'backward', 'both'].includes(road.direction)) throw new Unchecked('PATH_INPUT_INVALID', `/roads/${pointer(id)}/direction`, '道路方向不合法。');
      const points = roadPoints(map, id); const length = polylineLength2D(points);
      if (!points.every(p => p.every(Number.isFinite)) || !Number.isFinite(length) || length <= 0)
        throw new Unchecked('PATH_GEOMETRY_UNSUPPORTED', `/roads/${pointer(id)}`, '道路长度不能表示为有限正米数。');
      const payload = road.extensions?.[PLANNING_NAMESPACE] as { ownerEntityId?: string } | undefined;
      for (const direction of ['forward', 'backward'] as const) {
        const ref = { roadId: id, direction }; const forward = direction === 'forward';
        const arc: Arc = { ref, key: key(ref), start: forward ? road.fromNodeId : road.toNodeId, end: forward ? road.toNodeId : road.fromNodeId,
          length, points: forward ? points : [...points].reverse(), known: road.direction !== 'unknown',
          permitted: road.direction === 'unknown' || road.direction === 'both' || road.direction === direction,
          ...(payload?.ownerEntityId ? { owner: payload.ownerEntityId } : {}) };
        arcs.set(arc.key, arc);
        const list = outgoing.get(arc.start) ?? []; list.push(arc); outgoing.set(arc.start, list);
      }
    }
    for (const [id, junction] of Object.entries(map.junctions)) {
      if (new Set(junction.nodeIds).size > 1) throw new Unchecked('PATH_JUNCTION_TRANSITION_UNSUPPORTED', `/junctions/${pointer(id)}/nodeIds`, '多节点路口的过渡尚未编译，不能把缺失过渡的候选图称为断路。');
    }
    for (const [id, movement] of Object.entries(map.movements)) {
      const a = arcs.get(key(movement.incomingArc)); const b = arcs.get(key(movement.outgoingArc));
      const junction = Object.hasOwn(map.junctions, movement.junctionId) ? map.junctions[movement.junctionId] : undefined;
      if (!a || !b || !junction || !junction.nodeIds.includes(a.end) || !junction.nodeIds.includes(b.start))
        throw new Unchecked('PATH_INPUT_INVALID', `/movements/${pointer(id)}`, '转向引用或路口成员不合法。');
      if (movement.internalPath || a.end !== b.start)
        throw new Unchecked('PATH_MOVEMENT_GEOMETRY_UNSUPPORTED', `/movements/${pointer(id)}`, '独立转向几何或跨节点过渡尚未编译；不会画出瞬移路径。');
      const list = turns.get(pair(a, b)) ?? []; list.push(movement); turns.set(pair(a, b), list);
    }
  } catch (error) { preparationFailure = error; }
  return Object.freeze({ mapId: map.mapId, mapContentHash, preview });

  function preview(from: PathEndpoint, to: PathEndpoint, options: PathPreviewOptions = {}): PathPreviewReport {
    const mode = options.mode ?? 'declared';
    const report: PathPreviewReport = { mode, complete: false, mapId: map.mapId, mapContentHash, from: { ...from }, to: { ...to },
      status: 'not_checked', confirmed: null, candidate: null, issues: structuredClone(preparationIssues),
      assumptions: ['仅依据显式节点 ID、道路方向与转向声明；坐标相交不连接。', '按二维中心线长度求最短路；不含装卸和代理场内转运耗时。'],
      unchecked: ['resource_execution', 'physical_clearance', 'vehicle_swept_path', 'cargo_compatibility', 'dynamic_closures', 'business_completion', 'source_authenticity'] };
    if (mode === 'direction_only') {
      report.assumptions[0] = '仅在已知允许的道路方向子图检查连通；忽略全部转向许可，不证明转向可执行。';
      report.unchecked.push('movement_permissions');
    }
    try {
      if (preparationFailure) throw preparationFailure;
      if (mode !== 'declared' && mode !== 'direction_only') throw new Unchecked('PATH_MODE_UNSUPPORTED', '', '不支持的路径检查模式。');
      function endpoint(spec: PathEndpoint): Endpoint {
        if (spec.kind === 'nodes') {
          if (!Object.hasOwn(map.nodes, spec.id)) throw new Unchecked('PATH_ENDPOINT_MISSING', '/nodes/' + pointer(spec.id), '指定节点不存在。');
          return { node: spec.id, entry: spec.id, path: [], assumptions: ['显式节点端点只检查道路网络；不继承服务点到达语义或内部道路 owner 权限。'] };
        }
        if (!['servicePoints', 'accessPoints'].includes(spec.kind) || !Object.hasOwn(map[spec.kind], spec.id))
          throw new Unchecked('PATH_ENDPOINT_MISSING', `/${spec.kind}/${pointer(spec.id)}`, '指定端点不存在。');
        const point = map[spec.kind][spec.id]!;
        if (!Object.hasOwn(map.nodes, point.nodeId)) throw new Unchecked('PATH_ENDPOINT_MISSING', `/${spec.kind}/${pointer(spec.id)}/nodeId`, '指定端点的权威节点不存在。');
        const owner = point.facilityId ?? ('zoneId' in point ? point.zoneId : undefined);
        const result: Endpoint = { node: point.nodeId, entry: point.nodeId, path: [], assumptions: [], ...(owner ? { owner } : {}) };
        if (spec.kind === 'accessPoints') {
          if (!point.facilityId || !Object.hasOwn(map.facilities, point.facilityId)) throw new Unchecked('PATH_ENDPOINT_MISSING', `/accessPoints/${pointer(spec.id)}/facilityId`, '入口所属设施不存在。');
          return result;
        }
        const service = map.servicePoints[spec.id]!;
        const sequenceLength = service.arrival?.mode === 'explicit_internal' ? service.arrival.internalPath.length : 0;
        if (sequenceLength * Math.max(1, Object.keys(map.movements).length) > MAX_WORK)
          throw new Unchecked('PATH_COMPLEXITY_LIMIT', `/servicePoints/${pointer(spec.id)}/arrival/internalPath`, '内部路径检查超过同步工作上限。');
        const summary = inspectServiceConnection(map, spec.id);
        // Keep local geometry/arrival diagnostics; replace the older generic route-unchecked message.
        report.issues.push(...summary.issues.filter(i => i.code !== 'SERVICE_ROUTE_UNCHECKED'));
        const invalid = summary.issues.find(i => (i.severity === 'error' && !['INTERNAL_PATH_DIRECTION_FORBIDDEN', 'INTERNAL_TURN_FORBIDDEN'].includes(i.code))
          || ['SERVICE_ZONE_LAND_ACCESS_UNSUPPORTED', 'SERVICE_ACCESS_OWNER_UNDECLARED'].includes(i.code));
        if (invalid) throw new Unchecked('PATH_ENDPOINT_UNSUPPORTED', invalid.jsonPath, '端点声明不支持当前陆上网络预览。');
        if (!service.arrival) throw new Unchecked('PATH_ARRIVAL_UNDECLARED', `/servicePoints/${pointer(spec.id)}/arrival`, '服务点未声明到达语义，不将设施或入口当成装卸点。');
        if (service.arrival.mode === 'node_proxy') {
          result.assumptions.push(`${spec.id}: node_proxy (${service.arrival.transferAssumption})；${service.arrival.note}`);
          return result;
        }
        const entry = service.accessPointId ? map.accessPoints[service.accessPointId]?.nodeId : service.arrival.entryNodeId;
        if (!entry || !Object.hasOwn(map.nodes, entry) || !service.arrival.internalPath.length)
          throw new Unchecked('PATH_ARRIVAL_UNDECLARED', `/servicePoints/${pointer(spec.id)}/arrival`, '内部路径缺少显式入口或道路序列。');
        result.entry = entry;
        result.path = service.arrival.internalPath.map(ref => {
          const arc = arcs.get(key(ref));
          if (!arc) throw new Unchecked('PATH_INPUT_INVALID', `/servicePoints/${pointer(spec.id)}/arrival/internalPath`, '内部路径道路不存在。');
          return arc;
        });
        result.assumptions.push(`${spec.id}: arrival.internalPath 仅声明到达；作为终点必须走完整后缀，作为起点仅沿已有方向与转向离场，不据到达声明生成出口。`);
        return result;
      }
      function resolved(spec: PathEndpoint): Endpoint {
        const cacheKey = JSON.stringify([spec.kind, spec.id]);
        const old = endpoints.get(cacheKey);
        if (old) { report.issues.push(...structuredClone(old.issues)); if (old.error) throw old.error; return old.value!; }
        const begin = report.issues.length;
        try {
          const value = endpoint(spec); endpoints.set(cacheKey, { value, issues: structuredClone(report.issues.slice(begin)) }); return value;
        } catch (error) { endpoints.set(cacheKey, { error, issues: structuredClone(report.issues.slice(begin)) }); throw error; }
      }
      const source = resolved(from); const target = resolved(to);
      if (mode === 'direction_only') report.issues = report.issues.map(value => value.code === 'INTERNAL_TURN_FORBIDDEN'
        ? { ...value, severity: 'warning', message: value.message + ' 本次仅检查方向，保留该禁止声明但不据此阻断方向子图。' } : value);
      const endpointAssumptions = [...source.assumptions, ...target.assumptions];
      if (source.node === target.node) {
        const route: PathRoute = { arcs: [], lengthM: 0, points: [[...map.nodes[source.node]!.position]],
          assumptions: [...endpointAssumptions, '起终点使用同一权威节点：仅零位移，不表示已完成装卸、内部转运或服务。'] };
        report.confirmed = route; report.candidate = structuredClone(route); report.status = 'found'; report.complete = true; return report;
      }
      if (planningPresent) report.assumptions.push('已识别 sr02.planning 的 ownerEntityId：不穿越起终归属以外的第三方内部道路；容量与槽位执行仍未检查。');
      const owners = new Set([source.owner, target.owner].filter((x): x is string => !!x));
      const suffix = target.path;
      const traversable = (arc: Arc, optimistic: boolean) => arc.permitted && (optimistic || arc.known) && (!arc.owner || owners.has(arc.owner));
      function turn(a: Arc | undefined, b: Arc): 'yes' | 'unknown' | 'no' {
        if (!a) return 'yes';
        if (a.end !== b.start) return 'no';
        if (mode === 'direction_only') return 'yes';
        const rules = turns.get(pair(a, b)) ?? [];
        if (rules.some(rule => !rule.allowed)) return 'no';
        return rules.some(rule => rule.allowed && map.junctions[rule.junctionId]!.model === 'explicit_movements') ? 'yes' : 'unknown';
      }
      function follow(sequence: Arc[], incoming: Arc | undefined, optimistic: boolean): boolean {
        for (const arc of sequence) {
          tick(); const permission = turn(incoming, arc);
          if (!traversable(arc, optimistic) || permission === 'no' || (!optimistic && permission !== 'yes')) return false;
          incoming = arc;
        }
        return true;
      }
      let work = 0;
      const tick = () => { if (++work > MAX_WORK) throw new Unchecked('PATH_COMPLEXITY_LIMIT', '/roads', '路径搜索超过同步工作上限，未据部分搜索声称断路。'); };
      const sum = (path: Arc[]) => path.reduce((value, arc) => { tick(); return value + arc.length; }, 0);
      function search(optimistic: boolean): PathRoute | null {
        const startKey = '$start';
        const distances = new Map<string, number>([[startKey, 0]]);
        const previous = new Map<string, string>();
        const open = new Set([startKey]); const done = new Set<string>();
        let bestCost = Infinity; let bestKey: string | undefined;
        while (open.size) {
          let current = ''; let cost = Infinity;
          for (const candidate of open) { tick(); if (distances.get(candidate)! < cost) { current = candidate; cost = distances.get(candidate)!; } }
          if (!Number.isFinite(cost)) throw new Unchecked('PATH_DISTANCE_OVERFLOW', '/roads', '累计路径长度超出有限数值范围。');
          if (cost >= bestCost) break;
          open.delete(current); done.add(current);
          const incoming = current === '$start' ? undefined : arcs.get(current)!;
          const node = incoming?.end ?? source.node;
          if (node === target.entry && follow(suffix, incoming, optimistic)) {
            const total = cost + sum(suffix);
            if (!Number.isFinite(total)) throw new Unchecked('PATH_DISTANCE_OVERFLOW', '/roads', '累计路径长度超出有限数值范围。');
            if (total < bestCost) { bestCost = total; bestKey = current; }
          }
          for (const next of outgoing.get(node) ?? []) {
            tick(); const permission = turn(incoming, next);
            if (done.has(next.key) || !traversable(next, optimistic) || permission === 'no' || (!optimistic && permission !== 'yes')) continue;
            const nextCost = cost + next.length;
            if (!Number.isFinite(nextCost)) throw new Unchecked('PATH_DISTANCE_OVERFLOW', '/roads', '累计路径长度超出有限数值范围。');
            if (nextCost < (distances.get(next.key) ?? Infinity)) { distances.set(next.key, nextCost); previous.set(next.key, current); open.add(next.key); }
          }
        }
        if (bestKey === undefined) return null;
        const middle: Arc[] = []; let cursor = bestKey;
        while (cursor !== startKey) { middle.push(arcs.get(cursor)!); cursor = previous.get(cursor)!; }
        const route = [...middle.reverse(), ...suffix]; const assumptions = [...endpointAssumptions];
        const points: Vec3[] = [];
        route.forEach((arc, index) => {
          if (!arc.known) assumptions.push(`道路 ${arc.ref.roadId} 的 ${arc.ref.direction} 方向未声明允许。`);
          if (index > 0 && turn(route[index - 1], arc) === 'unknown') assumptions.push(`转向 ${route[index - 1]!.key} → ${arc.key} 未声明允许。`);
          for (let i = index ? 1 : 0; i < arc.points.length; i++) { tick(); points.push([...arc.points[i]!] as Vec3); }
        });
        return { arcs: route.map(arc => ({ ...arc.ref })), lengthM: bestCost, points, assumptions: [...new Set(assumptions)] };
      }
      report.confirmed = search(false); report.candidate = mode === 'direction_only' ? structuredClone(report.confirmed) : search(true);
      report.status = report.confirmed ? 'found' : report.candidate ? 'unconfirmed' : 'disconnected';
      if (report.status === 'unconfirmed') report.issues.push(issue('PATH_CONDITIONS_UNCONFIRMED', '/roads', '仅找到依赖未知方向或未声明转向的候选路径。'));
      if (report.status === 'disconnected') report.issues.push(mode === 'direction_only'
        ? issue('PATH_NO_KNOWN_DIRECTION_ROUTE', '/roads', '已知允许方向子图无路径；未知方向没有被放行，转向许可未检查。')
        : issue('PATH_NO_DECLARED_ROUTE', '/roads', '允许未知方向与未知转向的候选图也无路径；结论限当前显式网络和指定内部路径。'));
      report.complete = true;
    } catch (error) {
      report.status = 'not_checked'; report.confirmed = null; report.candidate = null;
      report.issues.push(error instanceof Unchecked ? issue(error.code, error.jsonPath, error.message)
        : issue('PATH_INPUT_INVALID', '', '输入未通过路径预览的引用或数值检查；请先运行共享地图校验。'));
    }
    return report;
  }
}
