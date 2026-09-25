import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { editCommand, type Target } from '../../src/app/canvas/handles';
import { carryAlongRing, entranceAdjustments } from '../../src/app/canvas/outlineEntrances';
import { applyMapCommand } from '../../src/domain/commands';
import { loadMap } from '../../src/domain/load';
import type { Polygon, YardMap } from '../../src/domain/model';
import { pointInPolygon } from '../../src/geometry/relations';
import { insertPolygonVertex, movePolygonVertex, rectangleFrame, removePolygonVertex, resizeRectangleCorner } from '../../src/geometry/rectangles';

const ring = (points: number[][]): Polygon['outer'] => [...points, points[0]!].map(([x, y]) => [x!, y!, 0]) as Polygon['outer'];
const square = ring([[0, 0], [10, 0], [10, 10], [0, 10]]);

describe('points on an outline go with its edit', () => {
  it('keep their edge and fraction when vertices move; a corner stays on its corner', () => {
    const moved = ring([[0, 0], [20, 0], [10, 10], [0, 10]]);
    expect(carryAlongRing(square, moved, [[5, 0, 0], [10, 0, 0], [10, 5, 0], [0, 5, 3]])).toEqual([[10, 0, 0], [20, 0, 0], [15, 5, 0], [0, 5, 3]]);
  });
  it('follow a rectangle rebuilt from its frame (its vertices renumbered)', () => {
    const renumbered = ring([[10, 0], [12, 12], [0, 12], [0, 0]]).map(point => point);
    // Same outline as [[0,0],[10,0],[12,12]...] rotated by one: the point on the bottom edge stays on the bottom edge.
    const carried = carryAlongRing(square, renumbered, [[5, 0, 0], [10, 5, 0]])!;
    expect(carried[0]).toEqual([5, 0, 0]);
    expect(carried[1]).toEqual([11, 6, 0]);
    const rect = square, frame = rectangleFrame({ outer: rect, holes: [] })!;
    const resized = resizeRectangleCorner(frame, 2, [14, 12, 0]).boundary.outer;
    expect(carryAlongRing(rect, resized, [[5, 0, 0], [10, 10, 0]])).toEqual([[7, 0, 0], [14, 12, 0]]);
  });
  it('follow a vertex inserted into their edge and dragged, along the new two edges', () => {
    const inserted = movePolygonVertex(insertPolygonVertex({ outer: square, holes: [] }, 0, 0), 0, 1, [5, -5, 0]).outer;
    const [a, b, c] = carryAlongRing(square, inserted, [[2.5, 0, 0], [5, 0, 0], [10, 5, 0]])!;
    // A quarter of the old edge is a quarter of the new broken edge (both halves are equally long).
    expect(a![0]).toBeCloseTo(2.5, 9); expect(a![1]).toBeCloseTo(-2.5, 9);
    expect(b).toEqual([5, -5, 0]);
    expect(c).toEqual([10, 5, 0]);
  });
  it('follow a removed vertex onto the joined edge, including the first vertex', () => {
    const removed = removePolygonVertex({ outer: ring([[0, 0], [5, -5], [10, 0], [10, 10], [0, 10]]), holes: [] }, 0, 1).outer;
    const before = ring([[0, 0], [5, -5], [10, 0], [10, 10], [0, 10]]);
    const [mid, onOther] = carryAlongRing(before, removed, [[5, -5, 0], [10, 5, 0]])!;
    expect(mid![0]).toBeCloseTo(5, 9); expect(mid![1]).toBeCloseTo(0, 9);
    expect(onOther).toEqual([10, 5, 0]);
    const first = removePolygonVertex({ outer: before, holes: [] }, 0, 0).outer;
    const [corner] = carryAlongRing(before, first, [[0, 0, 0]])!;
    // The corner (0, 0) was the removed vertex: it lands on the joined edge (0, 10) → (5, −5).
    expect(pointInPolygon(corner!, { outer: first, holes: [] })).toBe('boundary');
  });
  it('gives up on other changes, and on points not on the outline', () => {
    expect(carryAlongRing(square, ring([[0, 0], [4, -1], [6, -1], [10, 0], [10, 10], [0, 10]]), [[5, 0, 0]])).toBeNull();
    expect(carryAlongRing(square, ring([[0, 0], [11, 0], [10, 10], [0, 10]]), [[5, 5, 0]])).toEqual([null]);
  });
});

// The example's workshop covers 0–60 × 0–30 m; its own entrance sits on a public node at the corner (0, 0).
const EXAMPLE = new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url);
function example(change: (map: Record<string, Record<string, unknown>>) => void = () => {}): YardMap {
  const json = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
  change(json);
  const loaded = loadMap(JSON.stringify(json));
  if (!loaded.ok) throw new Error(loaded.report.issues.map(issue => issue.message).join('\n'));
  return loaded.map;
}
/** The workshop with a side door (own node, on the right wall), a gate on the top wall with a straight road to it, and a
 *  research access point 5 m outside. */
function doors(change: (map: Record<string, Record<string, unknown>>) => void = () => {}): YardMap {
  return example(json => {
    type Json = Record<string, unknown>;
    const node = (name: string, position: number[], kind = 'access') => ({ name, position, kind, provenance: { category: 'drawing' } });
    json.nodes!.nSide = node('侧门节点', [60, 10, 0]);
    json.accessPoints!.aSide = { name: '侧门', facilityId: 'fWorkshop', nodeId: 'nSide', provenance: { category: 'drawing' } };
    json.nodes!.nGate = node('门节点', [30, 30, 0]); json.nodes!.nNorth = node('北路端', [30, 50, 0], 'ordinary');
    json.roads!.rGate = { ...(json.roads!.rMain as Json), name: '门口路', fromNodeId: 'nNorth', toNodeId: 'nGate', shapePoints: [] };
    json.accessPoints!.aGate = { name: '大门', facilityId: 'fWorkshop', nodeId: 'nGate', provenance: { category: 'drawing' } };
    json.nodes!.nOut = node('研究接入节点', [30, 35, 0]);
    json.accessPoints!.aOut = { name: '研究接入', facilityId: 'fWorkshop', nodeId: 'nOut', provenance: { category: 'design_assumption' } };
    (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aSide', 'aGate', 'aOut');
    change(json);
  });
}
const outline = (map: YardMap): Polygon => map.facilities.fWorkshop!.boundary;
const workshop = (map: YardMap): Target => ({ kind: 'facilities', id: 'fWorkshop', boundary: outline(map), mode: 'free' });

describe("a building's entrances with an outline edit", () => {
  it('are carried when on the outline and free to move; ones off it, or fixed on a public node, are not', () => {
    const map = doors();
    // The top-right corner (60, 30) out to (70, 40): the side door on the right wall and the gate on the top wall move.
    const boundary = movePolygonVertex(outline(map), 0, 2, [70, 40, 0]);
    const adjustments = entranceAdjustments(map, 'fWorkshop', boundary);
    expect(adjustments.map(entry => entry.id).sort()).toEqual(['aGate', 'aSide']);
    expect(adjustments.find(entry => entry.id === 'aSide')!.position).toEqual([60 + 10 / 3, 10 + 10 / 3, 0].map((value, i) => i < 2 ? expect.closeTo(value, 9) : value));
    expect(adjustments.find(entry => entry.id === 'aGate')!.position).toEqual([35, 35, 0]);
    // The corner entrance on the public node (0, 0) is not carried; this edit does not move it anyway.
    expect(adjustments.some(entry => entry.id === 'aWorkshop' || entry.id === 'aOut')).toBe(false);
  });
  it('make an outline edit go through that the kernel refused before, in one transaction, the gate road stretched', () => {
    const map = doors(), boundary = movePolygonVertex(outline(map), 0, 2, [70, 40, 0]);
    const plain = applyMapCommand(map, { type: 'updateFacility', id: 'fWorkshop', patch: { boundary } });
    expect(plain.ok ? 'ok' : plain.issues.find(issue => issue.severity === 'error')?.code).toBe('OWNER_ENTRANCE_REPOSITION_REQUIRED');
    const change = editCommand(map, workshop(map), { boundary, label: '' })!;
    expect(change.command).toMatchObject({ type: 'updateFacility', entranceAdjustments: expect.any(Array) });
    const result = applyMapCommand(map, change.command);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const id of ['aSide', 'aGate']) expect(pointInPolygon(result.map.nodes[result.map.accessPoints[id]!.nodeId]!.position, result.map.facilities.fWorkshop!.boundary)).toBe('boundary');
    expect(result.map.nodes.nGate!.position).toEqual([35, 35, 0]);
    expect(result.map.nodes.nNorth!.position).toEqual([30, 50, 0]);
    expect(result.map.nodes.nOut!.position).toEqual([30, 35, 0]);
  });
  it('an edit that leaves a fixed entrance off the outline is still refused, with the reason', () => {
    const map = doors(), boundary = movePolygonVertex(outline(map), 0, 0, [-2, -2, 0]);
    const change = editCommand(map, workshop(map), { boundary, label: '' })!;
    const result = applyMapCommand(map, change.command);
    expect(result.ok ? 'ok' : result.issues.find(issue => issue.severity === 'error')?.code).toBe('OWNER_ENTRANCE_REPOSITION_REQUIRED');
  });
  it("for any other change, the kernel's nearest point on the new outline", () => {
    const map = doors(), boundary = { outer: [[0, 0, 0], [62, 0, 0], [62, 15, 0], [63, 20, 0], [62, 30, 0], [0, 30, 0], [0, 0, 0]], holes: [] } as unknown as Polygon;
    expect(entranceAdjustments(map, 'fWorkshop', boundary)).toEqual([{ id: 'aSide', position: [62, 10, 0] }]);
  });
  it('moves two entrances on one node once', () => {
    const map = doors(json => {
      json.accessPoints!.aSide2 = { name: '侧门二', facilityId: 'fWorkshop', nodeId: 'nSide', provenance: { category: 'drawing' } };
      (json.facilities!.fWorkshop as { accessPointIds: string[] }).accessPointIds.push('aSide2');
    });
    const boundary = movePolygonVertex(outline(map), 0, 2, [70, 40, 0]), adjustments = entranceAdjustments(map, 'fWorkshop', boundary);
    expect(adjustments.filter(entry => entry.id === 'aSide' || entry.id === 'aSide2')).toHaveLength(1);
    expect(applyMapCommand(map, { type: 'updateFacility', id: 'fWorkshop', patch: { boundary }, entranceAdjustments: adjustments }).ok).toBe(true);
  });
  it('an edit away from every entrance adds no adjustments', () => {
    const map = doors(), boundary = insertPolygonVertex(outline(map), 0, 0);
    expect(entranceAdjustments(map, 'fWorkshop', boundary)).toEqual([]);
    expect(editCommand(map, workshop(map), { boundary, label: '' })!.command).not.toHaveProperty('entranceAdjustments');
  });
});
