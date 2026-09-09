import type { CapabilityReport, YardMap } from './model';

export function mapCapabilities(map: YardMap): CapabilityReport {
  const unrendered: string[] = [];
  const reasons: string[] = [];
  const unchecked = ['polygon_geometry', 'crossing_classification', 'turn_reachability', 'resource_execution', 'physical_clearance', 'asset_availability', 'source_authenticity'];
  for (const key of ['junctions', 'movements', 'facilities', 'accessPoints', 'servicePoints', 'zones', 'resources', 'assets', 'backgroundLayers'] as const) {
    if (Object.keys(map[key]).length > 0) { unrendered.push(key); reasons.push(`M1 不支持编辑 ${key}，原始数据完整保留。`); }
  }
  if (map.siteBoundary) { unrendered.push('siteBoundary'); reasons.push('M1 不支持厂区边界编辑。'); }
  if (map.coordinateFrame.geographicAnchor) reasons.push('地理锚定转换尚未实现。');
  if (Object.values(map.roads).some(r => r.corridorPolygon)) {
    unrendered.push('roads.corridorPolygon'); reasons.push('存在人工道路边界；M1 不支持其同步编辑。');
  }
  for (const [namespace, declaration] of Object.entries(map.extensionNamespaces)) {
    if (declaration.category === 'behavior') reasons.push(`未支持行为扩展 ${namespace}，整图只读。`);
    if (declaration.category !== 'metadata') unrendered.push(`extensions.${namespace}`);
  }
  return { editable: reasons.length === 0, unrendered, unchecked, reasons };
}