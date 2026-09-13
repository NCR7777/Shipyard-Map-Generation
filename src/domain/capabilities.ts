import type { CapabilityReport, YardMap } from './model';
import { inspectPlanning } from './planning';
import { inspectAsset, inspectBackground } from './backgrounds';

/** Global protection only. Individual commands still need commandSupport. */
export function mapCapabilities(map: YardMap, planning = inspectPlanning(map)): CapabilityReport {
  const unrendered: string[] = [];
  const reasons: string[] = [];
  const unchecked = ['crossing_classification', 'turn_reachability', 'resource_execution', 'physical_clearance', 'asset_availability', 'source_authenticity'];
  if (Object.values(map.assets).some(asset => !inspectAsset(asset).supported)) {
    unrendered.push('assets'); reasons.push('存在未支持的 assets 声明，原始数据完整保留。');
  }
  if (Object.keys(map.backgroundLayers).some(id => !inspectBackground(map, id).supported)) {
    unrendered.push('backgroundLayers'); reasons.push('存在未支持的 backgroundLayers 变换或像素约定，原始数据完整保留。');
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
