import type { Issue, MapNode, MapRoad, Vec3, YardMap } from './model';
import { validateMap } from '../validation/validate';
import { mapCapabilities } from './capabilities';
import { contentHash, serializeMap } from './serialization';

export interface Selection { nodes: string[]; roads: string[] }
export type MapCommand =
  | { type: 'addNode'; id: string; node: MapNode }
  | { type: 'addRoad'; id: string; road: MapRoad }
  | { type: 'updateNode'; id: string; patch: Partial<Pick<MapNode, 'name' | 'position'>> }
  | { type: 'updateRoad'; id: string; patch: Partial<Pick<MapRoad, 'name' | 'shapePoints' | 'direction'>> }
  | { type: 'renameMap'; name: string }
  | { type: 'translateSelection'; selection: Selection; delta: Vec3 }
  | { type: 'duplicateSelection'; selection: Selection; delta: Vec3; idMap: Record<string, string> }
  | { type: 'deleteSelection'; selection: Selection };

export interface Transaction { before: YardMap; after: YardMap; label: string }
export type CommandResult =
  | { ok: true; map: YardMap; changed: boolean; transaction?: Transaction }
  | { ok: false; issues: Issue[] };

function problem(code: string, message: string, jsonPath = ''): Issue {
  return { code, severity: 'error', jsonPath, message, suggestedAction: '检查选中对象、引用和输入后重试。' };
}

function assertSelection(map: YardMap, selection: Selection): void {
  for (const id of selection.nodes) if (!Object.hasOwn(map.nodes, id)) throw new Error('不存在节点 ' + id);
  for (const id of selection.roads) if (!Object.hasOwn(map.roads, id)) throw new Error('不存在道路 ' + id);
}

/** A road's geometric closure includes its two explicitly referenced endpoints. */
export function closureSelection(map: YardMap, selection: Selection): Selection {
  assertSelection(map, selection);
  const nodes = new Set(selection.nodes);
  for (const id of selection.roads) {
    const road = map.roads[id]!;
    nodes.add(road.fromNodeId); nodes.add(road.toNodeId);
  }
  return { nodes: [...nodes].sort(), roads: [...new Set(selection.roads)].sort() };
}

export function freezeMap(map: YardMap): YardMap {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
  };
  freeze(map);
  return map;
}

function existsId(map: YardMap, id: string): boolean {
  return (['nodes', 'roads', 'junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'sources', 'assets', 'backgroundLayers'] as const)
    .some(key => Object.hasOwn(map[key], id));
}

function moved(position: Vec3, delta: Vec3): Vec3 {
  if (delta.length !== 3 || delta.some(value => !Number.isFinite(value))) throw new Error('位移必须为三个有限米制数值。');
  return [position[0] + delta[0], position[1] + delta[1], position[2] + delta[2]];
}

export function applyMapCommand(input: YardMap, command: MapCommand): CommandResult {
  const initial = validateMap(input);
  if (!initial.ok) return { ok: false, issues: initial.issues };
  if (!mapCapabilities(input).editable) return { ok: false, issues: [problem('READ_ONLY_MAP', '该地图含 M1 未支持的实体或行为，整图只读。')] };
  const next = structuredClone(input);
  try {
    switch (command.type) {
      case 'addNode':
        if (existsId(next, command.id)) return { ok: false, issues: [problem('DUPLICATE_ENTITY_ID', 'ID 已存在：' + command.id)] };
        Object.defineProperty(next.nodes, command.id, { value: structuredClone(command.node), writable: true, enumerable: true, configurable: true });
        break;
      case 'addRoad':
        if (existsId(next, command.id)) return { ok: false, issues: [problem('DUPLICATE_ENTITY_ID', 'ID 已存在：' + command.id)] };
        Object.defineProperty(next.roads, command.id, { value: structuredClone(command.road), writable: true, enumerable: true, configurable: true });
        break;
      case 'updateNode':
        assertSelection(next, { nodes: [command.id], roads: [] });
        next.nodes[command.id] = { ...next.nodes[command.id]!, ...structuredClone(command.patch) };
        break;
      case 'updateRoad':
        assertSelection(next, { nodes: [], roads: [command.id] });
        next.roads[command.id] = { ...next.roads[command.id]!, ...structuredClone(command.patch) };
        break;
      case 'renameMap':
        next.metadata.name = command.name;
        break;
      case 'translateSelection': {
        const selected = closureSelection(next, command.selection);
        for (const id of selected.nodes) next.nodes[id]!.position = moved(next.nodes[id]!.position, command.delta);
        for (const id of selected.roads) next.roads[id]!.shapePoints = next.roads[id]!.shapePoints.map(point => moved(point, command.delta));
        break;
      }
      case 'duplicateSelection': {
        const selected = closureSelection(next, command.selection);
        const sourceIds = [...selected.nodes, ...selected.roads];
        const targetIds = new Set<string>();
        for (const id of sourceIds) {
          const entity = Object.hasOwn(next.nodes, id) ? next.nodes[id]! : next.roads[id]!;
          if (Object.keys(entity.extensions ?? {}).length) return { ok: false, issues: [problem('UNSUPPORTED_COPY_SEMANTICS', '对象扩展可能含引用，M1 不猜测复制语义：' + id)] };
          const target = Object.hasOwn(command.idMap, id) ? command.idMap[id] : undefined;
          if (!target || existsId(next, target) || targetIds.has(target))
            return { ok: false, issues: [problem('INVALID_COPY_ID_MAP', '副本 ID 必须完整、新建且唯一。')] };
          targetIds.add(target);
        }
        if (Object.keys(command.idMap).length !== sourceIds.length)
          return { ok: false, issues: [problem('INVALID_COPY_ID_MAP', 'ID 映射必须恰好覆盖复制闭包。')] };
        for (const id of selected.nodes) {
          const node = structuredClone(next.nodes[id]!);
          node.position = moved(node.position, command.delta);
          Object.defineProperty(next.nodes, command.idMap[id]!, { value: node, enumerable: true, configurable: true, writable: true });
        }
        for (const id of selected.roads) {
          const road = structuredClone(next.roads[id]!);
          road.fromNodeId = command.idMap[road.fromNodeId]!;
          road.toNodeId = command.idMap[road.toNodeId]!;
          road.shapePoints = road.shapePoints.map(point => moved(point, command.delta));
          Object.defineProperty(next.roads, command.idMap[id]!, { value: road, enumerable: true, configurable: true, writable: true });
        }
        break;
      }
      case 'deleteSelection': {
        assertSelection(next, command.selection);
        const deletedNodes = new Set(command.selection.nodes);
        const deletedRoads = new Set(command.selection.roads);
        const dependencies: Issue[] = [];
        for (const [id, road] of Object.entries(next.roads)) {
          if (deletedRoads.has(id)) continue;
          for (const field of ['fromNodeId', 'toNodeId'] as const) if (deletedNodes.has(road[field]))
            dependencies.push({ ...problem('ENTITY_IN_USE', '道路 ' + id + ' 仍引用节点 ' + road[field] + '；请显式一并选择相关道路。', '/roads/' + id + '/' + field), entityType: 'roads', entityId: id });
        }
        if (dependencies.length) return { ok: false, issues: dependencies };
        for (const id of deletedRoads) delete next.roads[id];
        for (const id of deletedNodes) delete next.nodes[id];
        break;
      }
      default:
        return { ok: false, issues: [problem('UNKNOWN_COMMAND', '未支持的领域命令。')] };
    }
  } catch (error) {
    return { ok: false, issues: [problem('INVALID_COMMAND', error instanceof Error ? error.message : '命令输入无效。')] };
  }
  const report = validateMap(next);
  if (!report.ok) return { ok: false, issues: report.issues };
  if (contentHash(input) === contentHash(next)) return { ok: true, map: input, changed: false };
  next.revision = input.revision + 1;
  const finalReport = validateMap(next);
  if (!finalReport.ok) return { ok: false, issues: finalReport.issues };
  try { serializeMap(next); }
  catch (error) { return { ok: false, issues: [problem('JSON_SIZE_LIMIT', error instanceof Error ? error.message : '规范化 JSON 超过限制。')] }; }
  const before = freezeMap(structuredClone(input));
  const after = freezeMap(next);
  return { ok: true, map: after, changed: true, transaction: { before, after, label: command.type } };
}
