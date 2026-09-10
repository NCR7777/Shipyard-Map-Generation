import type { Extensions, Issue, Polygon, YardMap } from './model';
import { MAX_POLYGON_HOLES, MAX_POLYGON_VERTICES, polygonArea2D, validatePolygon } from '../geometry/polygons';

export const PLANNING_NAMESPACE = 'sr02.planning';
export interface PlanningSlot {
  ownerKind: 'facilities' | 'zones'; ownerId: string; id: string;
  boundary: Polygon; servicePointId?: string; parking: boolean;
}
export interface PlanningInspection { present: boolean; supported: boolean; issues: Issue[]; slots: PlanningSlot[] }
// ponytail: bounded synchronous static reader; no execution of planning or evidence payloads.
export const MAX_PLANNING_SLOTS = 4096;
const MAX_VERTICES = 32768;
const MAX_GEOMETRY_COST = 1_000_000;
const COLLECTIONS = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const;
const STORAGE_FIELDS = ['role', 'dimensionBasis', 'slotGapM', 'slotLengthM', 'slotWidthM', 'slots', 'storageResourceId', 'transportAisleWidthM'];
const PARKING_FIELDS = ['role', 'quantityBasis', 'slotLengthM', 'slotWidthM', 'slots', 'transportAisleWidthM'];
const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
const extPath = (path: string) => path + '/extensions/' + PLANNING_NAMESPACE;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const idValue = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(value);
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const close = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-7 * Math.max(1, Math.abs(a), Math.abs(b));

/** Fixed sr02.planning@1.0 reader. Input remains authoritative and is never modified. */
export function inspectPlanning(map: YardMap): PlanningInspection {
  const issues: Issue[] = []; const slots: PlanningSlot[] = [];
  let supported = true; let present = Object.hasOwn(map.extensionNamespaces, PLANNING_NAMESPACE);
  const declaration = map.extensionNamespaces[PLANNING_NAMESPACE];
  const knownDeclaration = declaration?.version === '1.0' && declaration.category === 'behavior';
  let slotCount = 0; let vertexCount = 0; let geometryCost = 0; let evidenceCount = 0;
  const slotById = new Map<string, PlanningSlot>();
  const coreIds = new Set(COLLECTIONS.flatMap(kind => Object.keys(map[kind])));
  const owners = new Map<string, { kind: 'facilities' | 'zones'; id: string; payload: Record<string, unknown>; path: string }>();
  const resources = new Map<string, { payload: Record<string, unknown>; path: string }>();
  const parkingServices = new Set<string>();
  function warn(code: string, path: string, message: string): void {
    supported = false;
    const parts = path.split('/');
    if (issues.length < 200) issues.push({ code: 'PLANNING_' + code, severity: 'warning', jsonPath: path, message,
      ...(COLLECTIONS.includes(parts[1] as typeof COLLECTIONS[number]) && parts[2] ? { entityType: parts[1], entityId: parts[2]!.replace(/~1/g, '/').replace(/~0/g, '~') } : {}),
      suggestedAction: '保留原始扩展；修正该字段或使用明确支持此契约的工具，当前地图不开放领域编辑。' });
  }
  function record(value: unknown, allowed: readonly string[], required: readonly string[], path: string): Record<string, unknown> | undefined {
    if (!object(value)) { warn('SHAPE', path, '扩展必须是对象。'); return; }
    let valid = true;
    for (const key of Object.keys(value)) if (!allowed.includes(key)) { warn('UNKNOWN_FIELD', path + '/' + pointer(key), '尚未理解此扩展字段，不能安全编辑。'); valid = false; }
    for (const key of required) if (!Object.hasOwn(value, key)) { warn('MISSING_FIELD', path + '/' + key, '固定扩展契约缺少必需字段。'); valid = false; }
    return valid ? value : undefined;
  }
  function strings(value: Record<string, unknown>, fields: readonly string[], path: string): boolean {
    let valid = true;
    for (const key of fields) if (typeof value[key] !== 'string' || !(value[key] as string).trim()) { warn('VALUE', path + '/' + key, '应为非空说明文本。'); valid = false; }
    return valid;
  }
  function choice(value: Record<string, unknown>, key: string, values: readonly string[], path: string): boolean {
    if (typeof value[key] === 'string' && values.includes(value[key])) return true;
    warn('VALUE', path + '/' + key, '未支持的规划语义值。'); return false;
  }
  function reference(value: unknown, collection: Record<string, unknown>, path: string): value is string {
    if (idValue(value) && Object.hasOwn(collection, value)) return true;
    warn('REFERENCE', path, '引用的对象不存在或 ID 非法。'); return false;
  }
  function evidence(value: unknown, path: string): void {
    // These named records are provenance-only JSON, never spatial or executable instructions.
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (++evidenceCount > 100000 || item.depth > 32) { warn('COMPLEXITY_LIMIT', path, '只读来源记录超出节点或嵌套深度限制。'); return; }
      if (item.value === null || typeof item.value === 'string' || typeof item.value === 'boolean' || typeof item.value === 'number' && Number.isFinite(item.value)) continue;
      if (Array.isArray(item.value) || object(item.value)) {
        const values = Object.values(item.value);
        if (values.length + evidenceCount > 100000) { warn('COMPLEXITY_LIMIT', path, '只读来源记录超出节点限制。'); return; }
        for (const child of values) pending.push({ value: child, depth: item.depth + 1 });
      } else { warn('VALUE', path, '只读来源记录只能包含有限 JSON 值。'); return; }
    }
  }
  function polygon(value: unknown, path: string): Polygon | undefined {
    const data = record(value, ['outer', 'holes'], ['outer', 'holes'], path);
    if (!data) return;
    if (!Array.isArray(data.outer) || !Array.isArray(data.holes) || data.holes.length > MAX_POLYGON_HOLES) { warn('SLOT_BOUNDARY', path, '槽位边界必须具有外环与至多 16 个孔洞。'); return; }
    const rings = [data.outer, ...data.holes];
    if (rings.some(ring => !Array.isArray(ring) || ring.length < 4)) { warn('SLOT_BOUNDARY', path, '槽位环至少需要四个含闭合点的顶点。'); return; }
    const count = rings.reduce((sum: number, ring: unknown[]) => sum + ring.length, 0);
    vertexCount += count; geometryCost += count * count;
    if (count > MAX_POLYGON_VERTICES || vertexCount > MAX_VERTICES || geometryCost > MAX_GEOMETRY_COST) { warn('COMPLEXITY_LIMIT', path, '槽位几何超出单面 512 顶点、全图 32768 顶点或 100 万几何工作量限制。'); return; }
    if (rings.some(ring => ring.some((point: unknown) => !Array.isArray(point) || point.length !== 3 || point.some(n => typeof n !== 'number' || !Number.isFinite(n))))) { warn('SLOT_BOUNDARY', path, '槽位坐标必须为三个有限米制数值。'); return; }
    const boundary = data as unknown as Polygon;
    const problems = validatePolygon(boundary);
    for (const problem of problems) warn(problem.code, path + problem.path, problem.message);
    return problems.length ? undefined : structuredClone(boundary);
  }
  function readSlots(kind: 'facilities' | 'zones', ownerId: string, data: Record<string, unknown>, path: string, parking: boolean): void {
    const fields = parking ? PARKING_FIELDS : STORAGE_FIELDS;
    const e = record(data, parking ? [...fields, 'motion'] : fields, fields, path);
    if (!e) return;
    strings(e, parking ? ['quantityBasis'] : ['dimensionBasis'], path);
    if (parking) {
      choice(e, 'role', ['parking'], path);
      if ('motion' in e) choice(e, 'motion', ['SPMT crab approach; individual bay sweep not certified'], path);
    } else choice(e, 'role', ['raw', 'production', 'paint', 'erection', 'yard', 'buffer', 'maintenance', 'erection_open'], path);
    for (const key of ['slotLengthM', 'slotWidthM', 'transportAisleWidthM']) if (!positive(e[key])) warn('VALUE', path + '/' + key, '长度必须为正的有限米值。');
    if (!parking && (typeof e.slotGapM !== 'number' || !Number.isFinite(e.slotGapM) || e.slotGapM < 0)) warn('VALUE', path + '/slotGapM', '间距必须为非负有限米值。');
    if (!parking) reference(e.storageResourceId, map.resources, path + '/storageResourceId');
    if (!Array.isArray(e.slots) || e.slots.length === 0 || e.slots.length + slotCount > MAX_PLANNING_SLOTS) { warn('COMPLEXITY_LIMIT', path + '/slots', '槽位必须为非空数组，单图最多支持 4096 个槽位。'); return; }
    owners.set(ownerId, { kind, id: ownerId, payload: e, path });
    for (const [index, value] of e.slots.entries()) {
      slotCount++;
      const slotPath = path + '/slots/' + index;
      const slot = record(value, ['id', 'boundary', ...(parking ? ['servicePointId'] : [])], ['id', 'boundary', ...(parking ? ['servicePointId'] : [])], slotPath);
      if (!slot) continue;
      if (!idValue(slot.id)) { warn('SLOT_ID', slotPath + '/id', '槽位 ID 必须遵循实体 ID 格式。'); continue; }
      if (slotById.has(slot.id) || coreIds.has(slot.id)) { warn('DUPLICATE_SLOT', slotPath + '/id', '槽位 ID 必须在整图内唯一。'); continue; }
      const boundary = polygon(slot.boundary, slotPath + '/boundary');
      if (!boundary) continue;
      if (positive(e.slotLengthM) && positive(e.slotWidthM) && !close(polygonArea2D(boundary), e.slotLengthM * e.slotWidthM)) warn('SLOT_AREA', slotPath + '/boundary', '槽位面积与声明长宽不一致。');
      let servicePointId: string | undefined;
      if (parking && reference(slot.servicePointId, map.servicePoints, slotPath + '/servicePointId')) {
        servicePointId = slot.servicePointId;
        const point = map.servicePoints[servicePointId]!;
        if (kind !== 'zones' || point.zoneId !== ownerId || point.kind !== 'parking' || point.facilityId !== undefined) warn('SLOT_SERVICE_OWNER', slotPath + '/servicePointId', '泊位必须引用同一停车区域的 parking 服务点。');
        if (parkingServices.has(servicePointId)) warn('SLOT_SERVICE_DUPLICATE', slotPath + '/servicePointId', '不同泊位不能复用同一停车服务点。');
        parkingServices.add(servicePointId);
      }
      const result: PlanningSlot = { ownerKind: kind, ownerId, id: slot.id, boundary, parking, ...(servicePointId ? { servicePointId } : {}) };
      slots.push(result); slotById.set(slot.id, result);
    }
  }

  function inspectPayload(kind: string, id: string, value: unknown, path: string): void {
    if (kind === 'root') {
      const e = record(value, ['assumptionId', 'role', 'siteAreaBasis'], ['assumptionId', 'role', 'siteAreaBasis'], path);
      if (e) { strings(e, ['assumptionId', 'siteAreaBasis'], path); choice(e, 'role', ['synthetic_planning'], path); }
    } else if (kind === 'metadata') {
      const fields = ['designScale', 'evidenceRegister', 'modeledScope', 'precision', 'publicFacts', 'publicFactsFile', 'publicReference', 'referenceRecord', 'roadOrganization'];
      const e = record(value, fields, ['publicFactsFile', 'publicReference'], path);
      if (e) for (const key of Object.keys(e)) {
        if (['evidenceRegister', 'referenceRecord', 'publicFacts'].includes(key)) {
          if (key === 'publicFacts' ? !Array.isArray(e[key]) : !object(e[key])) warn('SHAPE', path + '/' + key, '来源快照形状不符合已知契约。');
          else evidence(e[key], path + '/' + key);
        } else strings(e, [key], path);
      }
    } else if (kind === 'sources') {
      const e = record(value, ['evidenceRecord'], ['evidenceRecord'], path);
      if (e) { if (!object(e.evidenceRecord)) warn('SHAPE', path + '/evidenceRecord', '来源记录必须为只读对象。'); else evidence(e.evidenceRecord, path + '/evidenceRecord'); }
    } else if (kind === 'roads') {
      const e = record(value, ['role', 'physicalMeaning', 'ownerEntityId'], ['role', 'physicalMeaning'], path);
      if (!e) return;
      choice(e, 'role', ['main', 'internal'], path);
      choice(e, 'physicalMeaning', ['design_declared_corridor_not_surveyed_clearance', 'declared_design_corridor_not_surveyed_clearance'], path);
      if (e.role === 'internal') {
        if (!idValue(e.ownerEntityId) || !Object.hasOwn(map.facilities, e.ownerEntityId) && !Object.hasOwn(map.zones, e.ownerEntityId)) warn('REFERENCE', path + '/ownerEntityId', '内部道路必须引用有效设施或区域 owner。');
      } else if ('ownerEntityId' in e) warn('VALUE', path + '/ownerEntityId', '公共主路不能同时声明内部 owner。');
    } else if (kind === 'junctions') {
      const e = record(value, ['rotationSpaceStatus', 'motionMode', 'turningPadBasis'], ['rotationSpaceStatus'], path);
      if (!e) return;
      choice(e, 'rotationSpaceStatus', ['not_continuously_swept', 'necessary_envelope_only_no_continuous_sweep'], path);
      if ('motionMode' in e) choice(e, 'motionMode', ['SPMT_translation_or_turn_design_assumption'], path);
      if ('turningPadBasis' in e) choice(e, 'turningPadBasis', ['design_reserved_square_necessary_envelope_only', 'empty_vehicle_parking_design_square'], path);
    } else if (kind === 'servicePoints') {
      const e = record(value, ['capability', 'handling'], ['capability', 'handling'], path);
      if (e) {
        if (map.servicePoints[id]?.kind !== 'other') warn('VALUE', path, 'The declared combined handling capability requires service kind other.');
        choice(e, 'capability', ['loading_and_unloading'], path);
        choice(e, 'handling', ['reserved_slot_transfer_in_service_time'], path);
      }
    } else if (kind === 'facilities' || kind === 'zones') {
      if (!object(value)) { warn('SHAPE', path, '设施或区域扩展必须是对象。'); return; }
      if ('slots' in value || 'storageResourceId' in value || value.role === 'parking') {
        if (kind === 'facilities' && value.role === 'parking') { warn('VALUE', path + '/role', '停车槽位只支持区域 owner。'); return; }
        readSlots(kind, id, value, path, value.role === 'parking'); return;
      }
      if (kind === 'zones' && value.role === 'dock_exclusion') {
        const e = record(value, ['role', 'overlayOf', 'waterSurface'], ['role', 'overlayOf'], path);
        if (e) {
          reference(e.overlayOf, map.facilities, path + '/overlayOf');
          if ('waterSurface' in e && typeof e.waterSurface !== 'boolean') warn('VALUE', path + '/waterSurface', '水面标记必须为布尔值。');
        }
      } else if (kind === 'zones' && value.role === 'process_separation') {
        const e = record(value, ['role', 'purpose'], ['role', 'purpose'], path);
        if (e) choice(e, 'purpose', ['physical_design_separation_not_a_traffic_experiment'], path);
      } else if (kind === 'facilities' && 'vehicleAccess' in value) {
        const e = record(value, ['role', 'handoff', 'vehicleAccess'], ['role', 'handoff', 'vehicleAccess'], path);
        if (e) {
          choice(e, 'role', ['dry_berth', 'dry_dock'], path);
          choice(e, 'vehicleAccess', ['forbidden'], path);
          choice(e, 'handoff', ['via_final_erection_or_buffer_service_and_external_lift'], path);
        }
      } else {
        const e = record(value, ['role', 'dimensionBasis', 'SPMT'], ['role', 'dimensionBasis', 'SPMT'], path);
        if (e) {
          choice(e, 'role', kind === 'zones' ? ['harbor_basin'] : ['aux_support', 'aux_warehouse', 'dry_berth', 'dry_dock', 'quay_apron'], path);
          choice(e, 'SPMT', ['excluded_from_cargo_service_network'], path); strings(e, ['dimensionBasis'], path);
        }
      }
    } else if (kind === 'resources') {
      const e = record(value, ['slotAreaM2', 'slotIds', 'unitMeaning'], ['slotAreaM2', 'slotIds', 'unitMeaning'], path);
      if (e) {
        choice(e, 'unitMeaning', ['cargo_storage_area'], path);
        if (!positive(e.slotAreaM2)) warn('VALUE', path + '/slotAreaM2', '单槽位面积必须是正的有限平方米值。');
        if (!Array.isArray(e.slotIds) || e.slotIds.length === 0 || e.slotIds.length > MAX_PLANNING_SLOTS || e.slotIds.some(v => !idValue(v))) warn('SLOT_IDS', path + '/slotIds', '资源必须声明有界非空槽位 ID 数组。');
        else resources.set(id, { payload: e, path });
      }
    } else warn('UNSUPPORTED_LOCATION', path, '此对象位置没有已实现的 sr02.planning 静态契约。');
  }
  function visit(kind: string, id: string, extensions: Extensions | undefined, path: string): void {
    if (!extensions || !Object.hasOwn(extensions, PLANNING_NAMESPACE)) return;
    present = true;
    if (knownDeclaration) inspectPayload(kind, id, extensions[PLANNING_NAMESPACE], extPath(path));
  }
  visit('root', '', map.extensions, '');
  visit('metadata', '', map.metadata.extensions, '/metadata');
  for (const kind of COLLECTIONS) for (const [id, entity] of Object.entries(map[kind])) visit(kind, id, entity.extensions, '/' + kind + '/' + pointer(id));
  if (present) {
    if (!knownDeclaration) warn('UNSUPPORTED_DECLARATION', '/extensionNamespaces/' + PLANNING_NAMESPACE, '只支持显式声明的 sr02.planning behavior 版本 1.0。');
  }
  // Validate both directions; one existing reference must not hide omitted or shared slots.
  for (const owner of owners.values()) {
    const storageId = owner.payload.storageResourceId;
    if (owner.payload.role !== 'parking' && (typeof storageId !== 'string' || !resources.has(storageId) || map.resources[storageId]?.appliesTo.length !== 1 || map.resources[storageId]?.appliesTo[0]?.entityId !== owner.id || map.resources[storageId]?.appliesTo[0]?.entityType !== owner.kind)) warn('STORAGE_RESOURCE', owner.path + '/storageResourceId', '储位 owner 必须指向具有完整槽位契约的资源。');
  }
  for (const [id, point] of Object.entries(map.servicePoints)) {
    if (point.kind === 'parking' && point.zoneId && owners.get(point.zoneId)?.payload.role === 'parking' && !parkingServices.has(id))
      warn('PARKING_SLOT_MISSING', '/servicePoints/' + pointer(id), 'The parking service point has no declared bay in its owner.');
  }
  for (const [id, { payload, path }] of resources) {
    const ids = payload.slotIds as string[]; const resource = map.resources[id]!;
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) warn('DUPLICATE_SLOT', path + '/slotIds', '资源槽位列表不能重复。');
    const referenced = ids.map((slotId, index) => {
      const slot = slotById.get(slotId);
      if (!slot || slot.parking) warn('REFERENCE', path + '/slotIds/' + index, '储位资源引用了不存在或非储货槽位。');
      return slot;
    });
    const first = referenced.find(slot => slot !== undefined);
    const owner = first ? owners.get(first.ownerId) : undefined;
    if (!owner || owner.payload.storageResourceId !== id || referenced.some(slot => !slot || slot.ownerId !== owner.id || slot.ownerKind !== owner.kind))
      warn('RESOURCE_OWNER', path + '/slotIds', '资源与唯一储位 owner 的双向引用不一致。');
    if (owner) {
      const expected = Array.isArray(owner.payload.slots) ? owner.payload.slots.flatMap(slot => object(slot) && idValue(slot.id) ? [slot.id] : []) : [];
      if (expected.length !== ids.length || expected.some(slotId => !uniqueIds.has(slotId))) warn('RESOURCE_SLOTS', path + '/slotIds', '资源槽位必须完整覆盖 owner 声明的槽位。');
      if (resource.appliesTo.length !== 1 || resource.appliesTo[0]?.entityId !== owner.id || resource.appliesTo[0]?.entityType !== owner.kind) warn('RESOURCE_OWNER', '/resources/' + pointer(id) + '/appliesTo', '储位资源必须只归属于声明槽位的 owner。');
      const area = Number(owner.payload.slotLengthM) * Number(owner.payload.slotWidthM);
      if (!close(Number(payload.slotAreaM2), area)) warn('SLOT_AREA', path + '/slotAreaM2', '资源单槽面积与 owner 长宽不一致。');
    }
    if (resource.capacityUnit !== 'area_m2') warn('CAPACITY', '/resources/' + pointer(id) + '/capacityUnit', '货物储位容量单位必须为 area_m2。');
    if (resource.capacity.state !== 'known' || !close(resource.capacity.value, ids.length * Number(payload.slotAreaM2))) warn('CAPACITY', '/resources/' + pointer(id) + '/capacity', '储位容量必须等于槽位数量乘单槽面积。');
  }
  return { present, supported, issues, slots };
}
