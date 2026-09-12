import type { CapabilityReport, YardMap } from './model';
import { inspectPlanning } from './planning';

/** Global protection only. Individual commands still need commandSupport. */
export function mapCapabilities(map: YardMap, planning = inspectPlanning(map)): CapabilityReport {
  const unrendered: string[] = [];
  const reasons: string[] = [];
  const unchecked = ['crossing_classification', 'turn_reachability', 'resource_execution', 'physical_clearance', 'asset_availability', 'source_authenticity'];
  for (const key of ['assets', 'backgroundLayers'] as const) {
    if (Object.keys(map[key]).length > 0) { unrendered.push(key); reasons.push(`尚不支持 ${key} 的同步编辑，原始数据完整保留。`); }
  }
  if (Object.keys(map.movements).length) unrendered.push('movements_without_display_geometry');
  if (map.coordinateFrame.geographicAnchor) unchecked.push('geographic_anchor_accuracy', 'geographic_reprojection');
  if (Object.values(map.roads).some(r => r.corridorPolygon)) unrendered.push('roads.corridorPolygon');
  for (const [namespace, declaration] of Object.entries(map.extensionNamespaces)) {
    const recognized = namespace === 'sr02.planning' && planning.supported;
    if (declaration.category !== 'metadata' && !recognized) {
      reasons.push(`未支持扩展 ${namespace} 的 ${declaration.category} 语义，整图只读。`);
      unrendered.push(`extensions.${namespace}`);
    }
  }
  if (planning.present && !planning.supported && !reasons.length) reasons.push('sr02.planning 的版本、载荷或依赖不受支持，整图只读。');
  return { editable: reasons.length === 0, unrendered, unchecked, reasons };
}
