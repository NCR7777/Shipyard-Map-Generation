import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import legacySchema from '../../schemas/map.schema.json' with { type: 'json' };
import currentSchema from '../../schemas/map-0.2.schema.json' with { type: 'json' };
import pathSchema from '../../schemas/map-0.3.schema.json' with { type: 'json' };
import { roadGeometryAnchors, hasNonlinearGeometry, getRoadPath, pathLength } from '../geometry/roadPath';
import type { Issue, PhysicalValue, Provenance, ValidationReport, Vec3, YardMap } from '../domain/model';
import { isDeepFrozen, recentFor } from '../domain/value';
import { roadLength, roadPoints } from '../geometry/roads';
import { MAX_MAP_POLYGON_VERTICES, validatePolygon } from '../geometry/polygons';
import type { Polygon } from '../domain/model';
import { inspectServiceConnections } from '../topology/serviceConnections';
import { mapCapabilities } from '../domain/capabilities';
import { inspectPlanning } from '../domain/planning';
import { inspectSpatialClassification } from '../domain/spatialClassification';

const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
const legacyValidator = ajv.compile<YardMap>(legacySchema);
const currentValidator = ajv.compile<YardMap>(currentSchema);
const pathValidator = ajv.compile<YardMap>(pathSchema);
const collections = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
function pointer(key: string): string { return key.replace(/~/g, '~0').replace(/\//g, '~1'); }

function issue(code: string, path: string, message: string, severity: 'error' | 'warning' = 'error'): Issue {
  const parts = path.split('/');
  return {
    code, severity, jsonPath: path, message,
    ...(collections.some(name => name === parts[1]) && parts[2] ? { entityType: parts[1], entityId: parts[2].replace(/~1/g, '/').replace(/~0/g, '~') } : {}),
    suggestedAction: severity === 'error' ? '修正对应字段或引用后重新校验。' : '保留草稿标记，并在后续建模中补充依据或规则。',
  };
}

function schemaIssue(error: ErrorObject): Issue {
  let path = error.instancePath;
  if (error.keyword === 'additionalProperties') path += '/' + pointer(String(error.params.additionalProperty));
  if (error.keyword === 'required') path += '/' + pointer(String(error.params.missingProperty));
  return issue(error.keyword === 'additionalProperties' ? 'UNKNOWN_CORE_FIELD' : 'SCHEMA_ERROR', path, `结构不符合 Schema：${error.message ?? error.keyword}`);
}

function pointerPath(keys: readonly string[]): string { return keys.map(key => '/' + pointer(key)).join(''); }
/** keys is the current JSON path; the pointer text is built only for an issue. */
function checkJsonValues(value: unknown, keys: string[], issues: Issue[], ancestors: Set<object>): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push(issue('NON_FINITE_NUMBER', pointerPath(keys), '数字必须为有限值。'));
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value !== 'object') { issues.push(issue('NON_JSON_VALUE', pointerPath(keys), '字段必须为可表示的 JSON 值。')); return; }
  if (ancestors.has(value)) { issues.push(issue('CYCLIC_VALUE', pointerPath(keys), 'JSON 不允许循环引用。')); return; }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    issues.push(issue('NON_JSON_VALUE', pointerPath(keys), '对象必须为普通 JSON 对象。')); return;
  }
  // Same limit as parseMap: an object or array at key depth 64 is bracket depth 65 in the saved file.
  if (keys.length >= 64) { issues.push(issue('JSON_DEPTH_LIMIT', pointerPath(keys), '对象嵌套超过 64 层。')); return; }
  ancestors.add(value);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) { keys.push(key); checkJsonValues(record[key], keys, issues, ancestors); keys.pop(); }
  ancestors.delete(value);
}

const drafts: { key: object; value: ValidationReport }[] = [];
/** Deep-frozen maps never change, so their draft report is computed once and shared read-only. */
export function validateMap(input: unknown, profile = 'draft'): ValidationReport {
  if (profile !== 'draft' || !isDeepFrozen(input)) return validateUncached(input, profile);
  return recentFor(drafts, input, () => validateUncached(input, profile));
}

/** Buckets of item indices by planar cell; candidates are a superset, callers keep the exact distance test. */
function planarGrid(points: readonly Vec3[], cellM: number) {
  const cells = new Map<string, number[]>();
  const key = (x: number, y: number) => x + ':' + y;
  points.forEach((point, index) => {
    const k = key(Math.floor(point[0] / cellM), Math.floor(point[1] / cellM));
    const list = cells.get(k); if (list) list.push(index); else cells.set(k, [index]);
  });
  return {
    /** Indices whose cell overlaps the box, ascending; null when the box spans too many cells to enumerate. */
    query(minX: number, minY: number, maxX: number, maxY: number): number[] | null {
      const x0 = Math.floor(minX / cellM), x1 = Math.floor(maxX / cellM), y0 = Math.floor(minY / cellM), y1 = Math.floor(maxY / cellM);
      // Beyond 2^40 cells a unit step may no longer be exact; the caller then scans every point as before.
      if (![x0, x1, y0, y1].every(value => Math.abs(value) <= 2 ** 40) || (x1 - x0 + 1) * (y1 - y0 + 1) > 4096) return null;
      const found: number[] = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const list = cells.get(key(x, y)); if (list) found.push(...list); }
      return found.sort((a, b) => a - b);
    },
  };
}

function validateUncached(input: unknown, profile: string): ValidationReport {
  const issues: Issue[] = [];
  checkJsonValues(input, [], issues, new Set());
  if (issues.length) return { ok: false, profile, status: 'invalid', issues };
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== '0.1.0' && input.schemaVersion !== '0.2.0' && input.schemaVersion !== '0.3.0') {
    return { ok: false, profile, status: 'invalid', issues: [issue('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', '仅支持 schemaVersion 0.1.0 / 0.2.0 / 0.3.0；未执行自动迁移。')] };
  }
  const version = input && typeof input === 'object' && 'schemaVersion' in input ? input.schemaVersion : undefined;
  const structuralValidator = version === '0.3.0' ? pathValidator : version === '0.2.0' ? currentValidator : legacyValidator;
  if (!structuralValidator(input)) return { ok: false, profile, status: 'invalid', issues: (structuralValidator.errors ?? []).map(schemaIssue) };
  const map = input as YardMap;
  if (map.schemaVersion === '0.3.0') {
    for (const [id, road] of Object.entries(map.roads)) {
      if (road.geometry.spans.length !== road.geometry.anchors.length + 1) issues.push(issue('ROAD_SPAN_COUNT', '/roads/' + pointer(id) + '/geometry/spans', '路径 span 数量必须等于内部锚点数量 + 1。'));
    }
    if (issues.length) return { ok: false, profile, status: 'invalid', issues };
  }
  function ref(collection: typeof collections[number], id: string | undefined, path: string): void {
    if (id !== undefined && !Object.hasOwn(map[collection], id)) issues.push(issue('DANGLING_REFERENCE', path, `引用的 ${collection}/${id} 不存在。`));
  }
  function refs(collection: typeof collections[number], ids: string[] | undefined, path: string): void {
    ids?.forEach((id, i) => ref(collection, id, `${path}/${i}`));
  }
  function provenance(value: Provenance, path: string): void {
    refs('sources', value.sourceRefs, path + '/sourceRefs');
    for (const [field, id] of Object.entries(value.fieldSources ?? {})) ref('sources', id, path + '/fieldSources/' + pointer(field));
  }
  function physical(value: PhysicalValue | undefined, path: string): void {
    if (value?.state === 'known') ref('sources', value.sourceRef, path + '/sourceRef');
  }
  function extensions(value: Record<string, unknown> | undefined, path: string): void {
    for (const namespace of Object.keys(value ?? {})) {
      if (!Object.hasOwn(map.extensionNamespaces, namespace)) issues.push(issue('UNDECLARED_EXTENSION_NAMESPACE', path + '/' + pointer(namespace), `扩展命名空间 ${namespace} 未声明。`));
    }
  }
  extensions(map.extensions, '/extensions');
  extensions(map.metadata.extensions, '/metadata/extensions');
  const ids = new Map<string, string>();
  for (const collection of collections) {
    for (const [id, entity] of Object.entries(map[collection])) {
      const path = '/' + collection + '/' + pointer(id);
      const previous = ids.get(id);
      if (previous) issues.push(issue('DUPLICATE_ENTITY_ID', path, `实体 ID 已用于 ${previous}；ID 须全图唯一。`));
      ids.set(id, path);
      extensions(entity.extensions, path + '/extensions');
      if ('provenance' in entity) provenance(entity.provenance, path + '/provenance');
    }
  }
  const polygons: { polygon: Polygon; path: string }[] = [];
  if (map.siteBoundary) polygons.push({ polygon: map.siteBoundary, path: '/siteBoundary' });
  for (const [id, road] of Object.entries(map.roads)) if (road.corridorPolygon) polygons.push({ polygon: road.corridorPolygon, path: '/roads/' + pointer(id) + '/corridorPolygon' });
  for (const kind of ['facilities', 'zones'] as const) for (const [id, entity] of Object.entries(map[kind])) polygons.push({ polygon: entity.boundary, path: '/' + kind + '/' + pointer(id) + '/boundary' });
  for (const [id, junction] of Object.entries(map.junctions)) if (junction.boundary) polygons.push({ polygon: junction.boundary, path: '/junctions/' + pointer(id) + '/boundary' });
  if (polygons.reduce((sum, entry) => sum + entry.polygon.outer.length + entry.polygon.holes.reduce((n, ring) => n + ring.length, 0), 0) > MAX_MAP_POLYGON_VERTICES) {
    issues.push(issue('POLYGON_MAP_COMPLEXITY_LIMIT', '', `本轮仅支持整图最多 ${MAX_MAP_POLYGON_VERTICES} 个多边形顶点，未执行超限几何检查。`));
  } else for (const entry of polygons) for (const error of validatePolygon(entry.polygon)) issues.push(issue(error.code, entry.path + error.path, error.message));
  for (const [id, road] of Object.entries(map.roads)) {
    const path = '/roads/' + pointer(id);
    ref('nodes', road.fromNodeId, path + '/fromNodeId'); ref('nodes', road.toNodeId, path + '/toNodeId');
    refs('resources', road.resourceIds, path + '/resourceIds');
    for (const field of ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps', 'observedLengthM'] as const) {
      physical(road[field], path + '/' + field);
      if (road[field]?.state === 'unknown') issues.push(issue('UNKNOWN_PHYSICAL_VALUE', path + '/' + field, `${field} 未知；仅作草稿。`, 'warning'));
    }
    if (road.direction === 'unknown') issues.push(issue('UNKNOWN_DIRECTION', path + '/direction', '道路方向尚未定义。', 'warning'));
    if (Object.hasOwn(map.nodes, road.fromNodeId) && Object.hasOwn(map.nodes, road.toNodeId)) {
      if (hasNonlinearGeometry(road)) {
        const resolved = getRoadPath(map, id), measured = pathLength(resolved);
        if (!measured.converged) issues.push(issue('GEOMETRY_NOT_CONVERGED', path + '/geometry', '曲线长度或空间误差未收敛；不能将近似值作为已确认几何。'));
        resolved.spans.forEach((span, index) => {
          const a = resolved.anchors[index]!, b = resolved.anchors[index + 1]!;
          const controls = span.kind === 'cubic' ? [a, span.control1, span.control2, b] : [a, b];
          if (controls.every(point => point[0] === a[0] && point[1] === a[1])) issues.push(issue('ZERO_LENGTH_SPAN', path + '/geometry/spans/' + index, '路径包含完全零水平长度的 span。'));
        });
      }
      const length = roadLength(map, id);
      if (!Number.isFinite(length)) issues.push(issue('NON_FINITE_GEOMETRY', path + (road.geometry ? '/geometry' : '/shapePoints'), '派生二维长度超出有限数值范围。'));
      else if (length === 0) issues.push(issue('ZERO_LENGTH_ROAD', path + (road.geometry ? '/geometry' : '/shapePoints'), '道路二维水平长度为零。'));
    }
  }
  for (const [id, junction] of Object.entries(map.junctions)) {
    const path = '/junctions/' + pointer(id);
    refs('nodes', junction.nodeIds, path + '/nodeIds'); refs('resources', junction.resourceIds, path + '/resourceIds');
  }
  for (const [id, movement] of Object.entries(map.movements)) {
    const path = '/movements/' + pointer(id);
    ref('junctions', movement.junctionId, path + '/junctionId'); refs('resources', movement.resourceIds, path + '/resourceIds');
    for (const field of ['incomingArc', 'outgoingArc'] as const) {
      const arc = movement[field];
      ref('roads', arc.roadId, path + '/' + field + '/roadId');
      if (!Object.hasOwn(map.roads, arc.roadId)) continue;
      const road = map.roads[arc.roadId]!;
      if (road.direction !== 'unknown' && road.direction !== 'both' && road.direction !== arc.direction)
        issues.push(issue('ARC_DIRECTION_CONFLICT', path + '/' + field, '转向引用的道路方向被道路属性禁止。'));
      if (Object.hasOwn(map.junctions, movement.junctionId)) {
        const nodeId = field === 'incomingArc'
          ? (arc.direction === 'forward' ? road.toNodeId : road.fromNodeId)
          : (arc.direction === 'forward' ? road.fromNodeId : road.toNodeId);
        if (!map.junctions[movement.junctionId]!.nodeIds.includes(nodeId))
          issues.push(issue('ARC_OUTSIDE_JUNCTION', path + '/' + field, '转向端点未列入所引用路口的显式节点组。'));
      }
    }
  }
  for (const [id, facility] of Object.entries(map.facilities)) {
    const path = '/facilities/' + pointer(id);
    refs('accessPoints', facility.accessPointIds, path + '/accessPointIds');
    refs('servicePoints', facility.servicePointIds, path + '/servicePointIds');
    ref('assets', facility.assetId, path + '/assetId'); physical(facility.heightM, path + '/heightM');
    facility.accessPointIds.forEach((accessId, index) => {
      if (Object.hasOwn(map.accessPoints, accessId) && map.accessPoints[accessId]!.facilityId !== id)
        issues.push(issue('FACILITY_REFERENCE_CONFLICT', path + '/accessPointIds/' + index, '出入口的设施归属与本设施不一致。'));
    });
    facility.servicePointIds.forEach((serviceId, index) => {
      if (Object.hasOwn(map.servicePoints, serviceId) && map.servicePoints[serviceId]!.facilityId !== id)
        issues.push(issue('FACILITY_REFERENCE_CONFLICT', path + '/servicePointIds/' + index, '服务点的设施归属与本设施不一致。'));
    });
  }
  for (const [id, access] of Object.entries(map.accessPoints)) {
    const path = '/accessPoints/' + pointer(id);
    ref('facilities', access.facilityId, path + '/facilityId'); ref('nodes', access.nodeId, path + '/nodeId');
    if (Object.hasOwn(map.facilities, access.facilityId) && !map.facilities[access.facilityId]!.accessPointIds.includes(id)) issues.push(issue('FACILITY_MEMBERSHIP_MISSING', path + '/facilityId', '入口声明的设施必须反向列出该入口 ID。'));
  }
  for (const [id, service] of Object.entries(map.servicePoints)) {
    const path = '/servicePoints/' + pointer(id);
    ref('nodes', service.nodeId, path + '/nodeId'); ref('facilities', service.facilityId, path + '/facilityId');
    if (map.schemaVersion !== '0.1.0') ref('zones', service.zoneId, path + '/zoneId');
    ref('accessPoints', service.accessPointId, path + '/accessPointId'); refs('resources', service.resourceIds, path + '/resourceIds');
    if (service.facilityId && Object.hasOwn(map.facilities, service.facilityId) && !map.facilities[service.facilityId]!.servicePointIds.includes(id)) issues.push(issue('FACILITY_MEMBERSHIP_MISSING', path + '/facilityId', '服务点声明的设施必须反向列出该服务点 ID。'));
    if (service.facilityId && service.accessPointId && Object.hasOwn(map.accessPoints, service.accessPointId)
      && map.accessPoints[service.accessPointId]!.facilityId !== service.facilityId)
      issues.push(issue('SERVICE_ACCESS_FACILITY_CONFLICT', path + '/accessPointId', '服务点与所引用出入口的设施归属不一致。'));
  }
  if (map.schemaVersion !== '0.1.0') {
    const services = Object.values(map.servicePoints);
    const geometrySegments = Object.values(map.roads).reduce((sum, road) => sum + roadGeometryAnchors(road).length + 1, 0);
    const work = geometrySegments + services.length * Object.keys(map.roads).length + services.reduce((sum, service) => sum + (service.arrival?.mode === 'explicit_internal' ? service.arrival.internalPath.length * Math.max(1, Object.keys(map.movements).length) : 0), 0);
    if (work > 2_000_000) issues.push(issue('SERVICE_CONNECTION_COMPLEXITY_LIMIT', '/servicePoints', '服务点与道路/转向诊断组合超过 2000000，本轮不能完成接续校验；请拆分地图，不返回未检查的成功。'));
    else for (const summary of inspectServiceConnections(map)) issues.push(...summary.issues);
  }
  for (const [id, zone] of Object.entries(map.zones)) refs('resources', zone.resourceIds, '/zones/' + pointer(id) + '/resourceIds');
  for (const [id, resource] of Object.entries(map.resources)) {
    const path = '/resources/' + pointer(id);
    physical(resource.capacity, path + '/capacity');
    resource.appliesTo.forEach((target, i) => ref(target.entityType, target.entityId, path + '/appliesTo/' + i + '/entityId'));
  }
  for (const [id, asset] of Object.entries(map.assets)) {
    const path = '/assets/' + pointer(id);
    ref('sources', asset.sourceRef, path + '/sourceRef');
    const segments = asset.path.split('/');
    if (!asset.path.startsWith('assets/') || segments.length < 2 || segments.some(s => s === '' || s === '.' || s === '..') || /[\\:]/.test(asset.path) || [...asset.path].some(char => char.charCodeAt(0) < 32))
      issues.push(issue('UNSAFE_ASSET_PATH', path + '/path', '资源必须为 assets/ 下相对路径，禁止空路径段、点段、盘符、反斜杠及控制字符。'));
    issues.push(issue('ASSET_NOT_RESOLVED', path, '结构校验未读取图片二进制；图片加载状态与 SHA 校验由当前本地项目另行确认。', 'warning'));
  }
  for (const [id, background] of Object.entries(map.backgroundLayers)) {
    const path = '/backgroundLayers/' + pointer(id);
    ref('assets', background.assetId, path + '/assetId');
    const [a, b, c, d] = background.imageToWorld;
    if (a !== undefined && b !== undefined && c !== undefined && d !== undefined && a * d - b * c === 0)
      issues.push(issue('SINGULAR_BACKGROUND_TRANSFORM', path + '/imageToWorld', '底图变换矩阵不可逆。'));
  }
  // Bounded proximity hints only. They never create nodes, split edges or establish connectivity.
  const nearNodes = Object.entries(map.nodes);
  if (nearNodes.length <= 2000) {
    const connected = new Set(Object.values(map.roads).map(road => [road.fromNodeId, road.toNodeId].sort().join('|')));
    // Same pair order and 100-hint cap as the full scan; the grid only skips pairs that cannot be within 0.5 m.
    const grid = planarGrid(nearNodes.map(([, node]) => node.position), 16);
    let reported = 0;
    // The exact test below may round a distance just over 0.5 m down to 0.5; the pad keeps such pairs among the candidates.
    const pad = (...values: number[]) => 0.5 + 1e-6 + 1e-9 * Math.max(1, ...values.map(Math.abs));
    for (let i = 0; i < nearNodes.length && reported < 100; i++) {
      const [idA, nodeA] = nearNodes[i]!; const [x, y] = nodeA.position, r = pad(x, y);
      const candidates = grid.query(x - r, y - r, x + r, y + r) ?? nearNodes.map((_, index) => index);
      for (const j of candidates) {
        if (j <= i) continue; if (reported >= 100) break;
        const [idB, nodeB] = nearNodes[j]!;
        if (Math.hypot(nodeA.position[0] - nodeB.position[0], nodeA.position[1] - nodeB.position[1], nodeA.position[2] - nodeB.position[2]) <= 0.5 && !connected.has([idA, idB].sort().join('|'))) {
          issues.push(issue('NEAR_UNCONNECTED_NODES', '/nodes/' + pointer(idB) + '/position', `节点距 ${idA} 不超过 0.5 m，但没有显式直连道路；接近或重合不建立拓扑。`, 'warning')); reported++;
        }
      }
    }
    const segments = Object.values(map.roads).reduce((sum, road) => sum + roadGeometryAnchors(road).length + 1, 0);
    if (nearNodes.length * segments <= 2_000_000) {
      for (const [roadId, road] of Object.entries(map.roads)) {
        if (reported >= 100) break;
        if (!Object.hasOwn(map.nodes, road.fromNodeId) || !Object.hasOwn(map.nodes, road.toNodeId)) continue;
        const points = roadPoints(map, roadId);
        const near = new Set<number>(); let everyNode = false;
        for (let i = 0; i + 1 < points.length && !everyNode; i++) {
          const a = points[i]!, b = points[i + 1]!, r = pad(a[0], a[1], b[0], b[1]);
          const found = grid.query(Math.min(a[0], b[0]) - r, Math.min(a[1], b[1]) - r, Math.max(a[0], b[0]) + r, Math.max(a[1], b[1]) + r);
          if (found) found.forEach(index => near.add(index)); else everyNode = true;
        }
        const candidates = everyNode ? nearNodes : [...near].sort((a, b) => a - b).map(index => nearNodes[index]!);
        for (const [nodeId, node] of candidates) {
          if (reported >= 100) break;
          if (nodeId === road.fromNodeId || nodeId === road.toNodeId) continue;
          for (let i = 0; i + 1 < points.length; i++) {
            const a = points[i]!; const b = points[i + 1]!;
            const dx = b[0] - a[0]; const dy = b[1] - a[1]; const denominator = dx * dx + dy * dy;
            if (!Number.isFinite(denominator) || denominator === 0) continue;
            const t = Math.max(0, Math.min(1, ((node.position[0] - a[0]) * dx + (node.position[1] - a[1]) * dy) / denominator));
            const d = Math.hypot(node.position[0] - (a[0] + dx * t), node.position[1] - (a[1] + dy * t), node.position[2] - (a[2] + (b[2] - a[2]) * t));
            if (d <= 0.5) {
              issues.push(issue('NEAR_ROAD_UNCONNECTED', '/nodes/' + pointer(nodeId) + '/position', `节点距道路 ${roadId} 不超过 0.5 m，但不是该道路端点；需要显式拆分/连接，几何重合不通行。`, 'warning'));
              reported++; break;
            }
          }
        }
      }
    } else issues.push(issue('PROXIMITY_CHECK_LIMIT', '/roads', '节点与道路线段组合超过 2000000，跳过节点近道路提示；未确认不存在该问题。', 'warning'));
  } else issues.push(issue('PROXIMITY_CHECK_LIMIT', '/nodes', '节点超过 2000，本轮跳过近邻提示；并未确认不存在近邻未连接节点。', 'warning'));
  if (Object.keys(map.roads).length && Object.keys(map.movements).length === 0)
    issues.push(issue('TURN_RULES_UNSPECIFIED', '/movements', '未定义转向连接；共享节点只定义几何关联，M2A 未执行路径可达性检查。', 'warning'));
  const planning = inspectPlanning(map);
  // Own copies: the location added below must not write into another reader's (possibly cached) issues.
  issues.push(...planning.issues.map(item => ({ ...item })));
  issues.push(...inspectSpatialClassification(map).issues);
  const capabilities = mapCapabilities(map, planning);
  for (const reason of capabilities.reasons) issues.push(issue('UNSUPPORTED_EDIT_CAPABILITY', '', reason, 'warning'));
  if (capabilities.unchecked.length) issues.push(issue('MISSING_CHECKS', '', `本次未校验：${capabilities.unchecked.join(', ')}。`, 'warning'));
  for (const item of issues) {
    if (item.entityType === 'nodes' && item.entityId && Object.hasOwn(map.nodes, item.entityId))
      item.location = { position: [...map.nodes[item.entityId]!.position] };
    if ((item.entityType === 'facilities' || item.entityType === 'zones') && item.entityId && Object.hasOwn(map[item.entityType], item.entityId)) item.location = { position: [...map[item.entityType][item.entityId]!.boundary.outer[0]] };
    if ((item.entityType === 'accessPoints' || item.entityType === 'servicePoints') && item.entityId && Object.hasOwn(map[item.entityType], item.entityId)) {
      const nodeId = map[item.entityType][item.entityId]!.nodeId;
      if (Object.hasOwn(map.nodes, nodeId)) item.location = { position: [...map.nodes[nodeId]!.position] };
    }
    if (item.entityType === 'roads' && item.entityId && Object.hasOwn(map.roads, item.entityId)) {
      const road = map.roads[item.entityId]!;
      if (Object.hasOwn(map.nodes, road.fromNodeId)) item.location = { position: [...map.nodes[road.fromNodeId]!.position] };
    }
  }
  const valid = !issues.some(item => item.severity === 'error');
  if (!valid) return { ok: false, profile, status: 'invalid', issues };
  if (profile !== 'draft') return { ok: false, profile, status: 'unsupported', issues: [...issues, issue('UNSUPPORTED_PROFILE', '', `M2A 不支持 ${profile} 发布/校验配置。`)] };
  return { ok: true, profile, status: 'valid', issues };
}