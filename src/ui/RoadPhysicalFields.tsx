import type { MapRoad, PhysicalValue, YardMap } from '../domain/model';
import type { PropertyUnits } from '../editor/projectController';
import { DEFAULT_PROPERTY_UNITS } from '../editor/projectController';
import { sameValue } from '../domain/value';
import { readNumber, unitFactor } from './propertyFields';

export const physicalFields = ['widthM', 'heightLimitM', 'massLimitKg', 'speedLimitMps'] as const;
export type PhysicalField = typeof physicalFields[number];
export type PhysicalDraft = Record<PhysicalField, { state: PhysicalValue['state']; value: string; sourceRef: string; reason: string; unit?: string }>;
const names: Record<PhysicalField, string> = { widthM: '道路宽度', heightLimitM: '净高限制', massLimitKg: '承载限制', speedLimitMps: '速度限制' };
const states = { unknown: '待设置', unrestricted: '明确无限制', not_applicable: '不适用', known: '已声明' };
export function makePhysicalDraft(road: Pick<MapRoad, PhysicalField>): PhysicalDraft {
  return Object.fromEntries(physicalFields.map(field => {
    const value = road[field];
    return [field, { state: value.state, value: value.state === 'known' ? String(value.value) : '', sourceRef: value.state === 'known' ? value.sourceRef ?? '' : '', reason: value.state === 'known' ? '' : value.reason ?? '' }];
  })) as PhysicalDraft;
}
function parseField(field: PhysicalField, item: PhysicalDraft[PhysicalField]): PhysicalValue | string {
  if (item.state !== 'known') return { state: item.state, ...(item.reason.trim() ? { reason: item.reason.trim() } : {}) };
  const value = readNumber(item.value, unitFactor(item.unit ?? ''));
  if (value === null || value <= 0) return names[field] + '必须为大于零的有限数值；清空后将改为未知。';
  return { state: 'known', value, ...(item.sourceRef ? { sourceRef: item.sourceRef } : {}) };
}
export function parsePhysicalPatch(road: Pick<MapRoad, PhysicalField>, draft: PhysicalDraft): { ok: true; patch: Partial<Pick<MapRoad, PhysicalField>>; needsAssumption: boolean } | { ok: false; message: string } {
  const initial = makePhysicalDraft(road), patch: Partial<Pick<MapRoad, PhysicalField>> = {};
  for (const field of physicalFields) {
    if (sameValue(initial[field], draft[field])) continue;
    const parsed = parseField(field, draft[field]); if (typeof parsed === 'string') return { ok: false, message: parsed };
    if (!sameValue(road[field], parsed)) patch[field] = parsed;
  }
  return { ok: true, patch, needsAssumption: Object.values(patch).some(value => value.state === 'known' && !value.sourceRef) };
}
export function editPhysicalNumber(original: Pick<MapRoad, PhysicalField> | undefined, draft: PhysicalDraft, field: PhysicalField, value: string, unit: string, incomplete = false): PhysicalDraft {
  const before = original?.[field], parsed = readNumber(value, unitFactor(unit));
  if (before?.state === 'known' && parsed === before.value) return { ...draft, [field]: makePhysicalDraft(original!)[field] };
  return { ...draft, [field]: { ...draft[field], state: incomplete || value.trim() ? 'known' : 'unknown', value, sourceRef: '', reason: '', unit } };
}
/** Display units never rewrite the draft. Only actual field input creates a proposal. */
export function RoadPhysicalFields({ draft, onChange, readonly, sources, original, propertyUnits = DEFAULT_PROPERTY_UNITS, onPropertyUnitsChange }: {
  draft: PhysicalDraft; onChange(value: PhysicalDraft): void; readonly: boolean; sources: YardMap['sources'];
  original?: Pick<MapRoad, PhysicalField>; propertyUnits?: PropertyUnits; onPropertyUnitsChange?(units: PropertyUnits): void;
}) {
  const unit = (field: PhysicalField) => field === 'massLimitKg' ? propertyUnits.mass : field === 'speedLimitMps' ? propertyUnits.speed : 'm';
  function change(field: PhysicalField, patch: Partial<PhysicalDraft[PhysicalField]>) { onChange({ ...draft, [field]: { ...draft[field], ...patch } }); }
  function numeric(field: PhysicalField, value: string, incomplete: boolean) { onChange(editPhysicalNumber(original, draft, field, value, unit(field), incomplete)); }
  function control(field: PhysicalField) {
    const item = draft[field], currentUnit = unit(field);
    const base = readNumber(item.value, unitFactor(item.unit ?? ''));
    const displayed = base === null ? null : base / unitFactor(currentUnit);
    const overflow = item.state === 'known' && base !== null && (!Number.isFinite(displayed) || base !== 0 && displayed === 0);
    const text = overflow ? '' : item.state === 'known' ? item.unit === currentUnit ? item.value : base === null ? item.value : String(base / unitFactor(currentUnit)) : '';
    const label = names[field] + ' (' + currentUnit + ')';
    return <fieldset key={field} disabled={readonly}><legend>{label}</legend>
      <label className="field-label">{names[field]}<input type="number" step="any" aria-label={label + ' 数值'} disabled={overflow} value={text} placeholder={states[item.state]} onChange={e => numeric(field, e.target.value, e.target.validity.badInput)} /></label>
      {overflow && <p className="field-note">超出当前单位的有限显示范围；原值保留，请切换基础单位。</p>}
      <p className="field-note">{states[item.state]}{original?.[field].state === 'known' && item.state === 'unknown' ? ' · 应用后将改为未知，尚未提交' : ''}{item.state === 'known' ? item.sourceRef ? ' · ' + (sources[item.sourceRef]?.name ?? item.sourceRef) : ' · 本次设计假设，未经实测' : ''}</p>
      <details><summary>{names[field]}状态与依据</summary>
        <label className="field-label">状态<select aria-label={label + ' 状态'} value={item.state} onChange={e => change(field, { state: e.target.value as PhysicalValue['state'] })}>{Object.entries(states).map(([state, name]) => <option key={state} value={state}>{name}</option>)}</select></label>
        {item.state === 'known' ? <label className="field-label">依据<select aria-label={label + ' 来源'} value={item.sourceRef} onChange={e => change(field, { sourceRef: e.target.value })}><option value="">本次设计假设</option>{Object.entries(sources).map(([id, source]) => <option key={id} value={id}>{source.name} · {source.category}</option>)}</select></label> : <label className="field-label">说明<input aria-label={label + ' 说明'} value={item.reason} onChange={e => change(field, { reason: e.target.value })}/></label>}
      </details>
    </fieldset>;
  }
  return <div className="physical-fields">{control('widthM')}<p className="field-note">整条道路记录宽度；不是单车道宽度或已测净宽。</p>
    <details><summary>通行限制与来源</summary>
      <label className="field-label">质量显示单位<select aria-label="质量显示单位" value={propertyUnits.mass} disabled={!onPropertyUnitsChange} onChange={e => onPropertyUnitsChange?.({ ...propertyUnits, mass: e.target.value as PropertyUnits['mass'] })}><option value="t">t</option><option value="kg">kg</option></select></label>
      <label className="field-label">速度显示单位<select aria-label="速度显示单位" value={propertyUnits.speed} disabled={!onPropertyUnitsChange} onChange={e => onPropertyUnitsChange?.({ ...propertyUnits, speed: e.target.value as PropertyUnits['speed'] })}><option value="km/h">km/h</option><option value="m/s">m/s</option></select></label>
      {physicalFields.filter(field => field !== 'widthM').map(control)}
    </details>
  </div>;
}
