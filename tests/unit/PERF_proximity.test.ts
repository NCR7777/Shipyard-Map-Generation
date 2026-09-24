import { describe, expect, it } from 'vitest';
import { validateMap } from '../../src/validation/validate';
import { newMap, newNode, newRoad } from '../../src/domain/factory';
import { roadPoints } from '../../src/geometry/roads';
import { roadGeometryAnchors } from '../../src/geometry/roadPath';
import type { Vec3, YardMap } from '../../src/domain/model';

// The historical O(n·m) scans, kept verbatim as the reference for the grid-indexed version.
function reference(map: YardMap): string[] {
  const out: string[] = [], nodes = Object.entries(map.nodes);
  const connected = new Set(Object.values(map.roads).map(road => [road.fromNodeId, road.toNodeId].sort().join('|')));
  let reported = 0;
  for (let i = 0; i < nodes.length && reported < 100; i++) for (let j = i + 1; j < nodes.length && reported < 100; j++) {
    const [idA, a] = nodes[i]!, [idB, b] = nodes[j]!;
    if (Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) <= 0.5 && !connected.has([idA, idB].sort().join('|'))) { out.push('node:' + idB + ':' + idA); reported++; }
  }
  const segments = Object.values(map.roads).reduce((sum, road) => sum + roadGeometryAnchors(road).length + 1, 0);
  if (nodes.length * segments > 2_000_000) return out;
  for (const [roadId, road] of Object.entries(map.roads)) {
    if (reported >= 100) break;
    const points = roadPoints(map, roadId);
    for (const [nodeId, node] of nodes) {
      if (reported >= 100) break;
      if (nodeId === road.fromNodeId || nodeId === road.toNodeId) continue;
      for (let i = 0; i + 1 < points.length; i++) {
        const p = points[i]!, q = points[i + 1]!, dx = q[0] - p[0], dy = q[1] - p[1], den = dx * dx + dy * dy;
        if (!Number.isFinite(den) || den === 0) continue;
        const t = Math.max(0, Math.min(1, ((node.position[0] - p[0]) * dx + (node.position[1] - p[1]) * dy) / den));
        if (Math.hypot(node.position[0] - (p[0] + dx * t), node.position[1] - (p[1] + dy * t), node.position[2] - (p[2] + (q[2] - p[2]) * t)) <= 0.5) { out.push('road:' + nodeId + ':' + roadId); reported++; break; }
      }
    }
  }
  return out;
}
function actual(map: YardMap): string[] {
  return validateMap(map).issues.filter(issue => issue.code === 'NEAR_UNCONNECTED_NODES' || issue.code === 'NEAR_ROAD_UNCONNECTED')
    .map(issue => issue.code === 'NEAR_UNCONNECTED_NODES' ? 'node:' + issue.entityId + ':' + /节点距 (\S+) 不超过/.exec(issue.message)![1] : 'road:' + issue.entityId + ':' + /道路 (\S+) 不超过/.exec(issue.message)![1]);
}
function random(seed: number) { return () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296; }

describe('grid-indexed proximity hints', () => {
  it('reports exactly the pairs of the full scan, in the same order and with the same 100-hint cap', () => {
    const counts: number[] = [];
    for (const [seed, count, spread] of [[1, 60, 40], [2, 300, 200], [3, 900, 120], [4, 400, 2000]] as const) {
      const next = random(seed), map = newMap('map_prox_' + seed, 'proximity');
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        // Clusters of near-duplicate nodes, some far away, some on long diagonals.
        const base: Vec3 = next() < 0.3 && ids.length ? [...map.nodes[ids[Math.floor(next() * ids.length)]!]!.position] as Vec3 : [next() * spread, next() * spread, 0];
        const id = 'n' + i; ids.push(id);
        map.nodes[id] = newNode([base[0] + (next() - 0.5) * 0.9, base[1] + (next() - 0.5) * 0.9, next() < 0.1 ? 0.3 : 0]);
      }
      for (let i = 0; i < count / 2; i++) {
        const from = ids[Math.floor(next() * ids.length)]!, to = ids[Math.floor(next() * ids.length)]!;
        if (from === to) continue;
        const a = map.nodes[from]!.position, b = map.nodes[to]!.position;
        map.roads['r' + i] = newRoad(from, to, next() < 0.3 ? [[(a[0] + b[0]) / 2 + 3, (a[1] + b[1]) / 2 - 2, 0]] : []);
      }
      const expected = reference(map); expect(actual(map)).toEqual(expected); counts.push(expected.length);
    }
    // Non-trivial cases occur, and the dense case reaches the cap.
    expect(counts.some(count => count > 0 && count < 100)).toBe(true); expect(counts).toContain(100);
  });

  it('keeps pairs whose distance rounds to 0.5 m across a cell seam (tiny negative residue)', () => {
    const map = newMap('map_prox_seam', 'seam');
    map.nodes.a = newNode([0.5, 3, 0]); map.nodes.b = newNode([-1e-17, 3, 0]);
    map.nodes.c = newNode([3, -1e-17, 0]); map.nodes.d = newNode([0, 0.5, 0]); map.nodes.e = newNode([10, 0.5, 0]);
    map.roads.r = newRoad('d', 'e');
    const expected = reference(map);
    expect(expected).toEqual(expect.arrayContaining(['node:b:a', 'road:c:r']));
    expect(actual(map)).toEqual(expected);
  });
});
