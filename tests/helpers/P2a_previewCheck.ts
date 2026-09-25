import { expect } from 'vitest';
import { planMove, MOVE_POLICY } from '../../src/app/canvas/movePreview';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { applyMapCommand, type Selection } from '../../src/domain/commands';
import type { Vec3, YardMap } from '../../src/domain/model';

const close = (a: unknown, b: unknown) => expect(JSON.stringify(a, (_, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value))
  .toBe(JSON.stringify(b, (_, value) => typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value));

/** The drag preview must draw exactly what the committed translation produces, object by object. */
export function expectPreviewMatchesCommit(map: YardMap, selection: Selection, delta: Vec3): number {
  const scene = toSceneSnapshot(map), plan = planMove(map, scene, selection), overlay = plan.overlay(delta);
  const result = applyMapCommand(map, { type: 'translateSelection', selection, delta, facilityMovePolicy: MOVE_POLICY, zoneMovePolicy: MOVE_POLICY });
  if (!result.ok) throw new Error('commit refused: ' + result.issues[0]?.message);
  const after = toSceneSnapshot(result.map!);
  const find = <T extends { id: string }>(list: readonly T[], id: string) => list.find(entry => entry.id === id)!;
  for (const node of overlay.nodes) close(node.position, find(after.nodes, node.id).position);
  for (const road of overlay.roads) close(road.path, find(after.roads, road.id).path);
  for (const area of overlay.facilities) close(area.boundary, find(after.facilities, area.id).boundary);
  for (const area of overlay.zones) close(area.boundary, find(after.zones, area.id).boundary);
  for (const point of [...overlay.accessPoints, ...overlay.servicePoints]) close(point.position, find([...after.accessPoints, ...after.servicePoints], point.id).position);
  for (const item of overlay.items) close(item.polygons, after.items.find(entry => entry.key === item.key)!.polygons);
  // Everything the commit moved is either previewed or genuinely unchanged: nothing moves unseen.
  const shown = plan.hidden, before = new Map(scene.roads.map(road => [road.id, JSON.stringify(road.path)]));
  for (const road of after.roads) if (!shown.has('roads/' + road.id)) expect(JSON.stringify(road.path)).toBe(before.get(road.id));
  const nodes = new Map(scene.nodes.map(node => [node.id, JSON.stringify(node.position)]));
  for (const node of after.nodes) if (!shown.has('nodes/' + node.id)) expect(JSON.stringify(node.position)).toBe(nodes.get(node.id));
  for (const kind of ['facilities', 'zones'] as const) {
    const areas = new Map(scene[kind].map(area => [area.id, JSON.stringify(area.boundary)]));
    for (const area of after[kind]) if (!shown.has(kind + '/' + area.id)) expect(JSON.stringify(area.boundary)).toBe(areas.get(area.id));
  }
  return shown.size;
}
