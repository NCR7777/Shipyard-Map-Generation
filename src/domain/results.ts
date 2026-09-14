import { sha256 } from 'js-sha256';
import { parseTree, type Node, type ParseError } from 'jsonc-parser';
import type { Vec3, YardMap } from './model';
import { compileMap, COMPILER_VERSION, arcId, type CompiledMap, type CompiledArc } from '../compiler/routing';
import { poseAtDistance, type ResolvedPath } from '../geometry/roadPath';

export interface RunBinding { protocolVersion: '1.0'; runId: string; mapId: string; mapContentHash: string; scenarioId: string; scenarioHash: string; compilerVersion: string }
export interface TimeWindow { startS: number; endS: number }
export interface ScenarioFile {
  protocolVersion: '1.0'; scenarioId: string; units: { length: 'm'; time: 's' };
  vehicles: { id: string; name?: string }[];
  tasks: { id: string; name?: string; originNodeId?: string; destinationNodeId?: string; dueS?: number }[];
  timeWindow: TimeWindow; assumptions: string[]; parameters?: Record<string, unknown>;
}
export interface VerifiedScenario { scenario: ScenarioFile; scenarioHash: string }
export type Activity = ({ kind: 'travel'; roadId: string; direction: 'forward' | 'backward'; s0M: number; s1M: number } | { kind: 'wait' | 'load' | 'unload'; nodeId: string }) & { vehicleId: string; t0: number; t1: number; taskId?: string };
export interface PlanFile extends RunBinding { name?: string; source: 'synthetic' | 'external'; activities: Activity[] }
export interface RunEvent extends RunBinding {
  entityType: 'vehicle'; entityId: string; seq: number; simTimeS: number; state: 'travel' | 'wait' | 'load' | 'unload' | 'idle';
  roadId?: string; direction?: 'forward' | 'backward'; sM?: number; nodeId?: string; position?: Vec3; yawRad?: number; taskId?: string; poseAuthority?: 'road' | 'position';
}
export interface ResultMetric { key: string; value: number | null; unit: string; definition: string; window: TimeWindow; source: string }
export interface SummaryFile extends RunBinding { metrics: ResultMetric[] }
export interface ComparisonScope { taskIds: string[]; vehicleIds: string[]; window: TimeWindow }
export type LoadedSummary = SummaryFile & { scenarioVerified: boolean; comparisonScope: ComparisonScope; runSource: PlanFile['source'] };
export interface RunIssue { code: string; severity: 'error' | 'warning'; message: string; path?: string }
export interface PreparedRun {
  binding: RunBinding; name: string; source: PlanFile['source']; activities: Activity[]; events: RunEvent[]; summary?: LoadedSummary;
  vehicleIds: string[]; taskIds: string[]; startS: number; endS: number; issues: RunIssue[];
  scenarioVerified: boolean; scenario?: ScenarioFile; compiled: CompiledMap; tracks: Map<string, Activity[]>; eventTracks: Map<string, RunEvent[]>;
}
export type RunLoadResult = { ok: true; run: PreparedRun } | { ok: false; issues: RunIssue[] };
export type ScenarioLoadResult = ({ ok: true } & VerifiedScenario) | { ok: false; issues: RunIssue[] };
export interface RunVehicleFrame {
  vehicleId: string; taskId?: string; state: 'travel' | 'wait' | 'load' | 'unload' | 'idle' | 'gap'; position: Vec3; yawRad: number;
  roadId?: string; direction?: 'forward' | 'backward'; sM?: number; route: ResolvedPath | null; source: 'plan' | 'event'; note?: string;
}
export interface RunFrame { timeS: number; vehicles: RunVehicleFrame[]; activeActivities: Activity[]; issues: RunIssue[] }
const BINDING_KEYS = ['protocolVersion', 'runId', 'mapId', 'mapContentHash', 'scenarioId', 'scenarioHash', 'compilerVersion'] as const;
const MAX_BYTES = 10 * 1024 * 1024;
class RunInputError extends Error { constructor(readonly issue: RunIssue) { super(issue.message); } }
function fail(code: string, message: string, path = ''): never { throw new RunInputError({ code, severity: 'error', message, path }); }
const warn = (code: string, message: string, path = ''): RunIssue => ({ code, severity: 'warning', message, path });
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)])) : value;
const exact = (a: unknown, b: unknown): boolean => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const hash = (value: unknown): string => sha256(JSON.stringify(canonical(value)));
function parseJson(text: string): unknown {
  if (new TextEncoder().encode(text).length > MAX_BYTES) fail('RUN_SIZE_LIMIT', '单个输入最多 10 MiB。');
  let depth = 0, quoted = false, escaped = false;
  for (const char of text) { if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; } else if (char === '"') quoted = true; else if (char === '{' || char === '[') { if (++depth > 64) fail('RUN_JSON_DEPTH', 'JSON 嵌套超过 64 层。'); } else if (char === '}' || char === ']') depth--; }
  const errors: ParseError[] = [], tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || errors.length) fail('RUN_JSON_SYNTAX', '外部输入不是严格 JSON。');
  function inspect(node: Node): void {
    if (node.type === 'number' && !Number.isFinite(node.value)) fail('RUN_NON_FINITE', '输入数字必须有限。');
    if (node.type === 'object') { const seen = new Set<string>(); for (const child of node.children ?? []) { const key = String(child.children?.[0]?.value); if (seen.has(key)) fail('RUN_DUPLICATE_KEY', '重复 JSON 字段：' + key); seen.add(key); } }
    for (const child of node.children ?? []) inspect(child);
  }
  inspect(tree); return JSON.parse(text);
}
function object(value: unknown, keys: readonly string[], path = ''): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('RUN_OBJECT', '字段必须是对象。', path);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) if (!keys.includes(key)) fail('RUN_UNKNOWN_FIELD', '未支持字段：' + key, path + '/' + key);
  return result;
}
function text(value: unknown, path: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 4096) fail('RUN_STRING', '字段必须是非空字符串。', path); return value; }
function id(value: unknown, path: string): string { const result = text(value, path); if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(result)) fail('RUN_ID', '标识符须以字母开头，仅使用字母、数字和 _ . : -。', path); return result; }
function number(value: unknown, path: string, minimum = 0): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) fail('RUN_NUMBER', '数字必须有限且不小于 ' + minimum + '。', path); return value; }
function array(value: unknown, path: string, maximum = 50_000): unknown[] { if (!Array.isArray(value) || value.length > maximum) fail('RUN_ARRAY', '字段必须是有界数组。', path); return value; }
function windowOf(value: unknown, path: string): TimeWindow { const raw = object(value, ['startS', 'endS'], path), startS = number(raw.startS, path + '/startS'), endS = number(raw.endS, path + '/endS'); if (endS <= startS) fail('RUN_WINDOW', '时域结束必须大于开始。', path); return { startS, endS }; }
function bindingOf(raw: Record<string, unknown>): RunBinding {
  if (raw.protocolVersion !== '1.0') fail('RUN_PROTOCOL', '仅支持外部协议 1.0。');
  for (const key of ['mapContentHash', 'scenarioHash']) if (typeof raw[key] !== 'string' || !/^[a-f0-9]{64}$/i.test(raw[key] as string)) fail('RUN_HASH', '内容摘要必须是 SHA-256 十六进制串。', '/' + key);
  return { protocolVersion: '1.0', runId: id(raw.runId, '/runId'), mapId: id(raw.mapId, '/mapId'), mapContentHash: raw.mapContentHash as string, scenarioId: id(raw.scenarioId, '/scenarioId'), scenarioHash: raw.scenarioHash as string, compilerVersion: text(raw.compilerVersion, '/compilerVersion') };
}
function matchBinding(expected: RunBinding, actual: RunBinding): void { for (const key of BINDING_KEYS) if (actual[key] !== expected[key]) fail('RUN_BINDING_MISMATCH', '外部 ' + key + ' 与当前运行不一致；保留已载入结果。', '/' + key); }
function errors(error: unknown): { ok: false; issues: RunIssue[] } { return { ok: false, issues: [error instanceof RunInputError ? error.issue : { code: 'RUN_INPUT_ERROR', severity: 'error', message: error instanceof Error ? error.message : '无法读取外部结果。' }] }; }

export function loadScenario(input: string | unknown): ScenarioLoadResult {
  try {
    const value = typeof input === 'string' ? parseJson(input) : parseJson(JSON.stringify(input));
    const raw = object(value, ['protocolVersion', 'scenarioId', 'units', 'vehicles', 'tasks', 'timeWindow', 'assumptions', 'parameters']);
    if (raw.protocolVersion !== '1.0') fail('SCENARIO_PROTOCOL', '仅支持场景协议 1.0。');
    const units = object(raw.units, ['length', 'time'], '/units'); if (units.length !== 'm' || units.time !== 's') fail('SCENARIO_UNITS', '首期场景单位必须为 m 和 s。');
    const vehicleIds = new Set<string>(), taskIds = new Set<string>();
    const vehicles = array(raw.vehicles, '/vehicles').map((value, index) => { const row = object(value, ['id', 'name'], '/vehicles/' + index), key = id(row.id, '/vehicles/' + index + '/id'); if (vehicleIds.has(key)) fail('SCENARIO_DUPLICATE_ID', '车辆 ID 重复。'); vehicleIds.add(key); return { id: key, ...(row.name !== undefined ? { name: text(row.name, '/vehicles/' + index + '/name') } : {}) }; });
    const tasks = array(raw.tasks, '/tasks').map((value, index) => { const row = object(value, ['id', 'name', 'originNodeId', 'destinationNodeId', 'dueS'], '/tasks/' + index), key = id(row.id, '/tasks/' + index + '/id'); if (taskIds.has(key)) fail('SCENARIO_DUPLICATE_ID', '任务 ID 重复。'); taskIds.add(key); return { id: key, ...(row.name !== undefined ? { name: text(row.name, '/tasks/' + index + '/name') } : {}), ...(row.originNodeId !== undefined ? { originNodeId: id(row.originNodeId, '/tasks/' + index + '/originNodeId') } : {}), ...(row.destinationNodeId !== undefined ? { destinationNodeId: id(row.destinationNodeId, '/tasks/' + index + '/destinationNodeId') } : {}), ...(row.dueS !== undefined ? { dueS: number(row.dueS, '/tasks/' + index + '/dueS') } : {}) }; });
    if (raw.parameters !== undefined && (!raw.parameters || typeof raw.parameters !== 'object' || Array.isArray(raw.parameters))) fail('SCENARIO_PARAMETERS', 'parameters 必须为外部场景参数对象。');
    const scenario: ScenarioFile = { protocolVersion: '1.0', scenarioId: id(raw.scenarioId, '/scenarioId'), units: { length: 'm', time: 's' }, vehicles, tasks, timeWindow: windowOf(raw.timeWindow, '/timeWindow'), assumptions: array(raw.assumptions, '/assumptions').map((value, index) => text(value, '/assumptions/' + index)), ...(raw.parameters !== undefined ? { parameters: raw.parameters as Record<string, unknown> } : {}) };
    return { ok: true, scenario, scenarioHash: hash(scenario) };
  } catch (error) { return errors(error); }
}
function arcFor(compiled: CompiledMap, roadId: string, direction: 'forward' | 'backward'): CompiledArc {
  if (compiled.routingStatus !== 'declared') fail('RUN_UNSUPPORTED_EXTENSIONS', '地图包含未支持的行为扩展；不能把其道路规则当作已核验许可。');
  const arc = compiled.arcs[arcId({ roadId, direction })];
  if (!arc) fail('RUN_ROAD_REFERENCE', '结果引用的道路不存在：' + roadId);
  if (arc.ownerEntityId) fail('RUN_INTERNAL_OWNER_UNSUPPORTED', '道路 ' + roadId + ' 属于 ' + arc.ownerEntityId + ' 的内部路径；本协议尚未提供服务点归属授权，不能默认允许穿越。');
  if (arc.allowed !== true) fail('RUN_ROAD_DIRECTION', '结果使用了禁止或未声明的道路方向：' + roadId + ':' + direction);
  return arc;
}
function checkIdentity(run: Pick<PreparedRun, 'scenario'>, vehicleId: string, taskId?: string): void {
  if (!run.scenario) return;
  if (!run.scenario.vehicles.some(vehicle => vehicle.id === vehicleId)) fail('RUN_VEHICLE_REFERENCE', '车辆未列入已核验场景：' + vehicleId);
  if (taskId && !run.scenario.tasks.some(task => task.id === taskId)) fail('RUN_TASK_REFERENCE', '任务未列入已核验场景：' + taskId);
}
function activityOf(value: unknown, compiled: CompiledMap, scenario?: ScenarioFile): Activity {
  const raw = object(value, ['kind', 'vehicleId', 'taskId', 't0', 't1', 'roadId', 'direction', 's0M', 's1M', 'nodeId']);
  const vehicleId = id(raw.vehicleId, '/activities/vehicleId'), taskId = raw.taskId === undefined ? undefined : id(raw.taskId, '/activities/taskId'); checkIdentity({ scenario }, vehicleId, taskId);
  const t0 = number(raw.t0, '/activities/t0'), t1 = number(raw.t1, '/activities/t1'); if (t1 <= t0) fail('RUN_ACTIVITY_TIME', '活动结束必须大于开始。');
  if (scenario && (t0 < scenario.timeWindow.startS || t1 > scenario.timeWindow.endS)) fail('RUN_ACTIVITY_WINDOW', '活动超出已核验场景时域。');
  const common = { vehicleId, t0, t1, ...(taskId ? { taskId } : {}) };
  if (raw.kind === 'travel') {
    if (raw.nodeId !== undefined || !['forward', 'backward'].includes(String(raw.direction))) fail('RUN_TRAVEL_FIELDS', '行驶活动需要明确方向且不同时提供驻留节点。');
    const roadId = id(raw.roadId, '/activities/roadId'), direction = raw.direction as 'forward' | 'backward', arc = arcFor(compiled, roadId, direction);
    const s0M = number(raw.s0M, '/activities/s0M'), s1M = number(raw.s1M, '/activities/s1M');
    if (s1M < s0M || s0M > arc.lengthM + 1e-6 || s1M > arc.lengthM + 1e-6) fail('RUN_CHAINAGE', '行驶里程必须沿所声明方向递增且位于道路范围内。');
    return { ...common, kind: 'travel', roadId, direction, s0M, s1M };
  }
  if (!['wait', 'load', 'unload'].includes(String(raw.kind)) || ['roadId', 'direction', 's0M', 's1M'].some(key => raw[key] !== undefined)) fail('RUN_ACTIVITY_KIND', '首期支持 travel/wait/load/unload，驻留活动只引用节点。');
  const nodeId = id(raw.nodeId, '/activities/nodeId'); if (!compiled.nodes[nodeId]) fail('RUN_NODE_REFERENCE', '驻留节点不存在：' + nodeId);
  return { ...common, kind: raw.kind as 'wait' | 'load' | 'unload', nodeId };
}
function endpoint(compiled: CompiledMap, activity: Activity, end: boolean): { nodeId?: string; position: Vec3 } {
  if (activity.kind !== 'travel') return { nodeId: activity.nodeId, position: compiled.nodes[activity.nodeId]!.position };
  const arc = arcFor(compiled, activity.roadId, activity.direction), s = end ? activity.s1M : activity.s0M;
  return { ...(s <= 1e-6 ? { nodeId: arc.fromNodeId } : Math.abs(s - arc.lengthM) <= 1e-6 ? { nodeId: arc.toNodeId } : {}), position: poseAtDistance(arc.path, 'forward', s).position };
}
function transition(compiled: CompiledMap, previous: Activity, next: Activity, issues: RunIssue[]): void {
  if (next.t0 < previous.t1) fail('RUN_ACTIVITY_OVERLAP', '同一车辆的活动时间重叠：' + next.vehicleId);
  if (next.t0 > previous.t1) issues.push(warn('RUN_TIME_GAP', '车辆 ' + next.vehicleId + ' 的活动间有时间资料缺口；期间保持最近已知位置。'));
  if (previous.kind === 'travel' && next.kind === 'travel' && previous.roadId === next.roadId && previous.direction === next.direction && Math.abs(previous.s1M - next.s0M) <= 1e-6) return;
  const a = endpoint(compiled, previous, true), b = endpoint(compiled, next, false);
  if (!a.nodeId || a.nodeId !== b.nodeId) { issues.push(warn('RUN_SPATIAL_GAP', '车辆 ' + next.vehicleId + ' 的活动接续缺少连续道路；不会补画跨空白运动。')); return; }
  if (previous.kind !== 'travel' || next.kind !== 'travel') return;
  const turns = Object.values(compiled.movements).filter(turn => turn.incomingArc.roadId === previous.roadId && turn.incomingArc.direction === previous.direction && turn.outgoingArc.roadId === next.roadId && turn.outgoingArc.direction === next.direction);
  if (turns.some(turn => !turn.allowed)) fail('RUN_FORBIDDEN_TURN', '外部计划经过了显式禁止转向。');
  if (turns.some(turn => turn.internalPath)) fail('RUN_MOVEMENT_GEOMETRY_UNSUPPORTED', '此计划经过独立转向内部几何；当前活动协议没有该过渡的时间/里程，不能假称完整回放。');
  if (!turns.some(turn => turn.allowed)) issues.push(warn('RUN_TURN_UNDECLARED', '跨道路接续缺少明确转向许可；只展示已给活动，不声明完整可达。'));
}
function freezeCompiledPaths(compiled: CompiledMap): void { for (const arc of Object.values(compiled.arcs)) { for (const point of arc.path.anchors) Object.freeze(point); for (const span of arc.path.spans) { if (span.kind === 'cubic') { Object.freeze(span.control1); Object.freeze(span.control2); } Object.freeze(span); } Object.freeze(arc.path.anchors); Object.freeze(arc.path.spans); Object.freeze(arc.path); } }
export function loadRunPlan(map: YardMap, input: string | unknown, expectedScenario?: VerifiedScenario | { scenarioId: string; scenarioHash: string }): RunLoadResult {
  try {
    const raw = object(typeof input === 'string' ? parseJson(input) : parseJson(JSON.stringify(input)), [...BINDING_KEYS, 'name', 'source', 'activities']), binding = bindingOf(raw), compiled = compileMap(map);
    if (binding.mapId !== compiled.mapId || binding.mapContentHash !== compiled.mapContentHash) fail('RUN_MAP_MISMATCH', '计划绑定的地图与当前地图不一致；未替换已有结果。');
    if (binding.compilerVersion !== COMPILER_VERSION) fail('RUN_COMPILER_MISMATCH', '计划编译器版本与当前几何消费者不一致。');
    let scenario: ScenarioFile | undefined;
    if (expectedScenario) {
      const expectedId = 'scenario' in expectedScenario ? expectedScenario.scenario.scenarioId : expectedScenario.scenarioId;
      if (binding.scenarioId !== expectedId || binding.scenarioHash !== expectedScenario.scenarioHash) fail('RUN_SCENARIO_MISMATCH', '计划与所选场景摘要不一致。');
      if ('scenario' in expectedScenario) { const checked = loadScenario(expectedScenario.scenario); if (!checked.ok || checked.scenarioHash !== expectedScenario.scenarioHash) fail('RUN_SCENARIO_MISMATCH', '场景内容已改变，摘要不再有效。'); scenario = checked.scenario; }
    }
    if (raw.source !== 'synthetic' && raw.source !== 'external') fail('RUN_SOURCE', '计划必须明确标记 synthetic 或 external 来源。');
    if (scenario) for (const task of scenario.tasks) for (const nodeId of [task.originNodeId, task.destinationNodeId]) if (nodeId && !compiled.nodes[nodeId]) fail('SCENARIO_NODE_REFERENCE', '场景任务引用不存在的节点：' + nodeId);
    const activities = array(raw.activities, '/activities').map(value => activityOf(value, compiled, scenario)); if (!activities.length) fail('RUN_EMPTY_PLAN', '计划至少包含一个活动。');
    const tracks = new Map<string, Activity[]>(), issues: RunIssue[] = scenario ? [] : [warn('SCENARIO_CONTENT_UNVERIFIED', '尚未提供匹配的 scenario.json；场景内容未核验，禁止方案差值比较。')];
    for (const activity of activities) { const list = tracks.get(activity.vehicleId) ?? []; list.push(activity); tracks.set(activity.vehicleId, list); }
    for (const track of tracks.values()) {
      track.sort((a, b) => a.t0 - b.t0 || a.t1 - b.t1); let lastTravel: Activity | undefined;
      for (let i = 0; i < track.length; i++) {
        const activity = track[i]!; if (i > 0) transition(compiled, track[i - 1]!, activity, issues);
        if (activity.kind === 'travel') {
          if (lastTravel && lastTravel !== track[i - 1]) transition(compiled, { ...lastTravel, t1: activity.t0 }, activity, issues);
          lastTravel = activity;
        }
      }
    }
    if (scenario) { const scheduled = new Set(activities.flatMap(activity => activity.taskId ? [activity.taskId] : [])); const missing = scenario.tasks.filter(task => !scheduled.has(task.id)); if (missing.length) issues.push(warn('RUN_TASKS_UNSCHEDULED', '场景任务未出现在该计划中：' + missing.map(task => task.id).join('、'))); }
    freezeCompiledPaths(compiled);
    return { ok: true, run: { binding, name: raw.name === undefined ? binding.runId : text(raw.name, '/name'), source: raw.source, activities, events: [], vehicleIds: [...tracks.keys()].sort(), taskIds: [...new Set(activities.flatMap(activity => activity.taskId ? [activity.taskId] : []))].sort(), startS: scenario?.timeWindow.startS ?? Math.min(...activities.map(activity => activity.t0)), endS: scenario?.timeWindow.endS ?? Math.max(...activities.map(activity => activity.t1)), issues, scenarioVerified: !!scenario, ...(scenario ? { scenario } : {}), compiled, tracks, eventTracks: new Map<string, RunEvent[]>() } };
  } catch (error) { return errors(error); }
}
function eventOf(value: unknown, run: PreparedRun): RunEvent {
  const raw = object(value, [...BINDING_KEYS, 'entityType', 'entityId', 'seq', 'simTimeS', 'state', 'roadId', 'direction', 'sM', 'nodeId', 'position', 'yawRad', 'taskId', 'poseAuthority']), binding = bindingOf(raw); matchBinding(run.binding, binding);
  if (raw.entityType !== 'vehicle' || !['travel', 'wait', 'load', 'unload', 'idle'].includes(String(raw.state))) fail('RUN_EVENT_STATE', '事件实体必须为 vehicle 且状态有效。');
  const entityId = id(raw.entityId, '/entityId'), taskId = raw.taskId === undefined ? undefined : id(raw.taskId, '/taskId'); checkIdentity(run, entityId, taskId);
  const seq = number(raw.seq, '/seq'), simTimeS = number(raw.simTimeS, '/simTimeS'); if (!Number.isSafeInteger(seq)) fail('RUN_EVENT_SEQUENCE', '序号必须是非负安全整数。');
  if (run.scenario && (simTimeS < run.startS || simTimeS > run.endS)) fail('RUN_EVENT_WINDOW', '事件时间超出已核验场景时域。');
  let location: Pick<RunEvent, 'roadId' | 'direction' | 'sM' | 'nodeId' | 'position' | 'yawRad' | 'poseAuthority'> = {};
  const hasRoad = raw.roadId !== undefined || raw.direction !== undefined || raw.sM !== undefined;
  if (hasRoad) { const roadId = id(raw.roadId, '/roadId'); if (!['forward', 'backward'].includes(String(raw.direction))) fail('RUN_EVENT_DIRECTION', '道路事件需要明确方向。'); const direction = raw.direction as 'forward' | 'backward', arc = arcFor(run.compiled, roadId, direction), sM = number(raw.sM, '/sM'); if (sM > arc.lengthM + 1e-6) fail('RUN_CHAINAGE', '事件里程超出道路。'); location = { roadId, direction, sM }; }
  if (raw.position !== undefined) { if (!Array.isArray(raw.position) || raw.position.length !== 3 || raw.position.some(value => typeof value !== 'number' || !Number.isFinite(value))) fail('RUN_EVENT_POSITION', '位置必须是三个有限米制坐标。'); location.position = [...raw.position] as Vec3; }
  if (raw.nodeId !== undefined) { if (hasRoad || raw.position !== undefined) fail('RUN_EVENT_POSE_CONFLICT', '节点位置不能与另一套位置同时声明。'); const nodeId = id(raw.nodeId, '/nodeId'); if (!run.compiled.nodes[nodeId]) fail('RUN_NODE_REFERENCE', '事件节点不存在。'); location.nodeId = nodeId; }
  if (!hasRoad && !location.position && !location.nodeId) fail('RUN_EVENT_POSITION', '事件必须提供道路里程、节点或独立位置。');
  if (raw.poseAuthority !== undefined && raw.poseAuthority !== 'road' && raw.poseAuthority !== 'position') fail('RUN_EVENT_POSE_CONFLICT', '未知位置权威选择。');
  if (hasRoad && location.position && raw.poseAuthority === undefined) fail('RUN_EVENT_POSE_CONFLICT', '道路里程与独立位置同时出现时必须声明 poseAuthority。');
  if (raw.poseAuthority === 'road' && !hasRoad || raw.poseAuthority === 'position' && !location.position) fail('RUN_EVENT_POSE_CONFLICT', '指定的位置权威数据缺失。');
  if (raw.poseAuthority !== undefined) location.poseAuthority = raw.poseAuthority;
  if (raw.yawRad !== undefined) location.yawRad = number(raw.yawRad, '/yawRad', -Number.MAX_VALUE);
  return { ...binding, entityType: 'vehicle', entityId, seq, simTimeS, state: raw.state as RunEvent['state'], ...location, ...(taskId ? { taskId } : {}) };
}
export function loadRunEvents(run: PreparedRun, input: string): RunLoadResult {
  try {
    if (new TextEncoder().encode(input).length > MAX_BYTES) fail('RUN_SIZE_LIMIT', '事件文件最多 10 MiB。');
    const lines = input.split(/\r?\n/).filter(line => line.trim()); if (!lines.length || lines.length > 100_000) fail('RUN_EVENT_COUNT', '事件文件需要 1 至 100000 行。');
    const incoming = lines.map(line => eventOf(parseJson(line), run)), byVehicle = new Map<string, Map<number, RunEvent>>(), warnings: RunIssue[] = [];
    for (const event of [...run.events, ...incoming]) { const entries = byVehicle.get(event.entityId) ?? new Map<number, RunEvent>(), old = entries.get(event.seq); if (old && !exact(old, event)) fail('RUN_EVENT_SEQUENCE_CONFLICT', '相同车辆/序号携带不同状态。'); entries.set(event.seq, event); byVehicle.set(event.entityId, entries); }
    const observed = new Map<string, number>(); for (const event of incoming) { if ((observed.get(event.entityId) ?? -1) > event.seq) warnings.push(warn('RUN_EVENT_REORDERED', '乱序事件已按实体序号重排，不按文件到达顺序播放。')); observed.set(event.entityId, event.seq); }
    const events: RunEvent[] = [];
    for (const [vehicleId, entries] of byVehicle) { let previous: RunEvent | undefined; for (const event of [...entries.values()].sort((a, b) => a.seq - b.seq)) {
      if (previous && event.simTimeS < previous.simTimeS) { warnings.push(warn('RUN_EVENT_TIME_REGRESSION', '车辆 ' + vehicleId + ' 的序号与模拟时间冲突，保留前一个有效状态。')); continue; }
      if (previous && event.seq > previous.seq + 1) warnings.push(warn('RUN_EVENT_GAP', '车辆 ' + vehicleId + ' 存在事件序号缺口；不插补未提供的运动。'));
      events.push(event); previous = event;
    } }
    events.sort((a, b) => a.simTimeS - b.simTimeS || a.seq - b.seq);
    const eventTracks = new Map<string, RunEvent[]>();
    for (const event of events) { const track = eventTracks.get(event.entityId) ?? []; track.push(event); eventTracks.set(event.entityId, track); }
    return { ok: true, run: { ...run, events, eventTracks, vehicleIds: [...new Set([...run.vehicleIds, ...events.map(event => event.entityId)])].sort(), taskIds: [...new Set([...run.taskIds, ...events.flatMap(event => event.taskId ? [event.taskId] : [])])].sort(), startS: Math.min(run.startS, ...events.map(event => event.simTimeS)), endS: Math.max(run.endS, ...events.map(event => event.simTimeS)), issues: [...run.issues, ...warnings] } };
  } catch (error) { return errors(error); }
}
export function loadRunSummary(run: PreparedRun, input: string | unknown): RunLoadResult {
  try {
    const raw = object(typeof input === 'string' ? parseJson(input) : parseJson(JSON.stringify(input)), [...BINDING_KEYS, 'metrics']), binding = bindingOf(raw); matchBinding(run.binding, binding); const keys = new Set<string>();
    const metrics = array(raw.metrics, '/metrics', 1000).map((value, index) => { const row = object(value, ['key', 'value', 'unit', 'definition', 'window', 'source'], '/metrics/' + index), key = id(row.key, '/metrics/key'); if (keys.has(key)) fail('RUN_METRIC_DUPLICATE', '指标 key 重复。'); keys.add(key); return { key, value: row.value === null ? null : number(row.value, '/metrics/value', -Number.MAX_VALUE), unit: text(row.unit, '/metrics/unit'), definition: text(row.definition, '/metrics/definition'), window: windowOf(row.window, '/metrics/window'), source: text(row.source, '/metrics/source') }; });
    return { ok: true, run: { ...run, summary: { ...binding, metrics, scenarioVerified: run.scenarioVerified, runSource: run.source, comparisonScope: { taskIds: [...new Set(run.activities.flatMap(activity => activity.taskId ? [activity.taskId] : []))].sort(), vehicleIds: [...run.tracks.keys()].sort(), window: { startS: run.startS, endS: run.endS } } } } };
  } catch (error) { return errors(error); }
}
function planPose(run: PreparedRun, activity: Activity, timeS: number): RunVehicleFrame {
  const common = { vehicleId: activity.vehicleId, ...(activity.taskId ? { taskId: activity.taskId } : {}), state: activity.kind, source: 'plan' as const };
  if (activity.kind !== 'travel') return { ...common, position: [...run.compiled.nodes[activity.nodeId]!.position], yawRad: 0, route: null };
  const arc = arcFor(run.compiled, activity.roadId, activity.direction), fraction = Math.max(0, Math.min(1, (timeS - activity.t0) / (activity.t1 - activity.t0))), sM = activity.s0M + fraction * (activity.s1M - activity.s0M), pose = poseAtDistance(arc.path, 'forward', sM);
  return { ...common, position: pose.position, yawRad: pose.yawRad, roadId: activity.roadId, direction: activity.direction, sM, route: arc.path, note: '区间匀速插值' };
}
function atOrBefore<T>(rows: readonly T[], timeS: number, timestamp: (row: T) => number): number {
  let low = 0, high = rows.length;
  while (low < high) { const middle = (low + high) >>> 1; if (timestamp(rows[middle]!) <= timeS) low = middle + 1; else high = middle; }
  return low - 1;
}
export function frameAt(run: PreparedRun, requestedTimeS: number, filters: { vehicleIds?: string[]; taskIds?: string[] } = {}): RunFrame {
  const timeS = Math.max(run.startS, Math.min(run.endS, Number.isFinite(requestedTimeS) ? requestedTimeS : run.startS)), vehicles: RunVehicleFrame[] = [], activeActivities: Activity[] = [];
  for (const vehicleId of run.vehicleIds) {
    if (filters.vehicleIds && !filters.vehicleIds.includes(vehicleId)) continue;
    const track = run.tracks.get(vehicleId) ?? [], index = atOrBefore(track, timeS, value => value.t0), candidate = track[index];
    const activity = candidate && (timeS < candidate.t1 || index === track.length - 1 && timeS === candidate.t1) ? candidate : undefined;
    let current: RunVehicleFrame | undefined;
    if (activity) {
      current = planPose(run, activity, timeS); activeActivities.push(activity);
      if (activity.kind !== 'travel') { const previous = [...track].reverse().find(value => value.kind === 'travel' && value.t1 <= activity.t0); if (previous) { const held = planPose(run, previous, previous.t1); if (Math.hypot(...held.position.map((value, index) => value - current!.position[index]!)) <= 1e-6) current.yawRad = held.yawRad; } }
    }
    else { const previous = candidate; if (previous) current = { ...planPose(run, previous, previous.t1), state: index + 1 < track.length ? 'gap' : 'idle', route: null, note: '最近已知位置保持；此时没有活动资料。' }; }
    const samples = run.eventTracks.get(vehicleId) ?? [];
    const event = samples[atOrBefore(samples, timeS, value => value.simTimeS)];
    if (event) {
      let position: Vec3, yawRad = event.yawRad ?? current?.yawRad ?? 0, route: ResolvedPath | null = null;
      if (event.position && event.poseAuthority !== 'road') position = [...event.position];
      else if (event.roadId && event.direction && event.sM !== undefined) { const arc = arcFor(run.compiled, event.roadId, event.direction), pose = poseAtDistance(arc.path, 'forward', event.sM); position = pose.position; yawRad = pose.yawRad; if (event.state === 'travel') route = arc.path; }
      else position = [...run.compiled.nodes[event.nodeId!]!.position];
      current = { vehicleId, ...(event.taskId ? { taskId: event.taskId } : {}), state: event.state, position, yawRad, route, source: 'event', ...(event.roadId ? { roadId: event.roadId, direction: event.direction, sM: event.sM } : {}), note: '已提供事件采样保持；不插补事件间运动。' };
    }
    if (current && (!filters.taskIds || current.taskId && filters.taskIds.includes(current.taskId))) vehicles.push(current);
  }
  return { timeS, vehicles, activeActivities: activeActivities.filter(activity => !filters.taskIds || activity.taskId && filters.taskIds.includes(activity.taskId)), issues: run.issues };
}
export function compareSummaries(a: SummaryFile & { scenarioVerified?: boolean; comparisonScope?: ComparisonScope; runSource?: PlanFile['source'] }, b: SummaryFile & { scenarioVerified?: boolean; comparisonScope?: ComparisonScope; runSource?: PlanFile['source'] }): { comparable: boolean; reasons: string[]; metrics: { key: string; a: number | null; b: number | null; delta: number | null; unit: string; definition: string; window: TimeWindow }[] } {
  const reasons: string[] = [];
  if (!a.runSource || !b.runSource || a.runSource !== b.runSource) reasons.push('运行来源类别不一致，不能把 synthetic 示例与 external 结果并列评分。');
  if (!a.scenarioVerified || !b.scenarioVerified) reasons.push('场景内容未核验，不能比较差值。');
  for (const key of ['mapId', 'mapContentHash', 'scenarioId', 'scenarioHash', 'compilerVersion'] as const) if (a[key] !== b[key]) reasons.push(key + ' 不匹配。');
  if (!a.comparisonScope || !b.comparisonScope || !exact(a.comparisonScope, b.comparisonScope)) reasons.push('实际计划的任务集合、车辆集合或回放时域不同，不能并列评分。');
  const other = new Map(b.metrics.map(metric => [metric.key, metric]));
  for (const metric of a.metrics) { const target = other.get(metric.key); if (!target || metric.unit !== target.unit || metric.definition !== target.definition || !exact(metric.window, target.window)) reasons.push(metric.key + ' 的单位、定义、时域或指标集合不匹配。'); }
  if (a.metrics.length !== b.metrics.length) reasons.push('指标集合不同。');
  return { comparable: reasons.length === 0, reasons, metrics: a.metrics.map(metric => { const target = other.get(metric.key); return { key: metric.key, a: metric.value, b: target?.value ?? null, delta: !reasons.length && metric.value !== null && target?.value !== null && target?.value !== undefined ? target.value - metric.value : null, unit: metric.unit, definition: metric.definition, window: metric.window }; }) };
}
export function makeSyntheticRunFiles(map: YardMap): { scenario: ScenarioFile; plan: PlanFile; events: RunEvent[]; summary: SummaryFile } | null {
  const compiled = compileMap(map), candidates = Object.values(compiled.arcs).filter(arc => arc.direction === 'forward' && !arc.ownerEntityId && arc.allowed === true && compiled.arcs[arc.roadId + ':backward']?.allowed === true);
  const arc = candidates.find(value => value.path.spans.some(span => span.kind === 'cubic')) ?? candidates[0]; if (!arc) return null;
  const travelS = arc.lengthM / (5 / 3.6), endS = travelS + 30, timeWindow = { startS: 0, endS };
  const scenario: ScenarioFile = { protocolVersion: '1.0', scenarioId: 'FAST01-synthetic-display-v1', units: { length: 'm', time: 's' }, vehicles: [{ id: 'vehicle_forward' }, { id: 'vehicle_backward' }], tasks: [{ id: 'task_forward', originNodeId: arc.fromNodeId, destinationNodeId: arc.toNodeId }, { id: 'task_backward', originNodeId: arc.toNodeId, destinationNodeId: arc.fromNodeId }], timeWindow, assumptions: ['synthetic 固定协议接入示例；不表示任何优化收益。', '每车区间采用 5 km/h 显示假设；忽略车辆扫掠、会车和资源容量，仅测试数据消费。'], parameters: { mapId: compiled.mapId, mapContentHash: compiled.mapContentHash, speedMps: 5 / 3.6 } };
  const binding: RunBinding = { protocolVersion: '1.0', runId: 'FAST01-synthetic-run', mapId: compiled.mapId, mapContentHash: compiled.mapContentHash, scenarioId: scenario.scenarioId, scenarioHash: hash(scenario), compilerVersion: COMPILER_VERSION };
  const plan: PlanFile = { ...binding, name: 'synthetic 曲线正反向与等待', source: 'synthetic', activities: [
    { kind: 'travel', vehicleId: 'vehicle_forward', taskId: 'task_forward', t0: 0, t1: travelS, roadId: arc.roadId, direction: 'forward', s0M: 0, s1M: arc.lengthM },
    { kind: 'wait', vehicleId: 'vehicle_forward', taskId: 'task_forward', t0: travelS, t1: endS, nodeId: arc.toNodeId },
    { kind: 'wait', vehicleId: 'vehicle_backward', taskId: 'task_backward', t0: 0, t1: 10, nodeId: arc.toNodeId },
    { kind: 'travel', vehicleId: 'vehicle_backward', taskId: 'task_backward', t0: 10, t1: travelS + 10, roadId: arc.roadId, direction: 'backward', s0M: 0, s1M: arc.lengthM },
    { kind: 'wait', vehicleId: 'vehicle_backward', taskId: 'task_backward', t0: travelS + 10, t1: endS, nodeId: arc.fromNodeId },
  ] };
  const events: RunEvent[] = [0, 0.25, 0.5, 0.75, 1].flatMap((fraction, seq) => (['forward', 'backward'] as const).map(direction => ({ ...binding, entityType: 'vehicle' as const, entityId: 'vehicle_' + direction, taskId: 'task_' + direction, seq, simTimeS: fraction * travelS + (direction === 'backward' ? 10 : 0), state: fraction === 1 ? 'wait' as const : 'travel' as const, roadId: arc.roadId, direction, sM: fraction * arc.lengthM })));
  const summary: SummaryFile = { ...binding, metrics: [
    { key: 'makespan', value: endS, unit: 's', definition: '固定示例最后一项活动结束时刻；不是优化结论。', window: timeWindow, source: 'synthetic_fixed_plan' },
    { key: 'distance', value: 2 * arc.lengthM, unit: 'm', definition: '两车固定 travel 区间声明里程之和。', window: timeWindow, source: 'synthetic_fixed_plan' },
    { key: 'lateness', value: null, unit: 's', definition: '场景未给交付基准，迟交未提供。', window: timeWindow, source: 'not_provided' },
  ] };
  return { scenario, plan, events, summary };
}
