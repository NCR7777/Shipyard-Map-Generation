import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import legacySchema from '../../schemas/map.schema.json';
import currentSchema from '../../schemas/map-0.2.schema.json';
import type { Issue, PhysicalValue, Provenance, ValidationReport, YardMap } from '../domain/model';
import { roadLength, roadPoints } from '../geometry/roads';
import { MAX_MAP_POLYGON_VERTICES, validatePolygon } from '../geometry/polygons';
import type { Polygon } from '../domain/model';
import { inspectServiceConnections } from '../topology/serviceConnections';
import { mapCapabilities } from '../domain/capabilities';
import { inspectPlanning } from '../domain/planning';

const ajv = new Ajv2020({ allErrors: true, strict: true, ownProperties: true });
const legacyValidator = ajv.compile<YardMap>(legacySchema);
const currentValidator = ajv.compile<YardMap>(currentSchema);
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

function checkJsonValues(value: unknown, path: string, issues: Issue[], depth: number, ancestors: Set<object>): void {
  if (depth > 64) { issues.push(issue('JSON_DEPTH_LIMIT', path, '对象嵌套超过 64 层。')); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) issues.push(issue('NON_FINITE_NUMBER', path, '数字必须为有限值。'));
    return;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value !== 'object') { issues.push(issue('NON_JSON_VALUE', path, '字段必须为可表示的 JSON 值。')); return; }
  if (ancestors.has(value)) { issues.push(issue('CYCLIC_VALUE', path, 'JSON 不允许循环引用。')); return; }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    issues.push(issue('NON_JSON_VALUE', path, '对象必须为普通 JSON 对象。')); return;
  }
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) checkJsonValues(child, path + '/' + pointer(key), issues, depth + 1, ancestors);
  ancestors.delete(value);
}

export function validateMap(input: unknown, profile = 'draft'): ValidationReport {
  const issues: Issue[] = [];
  checkJsonValues(input, '', issues, 0, new Set());
  if (issues.length) return { ok: false, profile, status: 'invalid', issues };
  if (input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion !== '0.1.0' && input.schemaVersion !== '0.2.0') {
    return { ok: false, profile, status: 'invalid', issues: [issue('UNSUPPORTED_SCHEMA_VERSION', '/schemaVersion', '仅支持 schemaVersion 0.1.0 / 0.2.0；未执行自动迁移。')] };
  }
  const structuralValidator = input && typeof input === 'object' && 'schemaVersion' in input && input.schemaVersion === '0.2.0' ? currentValidator : legacyValidator;
  if (!structuralValidator(input)) return { ok: false, profile, status: 'invalid', issues: (structuralValidator.errors ?? []).map(schemaIssue) };
  const map = input as YardMap;
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
      const length = roadLength(map, id);
      if (!Number.isFinite(length)) issues.push(issue('NON_FINITE_GEOMETRY', path + '/shapePoints', '派生二维长度超出有限数值范围。'));
      else if (length === 0) issues.push(issue('ZERO_LENGTH_ROAD', path + '/shapePoints', '道路二维水平长度为零。'));
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
    if (map.schemaVersion === '0.2.0') ref('zones', service.zoneId, path + '/zoneId');
    ref('accessPoints', service.accessPointId, path + '/accessPointId'); refs('resources', service.resourceIds, path + '/resourceIds');
    if (service.facilityId && Object.hasOwn(map.facilities, service.facilityId) && !map.facilities[service.facilityId]!.servicePointIds.includes(id)) issues.push(issue('FACILITY_MEMBERSHIP_MISSING', path + '/facilityId', '服务点声明的设施必须反向列出该服务点 ID。'));
    if (service.facilityId && service.accessPointId && Object.hasOwn(map.accessPoints, service.accessPointId)
      && map.accessPoints[service.accessPointId]!.facilityId !== service.facilityId)
      issues.push(issue('SERVICE_ACCESS_FACILITY_CONFLICT', path + '/accessPointId', '服务点与所引用出入口的设施归属不一致。'));
  }
  if (map.schemaVersion === '0.2.0') {
    const services = Object.values(map.servicePoints);
    const geometrySegments = Object.values(map.roads).reduce((sum, road) => sum + road.shapePoints.length + 1, 0);
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
    issues.push(issue('ASSET_NOT_RESOLVED', path, 'M2A 仅保留资源引用，未读取或校验二进制资源；矢量地图仍然可用。', 'warning'));
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
    let reported = 0;
    for (let i = 0; i < nearNodes.length && reported < 100; i++) for (let j = i + 1; j < nearNodes.length && reported < 100; j++) {
      const [idA, nodeA] = nearNodes[i]!; const [idB, nodeB] = nearNodes[j]!;
      if (Math.hypot(nodeA.position[0] - nodeB.position[0], nodeA.position[1] - nodeB.position[1], nodeA.position[2] - nodeB.position[2]) <= 0.5 && !connected.has([idA, idB].sort().join('|'))) {
        issues.push(issue('NEAR_UNCONNECTED_NODES', '/nodes/' + pointer(idB) + '/position', `节点距 ${idA} 不超过 0.5 m，但没有显式直连道路；接近或重合不建立拓扑。`, 'warning')); reported++;
      }
    }
    const segments = Object.values(map.roads).reduce((sum, road) => sum + road.shapePoints.length + 1, 0);
    if (nearNodes.length * segments <= 2_000_000) {
      for (const [roadId, road] of Object.entries(map.roads)) {
        if (reported >= 100) break;
        if (!Object.hasOwn(map.nodes, road.fromNodeId) || !Object.hasOwn(map.nodes, road.toNodeId)) continue;
        const points = roadPoints(map, roadId);
        for (const [nodeId, node] of nearNodes) {
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
  issues.push(...planning.issues);
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