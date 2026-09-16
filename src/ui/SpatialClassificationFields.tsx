import { SpatialColorSwatch } from './SpatialColorLegend';
import { spatialClassColor } from '../compiler/spatialColors';
import type { YardMap } from '../domain/model';
import { getSpatialClasses, type SpatialClassification, type SpatialCollection } from '../domain/spatialClassification';
import { sameValue } from '../domain/value';

export interface SpatialClassificationDraft { classId: string; depth: string; reference: string; sourceRef: string; incomplete: boolean }
export function makeSpatialClassificationDraft(value?: SpatialClassification): SpatialClassificationDraft {
  return { classId: value?.classId ?? '', depth: value?.depthM?.state === 'known' ? String(value.depthM.value) : '', reference: value?.depthReference ?? '', sourceRef: value?.depthM?.state === 'known' ? value.depthM.sourceRef ?? '' : '', incomplete: false };
}
export function parseSpatialClassificationDraft(initial: SpatialClassification | undefined, draft: SpatialClassificationDraft):
  { ok: true; classification?: SpatialClassification; needsAssumption: boolean } | { ok: false; message: string } {
  const before = makeSpatialClassificationDraft(initial);
  if (draft.incomplete) return { ok: false, message: '干船坞深度数值尚未输入完整，请完成数值或明确清空。' };
  if (sameValue(before, draft)) return { ok: true, needsAssumption: false };
  if (!draft.classId) return { ok: false, message: '请选择建筑或区域分类。' };
  const classification: SpatialClassification = { ...initial, classId: draft.classId };
  if (draft.depth !== before.depth || draft.reference !== before.reference || draft.sourceRef !== before.sourceRef) {
    if (draft.depth.trim()) {
      const depth = Number(draft.depth);
      if (!Number.isFinite(depth) || depth <= 0) return { ok: false, message: '干船坞深度必须是大于零的有限米数；空白表示未知。' };
      if (!draft.reference.trim()) return { ok: false, message: '已知深度必须填写参照面说明。' };
      classification.depthM = { state: 'known', value: depth, ...(draft.sourceRef ? { sourceRef: draft.sourceRef } : {}) };
    } else classification.depthM = { state: 'unknown' };
    if (draft.reference.trim()) classification.depthReference = draft.reference.trim(); else delete classification.depthReference;
  }
  return { ok: true, classification, needsAssumption: classification.depthM?.state === 'known' && !classification.depthM.sourceRef };
}

export function editSpatialDepthDraft(initial: SpatialClassification | undefined, draft: SpatialClassificationDraft, patch: Partial<Pick<SpatialClassificationDraft, 'depth' | 'reference' | 'incomplete'>>): SpatialClassificationDraft {
  const next = { ...draft, ...patch, sourceRef: '' };
  if (!next.incomplete && initial?.depthM?.state === 'known' && next.depth.trim() && Number(next.depth) === initial.depthM.value && next.reference.trim() === (initial.depthReference ?? '')) next.sourceRef = initial.depthM.sourceRef ?? '';
  return next;
}

export function SpatialClassificationFields({ map, collection, draft, initial, onChange, disabled, unsupported }: {
  map: YardMap; collection: SpatialCollection; draft: SpatialClassificationDraft; initial?: SpatialClassification; onChange(value: SpatialClassificationDraft): void; disabled: boolean; unsupported: boolean;
}) {
  const classes = getSpatialClasses(map, collection);
  const label = collection === 'facilities' ? '建筑分类' : '区域分类';
  const showDepth = collection === 'zones' && (draft.classId === 'dry_dock' || initial?.depthM !== undefined || draft.depth !== '' || draft.reference !== '');
  const dockDescription = collection !== 'zones' ? '' : draft.classId === 'dock_unspecified'
    ? '船坞类型尚未确认；请依据结构或可靠资料区分岸式干船坞与浮船坞，不能只凭影像中是否看见水判断。'
    : draft.classId === 'dry_dock'
      ? '岸式干船坞是可进水、关门后抽排水的岸上坞池；上方可有厂房，建筑轮廓与船坞区域允许叠加。'
      : draft.classId === 'floating_dock'
        ? '浮船坞是通过压载水升沉的浮式设备；这里的区域只记录其当前平面占位，不代表固定岸上坞池。'
        : '';
  return <section aria-label="详细用途与深度">
    <label className="field-label"><span className="spatial-color-label" title="应用属性后更新地图颜色">{!unsupported && classes.some(item => item.id === draft.classId) && <SpatialColorSwatch color={spatialClassColor(collection, draft.classId)}/>} {label}</span><select aria-label={label} disabled={disabled} value={draft.classId} onChange={event => onChange({ ...draft, classId: event.target.value })}>
      <option value="" disabled>未设置详细分类</option>{classes.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    <p className="field-note">建筑描实体边界，区域描功能占地，两者允许叠加。分类不改变通行声明或几何；自定义分类在左侧管理。</p>
    {dockDescription && <p className="field-note">{dockDescription}</p>}
    {unsupported && <p className="field-note">此分类数据版本尚不支持，已保留原内容；普通属性仍可编辑。</p>}
    {showDepth && <fieldset disabled={disabled}><legend>干船坞深度</legend>
      <label className="field-label">深度 (m)<input aria-label="干船坞深度 (m)" type="number" min="0" step="any" value={draft.depth} placeholder="未知" onChange={event => onChange(editSpatialDepthDraft(initial, draft, { depth: event.target.value, incomplete: event.target.validity.badInput }))}/></label>
      <label className="field-label">参照面说明<input aria-label="深度参照面" value={draft.reference} onChange={event => onChange(editSpatialDepthDraft(initial, draft, { reference: event.target.value }))}/></label>
      <label className="field-label">来源<select aria-label="深度来源" value={draft.sourceRef} onChange={event => onChange({ ...draft, sourceRef: event.target.value })}><option value="">本次设计假设（未经实测）</option>{Object.entries(map.sources).map(([id, source]) => <option key={id} value={id}>{source.name} · {source.category}</option>)}</select></label>
      <p className="field-note">空白为未知；已知值须注明参照面与来源。此值为参照面向下至坞底的结构深度，不等于坞口水深、允许吃水或建筑高度；不改变边界 Z，切换分类仍保留原值。</p>
    </fieldset>}
  </section>;
}
