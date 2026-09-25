import type { YardMap } from '../../domain/model';
import { worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import { HANDLE_HIT_PX } from './handles';

/** What a press or a click takes hold of: the top object under the pointer; but on a road, the end of a road within reach
 *  (8 px), nearest first. Plain nodes are hidden by default, so a press at a road's end would otherwise take the road; the
 *  end is taken whether its node shows or not (hovering shows it). Anything else on top (a point marker, a shown node, a
 *  building or zone) is taken as it is: a press inside a building by a road end on its wall moves the building. */
export function pressTarget(map: YardMap, candidateKeys: readonly string[], at: Vec2, camera: Camera): string | undefined {
  const top = candidateKeys[0];
  if (!top?.startsWith('roads/')) return top;
  let best: string | undefined, reach = HANDLE_HIT_PX;
  for (const key of candidateKeys) {
    if (!key.startsWith('roads/')) continue;
    const road = map.roads[key.slice(key.indexOf('/') + 1)]; if (!road) continue;
    for (const id of [road.fromNodeId, road.toNodeId]) {
      const [x, y] = worldToScreen(map.nodes[id]!.position, camera), distance = Math.hypot(x - at[0], y - at[1]);
      if (distance <= reach) { best = endKey(map, id); reach = distance; }
    }
  }
  return best ?? top;
}

/** What a road's end stands for: the one entrance on its node (a service point beside it goes along; the entrance keeps to
 *  its outline), else the one service point, else the node. */
export function endKey(map: YardMap, nodeId: string): string {
  const entrances = Object.keys(map.accessPoints).filter(id => map.accessPoints[id]!.nodeId === nodeId);
  const services = Object.keys(map.servicePoints).filter(id => map.servicePoints[id]!.nodeId === nodeId);
  if (entrances.length === 1) return 'accessPoints/' + entrances[0];
  if (services.length === 1 && !entrances.length) return 'servicePoints/' + services[0];
  return 'nodes/' + nodeId;
}
