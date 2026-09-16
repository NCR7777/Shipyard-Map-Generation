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
  const label = collection === 'facilities' ? '建筑分类' : '区域分类';
  const showDepth = collection === 'zones' && (draft.classId === 'dry_dock' || draft.depth !== '' || draft.reference !== '');
  return <section aria-label="详细用途与深度">
    <label className="field-label">{label}<select aria-label={label} disabled={disabled} value={draft.classId} onChange={event => onChange({ ...draft, classId: event.target.value })}>
      <option value="" disabled>未设置详细分类</option>{getSpatialClasses(map, collection).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
    </select></label>
    <p className="field-note">分类不改变基础类型、通行声明或几何。自定义分类在左侧“建筑与区域分类”中管理。</p>
    {unsupported && <p className="field-note">此分类数据版本尚不支持，已保留原内容；普通属性仍可编辑。</p>}
    {showDepth && <fieldset disabled={disabled}><legend>干船坞深度</legend>
      <label className="field-label">深度 (m)<input aria-label="干船坞深度 (m)" type="number" min="0" step="any" value={draft.depth} placeholder="未知" onChange={event => onChange(editSpatialDepthDraft(initial, draft, { depth: event.target.value, incomplete: event.target.validity.badInput }))}/></label>
      <label className="field-label">参照面说明<input aria-label="深度参照面" value={draft.reference} onChange={event => onChange(editSpatialDepthDraft(initial, draft, { reference: event.target.value }))}/></label>
      <label className="field-label">来源<select aria-label="深度来源" value={draft.sourceRef} onChange={event => onChange({ ...draft, sourceRef: event.target.value })}><option value="">本次设计假设（未经实测）</option>{Object.entries(map.sources).map(([id, source]) => <option key={id} value={id}>{source.name} · {source.category}</option>)}</select></label>
      <p className="field-note">空白为未知；已知深度必须注明参照面与来源。这是从注明参照面向下至坞底的结构深度，不等于水深或建筑高度；不改变边界 Z；切换区域分类仍保留已填深度。</p>
    </fieldset>}
  </section>;
}
