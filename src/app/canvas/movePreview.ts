import type { SceneSnapshot } from '../../adapters/contracts';
import { closureSelection, commandSupport, selectionImpact, SELECTION_KINDS, type CommandAffectedRef, type FullSelection, type MapCommand, type Selection, type SelectionKind } from '../../domain/commands';
import type { MapNode, MapRoad, Vec3, YardMap } from '../../domain/model';
import { moveNodeWithHandles } from '../../domain/topologyEditing';
import { transformPolygon } from '../../geometry/polygons';
import { getRoadPath, transformRoadGeometry } from '../../geometry/roadPath';

/** The part of a scene a gesture redraws; everything else stays in the static layer. */
export type Overlay = Pick<SceneSnapshot, 'nodes' | 'roads' | 'facilities' | 'zones' | 'accessPoints' | 'servicePoints' | 'items'>;
export interface MovePlan {
  /** Move shifts the objects themselves; copy leaves them and draws the copies. */
  mode: 'move' | 'copy';
  selection: FullSelection;
  /** Scene keys not drawn from the static layer while the preview shows. */
  hidden: ReadonlySet<string>;
  /** Everything the command would touch, for the locked-layer check before any drawing. */
  affectedRefs: readonly CommandAffectedRef[];
  overlay(delta: Vec3): Overlay;
}
/** Facilities and zones carry their private contents; public network anchors stay (as in ../map). */
export const MOVE_POLICY = 'withStaticContents' as const;
const ID_PREFIX: Record<SelectionKind, string> = { nodes: 'node', roads: 'road', facilities: 'facility', zones: 'zone', accessPoints: 'access', servicePoints: 'service' };
export const uid = (prefix: string) => prefix + '_' + crypto.randomUUID();

export function translateCommand(selection: Selection, delta: Vec3): Extract<MapCommand, { type: 'translateSelection' }> {
  return { type: 'translateSelection', selection, delta, facilityMovePolicy: MOVE_POLICY, zoneMovePolicy: MOVE_POLICY };
}
/** A copy of the selection's closure (members and endpoints, never outside roads) under fresh IDs. */
export function duplicateCommand(map: YardMap, selection: Selection, delta: Vec3): Extract<MapCommand, { type: 'duplicateSelection' }> {
  const closure = closureSelection(map, selection);
  const idMap = Object.fromEntries(SELECTION_KINDS.flatMap(kind => closure[kind].map(id => [id, uid(ID_PREFIX[kind])])));
  return { type: 'duplicateSelection', selection, delta, idMap, associationPolicy: 'rejectExternal' };
}
/** The kernel's structural verdict (reference rules, shared nodes, …) on the command as it will run; checks of the result,
 *  which depend on where the objects land, remain for the commit. */
export function structuralCheck(map: YardMap, command: MapCommand): { refusal: string | null; affectedRefs: readonly CommandAffectedRef[] } {
  const support = commandSupport(map, command);
  return { refusal: support.allowed ? null : support.issues[0]?.message ?? '内核不允许此操作。', affectedRefs: support.affectedRefs };
}

const shift = (delta: Vec3) => (point: Vec3): Vec3 => [point[0] + delta[0], point[1] + delta[1], point[2] + delta[2]];

/** Plans a translation preview with the kernel's own rules: selectionImpact picks what moves (it also refuses moves the commit
 *  would refuse, so the user learns before dragging), then each frame moves nodes with moveNodeWithHandles and rigid parts with
 *  transformRoadGeometry / transformPolygon, exactly as transformSelection will. Throws the kernel's refusal. */
export function planMove(map: YardMap, scene: SceneSnapshot, selection: Selection, mode: 'move' | 'copy' = 'move'): MovePlan {
  const probe: Vec3 = [1, 0, 0], check = structuralCheck(map, mode === 'move' ? translateCommand(selection, probe) : duplicateCommand(map, selection, probe));
  if (check.refusal) throw new Error(check.refusal);
  const full = mode === 'move' ? selectionImpact(map, selection, MOVE_POLICY, MOVE_POLICY) : null;
  const chosen = full ? full.selection : closureSelection(map, selection);
  const moving = new Set(chosen.nodes), rigid = new Set(chosen.roads);
  // A copy duplicates only the closure and never stretches outside roads.
  const stretched = mode === 'move' ? Object.entries(map.roads).filter(([id, road]) => !rigid.has(id) && (moving.has(road.fromNodeId) || moving.has(road.toNodeId))).map(([id]) => id) : [];
  const slotOwners = new Set((full?.slots ?? []).map(slot => slot.ownerKind + '/' + slot.ownerId));
  const junctions = new Set(full?.junctionIds ?? []);
  const items = scene.items.filter(item => item.kind === 'slots' ? !!item.owner && slotOwners.has(item.owner.kind + '/' + item.owner.id) : item.kind === 'junctions' && junctions.has(item.id));
  const byId = <T extends { id: string }>(list: readonly T[], ids: Iterable<string>) => { const wanted = new Set(ids); return list.filter(entry => wanted.has(entry.id)); };
  // A move carries every point on a moving node; a copy creates only the points in its closure.
  const points = mode === 'copy' ? { accessPoints: byId(scene.accessPoints, chosen.accessPoints), servicePoints: byId(scene.servicePoints, chosen.servicePoints) }
    : { accessPoints: scene.accessPoints.filter(point => moving.has(point.nodeId)), servicePoints: scene.servicePoints.filter(point => moving.has(point.nodeId)) };
  const base = {
    nodes: byId(scene.nodes, moving), roads: byId(scene.roads, [...rigid, ...stretched]),
    facilities: byId(scene.facilities, chosen.facilities), zones: byId(scene.zones, chosen.zones), ...points,
  };
  const hidden = new Set(mode === 'copy' ? [] : [
    ...base.nodes.map(node => 'nodes/' + node.id), ...base.roads.map(road => 'roads/' + road.id),
    ...base.facilities.map(area => 'facilities/' + area.id), ...base.zones.map(area => 'zones/' + area.id),
    ...points.accessPoints.map(point => 'accessPoints/' + point.id), ...points.servicePoints.map(point => 'servicePoints/' + point.id),
    ...items.map(item => item.key),
  ]);
  return { mode, selection: chosen, hidden, affectedRefs: check.affectedRefs, overlay(delta) {
    const move = shift(delta);
    // Mutable copies of just the nodes and stretched roads the kernel helper touches.
    const local = { nodes: {} as Record<string, MapNode>, roads: {} as Record<string, MapRoad> };
    for (const id of moving) local.nodes[id] = { ...map.nodes[id]!, position: [...map.nodes[id]!.position] };
    for (const id of stretched) local.roads[id] = structuredClone(map.roads[id]!);
    for (const id of moving) moveNodeWithHandles(local as unknown as YardMap, id, move(map.nodes[id]!.position), rigid);
    const position = (id: string) => local.nodes[id]?.position ?? map.nodes[id]!.position;
    const path = (id: string) => {
      const road = rigid.has(id) ? transformRoadGeometry(map.roads[id]!, move) : local.roads[id] ?? map.roads[id]!;
      return getRoadPath({ roads: { [id]: road }, nodes: { [road.fromNodeId]: { ...map.nodes[road.fromNodeId]!, position: position(road.fromNodeId) }, [road.toNodeId]: { ...map.nodes[road.toNodeId]!, position: position(road.toNodeId) } } } as unknown as YardMap, id);
    };
    return {
      nodes: base.nodes.map(node => ({ ...node, position: position(node.id) })),
      roads: base.roads.map(road => ({ ...road, path: path(road.id), points: [] })),
      facilities: base.facilities.map(area => ({ ...area, boundary: transformPolygon(area.boundary, move) })),
      zones: base.zones.map(area => ({ ...area, boundary: transformPolygon(area.boundary, move) })),
      accessPoints: points.accessPoints.map(point => ({ ...point, position: position(point.nodeId) })),
      servicePoints: points.servicePoints.map(point => ({ ...point, position: position(point.nodeId) })),
      items: items.map(item => ({ ...item, polygons: item.polygons.map(polygon => transformPolygon(polygon, move)) })),
    };
  } };
}
