import { useEffect, useState } from 'react';
import { changedFields, unitFactor } from './propertyFields';
import { DEFAULT_PROPERTY_UNITS, type PropertyUnits } from '../editor/projectController';
import type { MapNode, MapRoad, Vec3, YardMap } from '../domain/model';
import type { FacilityMovePolicy, ZoneMovePolicy, MapCommand } from '../domain/commands';
import { SpatialPropertyPanel, type SpatialSelection } from './SpatialPropertyPanel';
import { RoadPhysicalFields, makePhysicalDraft, parsePhysicalPatch, type PhysicalDraft } from './RoadPhysicalFields';
import { usePropertyDraft, type PropertyDraftProps } from '../editor/drafts';

export type RoadShapePreview = { roadId: string; shapePoints: Vec3[]; mapContentHash: string };

type NetworkSelection = { kind: 'node'; id: string; value: MapNode } | { kind: 'road'; id: string; value: MapRoad; lengthM: number };
type Props = PropertyDraftProps & {
  map: YardMap;
  propertyUnits?: PropertyUnits; onPropertyUnitsChange?: (units: PropertyUnits) => void;
  onPlaceAction?: (kind: 'facilities' | 'zones', id: string, action: 'enter' | 'access' | 'service') => void;
  onRelocatePoint?: (kind: 'accessPoints' | 'servicePoints', id: string) => void;
  onRoadPreset?: (roadId: string) => void; onRoadBatch?: (roadId: string) => void;
  mapContentHash: string;
  onRoadPreviewChange?: (preview: RoadShapePreview | null) => void;
  boundaryEditMode?: 'auto' | 'polygon';
  onBoundaryModeChange?: (mode: 'auto' | 'polygon') => void;
  zoneMovePolicy?: ZoneMovePolicy;
  facilityMovePolicy: FacilityMovePolicy;
  selected: NetworkSelection | SpatialSelection | null;
  readonly: boolean;
  count: number;
  onApply: (command: MapCommand) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

function vec(values: string[]): Vec3 | null {
  if (values.length !== 3 || values.some(value => value.trim() === '' || !Number.isFinite(Number(value)))) return null;
  return values.map(Number) as Vec3;
}

export function PropertyPanel(props: Props) {
  const { selected } = props;
  return <>{selected && selected.kind !== 'node' && selected.kind !== 'road'
    ? <SpatialPropertyPanel {...props} selected={selected} />
    : <NetworkPropertyPanel {...props} selected={selected} />}
    {selected?.value.provenance.fieldSources && <details className="provenance-note" data-testid="field-sources"><summary>字段来源</summary>
      {Object.entries(selected.value.provenance.fieldSources).map(([field, id]) => <div key={field}>{field}：{id} · {props.map.sources[id]?.name ?? '来源缺失'} · {props.map.sources[id]?.category}</div>)}
      人工几何修改不表示已实测或重新核验。
    </details>}</>;

}

function NetworkPropertyPanel({ selected, readonly, count, onApply, onDirtyChange, map, mapContentHash, onRoadPreviewChange, draftContext, onDraftChange, propertyUnits, onPropertyUnitsChange, onRoadPreset, onRoadBatch }: Omit<Props, 'selected'> & { selected: NetworkSelection | null }) {
  const units = propertyUnits ?? DEFAULT_PROPERTY_UNITS;
  const [physical, setPhysical] = useState<PhysicalDraft | null>(() => selected?.kind === 'road' ? makePhysicalDraft(selected.value) : null);
  const physicalPending = selected?.kind === 'road' && physical !== null && JSON.stringify(physical) !== JSON.stringify(makePhysicalDraft(selected.value));
  const [name, setName] = useState(selected?.value.name ?? '');
  const [coords, setCoords] = useState<string[]>(selected?.kind === 'node' ? selected.value.position.map(String) : []);
  const [shapePoints, setShapePoints] = useState<string[][]>(selected?.kind === 'road' ? selected.value.shapePoints.map(p => p.map(String)) : []);
  const [direction, setDirection] = useState<MapRoad['direction']>(selected?.kind === 'road' ? selected.value.direction : 'unknown');
  const [error, setError] = useState('');
  const pending = !!selected && (!!physicalPending || name !== selected.value.name || (selected.kind === 'node'
    ? JSON.stringify(coords) !== JSON.stringify(selected.value.position.map(String))
    : JSON.stringify(shapePoints) !== JSON.stringify(selected.value.shapePoints.map(point => point.map(String))) || direction !== selected.value.direction));
  useEffect(() => { onDirtyChange?.(pending); return () => onDirtyChange?.(false); }, [pending, onDirtyChange]);
  const roadId = selected?.kind === 'road' ? selected.id : null;
  const originalShapePoints = selected?.kind === 'road' ? selected.value.shapePoints : null;
  useEffect(() => {
    const points = shapePoints.map(vec);
    const changed = originalShapePoints !== null && JSON.stringify(points) !== JSON.stringify(originalShapePoints);
    onRoadPreviewChange?.(roadId && changed && points.every((point): point is Vec3 => point !== null)
      ? { roadId, shapePoints: points, mapContentHash } : null);
    return () => onRoadPreviewChange?.(null);
  }, [shapePoints, roadId, originalShapePoints, mapContentHash, onRoadPreviewChange]);
  usePropertyDraft(selected ? draftContext : undefined, pending, apply, onDraftChange);
  if (!selected) return <div className="empty-properties"><div className="empty-glyph">↖</div><strong>{count > 1 ? `已选择 ${count} 个对象` : '选择对象查看属性'}</strong><p>{count > 1 ? '可一起移动、复制；道路包含显式端点，设施按移动策略处理关联节点。' : '点击节点、道路、设施、区域或关联点，也可使用左侧对象列表。Shift 点击可多选。'}</p></div>;

  function apply(): boolean {
    if (!selected || readonly) { setError('请先选择一个可编辑对象，再应用属性。'); return false; }
    if (selected.kind === 'node') {
      const proposal: Partial<MapNode> = {};
      if (name !== selected.value.name) proposal.name = name;
      if (coords.some((v, i) => v !== String(selected.value.position[i]))) {
        const position = vec(coords);
        if (!position) { setError('XY/Z 必须为有限米制数值。'); return false; }
        proposal.position = position.map((v, i) => coords[i] === String(selected.value.position[i]) ? selected.value.position[i]! : v) as Vec3;
      }
      const patch = changedFields(selected.value, proposal);
      if (!Object.keys(patch).length) { setError(''); setCoords(selected.value.position.map(String)); return true; }
      const accepted = onApply({ type: 'updateNode', id: selected.id, patch }); if (accepted) setError(''); return accepted;
    }
    const proposal: Partial<MapRoad> = {};
    if (name !== selected.value.name) proposal.name = name;
    if (direction !== selected.value.direction) proposal.direction = direction;
    if (JSON.stringify(shapePoints) !== JSON.stringify(selected.value.shapePoints.map(p => p.map(String)))) {
      const points = shapePoints.map(vec);
      if (points.some(p => p === null)) { setError('折点 XYZ 必须为有限米制数值。'); return false; }
      proposal.shapePoints = points as Vec3[];
    }
    const parsed = physical ? parsePhysicalPatch(selected.value, physical) : { ok: true as const, patch: {}, needsAssumption: false };
    if (!parsed.ok) { setError(parsed.message); return false; }
    const patch = changedFields(selected.value, { ...proposal, ...parsed.patch });
    if (!Object.keys(patch).length) { setError(''); setShapePoints(selected.value.shapePoints.map(p => p.map(String))); setPhysical(makePhysicalDraft(selected.value)); return true; }
    const accepted = onApply({ type: 'updateRoad', id: selected.id, patch,
      ...(parsed.needsAssumption ? { designAssumption: { id: 'source_' + crypto.randomUUID(), name: '道路参数设计假设', description: '用户数值输入，未经现场核验' } } : {}),
    });
    if (accepted) setError(''); return accepted;
  }
  return <div className="property-content">
    <div className="entity-kind">{selected.kind === 'node' ? '网络节点' : '道路折线'}</div>
    <label className="field-label">名称<input aria-label="名称" value={name} onChange={event => setName(event.target.value)} disabled={readonly} /></label>
    {selected.kind === 'node' ? <>
      <div className="property-subheading">权威坐标 · m</div>
      <div className="coordinate-fields">{(['X', 'Y'] as const).map((axis, index) => <label className="field-label" key={axis}>{axis} (m)<input aria-label={axis + ' (m)'} type="number" step="any" value={coords[index] ?? ''} disabled={readonly} onChange={event => setCoords(values => values.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>
      <p className="field-note">连接道路 {Object.values(map.roads).filter(r => r.fromNodeId === selected.id || r.toNodeId === selected.id).length} 条；移动此点更新相邻道路端点。</p>
      <details><summary>技术详情</summary><label className="field-label">稳定 ID<input aria-label="稳定 ID" value={selected.id} readOnly /></label><label className="field-label">Z (m)<input aria-label="Z (m)" type="number" step="any" value={coords[2] ?? ''} disabled={readonly} onChange={e => setCoords(v => [v[0]!, v[1]!, e.target.value])}/></label><p>高程原值保留；{selected.value.provenance.category}</p></details>
    </> : <>
      <div className="measurement-card"><span>派生二维长度</span><strong><output data-testid="road-length">{Number(selected.lengthM.toPrecision(12))}</output><small> m</small></strong><p>端点 + 内部折点计算，只读</p></div>

      {physical && <RoadPhysicalFields draft={physical} onChange={setPhysical} readonly={readonly} sources={map.sources} original={selected.value} propertyUnits={propertyUnits} onPropertyUnitsChange={onPropertyUnitsChange} />}
      <label className="field-label">道路方向<select aria-label="道路方向" value={direction} disabled={readonly} onChange={event => setDirection(event.target.value as MapRoad['direction'])}><option value="unknown">待配置</option><option value="forward">沿箭头单向</option><option value="backward">沿反向箭头单向</option><option value="both">双向</option></select></label>
      {(direction === 'forward' || direction === 'backward') && <button disabled={readonly} onClick={() => setDirection(direction === 'forward' ? 'backward' : 'forward')}>反转行驶方向</button>}
      {onRoadBatch && <button disabled={readonly || pending} onClick={() => onRoadBatch(selected.id)}>连续路段一起修改</button>}
      {onRoadPreset && <button disabled={readonly || pending} onClick={() => onRoadPreset(selected.id)}>用于随后新建道路</button>}
      <p className="field-note">{(['heightLimitM', 'massLimitKg', 'speedLimitMps'] as const).flatMap(field => {
        const value = selected.value[field]; if (value.state !== 'known') return [];
        const unit = field === 'massLimitKg' ? units.mass : field === 'speedLimitMps' ? units.speed : 'm';
        const label = field === 'massLimitKg' ? '限载' : field === 'speedLimitMps' ? '限速' : '限高';
        const display = value.value / unitFactor(unit);
        return [label + ' ' + (Number.isFinite(display) ? Number(display.toPrecision(8)) + ' ' + unit : value.value + ' 基础单位')];
      }).join(' · ')}</p>
      <p className="field-note">{(['heightLimitM', 'massLimitKg', 'speedLimitMps'] as const).filter(f => selected.value[f].state === 'known').length} 项已声明限制 · {(['heightLimitM', 'massLimitKg', 'speedLimitMps'] as const).filter(f => selected.value[f].state === 'unknown').length} 项待配置</p>
      <details><summary>技术详情与折点</summary><label className="field-label">稳定 ID<input aria-label="稳定 ID" value={selected.id} readOnly /></label><dl className="reference-list"><dt>起点</dt><dd>{selected.value.fromNodeId}</dd><dt>终点</dt><dd>{selected.value.toNodeId}</dd></dl>
      <div className="property-subheading">内部折点 · m</div>
      <p className="field-note">按起点到终点排序；端点只引用节点。</p>
      {shapePoints.map((point, index) => <div key={index} className="shape-point"><span>{index + 1}</span>{(['X', 'Y', 'Z'] as const).map((axis, axisIndex) => <input key={axis} type="number" step="any" aria-label={`折点 ${index + 1} ${axis} (m)`} title={axis + ' (m)'} value={point[axisIndex] ?? ''} disabled={readonly} onChange={event => setShapePoints(points => points.map((p, i) => i === index ? p.map((v, j) => j === axisIndex ? event.target.value : v) : p))} />)}<button type="button" className="icon-button" aria-label={`删除折点 ${index + 1}`} disabled={readonly} onClick={() => setShapePoints(points => points.filter((_, i) => i !== index))}>×</button></div>)}
      <button type="button" className="subtle-button full-width" disabled={readonly} onClick={() => setShapePoints(points => [...points, points.at(-1) ? [...points.at(-1)!] : ['0', '0', '0']])}>添加内部折点</button>
      <p className="field-note">道路外观不决定通行约束；隐藏字段完整保留。</p></details>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button className="primary-button full-width" disabled={readonly} onClick={apply}>应用属性</button>
    <details className="provenance-note"><summary>来源声明</summary>{selected.value.provenance.category}；名称与位置变化保留稳定 ID，人工修改不表示重新核验。</details>
  </div>;
}
