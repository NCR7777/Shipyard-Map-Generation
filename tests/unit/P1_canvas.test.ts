import { describe, expect, it } from 'vitest';
import type { Polygon, Vec3 } from '../../src/domain/model';
import { rectanglePolygon } from '../../src/geometry/polygons';
import { polygonTouchesBox, polylineTouchesBox, segmentTouchesBox } from '../../src/app/canvas/boxSelect';
import { createDisplayIndex, createTextMeasurer, layoutLabels, selectDisplay } from '../../src/app/canvas/display';
import { toSceneSnapshot } from '../../src/compiler/scene';
import { editorFixture } from '../helpers/M1_fixtures';

const box = { minX: 0, minY: 0, maxX: 10, maxY: 10 };

describe('crossing box selection uses exact geometry, not bounding boxes', () => {
  it('segments: crossing, touching, and diagonal misses whose bounding box overlaps', () => {
    expect(segmentTouchesBox([-5, 5, 0], [15, 5, 0], box)).toBe(true);
    expect(segmentTouchesBox([2, 2, 0], [3, 3, 0], box)).toBe(true);
    expect(segmentTouchesBox([10, 12, 0], [10, 20, 0], box)).toBe(false);
    expect(segmentTouchesBox([10, 10, 0], [20, 20, 0], box)).toBe(true);
    // On x + y = 25: its bounding box (-5..30, -5..30) covers the box, the line itself passes beside it.
    expect(segmentTouchesBox([-5, 30, 0], [30, -5, 0], box)).toBe(false);
  });
  it('polylines honour the road half width', () => {
    const road: Vec3[] = [[-5, 12, 0], [15, 12, 0]];
    expect(polylineTouchesBox(road, box)).toBe(false);
    expect(polylineTouchesBox(road, box, 2.5)).toBe(true);
  });
  it('polygons: edge crossing, box inside the area, and a diagonal area that only shares its bounding box', () => {
    // rectanglePolygon takes the lower-left corner.
    expect(polygonTouchesBox(rectanglePolygon([5, -20, 0], 4, 60), box)).toBe(true);
    expect(polygonTouchesBox(rectanglePolygon([-50, -50, 0], 100, 100), box)).toBe(true);
    const diagonal: Polygon = { outer: [[12, -20, 0], [40, 8, 0], [38, 10, 0], [10, -18, 0], [12, -20, 0]], holes: [] };
    expect(polygonTouchesBox(diagonal, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    const withHole: Polygon = { outer: rectanglePolygon([-50, -50, 0], 100, 100).outer, holes: [rectanglePolygon([-10, -10, 0], 30, 30).outer.slice().reverse() as Polygon['outer']] };
    expect(polygonTouchesBox(withHole, box)).toBe(false);
  });
});

it('labels show names first and fall back to the ID only when the name is blank', () => {
  const map = editorFixture();
  map.nodes.nA = { ...map.nodes.nA!, name: '  ' };
  const scene = toSceneSnapshot(map);
  const view = selectDisplay(createDisplayIndex(scene), { camera: { offsetX: 200, offsetY: 300, scale: 3 }, width: 800, height: 600 });
  const labels = layoutLabels(view, { camera: { offsetX: 200, offsetY: 300, scale: 3 }, width: 800, height: 600, mode: 'debug_all' }, createTextMeasurer(text => text.length * 6));
  const text = new Map(labels.labels.map(label => [label.key, label.text]));
  expect(text.get('nodes/nA')).toBe('nA');
  expect(text.get('nodes/nB')).toBe('B');
  for (const item of scene.items) if (item.name.trim() && text.has(item.key)) expect(text.get(item.key)).toBe(item.name.trim());
});
