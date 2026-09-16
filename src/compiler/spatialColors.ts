import type { YardMap } from '../domain/model';
import { getSpatialClassification, getSpatialClasses, SPATIAL_CLASSIFICATION_NAMESPACE, type SpatialCollection } from '../domain/spatialClassification';

/** Display only: classification colors never imply passability, capacity or field verification. */
export interface SpatialAppearance { classId?: string; classLabel: string; color: string; stroke: string; selectedStroke: string }
const COLORS: Record<SpatialCollection, Record<string, string>> = {
  facilities: {
    building: '#8c8178', workshop: '#df7628', warehouse: '#8758b8', office: '#3f8ac4', residential: '#cb659a',
    power_house: '#c6a128', maintenance_workshop: '#966444', paint_workshop: '#dc4f76', assembly_workshop: '#289d95', security_house: '#596b83',
  },
  zones: {
    unclassified: '#879b95', dock_unspecified: '#7a8795', dry_dock: '#477dc2', floating_dock: '#6a67a9',
    yard: '#53a890', assembly_yard: '#8b67b5', quay: '#42a5af', water: '#82b7df', parking: '#cfab39', buffer: '#98b97b',
    slipway: '#d48948', logistics: '#3a9b82', road_reserve: '#8e9fab', restricted: '#c65f5b',
  },
};
const outlines = (collection: SpatialCollection, color: string) => ({
  stroke: color.replace(/[0-9a-f]{2}/g, channel => Math.round(parseInt(channel, 16) * 0.65).toString(16).padStart(2, '0')),
  selectedStroke: collection === 'facilities' ? '#e07012' : '#a93e96',
});
/** A custom ID determines its color, independent of catalog order, label, project or persistence. */
export function spatialClassColor(collection: SpatialCollection, classId: string): string {
  if (Object.hasOwn(COLORS[collection], classId)) return COLORS[collection][classId]!;
  let hash = 2166136261;
  for (let i = 0; i < classId.length; i++) hash = Math.imul(hash ^ classId.charCodeAt(i), 16777619) >>> 0;
  const rgb = collection === 'facilities'
    ? [160 + (hash & 63), 60 + ((hash >>> 8) & 63), 52 + ((hash >>> 16) & 63)]
    : [42 + (hash & 63), 100 + ((hash >>> 8) & 63), 135 + ((hash >>> 16) & 63)];
  return '#' + rgb.map(value => value.toString(16).padStart(2, '0')).join('');
}
/** Missing/unsupported classification uses only the declared coarse kind; never infer a dry dock. */
export function legacySpatialAppearance(collection: SpatialCollection, kind: string): SpatialAppearance {
  const labels: Record<string, string> = collection === 'facilities'
    ? { building: '通用建筑', workshop: '厂房', yard: '堆场（历史设施）', assembly: '总组区（历史设施）', dock: '船坞（类型待确认，历史设施）', quay: '码头（历史设施）', other: '其他建筑' }
    : { unclassified: '未分类区域', work: '作业区', buffer: '缓冲区', waiting: '等待区', water: '水域', obstacle: '障碍区', drivable: '可通行区', forbidden: '禁入区' };
  const colors: Record<string, string> = collection === 'facilities'
    ? { building: COLORS.facilities.building!, workshop: COLORS.facilities.workshop!, yard: COLORS.zones.yard!, assembly: COLORS.zones.assembly_yard!, dock: COLORS.zones.dock_unspecified!, quay: COLORS.zones.quay!, other: '#8c8178' }
    : { unclassified: COLORS.zones.unclassified!, work: '#6f9cba', buffer: COLORS.zones.buffer!, waiting: '#a89962', water: COLORS.zones.water!, obstacle: COLORS.zones.restricted!, forbidden: COLORS.zones.restricted!, drivable: '#82a074' };
  const color = Object.hasOwn(colors, kind) ? colors[kind]! : collection === 'facilities' ? '#8c8178' : '#879b95';
  return { classLabel: (labels[kind] ?? kind) + ' · 未设置详细分类', color, ...outlines(collection, color) };
}
export function spatialAppearance(map: YardMap, collection: SpatialCollection, id: string): SpatialAppearance {
  const entity = map[collection][id];
  const classification = getSpatialClassification(map, collection, id);
  const definition = classification && getSpatialClasses(map, collection).find(item => item.id === classification.classId);
  if (definition) {
    const color = spatialClassColor(collection, definition.id);
    return { classId: definition.id, classLabel: definition.label, color, ...outlines(collection, color) };
  }
  const fallback = legacySpatialAppearance(collection, entity?.kind ?? 'unknown');
  if (entity?.extensions?.[SPATIAL_CLASSIFICATION_NAMESPACE] !== undefined) fallback.classLabel = fallback.classLabel.replace('未设置详细分类', '详细分类未识别，按基础类型显示');
  return fallback;
}
