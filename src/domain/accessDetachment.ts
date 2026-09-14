import type { Issue, Source, Vec3, YardMap } from './model';
import { sourceId } from './geometrySources';
import type { MapCommand, SplitMapping } from './commands';
import { inspectPlanning, PLANNING_NAMESPACE } from './planning';
import { nodeOwners, roadOwner } from './ownerEditing';
import { TopologyError } from './topologyEditing';
import { roadGeometryAnchors, hasNonlinearGeometry } from '../geometry/roadPath';
import { polylineLength2D, projectPolyline, roadPoints } from '../geometry/roads';

/** Distances run from the access's existing public node toward the private end, not road.fromNodeId. */
export interface DetachAccessPointCommand {
  type: 'detachAccessPoint';
  id: string;
  distanceM: number;
  nodeId: string;
  connectorRoadId: string;
  internalRoadId: string;
}
export interface AccessDetachmentInfo {
  supported: true;
  roadId: string;
  publicNodeId: string;
  privateEndNodeId: string;
  lengthM: number;
  suggestedDistanceM: number;
  suggestionNote: string;
  position: Vec3;
  servicePointIds: string[];
}
type Split = (map: YardMap, command: Extract<MapCommand, { type: 'splitRoad' }>) => SplitMapping;
function fail(code: string, message: string, path: string): never { throw new TopologyError(code, message, path); }

function candidate(map: YardMap, id: string): AccessDetachmentInfo {
  const access = map.accessPoints[id], path = '/accessPoints/' + id;
  if (!access || !map.facilities[access.facilityId]) fail('ACCESS_DETACH_MISSING', '请选择现有设施入口。', path);
  if (map.schemaVersion === '0.1.0') fail('ACCESS_DETACH_SCHEMA', '请先显式升级地图到 0.2.0，保留原件。', '/schemaVersion');
  const planning = inspectPlanning(map);
  if (!planning.supported) fail('ACCESS_DETACH_PLANNING', '现有静态内容语义未受支持，不能猜测入口连接拆分规则。', path);
  const publicNodeId = access.nodeId, ownerId = access.facilityId;
  const roads = Object.entries(map.roads).filter(([, road]) => road.fromNodeId === publicNodeId || road.toNodeId === publicNodeId);
  const internal = roads.filter(([roadId]) => roadOwner(map, roadId) === ownerId);
  const external = roads.filter(([roadId]) => !roadOwner(map, roadId));
  const refs = nodeOwners(map, publicNodeId);
  if (refs.unownedPoint || refs.owners.size !== 1 || !refs.owners.has(ownerId)
    || Object.entries(map.accessPoints).some(([otherId, point]) => otherId !== id && point.nodeId === publicNodeId)) {
    fail('ACCESS_DETACH_SHARED_OWNER', '公共锚点还被其他入口或归属使用，需要明确独立的重接方案。', path + '/nodeId');
  }
  if (internal.length !== 1 || external.length < 2 || internal.length + external.length !== roads.length) {
    fail('ACCESS_DETACH_CONNECTIONS', '只支持一个明确归属的内部支路接到公共路网的入口；已独立或多分支入口保持原保护。', path + '/nodeId');
  }
  const [roadId, road] = internal[0]!;
  const privateEndNodeId = road.fromNodeId === publicNodeId ? road.toNodeId : road.fromNodeId;
  if (roadGeometryAnchors(road).length || hasNonlinearGeometry(road) || road.corridorPolygon || road.observedLengthM || roadPoints(map, roadId).some(point => point[2] !== map.nodes[publicNodeId]!.position[2])) {
    fail('ACCESS_DETACH_GEOMETRY', '内部支路含折点、高差、人工道路带或登记长度，尚无安全拆分规则。', '/roads/' + roadId);
  }
  if (road.direction === 'unknown') fail('ACCESS_DETACH_DIRECTION', '内部支路方向未声明，不能生成连续通过的转向。', '/roads/' + roadId + '/direction');
  if (road.resourceIds.length || Object.values(map.resources).some(resource => resource.appliesTo.some(ref => ref.entityType === 'roads' && ref.entityId === roadId))) {
    fail('ACCESS_DETACH_RESOURCE', '内部支路关联资源，拆分会改变资源作用范围；本批不拆分或重复预约资源。', '/roads/' + roadId + '/resourceIds');
  }
  for (const [junctionId, junction] of Object.entries(map.junctions)) if (junction.nodeIds.some(node => node === publicNodeId || node === privateEndNodeId) && junction.nodeIds.length !== 1) {
    fail('ACCESS_DETACH_JUNCTION', '端点属于多节点路口，不能猜测端口转接。', '/junctions/' + junctionId);
  }
  for (const [movementId, movement] of Object.entries(map.movements)) if ((movement.incomingArc.roadId === roadId || movement.outgoingArc.roadId === roadId) && movement.internalPath !== undefined) {
    fail('ACCESS_DETACH_MOVEMENT_GEOMETRY', '相关转向含独立几何，不能只重映射道路 ID。', '/movements/' + movementId + '/internalPath');
  }
  const servicePointIds: string[] = [];
  const outgoing = road.fromNodeId === publicNodeId ? 'forward' : 'backward';
  for (const [serviceId, service] of Object.entries(map.servicePoints)) {
    const arrival = service.arrival;
    const usesRoad = arrival?.mode === 'explicit_internal' && arrival.internalPath.some(arc => arc.roadId === roadId);
    if (service.nodeId === publicNodeId) fail('ACCESS_DETACH_SHARED_SERVICE', '公共入口节点也是作业点，需明确区分真实作业位置与代理服务语义。', '/servicePoints/' + serviceId + '/nodeId');
    if (service.accessPointId !== id) {
      if (usesRoad || arrival?.mode === 'explicit_internal' && arrival.entryNodeId === publicNodeId) fail('ACCESS_DETACH_EXTERNAL_SERVICE', '其他服务也使用这段内部支路或公共入口起点，不能隐式改写其接入。', '/servicePoints/' + serviceId + '/arrival');
      continue;
    }
    if (service.facilityId !== ownerId || service.zoneId || arrival?.mode !== 'explicit_internal'
      || arrival.entryNodeId && arrival.entryNodeId !== publicNodeId || !arrival.internalPath.length
      || arrival.internalPath[0]!.roadId !== roadId || arrival.internalPath[0]!.direction !== outgoing
      || arrival.internalPath.filter(arc => arc.roadId === roadId).length !== 1
      || arrival.internalPath.some(arc => roadOwner(map, arc.roadId) !== ownerId)) {
      fail('ACCESS_DETACH_ARRIVAL', '作业点需要从该公共入口出发、方向一致且归属明确的内部到达路径。', '/servicePoints/' + serviceId + '/arrival');
    }
    if (Object.entries(map.servicePoints).some(([otherId, point]) => otherId !== serviceId && point.nodeId === service.nodeId)) fail('ACCESS_DETACH_SHARED_SERVICE', '作业节点被多个服务共用，本批不隐式改写共享接入。', '/servicePoints/' + serviceId + '/nodeId');
    servicePointIds.push(serviceId);
  }
  if (!servicePointIds.length) fail('ACCESS_DETACH_ARRIVAL', '没有可核对的已声明内部服务到达路径，不能仅根据空间位置新造归属。', path);
  const lengthM = polylineLength2D(roadPoints(map, roadId));
  if (!Number.isFinite(lengthM) || lengthM <= 2e-6) fail('ACCESS_DETACH_LENGTH', '支路过短，无法保留两个非零路段。', '/roads/' + roadId);
  const a = map.nodes[publicNodeId]!.position, b = map.nodes[privateEndNodeId]!.position;
  const knownBands = external.flatMap(([id, road]) => road.widthM.state === 'known' ? [{ points: roadPoints(map, id), halfWidth: road.widthM.value / 2 }] : []);
  const pointAt = (fraction: number) => a.map((value, axis) => value + (b[axis]! - value) * fraction) as Vec3;
  const fraction = knownBands.length ? [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].find(value => knownBands.every(band => (projectPolyline(pointAt(value), band.points)?.offsetM ?? 0) > band.halfWidth + 1e-6)) : undefined;
  const suggestionNote = fraction === undefined ? '未找到已确认在公共道路带外的建议点；距离可调整，声明宽度或支路余量不足，需人工对照。'
    : knownBands.length < external.length ? '建议点避开已知公共道路带；部分宽度未知，仍需人工对照。' : '建议点位于相关公共道路声明带外；这不是净空、入口现场位置或运输可行性证明。';
  return { supported: true, roadId, publicNodeId, privateEndNodeId, lengthM, suggestedDistanceM: lengthM * (fraction ?? 0.5), suggestionNote,
    position: pointAt(fraction ?? 0.5), servicePointIds };
}

/** Structural suggestion only. Existing command validation still decides the actual split and spatial relations. */
export function inspectAccessDetachment(map: YardMap, id: string): AccessDetachmentInfo | { supported: false; issues: Issue[] } {
  try { return candidate(map, id); }
  catch (error) {
    if (!(error instanceof TopologyError)) throw error;
    return { supported: false, issues: [{ code: error.code, severity: 'error', jsonPath: error.path, entityType: 'accessPoints', entityId: id,
      message: error.message, suggestedAction: '保留公共路网与全部声明，按定位提示处理依赖；不要删除资源或扩展来绕过。' }] };
  }
}

/** Mutate only the command layer's disposable candidate; TE01 owns geometry subdivision and reference remapping. */
export function runAccessDetachment(map: YardMap, command: DetachAccessPointCommand, split: Split): { geometryPreservedRoadIds: string[] } {
  const info = candidate(map, command.id), access = map.accessPoints[command.id]!, road = map.roads[info.roadId]!;
  const forward = road.fromNodeId === info.publicNodeId;
  const originalEvidence = { roadId: info.roadId, extensions: road.extensions, provenance: road.provenance, accessNodeId: access.nodeId, accessPosition: map.nodes[access.nodeId]!.position };
  const source: Source = { name: '入口独立及接入支路角色声明', category: 'design_assumption',
    description: '沿原内部支路细分，公共锚点与原通行许可保持；新公共接入支路采用既有 main（无 owner）类别，私有剩余段保留原 owner。main 不代表主干道路、净空或运输可行性。原 metadata 分类仅作为来源证据保留；道路 ID 沿革见 org.shipyard.editor.lineage。原声明及新段角色：' + JSON.stringify({ originalEvidence, connectorRoadId: command.connectorRoadId, internalRoadId: command.internalRoadId, ownerEntityId: access.facilityId, distanceFromPublicM: command.distanceM }) };
  const evidenceSourceId = sourceId(map, 'source_editor_access_detachment', source);
  if (!Number.isFinite(command.distanceM) || command.distanceM <= 1e-6 || command.distanceM >= info.lengthM - 1e-6) fail('INVALID_SPLIT_POSITION', '入口距离必须严格位于原内部支路两端之间。', '/accessPoints/' + command.id);
  const newRoadIds: [string, string] = forward ? [command.connectorRoadId, command.internalRoadId] : [command.internalRoadId, command.connectorRoadId];
  split(map, { type: 'splitRoad', id: info.roadId, distanceM: forward ? command.distanceM : info.lengthM - command.distanceM, nodeId: command.nodeId, newRoadIds });
  // A new external connector and a retained private suffix are explicit roles, not removal of the owner's original road.
  const connector = map.roads[command.connectorRoadId]!;
  const fields = connector.extensions?.[PLANNING_NAMESPACE] as Record<string, unknown>;
  delete fields.ownerEntityId;
  fields.role = 'main'; // Existing planning contract: unowned access roads use main; this does not assert a trunk-road width or capacity.
  map.sources[evidenceSourceId] = source;
  connector.provenance.sourceRefs = [...new Set([...(connector.provenance.sourceRefs ?? []), evidenceSourceId])];
  connector.provenance.fieldSources = { ...connector.provenance.fieldSources, ['extensions/' + PLANNING_NAMESPACE]: evidenceSourceId };
  access.nodeId = command.nodeId;
  for (const id of info.servicePointIds) {
    const arrival = map.servicePoints[id]!.arrival!;
    if (arrival.mode !== 'explicit_internal' || arrival.internalPath[0]?.roadId !== command.connectorRoadId) fail('ACCESS_DETACH_PREFIX', '拆分后内部路径前缀不一致，整个事务未提交。', '/servicePoints/' + id + '/arrival');
    arrival.internalPath.shift();
    if (arrival.entryNodeId === info.publicNodeId) arrival.entryNodeId = command.nodeId;
  }
  // Only the private suffix retains the original owner's traversal semantics. The new public connector must pass building checks.
  return { geometryPreservedRoadIds: [command.internalRoadId] };
}

