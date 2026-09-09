import { useEffect, useState } from 'react';
import type { MapNode, MapRoad, Vec3, YardMap } from '../domain/model';
import type { FacilityMovePolicy, ZoneMovePolicy, MapCommand } from '../domain/commands';
import { SpatialPropertyPanel, type SpatialSelection } from './SpatialPropertyPanel';
import { RoadPhysicalFields, makePhysicalDraft, parsePhysicalDraft, physicalFields, type PhysicalDraft } from './RoadPhysicalFields';

type NetworkSelection = { kind: 'node'; id: string; value: MapNode } | { kind: 'road'; id: string; value: MapRoad; lengthM: number };
type Props = {
  map: YardMap;
  zoneMovePolicy?: ZoneMovePolicy;
  onZoneMovePolicyChange?: (policy: ZoneMovePolicy) => void;
  facilityMovePolicy: FacilityMovePolicy;
  onMovePolicyChange: (policy: FacilityMovePolicy) => void;
  selected: NetworkSelection | SpatialSelection | null;
  readonly: boolean;
  count: number;
  onApply: (command: MapCommand) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function PropertyPanel(props: Props) {
  const { selected } = props;
  if (selected && selected.kind !== 'node' && selected.kind !== 'road') return <SpatialPropertyPanel {...props} selected={selected} />;
  return <NetworkPropertyPanel {...props} selected={selected} />;
}

function NetworkPropertyPanel({ selected, readonly, count, onApply, onDirtyChange, map }: Omit<Props, 'selected'> & { selected: NetworkSelection | null }) {
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
  if (!selected) return <div className="empty-properties"><div className="empty-glyph">↖</div><strong>{count > 1 ? `已选择 ${count} 个对象` : '选择对象查看属性'}</strong><p>{count > 1 ? '可一起移动、复制；道路包含显式端点，设施按移动策略处理关联节点。' : '点击节点、道路、设施、区域或关联点，也可使用左侧对象列表。Shift 点击可多选。'}</p></div>;
  function vec(values: string[]): Vec3 | null {
    if (values.some(value => value.trim() === '' || !Number.isFinite(Number(value)))) return null;
    return values.map(Number) as Vec3;
  }
  function apply() {
    if (!selected || readonly) return;
    if (selected.kind === 'node') {
      const position = vec(coords);
      if (!position) { setError('XYZ 必须为有限数值，单位为米。'); return; }
      if (onApply({ type: 'updateNode', id: selected.id, patch: { name, position } })) setError('');
    } else {
      const points = shapePoints.map(vec);
      if (points.some(p => p === null)) { setError('所有折点 XYZ 必须为有限米制数值。'); return; }
      const physicalPatch: Partial<MapRoad> = {};
      let needsAssumption = false;
      if (physicalPending && physical) {
        const parsed = parsePhysicalDraft(physical);
        if (!parsed.ok) { setError(parsed.message); return; }
        const original = makePhysicalDraft(selected.value);
        for (const field of physicalFields) {
          if (JSON.stringify(physical[field]) === JSON.stringify(original[field])) continue;
          const before = selected.value[field]; const after = parsed.values[field];
          const equal = before.state === after.state && (before.state === 'known' && after.state === 'known'
            ? before.value === after.value && before.sourceRef === after.sourceRef
            : before.state !== 'known' && after.state !== 'known' && before.reason === after.reason);
          if (equal) continue;
          physicalPatch[field] = after;
          if (after.state === 'known' && !after.sourceRef) needsAssumption = true;
        }
      }
      if (onApply({ type: 'updateRoad', id: selected.id, patch: { name, shapePoints: points as Vec3[], direction, ...physicalPatch },
        ...(needsAssumption ? { designAssumption: { id: 'source_' + crypto.randomUUID(), name: '道路参数设计假设', description: '用户数值输入，未经现场核验' } } : {}),
      })) setError('');
    }
  }
  return <div className="property-content">
    <div className="entity-kind">{selected.kind === 'node' ? '网络节点' : '道路折线'}</div>
    <label className="field-label">稳定 ID<input aria-label="稳定 ID" value={selected.id} readOnly className="id-input" /></label>
    <label className="field-label">名称<input aria-label="名称" value={name} onChange={event => setName(event.target.value)} disabled={readonly} /></label>
    {selected.kind === 'node' ? <>
      <div className="property-subheading">权威坐标 · m</div>
      <div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label className="field-label" key={axis}>{axis} (m)<input aria-label={axis + ' (m)'} type="number" step="any" value={coords[index] ?? ''} disabled={readonly} onChange={event => setCoords(values => values.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>
      <p className="field-note">XY 为地面，Z 向上。Z=0 是本地图基面。</p>
    </> : <>
      <div className="measurement-card"><span>派生二维长度</span><strong><output data-testid="road-length">{Number(selected.lengthM.toPrecision(12))}</output><small> m</small></strong><p>端点 + 内部折点计算，只读</p></div>
      <dl className="reference-list"><dt>起点</dt><dd>{selected.value.fromNodeId}</dd><dt>终点</dt><dd>{selected.value.toNodeId}</dd></dl>
      <label className="field-label">道路方向<select aria-label="道路方向" value={direction} disabled={readonly} onChange={event => setDirection(event.target.value as MapRoad['direction'])}><option value="unknown">未知（草稿）</option><option value="forward">起点 → 终点</option><option value="backward">终点 → 起点</option><option value="both">双向</option></select></label>
      <div className="property-subheading">内部折点 · m</div>
      <p className="field-note">按起点到终点排序；端点只引用节点。</p>
      {shapePoints.map((point, index) => <div key={index} className="shape-point"><span>{index + 1}</span>{(['X', 'Y', 'Z'] as const).map((axis, axisIndex) => <input key={axis} type="number" step="any" aria-label={`折点 ${index + 1} ${axis} (m)`} title={axis + ' (m)'} value={point[axisIndex] ?? ''} disabled={readonly} onChange={event => setShapePoints(points => points.map((p, i) => i === index ? p.map((v, j) => j === axisIndex ? event.target.value : v) : p))} />)}<button type="button" className="icon-button" aria-label={`删除折点 ${index + 1}`} disabled={readonly} onClick={() => setShapePoints(points => points.filter((_, i) => i !== index))}>×</button></div>)}
      <button type="button" className="subtle-button full-width" disabled={readonly} onClick={() => setShapePoints(points => [...points, points.at(-1) ? [...points.at(-1)!] : ['0', '0', '0']])}>添加内部折点</button>
      {physical && <RoadPhysicalFields draft={physical} onChange={setPhysical} readonly={readonly} sources={map.sources} />}
      <p className="field-note">物理参数与折线编辑一起提交；道路外观不决定通行约束，尚未提供正式网络发布。</p>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button className="primary-button full-width" disabled={readonly} onClick={apply}>应用属性</button>
    <div className="provenance-note">来源声明：{selected.value.provenance.category}<br/>名称与位置变化均保留稳定 ID。手工修改不会重新核验来源，请同步审查字段来源。</div>
  </div>;
}