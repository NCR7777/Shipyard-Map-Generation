import type { SceneSnapshot } from '../../adapters/contracts';
import type { MapCommand } from '../../domain/commands';
import type { Issue, MapRoad, PhysicalValue, YardMap } from '../../domain/model';
import { sameValue } from '../../domain/value';
import { enumerateConnectionTurns, enumerateMergeTurns, type ApprovedMovement, type TopologyCommand } from '../../domain/topologyEditing';
import type { DrawingConfig } from '../../editor/projectController';
import type { Camera, Vec2 } from '../../geometry/coordinates';
import { getRoadPath, pathLength, projectToPath } from '../../geometry/roadPath';
import { snapTarget, type SnapTarget } from './drafting';
import { uid } from './movePreview';

/** Topology edits (P3c1). A road split where the split tool is clicked; two nodes merged, a node connected into a road (a node
 *  dropped on another node or on a road, or two selected objects and the edit menu), a node with two roads removed and its
 *  roads joined: those three are confirmed in a dialog that shows what changes and which new turns it would allow. */

export const incidentRoads = (map: YardMap, nodeId: string) =>
  Object.keys(map.roads).filter(id => map.roads[id]!.fromNodeId === nodeId || map.roads[id]!.toNodeId === nodeId);
const neighbours = (map: YardMap, nodeId: string) =>
  new Set(incidentRoads(map, nodeId).map(id => map.roads[id]!.fromNodeId === nodeId ? map.roads[id]!.toNodeId : map.roads[id]!.fromNodeId));

const NODE_KINDS: Record<string, string> = { ordinary: '普通节点', junction: '路口节点', access: '入口节点', service: '作业节点' };
/** Why two nodes cannot be merged by the kernel, or null: it merges only nodes of the same kind and extensions (the one removed
 *  would lose its own), either way round. */
export function nodeConflict(map: YardMap, a: string, b: string): string | null {
  const first = map.nodes[a]!, second = map.nodes[b]!;
  if (first.kind === second.kind && sameValue(first.extensions, second.extensions)) return null;
  const what = first.kind !== second.kind ? `「${first.name}」是${NODE_KINDS[first.kind] ?? first.kind}，「${second.name}」是${NODE_KINDS[second.kind] ?? second.kind}` : `「${first.name}」与「${second.name}」的扩展数据不同`;
  return `不能合并：${what}，合并会丢掉其中一个的类型或数据。要接到「${second.name}」，请用道路工具从它画这一段。`;
}

/** Where a node dropped at the pointer would go: onto another node at its height (merged), or into a road's interior (connected
 *  there), within the snap distance, on layers shown and unlocked, while snapping to nodes is on. Not a node it shares a road
 *  with (the road would become a loop), nor one of its own roads (it is already their end). `refusal`: a node there it cannot
 *  be merged with (a release there does nothing, and says why). */
export function dropTarget(map: YardMap, scene: SceneSnapshot, nodeId: string, screen: Vec2, camera: Camera, drawing: Pick<DrawingConfig, 'hiddenTypes' | 'lockedTypes' | 'snapNodes'>): (SnapTarget & { refusal: string | null }) | null {
  if (!drawing.snapNodes) return null;
  const usable = (kind: 'nodes' | 'roads') => !drawing.hiddenTypes.includes(kind) && !drawing.lockedTypes.includes(kind);
  const found = snapTarget(scene, screen, camera, { z: map.nodes[nodeId]!.position[2], nodes: usable('nodes'), roads: usable('roads'), excludeNodeId: nodeId });
  if (!found) return null;
  const { connection } = found;
  if (connection.kind === 'node') return neighbours(map, nodeId).has(connection.nodeId) ? null : { ...found, refusal: nodeConflict(map, nodeId, connection.nodeId) };
  if (incidentRoads(map, nodeId).includes(connection.roadId)) return null;
  return { ...found, refusal: atEnd(connection.distanceM, scene.roads.find(road => road.id === connection.roadId)?.lengthM ?? Infinity) ? AT_END : null };
}
/** Within half a millimetre of a road's end the connection, taken to the millimetre, would fall on the end itself. */
const atEnd = (distanceM: number, lengthM: number) => mm(distanceM) <= 1e-6 || mm(distanceM) >= lengthM - 1e-6;
const AT_END = '这里就是道路的端点（不到 1 毫米）：请拖到端点的节点上合并。';

/** The edit a drop makes: the dragged node merged into the node there (which stays where it is), or connected into the road. */
export function dropCommand(map: YardMap, nodeId: string, target: SnapTarget): TopologyCommand {
  const { connection } = target;
  if (connection.kind === 'node') return { type: 'mergeNodes', sourceNodeId: nodeId, targetNodeId: connection.nodeId, approvedMovements: [] };
  // The node's own junction is kept (the kernel requires its ID); a new one is made only if it has none.
  const junction = Object.entries(map.junctions).find(([, item]) => item.nodeIds.length === 1 && item.nodeIds[0] === nodeId)?.[0] ?? uid('junction');
  return { type: 'connectNodeToRoad', nodeId, roadId: connection.roadId, distanceM: mm(connection.distanceM), newRoadIds: [uid('road'), uid('road')], junctionId: junction, approvedMovements: [] };
}

/** Removing a node and joining its two roads keeps one of them (its ID and properties); the first by default. */
export function suppressCommand(map: YardMap, nodeId: string): TopologyCommand | null {
  const roads = incidentRoads(map, nodeId);
  return roads.length === 2 ? { type: 'suppressDegree2Node', nodeId, retainedRoadId: roads[0]! } : null;
}

/** The new turns the kernel would allow at the joined node if approved (never a U-turn, never against a one-way road; for a
 *  connection, not the straight-on of the road it splits, which the split keeps). */
export function proposedTurns(map: YardMap, command: TopologyCommand): Omit<ApprovedMovement, 'id'>[] {
  if (command.type === 'mergeNodes') return enumerateMergeTurns(map, command);
  if (command.type === 'connectNodeToRoad') return enumerateConnectionTurns(map, command);
  return [];
}
/** The command with those turns approved (IDs given once per preview), or none. */
export function withTurns(command: TopologyCommand, turns: readonly ApprovedMovement[], approve: boolean): TopologyCommand {
  return command.type === 'suppressDegree2Node' ? command : { ...command, approvedMovements: approve ? [...turns] : [] };
}

/** The split tool's target under the pointer: a road's interior (split there), or a node (a road's end: nothing to split; nodes
 *  count even while their layer is hidden, so a click beside a junction never cuts a sliver off a road). */
export function splitSpot(scene: SceneSnapshot, screen: Vec2, camera: Camera, drawing: Pick<DrawingConfig, 'hiddenTypes' | 'lockedTypes'>): SnapTarget | null {
  if (drawing.hiddenTypes.includes('roads')) return null;
  return snapTarget(scene, screen, camera, { nodes: true, roads: true });
}
export function splitCommand(roadId: string, distanceM: number): MapCommand {
  return { type: 'splitRoad', id: roadId, distanceM: mm(distanceM), nodeId: uid('node'), newRoadIds: [uid('road'), uid('road')] };
}
/** A position picked with the pointer, along a road, to the millimetre (as moves are): readable coordinates, no pixel noise. */
const mm = (value: number) => Math.round(value * 1000) / 1000;

/** The topology edit the selection offers from the edit menu, or why it offers none: two nodes merged (the second into the
 *  first, which stays), a node connected into a road (at the road point nearest to it), a node with two roads removed. */
export function selectionTopology(map: YardMap, keys: readonly string[], kind: TopologyCommand['type']): TopologyCommand | string {
  const nodes = keys.filter(key => key.startsWith('nodes/')).map(key => key.slice(6)), roads = keys.filter(key => key.startsWith('roads/')).map(key => key.slice(6));
  if (kind === 'mergeNodes') {
    if (nodes.length !== 2 || keys.length !== 2) return '请只选中两个节点（先选的保留）';
    if (neighbours(map, nodes[0]!).has(nodes[1]!)) return '两个节点由道路直接相连，合并会把那条路压成一个点';
    const conflict = nodeConflict(map, nodes[1]!, nodes[0]!); if (conflict) return conflict;
    return { type: 'mergeNodes', sourceNodeId: nodes[1]!, targetNodeId: nodes[0]!, approvedMovements: [] };
  }
  if (kind === 'connectNodeToRoad') {
    if (nodes.length !== 1 || roads.length !== 1 || keys.length !== 2) return '请只选中一个节点和一条道路';
    if (incidentRoads(map, nodes[0]!).includes(roads[0]!)) return '节点已是这条道路的端点';
    const path = getRoadPath(map, roads[0]!), projected = projectToPath(path, map.nodes[nodes[0]!]!.position);
    if (!projected.converged || projected.ambiguous) return '节点到这条道路的最近点不唯一';
    if (atEnd(projected.sM, pathLength(path).lengthM)) return '节点到这条道路的最近点是道路端点：请改为合并两个节点';
    return dropCommand(map, nodes[0]!, { connection: { kind: 'road', roadId: roads[0]!, distanceM: projected.sM }, position: projected.point });
  }
  if (nodes.length !== 1 || keys.length !== 1) return '请只选中一个节点';
  return suppressCommand(map, nodes[0]!) ?? '这个节点不是恰好连着两条道路';
}

/** Shown in the units the properties panel starts with (t, km/h), so the two can be compared. */
const PHYSICAL: readonly [keyof MapRoad, string, string, number][] = [['widthM', '宽度', 'm', 1], ['heightLimitM', '限高', 'm', 1], ['massLimitKg', '承载', 't', 1 / 1000], ['speedLimitMps', '限速', 'km/h', 3.6]];
const shown = (value: PhysicalValue, unit: string, factor: number) => value.state === 'known' ? `${Number((value.value * factor).toFixed(3))} ${unit}` : ({ unknown: '未知', unrestricted: '无限制', not_applicable: '不适用' } as Record<string, string>)[value.state] ?? value.state;
/** The kernel's refusal of a topology edit in plain words, where its own are technical; null: its message is clear. For two roads
 *  that cannot be joined, which of their properties differ, by the kernel's comparison (the direction read along the joined
 *  road; the physical values with their basis; resources; extensions), and whether the properties panel can make them agree. */
export function topologyRefusal(map: YardMap, command: TopologyCommand, issue: Issue | undefined): string | null {
  switch (issue?.code) {
    case 'TOPOLOGY_ROAD_CONFLICT': {
      if (command.type !== 'suppressDegree2Node') return null;
      const [a, b] = incidentRoads(map, command.nodeId).map(id => map.roads[id]!), node = command.nodeId;
      if (!a || !b) return null;
      const along = (road: MapRoad, forward: boolean) => road.direction === 'both' ? 'both' : (road.direction === 'forward') === forward ? 'forward' : 'backward';
      const editable = [...along(a, a.toNodeId === node) !== along(b, b.fromNodeId === node) ? ['方向'] : [],
        ...PHYSICAL.filter(([key]) => !sameValue(a[key], b[key])).map(([key, label, unit, factor]) => {
          const x = a[key] as PhysicalValue, y = b[key] as PhysicalValue, left = shown(x, unit, factor), right = shown(y, unit, factor);
          return left === right ? `${label}的依据` : `${label}（${left} / ${right}）`;
        })];
      const fixed = [...!sameValue(a.resourceIds, b.resourceIds) ? ['关联的资源'] : [], ...!sameValue(a.extensions, b.extensions) ? ['扩展数据（如走廊编号）'] : []];
      const differ = [...editable, ...fixed].join('、') || '属性';
      return fixed.length
        ? `两条道路的${differ}不同。${fixed.join('、')}在属性栏改不了：这两段路在数据里是分开记录的，工具不把它们合成一条；保留这个节点即可，两段路照样在这里相连。`
        : `两条道路的${differ}不同，合成一条时工具不替你决定取哪一个：先在属性栏把它们改成一致，再删除节点。`;
    }
    case 'TOPOLOGY_NODE_CONFLICT':
      return command.type === 'mergeNodes' ? nodeConflict(map, command.sourceNodeId, command.targetNodeId) : null;
    case 'TOPOLOGY_CONTINUATION_UNDECLARED': return '这个节点上还没有声明两条道路之间的直行许可；合成一条路等于认定可以直行，工具不替你认定。以后可在路口转向里声明（P3c2）。';
    case 'TOPOLOGY_DIRECTION_UNKNOWN': return '道路方向是「待配置」：先在属性栏定下方向。';
    case 'TOPOLOGY_POINT_DEPENDENCY': return '这个节点上有入口或作业点，不能删除。';
    case 'TOPOLOGY_OWNER_CONNECTION': return '涉及建筑或区域自己的内部道路，不能这样改接。';
    case 'TOPOLOGY_DUPLICATE_EDGE': return '改完会有两条道路连着同样两个节点（重复道路），工具不替你决定保留哪条。';
    case 'TOPOLOGY_SELF_LOOP': return '改完会有道路首尾接在同一个节点上（自环）。';
    default: return null;
  }
}
