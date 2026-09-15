import { useEffect, useState } from 'react';
import type { Polygon, Vec3 } from '../../domain/model';
import type { SceneSnapshot } from '../../adapters/contracts';
import { polygonFromVertices, rectanglePolygon } from '../../geometry/polygons';
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import type { Tool } from './MapCanvas';
import { orientedRectangleVertices, MIN_RECTANGLE_SIZE_M } from '../../geometry/rectangles';
export { orientedRectangleVertices } from '../../geometry/rectangles';
export interface SnapOptions { gridM: number | null; nodes: boolean }
export const isSpatialTool = (tool: Tool) => tool.startsWith('facility') || tool.startsWith('zone');
export const isRectangleTool = (tool: Tool) => tool === 'facilityRect' || tool === 'zoneRect' || tool === 'facilityOrientedRect' || tool === 'zoneOrientedRect';
export const isOrientedRectangleTool = (tool: Tool) => tool === 'facilityOrientedRect' || tool === 'zoneOrientedRect';
export function snapPosition(screen: Vec2, camera: Camera, nodes: SceneSnapshot['nodes'], options?: SnapOptions, excluded = new Set<string>(), z = 0): { world: Vec3; nodeId?: string } {
  const world = screenToWorld(screen, camera, z);
  if (options?.nodes) {
    let closest: { id: string; distance: number; position: Vec3 } | null = null;
    for (const node of nodes) {
      if (excluded.has(node.id) || Math.abs(node.position[2] - z) > 1e-6) continue;
      const p = worldToScreen(node.position, camera); const distance = Math.hypot(screen[0] - p[0], screen[1] - p[1]);
      if (distance <= 12 && (!closest || distance < closest.distance)) closest = { id: node.id, distance, position: node.position };
    }
    if (closest) return { world: [closest.position[0], closest.position[1], z], nodeId: closest.id };
  }
  const step = options?.gridM;
  if (step && Number.isFinite(step) && step > 0) return { world: [Math.round(world[0] / step) * step, Math.round(world[1] / step) * step, z] };
  return { world };
}
export function useSpatialDrawing(tool: Tool, readonly: boolean, camera: Camera, onCreate?: (kind: 'facilities' | 'zones', polygon: Polygon) => boolean, draftResetToken?: number) {
  const [vertices, setVertices] = useState<Vec3[]>([]); const [error, setError] = useState('');
  useEffect(() => { setVertices([]); setError(''); }, [tool, draftResetToken]);
  function emit(polygon: Polygon) { if (onCreate?.(tool.startsWith('facility') ? 'facilities' : 'zones', polygon)) { setVertices([]); setError(''); } }
  function finish() {
    if (readonly || !isSpatialTool(tool) || vertices.length < 3) return;
    try { emit(polygonFromVertices(vertices)); } catch (reason) { setError(reason instanceof Error ? reason.message : '多边形输入无效。'); }
  }
  function project(world: Vec3, shift: boolean): Vec3 {
    const anchor = vertices.at(-1);
    if (!shift || !anchor || isRectangleTool(tool)) return world;
    return Math.abs(world[0] - anchor[0]) >= Math.abs(world[1] - anchor[1]) ? [world[0], anchor[1], anchor[2]] : [anchor[0], world[1], anchor[2]];
  }
  function dragRectangle(a: Vec3, b: Vec3) {
    if (readonly || !isRectangleTool(tool) || isOrientedRectangleTool(tool)) return;
    try { emit(rectanglePolygon([Math.min(a[0], b[0]), Math.min(a[1], b[1]), a[2]], Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))); } catch (reason) { setError(reason instanceof Error ? reason.message : '矩形输入无效。'); }
  }
  function click(world: Vec3, screen: Vec2, complete = false, shift = false) {
    world = project(world, shift);
    if (readonly || !isSpatialTool(tool)) return;
    if (isOrientedRectangleTool(tool)) {
      if (vertices.length < 2) {
        const a = vertices[0], length = a ? Math.hypot(world[0] - a[0], world[1] - a[1]) : 1;
        if (!world.every(Number.isFinite) || !Number.isFinite(length) || length < MIN_RECTANGLE_SIZE_M || a && world[2] !== a[2]) { setError(`请选择同一水平面上的有效基边，长度至少 ${MIN_RECTANGLE_SIZE_M} m。`); return; }
        setVertices(points => [...points, [...world]]); setError('');
      }
      else { try { emit(polygonFromVertices(orientedRectangleVertices(vertices[0]!, vertices[1]!, world))); } catch (reason) { setError(reason instanceof Error ? reason.message : '矩形输入无效。'); } }
    } else if (isRectangleTool(tool)) {
      if (!vertices.length) setVertices([world]);
      else {
        const first = vertices[0]!;
        try { emit(rectanglePolygon([Math.min(first[0], world[0]), Math.min(first[1], world[1]), first[2]], Math.abs(first[0] - world[0]), Math.abs(first[1] - world[1]))); }
        catch (reason) { setError(reason instanceof Error ? reason.message : '矩形输入无效。'); }
      }
    } else {
      if (complete && vertices.length >= 3) { finish(); return; }
      const first = vertices[0] ? worldToScreen(vertices[0], camera) : null;
      if (vertices.length >= 3 && first && Math.hypot(first[0] - screen[0], first[1] - screen[1]) <= 12) finish();
      else setVertices(points => [...points, world]);
    }
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!isSpatialTool(tool) || (event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"],[role="dialog"]') || document.querySelector('[role="dialog"]')) return;

      if (event.key === 'Enter' && !isRectangleTool(tool)) { event.preventDefault(); finish(); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  return { vertices, error, click, finish, project, dragRectangle, cancel: () => { setVertices([]); setError(''); } };
}
