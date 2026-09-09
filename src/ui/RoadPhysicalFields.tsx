import type { MapRoad, PhysicalValue, YardMap } from '../domain/model';

export const physicalFields = ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps'] as const;
export type PhysicalField = typeof physicalFields[number];
export type PhysicalDraft = Record<PhysicalField, { state: PhysicalValue['state']; value: string; sourceRef: string; reason: string }>;
const labels: Record<PhysicalField, string> = {
  widthM: '道路宽度 (m)', heightLimitM: '净高限制 (m)', massLimitKg: '承载限制 (kg)', speedLimitMps: '速度限制 (m/s)',
};

export function makePhysicalDraft(road: Pick<MapRoad, PhysicalField>): PhysicalDraft {
  return Object.fromEntries(physicalFields.map(field => {
    const value = road[field];
    return [field, { state: value.state, value: value.state === 'known' ? String(value.value) : '', sourceRef: value.state === 'known' ? value.sourceRef ?? '' : '', reason: value.state === 'known' ? '' : value.reason ?? '' }];
  })) as PhysicalDraft;
}

export function parsePhysicalDraft(draft: PhysicalDraft): { ok: true; values: Pick<MapRoad, PhysicalField>; needsAssumption: boolean } | { ok: false; message: string } {
  const values = {} as Pick<MapRoad, PhysicalField>;
  let needsAssumption = false;
  for (const field of physicalFields) {
    const item = draft[field];
    if (item.state === 'known') {
      const number = Number(item.value);
      if (!item.value.trim() || !Number.isFinite(number) || number <= 0) return { ok: false, message: labels[field] + ' 必须为大于零的有限数值；未知请选择 unknown。' };
      values[field] = { state: 'known', value: number, ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}) };
      if (!item.sourceRef) needsAssumption = true;
    } else values[field] = { state: item.state, ...(item.reason.trim() ? { reason: item.reason.trim() } : {}) };
  }
  return { ok: true, values, needsAssumption };
}

/** Controlled form only. Its parent submits all changes through one domain command. */
export function RoadPhysicalFields({ draft, onChange, readonly, sources }: {
  draft: PhysicalDraft;
  onChange: (value: PhysicalDraft) => void;
  readonly: boolean;
  sources: YardMap['sources'];
}) {
  function change(field: PhysicalField, patch: Partial<PhysicalDraft[PhysicalField]>) {
    onChange({ ...draft, [field]: { ...draft[field], ...patch } });
  }
  function fieldControl(field: PhysicalField) {
    return <fieldset key={field} disabled={readonly}>
      <legend>{labels[field]}</legend>
      <label className="field-label">状态<select aria-label={labels[field] + ' 状态'} value={draft[field].state} onChange={event => change(field, { state: event.target.value as PhysicalValue['state'] })}>
        <option value="unknown">unknown · 未知</option><option value="known">known · 已声明数值</option><option value="unrestricted">unrestricted · 声明无限制</option><option value="not_applicable">not_applicable · 不适用</option>
      </select></label>
      {draft[field].state === 'known' ? <>
        <label className="field-label">数值<input type="number" step="any" aria-label={labels[field] + ' 数值'} value={draft[field].value} onChange={event => change(field, { value: event.target.value })} /></label>
        <label className="field-label">依据<select aria-label={labels[field] + ' 来源'} value={draft[field].sourceRef} onChange={event => change(field, { sourceRef: event.target.value })}>
          <option value="">设计假设（创建来源记录）</option>
          {Object.entries(sources).map(([id, source]) => <option key={id} value={id}>{source.name} · {source.category}</option>)}
        </select></label>
      </> : <label className="field-label">说明<input aria-label={labels[field] + ' 说明'} value={draft[field].reason} onChange={event => change(field, { reason: event.target.value })} /></label>}
    </fieldset>;
  }
  return <div className="physical-fields">
    {fieldControl('widthM')}
    <p className="field-note">widthM 是既有记录的道路整体横向宽度，不是单车道宽度。画布以中心线两侧各一半绘制近似道路带；旧数据未区分铺装宽度与净宽时，请核对来源。</p>
    <p className="field-note">unknown、无限制和不适用不是零，也不代填可视宽度。没有来源的新数值将登记为设计假设；不是实测值。</p>
    <details>
      <summary>物理参数与来源</summary>
      {physicalFields.filter(field => field !== 'widthM').map(fieldControl)}
    </details>
  </div>;
}
