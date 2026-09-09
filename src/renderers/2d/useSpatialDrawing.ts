import { useEffect, useState } from 'react';
import type { Polygon, Vec3 } from '../../domain/model';
import type { SceneSnapshot } from '../../adapters/contracts';
import { polygonFromVertices, rectanglePolygon } from '../../geometry/polygons';
import { screenToWorld, worldToScreen, type Camera, type Vec2 } from '../../geometry/coordinates';
import type { Tool } from './MapCanvas';
export interface SnapOptions { gridM: number | null; nodes: boolean }
export const isSpatialTool = (tool: Tool) => tool.startsWith('facility') || tool.startsWith('zone');
export const isRectangleTool = (tool: Tool) => tool === 'facilityRect' || tool === 'zoneRect';
export function snapPosition(screen: Vec2, camera: Camera, nodes: SceneSnapshot['nodes'], options?: SnapOptions, excluded = new Set<string>(), z = 0): { world: Vec3; nodeId?: string } {
  const world = screenToWorld(screen, camera, z);
  if (options?.nodes) {
    let closest: { id: string; distance: number; position: Vec3 } | null = null;
    for (const node of nodes) {
      if (excluded.has(node.id)) continue;
      const p = worldToScreen(node.position, camera); const distance = Math.hypot(screen[0] - p[0], screen[1] - p[1]);
      if (distance <= 12 && (!closest || distance < closest.distance)) closest = { id: node.id, distance, position: node.position };
    }
    if (closest) return { world: [closest.position[0], closest.position[1], z], nodeId: closest.id };
  }
  const step = options?.gridM;
  if (step && Number.isFinite(step) && step > 0) return { world: [Math.round(world[0] / step) * step, Math.round(world[1] / step) * step, z] };
  return { world };
}
export function useSpatialDrawing(tool: Tool, readonly: boolean, camera: Camera, onCreate?: (kind: 'facilities' | 'zones', polygon: Polygon) => boolean) {
  const [vertices, setVertices] = useState<Vec3[]>([]); const [error, setError] = useState('');
  useEffect(() => { setVertices([]); setError(''); }, [tool]);
  function emit(polygon: Polygon) { if (onCreate?.(tool.startsWith('facility') ? 'facilities' : 'zones', polygon)) { setVertices([]); setError(''); } }
  function finish() {
    if (readonly || !isSpatialTool(tool) || vertices.length < 3) return;
    try { emit(polygonFromVertices(vertices)); } catch (reason) { setError(reason instanceof Error ? reason.message : '多边形输入无效。'); }
  }
  function click(world: Vec3, screen: Vec2) {
    if (readonly || !isSpatialTool(tool)) return;
    if (isRectangleTool(tool)) {
      if (!vertices.length) setVertices([world]);
      else {
        const first = vertices[0]!;
        try { emit(rectanglePolygon([Math.min(first[0], world[0]), Math.min(first[1], world[1]), 0], Math.abs(first[0] - world[0]), Math.abs(first[1] - world[1]))); }
        catch (reason) { setError(reason instanceof Error ? reason.message : '矩形输入无效。'); }
      }
    } else {
      const first = vertices[0] ? worldToScreen(vertices[0], camera) : null;
      if (vertices.length >= 3 && first && Math.hypot(first[0] - screen[0], first[1] - screen[1]) <= 12) finish();
      else setVertices(points => [...points, world]);
    }
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (!isSpatialTool(tool) || (event.target as HTMLElement).closest('button,input,textarea,select,[contenteditable="true"],[role="dialog"]') || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') { setVertices([]); setError(''); }
      if (event.key === 'Enter' && !isRectangleTool(tool)) { event.preventDefault(); finish(); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  return { vertices, error, click, finish, cancel: () => { setVertices([]); setError(''); } };
}
