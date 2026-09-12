import type { ArcRef, MapRoad, Vec3, YardMap } from './model';
import type { CommandAffectedRef, MapCommand, SplitMapping } from './commands';
import { sameValue } from './value';
import { roadPoints, polylineLength2D } from '../geometry/roads';
import { inspectPlanning, PLANNING_NAMESPACE } from './planning';
export interface ApprovedMovement {
    id: string;
    incomingArc: ArcRef;
    outgoingArc: ArcRef;
}
export type TopologyCommand = {
    type: 'mergeNodes';
    sourceNodeId: string;
    targetNodeId: string;
    approvedMovements?: ApprovedMovement[];
} | {
    type: 'connectNodeToRoad';
    nodeId: string;
    roadId: string;
    distanceM: number;
    newRoadIds: [
        string,
        string
    ];
    junctionId: string;
    approvedMovements: ApprovedMovement[];
} | {
    type: 'suppressDegree2Node';
    nodeId: string;
    retainedRoadId: string;
};
export class TopologyError extends Error {
    constructor(readonly code: string, message: string, readonly path = '') { super(message); }
}
const fail = (code: string, message: string, path = ''): never => { throw new TopologyError(code, message, path); };
const collections = ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources'] as const;
const has = (collection: object, id: string) => Object.hasOwn(collection, id);
function node(map: YardMap, id: string) { if (!has(map.nodes, id))
    fail('TOPOLOGY_NODE_MISSING', '节点不存在：' + id, '/nodes/' + id); return map.nodes[id]!; }
function road(map: YardMap, id: string) { if (!has(map.roads, id))
    fail('TOPOLOGY_ROAD_MISSING', '道路不存在：' + id, '/roads/' + id); return map.roads[id]!; }
function freeId(map: YardMap, id: string) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(id) || [...collections, 'assets', 'backgroundLayers'].some(kind => has(map[kind as typeof collections[number]], id)) || inspectPlanning(map).slots.some(slot => slot.id === id))
        fail('DUPLICATE_ENTITY_ID', '新 ID 非法或已被使用：' + id);
}
const fields = (entity: {
    extensions?: Record<string, unknown>;
}) => (entity.extensions?.[PLANNING_NAMESPACE] ?? {}) as Record<string, unknown>;
const arcEqual = (a: ArcRef, b: ArcRef) => a.roadId === b.roadId && a.direction === b.direction;
const incident = (map: YardMap, id: string) => Object.keys(map.roads).filter(key => map.roads[key]!.fromNodeId === id || map.roads[key]!.toNodeId === id);
const endpoint = (r: MapRoad, arc: ArcRef, incoming: boolean) => (arc.direction === 'forward') === incoming ? r.toNodeId : r.fromNodeId;
function independentGeometry(map: YardMap, ids: string[]) {
    for (const id of ids) {
        const r = road(map, id);
        if (r.corridorPolygon || r.observedLengthM)
            fail('TOPOLOGY_INDEPENDENT_GEOMETRY', '道路含独立通行带或登记长度，不能猜测拆分/重连规则。', '/roads/' + id);
        const points = roadPoints(map, id);
        if (points.some(p => p[2] !== points[0]![2]))
            fail('LOCAL_NONPLANAR_EDIT', '此拓扑编辑仅支持同一 XY 水平面。', '/roads/' + id);
    }
}
/** Actual changed/deleted/created entities, before dependency closure; no geometry inference. */
export function topologyChangedRefs(before: YardMap, after: YardMap): CommandAffectedRef[] {
    const refs: CommandAffectedRef[] = [];
    for (const kind of collections)
        for (const id of new Set([...Object.keys(before[kind]), ...Object.keys(after[kind])]))
            if (!sameValue(before[kind][id], after[kind][id]))
                refs.push({ kind, id });
    if (!sameValue(before.extensions, after.extensions) || !sameValue(before.extensionNamespaces, after.extensionNamespaces))
        refs.push({ kind: 'extensions', id: 'org.shipyard.editor.lineage' });
    return refs;
}
/** Split references retain direction and original endpoint meaning. */
export function remapSplitReferences(map: YardMap, oldId: string, newIds: [
    string,
    string
]): void {
    for (const movement of Object.values(map.movements))
        for (const field of ['incomingArc', 'outgoingArc'] as const) {
            const arc = movement[field];
            if (arc.roadId !== oldId)
                continue;
            arc.roadId = newIds[(field === 'incomingArc') === (arc.direction === 'forward') ? 1 : 0];
        }
    for (const point of Object.values(map.servicePoints))
        if (point.arrival?.mode === 'explicit_internal')
            point.arrival.internalPath = point.arrival.internalPath.flatMap(arc => arc.roadId !== oldId ? [arc] : (arc.direction === 'forward' ? newIds : [...newIds].reverse()).map(roadId => ({ roadId, direction: arc.direction })));
    for (const resource of Object.values(map.resources))
        resource.appliesTo = resource.appliesTo.flatMap(ref => ref.entityType !== 'roads' || ref.entityId !== oldId ? [ref] : newIds.map(entityId => ({ ...ref, entityId })));
}
export function checkSplitGeometry(map: YardMap, id: string): void { independentGeometry(map, [id]); }
export function splitPosition(map: YardMap, id: string, distanceM: number): Vec3 {
    const points = roadPoints(map, id), length = polylineLength2D(points);
    if (!Number.isFinite(distanceM) || distanceM <= 1e-6 || distanceM >= length - 1e-6)
        fail('INVALID_SPLIT_POSITION', '切分点必须严格位于道路内部。');
    let accumulated = 0;
    for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i]!, b = points[i + 1]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (length > 0 && accumulated + length >= distanceM) {
            const t = (distanceM - accumulated) / length;
            return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
        }
        accumulated += length;
    }
    return fail('INVALID_SPLIT_POSITION', '无法定位切分点。');
}
export function deleteNetwork(map: YardMap, command: Extract<MapCommand, {
    type: 'deleteSelection';
}>): void {
    const nodes = new Set(command.selection.nodes), roads = new Set(command.selection.roads), cascade = command.topologyPolicy === 'cascade';
    if (command.topologyPolicy !== undefined && !['reject', 'cascade'].includes(command.topologyPolicy))
        fail('INVALID_TOPOLOGY_POLICY', '未知拓扑删除策略。');
    for (const id of nodes)
        node(map, id);
    for (const id of roads)
        road(map, id);
    for (const id of nodes)
        for (const linked of incident(map, id))
            if (!roads.has(linked)) {
                if (!cascade)
                    fail('TOPOLOGY_DELETE_DEPENDENCIES', '删除节点会影响关联道路；请先预览并明确级联。', '/roads/' + linked);
                roads.add(linked);
            }
    for (const kind of ['accessPoints', 'servicePoints'] as const)
        for (const [id, point] of Object.entries(map[kind]))
            if (nodes.has(point.nodeId))
                fail('TOPOLOGY_POINT_DEPENDENCY', '节点由入口或服务点使用；不会删除服务对象来完成拓扑编辑。', '/' + kind + '/' + id + '/nodeId');
    for (const [id, point] of Object.entries(map.servicePoints))
        if (point.arrival?.mode === 'explicit_internal') {
            if (point.arrival.entryNodeId && nodes.has(point.arrival.entryNodeId))
                fail('TOPOLOGY_SERVICE_PATH_DEPENDENCY', '服务内部入口仍引用该节点；不会删除服务对象来完成拓扑编辑。', '/servicePoints/' + id + '/arrival/entryNodeId');
            if (point.arrival.internalPath.some(arc => roads.has(arc.roadId)))
                fail('TOPOLOGY_SERVICE_PATH_DEPENDENCY', '服务内部路径使用待删除道路；须先明确修改到达声明。', '/servicePoints/' + id + '/arrival/internalPath');
        }
    const movements = new Set<string>();
    for (const [id, movement] of Object.entries(map.movements))
        if (roads.has(movement.incomingArc.roadId) || roads.has(movement.outgoingArc.roadId)) {
            if (!cascade)
                fail('TOPOLOGY_DELETE_DEPENDENCIES', '道路仍被转向声明引用；请预览并明确删除这些转向。', '/movements/' + id);
            movements.add(id);
        }
    const junctions = new Set<string>();
    for (const [id, junction] of Object.entries(map.junctions))
        if (junction.nodeIds.some(n => nodes.has(n))) {
            if (!cascade)
                fail('TOPOLOGY_DELETE_DEPENDENCIES', '节点仍属于路口；须明确级联处理纯引用。', '/junctions/' + id);
            if (junction.nodeIds.length !== 1)
                fail('TOPOLOGY_JUNCTION_CONFLICT', '多节点分组路口没有局部删点维护规则。', '/junctions/' + id);
            if (junction.boundary)
                fail('TOPOLOGY_JUNCTION_GEOMETRY', '路口有独立边界，不能推测删点后含义。', '/junctions/' + id);
            if (Object.entries(map.movements).some(([mid, movement]) => movement.junctionId === id && !movements.has(mid)))
                fail('TOPOLOGY_JUNCTION_DEPENDENCY', '路口仍有未删除的转向。', '/junctions/' + id);
            junctions.add(id);
        }
    const removed = new Set([...nodes].map(id => 'nodes/' + id).concat([...roads].map(id => 'roads/' + id), [...movements].map(id => 'movements/' + id), [...junctions].map(id => 'junctions/' + id)));
    for (const [id, resource] of Object.entries(map.resources))
        if (resource.appliesTo.some(ref => removed.has(ref.entityType + '/' + ref.entityId))) {
            if (!cascade)
                fail('TOPOLOGY_DELETE_DEPENDENCIES', '资源引用待删除对象；须明确清理引用，资源实体与容量保持。', '/resources/' + id);
            resource.appliesTo = resource.appliesTo.filter(ref => !removed.has(ref.entityType + '/' + ref.entityId));
        }
    rejectOpaqueTopologyReferences(map, [...nodes, ...roads, ...movements, ...junctions]);
    for (const id of movements)
        delete map.movements[id];
    for (const id of roads)
        delete map.roads[id];
    for (const id of nodes)
        delete map.nodes[id];
    for (const id of junctions)
        delete map.junctions[id];
}
function checkMovedNode(map: YardMap, id: string, position: Vec3): void {
    const old = node(map, id).position;
    if (sameValue(old, position))
        return;
    if (old[2] !== position[2])
        fail('LOCAL_NONPLANAR_EDIT', '拓扑重连不得改变 Z。', '/nodes/' + id);
    const roads = incident(map, id);
    independentGeometry(map, roads);
    for (const rid of roads)
        if (fields(map.roads[rid]!).ownerEntityId)
            fail('TOPOLOGY_OWNER_CONNECTION', '内部道路归属几何不能通过单独重连节点搬移。', '/roads/' + rid);
    for (const [jid, junction] of Object.entries(map.junctions))
        if (junction.nodeIds.includes(id) && junction.boundary)
            fail('TOPOLOGY_JUNCTION_GEOMETRY', '节点移动会留下路口独立边界。', '/junctions/' + jid);
    for (const [mid, movement] of Object.entries(map.movements))
        if (movement.internalPath && (roads.includes(movement.incomingArc.roadId) || roads.includes(movement.outgoingArc.roadId)))
            fail('TOPOLOGY_MOVEMENT_GEOMETRY', '节点移动影响独立转向几何。', '/movements/' + mid);
}
export function mergeNodes(map: YardMap, sourceId: string, targetId: string, approvedMovements: ApprovedMovement[] = []): void {
    const source = node(map, sourceId), target = node(map, targetId);
    if (sourceId === targetId)
        return;
    checkMovedNode(map, sourceId, target.position);
    const affected = incident(map, sourceId);
    independentGeometry(map, affected);
    const sourceJunctions = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(sourceId));
    const targetJunctions = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(targetId));
    if (sourceJunctions.length > 1 || targetJunctions.length > 1 || [...sourceJunctions, ...targetJunctions].some(([, j]) => j.boundary || j.nodeIds.length !== 1))
        fail('TOPOLOGY_JUNCTION_CONFLICT', '只支持单节点、无独立边界的路口合并。');
    const sourceJ = sourceJunctions[0], targetJ = targetJunctions[0];
    if (sourceJ && targetJ && sourceJ[0] !== targetJ[0] && (sourceJ[1].model !== targetJ[1].model || !sameValue(sourceJ[1].extensions, targetJ[1].extensions)))
        fail('TOPOLOGY_JUNCTION_CONFLICT', '两个路口的模型或扩展不兼容。');
    if (sourceJ && Object.values(map.movements).some(m => m.junctionId === sourceJ[0] && m.internalPath))
        fail('TOPOLOGY_MOVEMENT_GEOMETRY', '合并不能重写路口独立转向几何。');
    const permitted = enumerateMergeTurns(map, { sourceNodeId: sourceId, targetNodeId: targetId });
    if (approvedMovements.some(v => !permitted.some(p => arcEqual(p.incomingArc, v.incomingArc) && arcEqual(p.outgoingArc, v.outgoingArc))))
        fail('TOPOLOGY_TURN_NOT_PROPOSED', '仅可批准明确列出的新增跨支路接续；不重复或覆盖原转向。');
    for (const id of affected) {
        const r = map.roads[id]!;
        const from = r.fromNodeId === sourceId ? targetId : r.fromNodeId, to = r.toNodeId === sourceId ? targetId : r.toNodeId;
        if (from === to)
            fail('TOPOLOGY_SELF_LOOP', '合并会把道路压成自环；请使用连续路段化简或显式删除。', '/roads/' + id);
        if (Object.entries(map.roads).some(([other, value]) => other !== id && !affected.includes(other) && (value.fromNodeId === from && value.toNodeId === to || value.fromNodeId === to && value.toNodeId === from)))
            fail('TOPOLOGY_DUPLICATE_EDGE', '合并会产生重复端点道路，不能猜测合并道路属性。', '/roads/' + id);
        r.fromNodeId = from;
        r.toNodeId = to;
    }
    const pairs = new Set<string>();
    for (const id of affected) {
        const r = map.roads[id]!, pair = [r.fromNodeId, r.toNodeId].sort().join('/');
        if (pairs.has(pair))
            fail('TOPOLOGY_DUPLICATE_EDGE', '合并产生重复道路。');
        pairs.add(pair);
    }
    for (const kind of ['accessPoints', 'servicePoints'] as const)
        for (const point of Object.values(map[kind]))
            if (point.nodeId === sourceId)
                point.nodeId = targetId;
    for (const point of Object.values(map.servicePoints))
        if (point.arrival?.mode === 'explicit_internal' && point.arrival.entryNodeId === sourceId)
            point.arrival.entryNodeId = targetId;
    for (const [, junction] of sourceJunctions)
        junction.nodeIds = [...new Set(junction.nodeIds.map(id => id === sourceId ? targetId : id))];
    for (const resource of Object.values(map.resources))
        resource.appliesTo = resource.appliesTo.map(ref => ref.entityType === 'nodes' && ref.entityId === sourceId ? { ...ref, entityId: targetId } : ref).filter((ref, i, all) => all.findIndex(value => sameValue(value, ref)) === i);
    // Source node semantic fields must not disappear through an undocumented value merge.
    if (source.kind !== target.kind || !sameValue(source.extensions, target.extensions))
        fail('TOPOLOGY_NODE_CONFLICT', '节点类型或扩展不兼容，不能隐式覆盖保留节点。');
    let junctionId = targetJ?.[0] ?? sourceJ?.[0];
    if (sourceJ && targetJ && sourceJ[0] !== targetJ[0]) {
        rejectOpaqueTopologyReferences(map, [sourceJ[0]]);
        targetJ[1].resourceIds = [...new Set([...targetJ[1].resourceIds, ...sourceJ[1].resourceIds])];
        for (const movement of Object.values(map.movements))
            if (movement.junctionId === sourceJ[0])
                movement.junctionId = targetJ[0];
        for (const resource of Object.values(map.resources))
            resource.appliesTo = resource.appliesTo.map(ref => ref.entityType === 'junctions' && ref.entityId === sourceJ[0] ? { ...ref, entityId: targetJ[0] } : ref).filter((ref, i, all) => all.findIndex(v => sameValue(v, ref)) === i);
        delete map.junctions[sourceJ[0]];
    }
    if (approvedMovements.length && !junctionId) {
        junctionId = allocate(map, 'junction_editor_merge');
        map.junctions[junctionId] = { name: '用户明确合并的节点接续', nodeIds: [targetId], model: 'explicit_movements', resourceIds: [], provenance: { category: 'design_assumption' } };
    }
    for (const value of approvedMovements) {
        freeId(map, value.id);
        map.movements[value.id] = { name: '用户明确批准的合并接续', junctionId: junctionId!, incomingArc: structuredClone(value.incomingArc), outgoingArc: structuredClone(value.outgoingArc), allowed: true, resourceIds: [...map.junctions[junctionId!]!.resourceIds], provenance: { category: 'design_assumption' } };
    }
    delete map.nodes[sourceId];
}
export function suppressDegree2Node(map: YardMap, nodeId: string, retainedId: string): void {
    node(map, nodeId);
    const ids = incident(map, nodeId);
    if (ids.length !== 2 || !ids.includes(retainedId))
        fail('TOPOLOGY_DEGREE_TWO_REQUIRED', '连续化简要求恰好两条关联道路，且保留 ID 属于其中一条。');
    const removedId = ids.find(id => id !== retainedId)!, first = road(map, retainedId), second = road(map, removedId);
    independentGeometry(map, ids);
    if (first.direction === 'unknown' || second.direction === 'unknown')
        fail('TOPOLOGY_DIRECTION_UNKNOWN', '连续化简前必须明确道路方向。');
    const firstForward = first.toNodeId === nodeId, secondForward = second.fromNodeId === nodeId;
    const oriented = (r: MapRoad, forward: boolean) => r.direction === 'both' ? 'both' : (r.direction === 'forward') === forward ? 'forward' : 'backward';
    const keys = ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps', 'resourceIds', 'extensions'] as const;
    if (oriented(first, firstForward) !== oriented(second, secondForward) || keys.some(key => !sameValue(first[key], second[key])))
        fail('TOPOLOGY_ROAD_CONFLICT', '两段道路的方向、物理值、资源或扩展不兼容，不能自动拼接。');
    for (const kind of ['accessPoints', 'servicePoints'] as const)
        for (const [id, p] of Object.entries(map[kind]))
            if (p.nodeId === nodeId)
                fail('TOPOLOGY_POINT_DEPENDENCY', '连续化简不能删除入口或服务目标节点。', '/' + kind + '/' + id);
    for (const [id, p] of Object.entries(map.servicePoints))
        if (p.arrival?.mode === 'explicit_internal' && p.arrival.entryNodeId === nodeId)
            fail('TOPOLOGY_SERVICE_PATH_DEPENDENCY', '连续化简不能删除服务内部入口。', '/servicePoints/' + id);
    const junctionIds = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(nodeId)).map(([id]) => id);
    for (const id of junctionIds) {
        const j = map.junctions[id]!;
        if (j.boundary || j.resourceIds.length || j.nodeIds.length !== 1 || Object.values(map.resources).some(r => r.appliesTo.some(ref => ref.entityType === 'junctions' && ref.entityId === id)))
            fail('TOPOLOGY_JUNCTION_RESOURCE', '连续化简不能消除独立路口边界、分组或资源。', '/junctions/' + id);
    }
    const internalMovements = Object.entries(map.movements).filter(([, m]) => junctionIds.includes(m.junctionId));
    for (const [id, m] of internalMovements)
        if (!m.allowed || m.internalPath || m.resourceIds.length || !ids.includes(m.incomingArc.roadId) || !ids.includes(m.outgoingArc.roadId) || m.incomingArc.roadId === m.outgoingArc.roadId)
            fail('TOPOLOGY_MOVEMENT_CONFLICT', '连续化简不能消除禁止、独立几何、掉头或资源转向规则。', '/movements/' + id);
    for (const forward of [true, false]) {
        const joined = oriented(first, firstForward);
        if (joined !== 'both' && joined !== (forward ? 'forward' : 'backward'))
            continue;
        const incomingArc: ArcRef = { roadId: forward ? retainedId : removedId, direction: (forward ? firstForward : !secondForward) ? 'forward' : 'backward' };
        const outgoingArc: ArcRef = { roadId: forward ? removedId : retainedId, direction: (forward ? secondForward : !firstForward) ? 'forward' : 'backward' };
        if (!internalMovements.some(([, m]) => m.allowed && arcEqual(m.incomingArc, incomingArc) && arcEqual(m.outgoingArc, outgoingArc) && map.junctions[m.junctionId]!.model === 'explicit_movements'))
            fail('TOPOLOGY_CONTINUATION_UNDECLARED', '化简前须有每个道路允许方向的显式无资源直行许可；缺失不能被解释为已允许。');
    }
    const pathA = firstForward ? roadPoints(map, retainedId) : roadPoints(map, retainedId).reverse(), pathB = secondForward ? roadPoints(map, removedId) : roadPoints(map, removedId).reverse();
    const from = firstForward ? first.fromNodeId : first.toNodeId, to = secondForward ? second.toNodeId : second.fromNodeId;
    if (from === to || Object.entries(map.roads).some(([id, r]) => !ids.includes(id) && (r.fromNodeId === from && r.toNodeId === to || r.fromNodeId === to && r.toNodeId === from)))
        fail('TOPOLOGY_DUPLICATE_EDGE', '连续化简会形成自环或重复道路。');
    const orientation = new Map([[retainedId, firstForward], [removedId, secondForward]]);
    const remap = (arc: ArcRef): ArcRef => ids.includes(arc.roadId) ? { roadId: retainedId, direction: (arc.direction === 'forward') === orientation.get(arc.roadId) ? 'forward' : 'backward' } : arc;
    for (const [id, point] of Object.entries(map.servicePoints))
        if (point.arrival?.mode === 'explicit_internal') {
            const path = point.arrival.internalPath, result: ArcRef[] = [];
            for (let i = 0; i < path.length; i++) {
                const arc = path[i]!;
                if (!ids.includes(arc.roadId)) {
                    result.push(arc);
                    continue;
                }
                const next = path[i + 1], translated = remap(arc);
                if (!next || next.roadId === arc.roadId || !ids.includes(next.roadId) || !arcEqual(translated, remap(next)))
                    fail('TOPOLOGY_SERVICE_PATH_DEPENDENCY', '服务内部路径没有连续穿过完整两段，不能缩写为整条新道路。', '/servicePoints/' + id + '/arrival/internalPath');
                result.push(translated);
                i++;
            }
            point.arrival.internalPath = result;
        }
    for (const [id, movement] of Object.entries(map.movements))
        if (!internalMovements.some(([mid]) => mid === id)) {
            movement.incomingArc = remap(movement.incomingArc);
            movement.outgoingArc = remap(movement.outgoingArc);
        }
    const removedKeys = new Set(['nodes/' + nodeId, ...junctionIds.map(id => 'junctions/' + id), ...internalMovements.map(([id]) => 'movements/' + id)]);
    for (const [id, resource] of Object.entries(map.resources)) {
        if (resource.appliesTo.some(ref => removedKeys.has(ref.entityType + '/' + ref.entityId)))
            fail('TOPOLOGY_RESOURCE_DEPENDENCY', '资源仍引用将被连续化简移除的节点或转向。', '/resources/' + id);
        resource.appliesTo = resource.appliesTo.map(ref => ref.entityType === 'roads' && ref.entityId === removedId ? { ...ref, entityId: retainedId } : ref).filter((ref, i, all) => all.findIndex(v => sameValue(v, ref)) === i);
    }
    first.fromNodeId = from;
    first.toNodeId = to;
    first.direction = oriented(first, firstForward);
    first.shapePoints = [...pathA, ...pathB.slice(1)].slice(1, -1);
    first.provenance.sourceRefs = [...new Set([...(first.provenance.sourceRefs ?? []), ...(second.provenance.sourceRefs ?? []), ...Object.values(second.provenance.fieldSources ?? {})])];
    rejectOpaqueTopologyReferences(map, [removedId, nodeId, ...junctionIds, ...internalMovements.map(([id]) => id)]);
    delete map.roads[removedId];
    delete map.nodes[nodeId];
    for (const id of junctionIds)
        delete map.junctions[id];
    for (const [id] of internalMovements)
        delete map.movements[id];
}
export function runTopology(map: YardMap, command: TopologyCommand, split: (map: YardMap, command: Extract<MapCommand, {
    type: 'splitRoad';
}>) => SplitMapping): SplitMapping | undefined {
    if (command.type === 'mergeNodes') {
        mergeNodes(map, command.sourceNodeId, command.targetNodeId, command.approvedMovements);
        return;
    }
    if (command.type === 'suppressDegree2Node') {
        suppressDegree2Node(map, command.nodeId, command.retainedRoadId);
        return;
    }
    const moving = node(map, command.nodeId), target = road(map, command.roadId);
    if (target.fromNodeId === command.nodeId || target.toNodeId === command.nodeId)
        fail('TOPOLOGY_ALREADY_CONNECTED', '该节点已经是目标道路端点。');
    if (fields(target).ownerEntityId)
        fail('TOPOLOGY_OWNER_CONNECTION', '不能在未明确内部归属规则时接入 owner 内部道路。');
    const permitted = enumerateConnectionTurns(map, command);
    if (!Array.isArray(command.approvedMovements) || command.approvedMovements.some(v => !permitted.some(p => arcEqual(p.incomingArc, v.incomingArc) && arcEqual(p.outgoingArc, v.outgoingArc))))
        fail('TOPOLOGY_TURN_NOT_PROPOSED', '仅可批准列表中的新增接续，不能覆盖既有转向或重复添加直行。');
    const position = splitPosition(map, command.roadId, command.distanceM);
    checkMovedNode(map, command.nodeId, position);
    const junctions = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(command.nodeId));
    if (junctions.some(([id, j]) => id !== command.junctionId || j.boundary || j.nodeIds.length !== 1))
        fail('TOPOLOGY_JUNCTION_CONFLICT', '接入必须保留现有单节点路口 ID，不能合并独立路口几何。');
    if (has(map.junctions, command.junctionId) && !junctions.length)
        fail('TOPOLOGY_JUNCTION_CONFLICT', '所选路口不属于待连接节点。');
    if (!has(map.junctions, command.junctionId))
        freeId(map, command.junctionId);
    moving.position = position;
    if (!has(map.junctions, command.junctionId))
        map.junctions[command.junctionId] = { name: '编辑器显式接入', nodeIds: [command.nodeId], model: 'explicit_movements', resourceIds: [], provenance: { category: 'design_assumption' } };
    const mapping = split(map, { type: 'splitRoad', id: command.roadId, distanceM: command.distanceM, nodeId: command.nodeId, existingNode: true, newRoadIds: command.newRoadIds });
    if (!Array.isArray(command.approvedMovements) || command.approvedMovements.length > 4096)
        fail('INVALID_TOPOLOGY_MOVEMENTS', '显式批准转向必须是有界列表。');
    for (const value of command.approvedMovements) {
        freeId(map, value.id);
        for (const [field, incoming] of [['incomingArc', true], ['outgoingArc', false]] as const) {
            const arc = value[field], r = road(map, arc.roadId);
            if (!['forward', 'backward'].includes(arc.direction) || r.direction === 'unknown' || r.direction !== 'both' && r.direction !== arc.direction || endpoint(r, arc, incoming) !== command.nodeId)
                fail('TOPOLOGY_TURN_DIRECTION', '批准转向必须在共享节点连续且方向明确允许。');
        }
        if (Object.values(map.movements).some(m => arcEqual(m.incomingArc, value.incomingArc) && arcEqual(m.outgoingArc, value.outgoingArc)))
            fail('TOPOLOGY_TURN_EXISTS', '该转向已有允许/禁止声明，不覆盖也不重复生成。');
        map.movements[value.id] = { name: '用户明确批准的拓扑接续', junctionId: command.junctionId, incomingArc: structuredClone(value.incomingArc), outgoingArc: structuredClone(value.outgoingArc), allowed: true, resourceIds: [...map.junctions[command.junctionId]!.resourceIds], provenance: { category: 'design_assumption' } };
    }
    return mapping;
}
function allocate(map: YardMap, base: string): string {
    let id = base, suffix = 0;
    while (collections.some(kind => has(map[kind], id)) || has(map.assets, id) || has(map.backgroundLayers, id) || inspectPlanning(map).slots.some(slot => slot.id === id))
        id = base + '_' + ++suffix;
    return id;
}
/** Exact identifier references in opaque metadata cannot be safely rewritten as topology. */
export function rejectOpaqueTopologyReferences(map: YardMap, removedIds: readonly string[]): void {
    const ids = new Set(removedIds);
    const pointer = (value: string) => value.replace(/~/g, '~0').replace(/\//g, '~1');
    const visit = (value: unknown, path: string): void => {
        if (typeof value === 'string' && ids.has(value))
            fail('TOPOLOGY_OPAQUE_REFERENCE', '元数据扩展明确引用将被替换/删除的 ID；没有已知重写规则。', path);
        if (value && typeof value === 'object')
            for (const [key, item] of Object.entries(value)) {
                if (ids.has(key))
                    fail('TOPOLOGY_OPAQUE_REFERENCE', '元数据扩展以待替换 ID 为键，没有已知重写规则。', path + '/' + pointer(key));
                visit(item, path + '/' + pointer(key));
            }
    };
    const extensions = (values: Record<string, unknown> | undefined, path: string) => { for (const [ns, payload] of Object.entries(values ?? {}))
        if (ns !== PLANNING_NAMESPACE && ns !== 'org.shipyard.editor.lineage')
            visit(payload, path + '/' + ns); };
    extensions(map.extensions, '/extensions');
    extensions(map.metadata.extensions, '/metadata/extensions');
    for (const kind of [...collections, 'assets', 'backgroundLayers'] as const)
        for (const [id, entity] of Object.entries(map[kind]))
            extensions(entity.extensions, '/' + kind + '/' + id + '/extensions');
}
/** Subdivision adds only equivalent straight traversal, not new branch turn permission. */
export function preserveSplitContinuation(map: YardMap, nodeId: string, ids: [
    string,
    string
]): void {
    const junctions = Object.entries(map.junctions).filter(([, j]) => j.nodeIds.includes(nodeId));
    if (junctions.length > 1 || junctions.some(([, j]) => j.boundary || j.nodeIds.length !== 1))
        fail('TOPOLOGY_JUNCTION_CONFLICT', '拆分节点不能混入多个路口或独立路口几何。');
    const id = junctions[0]?.[0] ?? allocate(map, 'junction_editor_split');
    if (!junctions.length)
        map.junctions[id] = { name: '道路细分接续', nodeIds: [nodeId], model: 'explicit_movements', resourceIds: [], provenance: { category: 'design_assumption' } };
    const direction = map.roads[ids[0]]!.direction;
    for (const forward of [true, false]) {
        const dir = forward ? 'forward' : 'backward';
        if (direction !== 'both' && direction !== dir)
            continue;
        const incomingArc: ArcRef = { roadId: ids[forward ? 0 : 1], direction: dir }, outgoingArc: ArcRef = { roadId: ids[forward ? 1 : 0], direction: dir };
        const prior = Object.values(map.movements).find(m => arcEqual(m.incomingArc, incomingArc) && arcEqual(m.outgoingArc, outgoingArc));
        if (prior) {
            if (!prior.allowed)
                fail('TOPOLOGY_TURN_EXISTS', '原禁止转向不能被道路细分覆盖。');
            continue;
        }
        map.movements[allocate(map, 'movement_editor_split')] = { name: '原道路细分直行', junctionId: id, incomingArc, outgoingArc, allowed: true, resourceIds: [...map.junctions[id]!.resourceIds], provenance: { category: 'design_assumption' } };
    }
}
export function enumerateConnectionTurns(map: YardMap, command: {
    nodeId: string;
    roadId: string;
    newRoadIds: [
        string,
        string
    ];
}): Omit<ApprovedMovement, 'id'>[] {
    const target = road(map, command.roadId), copies: Record<string, MapRoad> = {};
    for (const id of incident(map, command.nodeId))
        if (id !== command.roadId)
            copies[id] = map.roads[id]!;
    copies[command.newRoadIds[0]] = { ...target, toNodeId: command.nodeId };
    copies[command.newRoadIds[1]] = { ...target, fromNodeId: command.nodeId };
    const incoming: ArcRef[] = [], outgoing: ArcRef[] = [];
    for (const [roadId, r] of Object.entries(copies))
        for (const direction of ['forward', 'backward'] as const)
            if (r.direction === 'both' || r.direction === direction) {
                const arc = { roadId, direction };
                if (endpoint(r, arc, true) === command.nodeId)
                    incoming.push(arc);
                if (endpoint(r, arc, false) === command.nodeId)
                    outgoing.push(arc);
            }
    return incoming.flatMap(incomingArc => outgoing.filter(outgoingArc => incomingArc.roadId !== outgoingArc.roadId && !(command.newRoadIds.includes(incomingArc.roadId) && command.newRoadIds.includes(outgoingArc.roadId)) && !Object.values(map.movements).some(m => arcEqual(m.incomingArc, incomingArc) && arcEqual(m.outgoingArc, outgoingArc))).map(outgoingArc => ({ incomingArc, outgoingArc })));
}
export function enumerateMergeTurns(map: YardMap, command: {
    sourceNodeId: string;
    targetNodeId: string;
}): Omit<ApprovedMovement, 'id'>[] {
    node(map, command.sourceNodeId);
    node(map, command.targetNodeId);
    if (command.sourceNodeId === command.targetNodeId)
        return [];
    const source = new Set(incident(map, command.sourceNodeId)), target = new Set(incident(map, command.targetNodeId));
    const incoming: ArcRef[] = [], outgoing: ArcRef[] = [];
    for (const id of new Set([...source, ...target])) {
        const r = map.roads[id]!, at = source.has(id) ? command.sourceNodeId : command.targetNodeId;
        for (const direction of ['forward', 'backward'] as const)
            if (r.direction === 'both' || r.direction === direction) {
                const arc = { roadId: id, direction };
                if (endpoint(r, arc, true) === at)
                    incoming.push(arc);
                if (endpoint(r, arc, false) === at)
                    outgoing.push(arc);
            }
    }
    return incoming.flatMap(incomingArc => outgoing.filter(outgoingArc => incomingArc.roadId !== outgoingArc.roadId && source.has(incomingArc.roadId) !== source.has(outgoingArc.roadId) && !Object.values(map.movements).some(m => arcEqual(m.incomingArc, incomingArc) && arcEqual(m.outgoingArc, outgoingArc))).map(outgoingArc => ({ incomingArc, outgoingArc })));
}
/** Structural equivalence, not a trusted name/source/lineage marker, keeps basic-map edits compatible after subdivision. */
export function onlySubdivisionJunctions(map: YardMap): boolean {
    if (Object.hasOwn(map.extensionNamespaces, PLANNING_NAMESPACE) || Object.keys(map.resources).length)
        return false;
    for (const [id, j] of Object.entries(map.junctions)) {
        if (j.nodeIds.length !== 1 || j.boundary || j.resourceIds.length || Object.keys(j.extensions ?? {}).length || j.model !== 'explicit_movements')
            return false;
        const roads = incident(map, j.nodeIds[0]!);
        if (roads.length !== 2)
            return false;
        const turns = Object.values(map.movements).filter(m => m.junctionId === id);
        const incoming: ArcRef[] = [], outgoing: ArcRef[] = [];
        for (const rid of roads) {
            const r = map.roads[rid]!;
            for (const direction of ['forward', 'backward'] as const)
                if (r.direction === 'both' || r.direction === direction) {
                    const arc = { roadId: rid, direction };
                    if (endpoint(r, arc, true) === j.nodeIds[0])
                        incoming.push(arc);
                    if (endpoint(r, arc, false) === j.nodeIds[0])
                        outgoing.push(arc);
                }
        }
        const expected = incoming.flatMap(a => outgoing.filter(b => a.roadId !== b.roadId).map(b => [a, b] as const));
        if (expected.some(([a, b]) => turns.filter(m => arcEqual(a, m.incomingArc) && arcEqual(b, m.outgoingArc)).length !== 1))
            return false;
        if (turns.length !== expected.length || turns.some(m => !m.allowed || m.internalPath || m.resourceIds.length || Object.keys(m.extensions ?? {}).length || !expected.some(([a, b]) => arcEqual(a, m.incomingArc) && arcEqual(b, m.outgoingArc))))
            return false;
    }
    return Object.values(map.movements).every(m => has(map.junctions, m.junctionId));
}
