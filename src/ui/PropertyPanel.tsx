import { useEffect, useState } from 'react';
import type { MapNode, MapRoad, Vec3 } from '../domain/model';
import type { MapCommand } from '../domain/commands';

type Props = {
  selected: { kind: 'node'; id: string; value: MapNode } | { kind: 'road'; id: string; value: MapRoad; lengthM: number } | null;
  readonly: boolean;
  count: number;
  onApply: (command: MapCommand) => boolean;
  onDirtyChange?: (dirty: boolean) => void;
};

export function PropertyPanel({ selected, readonly, count, onApply, onDirtyChange }: Props) {
  const [name, setName] = useState(selected?.value.name ?? '');
  const [coords, setCoords] = useState<string[]>(selected?.kind === 'node' ? selected.value.position.map(String) : []);
  const [shapePoints, setShapePoints] = useState<string[][]>(selected?.kind === 'road' ? selected.value.shapePoints.map(p => p.map(String)) : []);
  const [direction, setDirection] = useState<MapRoad['direction']>(selected?.kind === 'road' ? selected.value.direction : 'unknown');
  const [error, setError] = useState('');
  const pending = !!selected && (name !== selected.value.name || (selected.kind === 'node'
    ? JSON.stringify(coords) !== JSON.stringify(selected.value.position.map(String))
    : JSON.stringify(shapePoints) !== JSON.stringify(selected.value.shapePoints.map(point => point.map(String))) || direction !== selected.value.direction));
  useEffect(() => { onDirtyChange?.(pending); return () => onDirtyChange?.(false); }, [pending, onDirtyChange]);
  if (!selected) return <div className="empty-properties"><div className="empty-glyph">↖</div><strong>{count > 1 ? `已选择 ${count} 个对象` : '选择对象查看属性'}</strong><p>{count > 1 ? '可一起移动、复制；道路平移会连同其显式端点。' : '点击节点或道路，也可使用左侧对象列表。Shift 点击可多选。'}</p></div>;
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
      if (onApply({ type: 'updateRoad', id: selected.id, patch: { name, shapePoints: points as Vec3[], direction } })) setError('');
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
      <p className="field-note">宽度、高度、质量与速度限制保留原值；M1 不提供物理发布。</p>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button className="primary-button full-width" disabled={readonly} onClick={apply}>应用属性</button>
    <div className="provenance-note">来源声明：{selected.value.provenance.category}<br/>名称与位置变化均保留稳定 ID。手工修改不会重新核验来源，请同步审查字段来源。</div>
  </div>;
}