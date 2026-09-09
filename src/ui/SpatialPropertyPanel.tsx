import { useEffect, useState } from 'react';
import type { AccessPoint, Facility, Polygon, ServicePoint, Vec3, YardMap, Zone } from '../domain/model';
import { normalizeSelection, selectionImpact, type FacilityMovePolicy, type ZoneMovePolicy, type MapCommand, type Selection } from '../domain/commands';
import { polygonArea2D } from '../geometry/polygons';
import { MIN_RECTANGLE_SIZE_M, rectangleFrame, resizeRectangleDimensions, type RectangleCorner } from '../geometry/rectangles';
import './spatial.css';
import { PointPropertyPanel } from './PointPropertyPanel';
import { zoneServicePointIds } from '../topology/serviceConnections';
export type SpatialSelection =
  | { kind: 'facility'; id: string; value: Facility }
  | { kind: 'zone'; id: string; value: Zone }
  | { kind: 'accessPoint'; id: string; value: AccessPoint }
  | { kind: 'servicePoint'; id: string; value: ServicePoint };
export interface SpatialPanelProps {
  selected: SpatialSelection; map: YardMap; readonly: boolean;
  boundaryEditMode?: 'auto' | 'polygon'; onBoundaryModeChange?: (mode: 'auto' | 'polygon') => void;
  onApply: (command: MapCommand) => boolean; onDirtyChange?: (dirty: boolean) => void;
  zoneMovePolicy?: ZoneMovePolicy; onZoneMovePolicyChange?: (policy: ZoneMovePolicy) => void;
  facilityMovePolicy: FacilityMovePolicy; onMovePolicyChange: (policy: FacilityMovePolicy) => void;
}
const makeRings = (polygon: Polygon) => [polygon.outer, ...polygon.holes].map(ring => ring.slice(0, -1).map(point => point.map(String)));
const numberVector = (values: string[]): Vec3 | null => values.length === 3 && values.every(value => value.trim() && Number.isFinite(Number(value))) ? values.map(Number) as Vec3 : null;
const facilityKinds: [Facility['kind'], string][] = [['workshop', '厂房'], ['yard', '堆场'], ['assembly', '总组区'], ['dock', '船坞'], ['quay', '码头'], ['other', '其他']];
const zoneKinds: [Zone['kind'], string][] = [['work', '作业区'], ['buffer', '缓冲区'], ['waiting', '等待区'], ['water', '水域'], ['obstacle', '障碍区'], ['drivable', '可通行区'], ['forbidden', '禁入区']];

export function SpatialPropertyPanel(props: SpatialPanelProps) {
  return props.selected.kind === 'facility' || props.selected.kind === 'zone'
    ? <PolygonPanel {...props} selected={props.selected} /> : <PointPropertyPanel {...props} selected={props.selected} />;
}
function PolygonPanel({ selected, map, readonly, onApply, onDirtyChange, facilityMovePolicy, onMovePolicyChange, zoneMovePolicy = 'boundaryOnly', onZoneMovePolicyChange, boundaryEditMode = 'auto', onBoundaryModeChange }: SpatialPanelProps & { selected: Extract<SpatialSelection, { kind: 'facility' | 'zone' }> }) {
  const [name, setName] = useState(selected.value.name); const [kind, setKind] = useState(selected.value.kind);
  const [passability, setPassability] = useState<Zone['passability']>(selected.kind === 'zone' ? selected.value.passability : 'unknown');
  const [rings, setRings] = useState(() => makeRings(selected.value.boundary));
  const rectangle = rectangleFrame(selected.value.boundary);
  const rectangular = rectangle !== null && boundaryEditMode === 'auto';
  const [dimensions, setDimensions] = useState(() => [String(rectangle?.widthM ?? ''), String(rectangle?.heightM ?? '')]);
  const [fixedCorner, setFixedCorner] = useState<RectangleCorner>(0);
  const dimensionsPending = rectangular && (dimensions[0] !== String(rectangle.widthM) || dimensions[1] !== String(rectangle.heightM));
  const [delta, setDelta] = useState(['0', '0', '0']); const [angle, setAngle] = useState('0');
  const xs = selected.value.boundary.outer.map(point => point[0]); const ys = selected.value.boundary.outer.map(point => point[1]);
  const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
  const initialPivot = [String(minX / 2 + maxX / 2), String(minY / 2 + maxY / 2), String(selected.value.boundary.outer[0][2])];
  const [pivot, setPivot] = useState(initialPivot);
  const [error, setError] = useState('');
  const basePending = dimensionsPending || name !== selected.value.name || kind !== selected.value.kind || JSON.stringify(rings) !== JSON.stringify(makeRings(selected.value.boundary)) || (selected.kind === 'zone' && passability !== selected.value.passability);
  const moving = delta.some(value => value !== '0'); const rotating = angle !== '0';
  const pivotPending = JSON.stringify(pivot) !== JSON.stringify(initialPivot);
  useEffect(() => { onDirtyChange?.(basePending || moving || rotating || pivotPending); return () => onDirtyChange?.(false); }, [basePending, moving, rotating, pivotPending, onDirtyChange]);
  const selection: Selection = { ...normalizeSelection({ nodes: [], roads: [] }), [selected.kind === 'facility' ? 'facilities' : 'zones']: [selected.id] };
  const impact = selectionImpact(map, selection, facilityMovePolicy, zoneMovePolicy);
  function apply() {
    if (readonly) return;
    if (moving || rotating || pivotPending) { setError('另有未执行的平移/旋转参数，请先重置变换参数，再提交边界属性。'); return; }
    let boundary = selected.value.boundary;
    if (rectangular) {
      if (dimensionsPending) {
        if (dimensions.some(value => !value.trim())) { setError('矩形宽高不能为空，单位为米。'); return; }
        try { boundary = resizeRectangleDimensions(rectangle, Number(dimensions[0]), Number(dimensions[1]), ((fixedCorner + 2) % 4) as RectangleCorner); }
        catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
      }
    } else {
      const parsed = rings.map(ring => ring.map(numberVector));
      if (!parsed.length || parsed.some(ring => ring.length < 3 || ring.some(point => !point))) { setError('每个环至少三个顶点；XYZ 都必须是有限米制数值。'); return; }
      const closed = parsed.map(ring => [...ring as Vec3[], [...ring[0]!] as Vec3] as unknown as Polygon['outer']);
      boundary = { outer: closed[0]!, holes: closed.slice(1) };
    }
    const command: MapCommand = selected.kind === 'facility'
      ? { type: 'updateFacility', id: selected.id, patch: { name, kind: kind as Facility['kind'], boundary } }
      : { type: 'updateZone', id: selected.id, patch: { name, kind: kind as Zone['kind'], boundary, passability } };
    if (onApply(command)) {
      const acceptedRectangle = rectangleFrame(boundary);
      setDimensions([String(acceptedRectangle?.widthM ?? ''), String(acceptedRectangle?.heightM ?? '')]);
      setRings(makeRings(boundary)); setError('');
    }
  }
  function transform(type: 'translateSelection' | 'rotateSelection') {
    if (readonly) return;
    if (basePending || (type === 'rotateSelection' ? moving : rotating)) { setError('请先应用边界属性，或重置另一组变换参数；每次只提交一个完整事务。'); return; }
    const vector = numberVector(type === 'translateSelection' ? delta : pivot);
    if (!vector || !angle.trim() || !Number.isFinite(Number(angle))) { setError('平移/旋转参数必须是有限数值；角度为弧度。'); return; }
    const command: MapCommand = type === 'translateSelection'
      ? { type, selection, delta: vector, facilityMovePolicy, zoneMovePolicy }
      : { type, selection, pivot: vector, angleRad: Number(angle), facilityMovePolicy, zoneMovePolicy };
    if (onApply(command)) { setDelta(['0', '0', '0']); setAngle('0'); setPivot(initialPivot); setError(''); }
  }
  function addVertex(ringIndex: number) {
    setRings(current => current.map((ring, index) => {
      if (index !== ringIndex) return ring;
      const first = numberVector(ring[0] ?? []); const last = numberVector(ring.at(-1) ?? []);
      return [...ring, first && last ? first.map((value, axis) => String(value / 2 + last[axis]! / 2)) : ['0', '0', '0']];
    }));
  }
  function addHole() {
    const z = selected.value.boundary.outer[0][2]; const x1 = minX + (maxX - minX) * .4; const x2 = minX + (maxX - minX) * .6;
    const y1 = minY + (maxY - minY) * .4; const y2 = minY + (maxY - minY) * .6;
    setRings(current => [...current, [[x1, y1, z], [x1, y2, z], [x2, y2, z], [x2, y1, z]].map(point => point.map(String))]);
  }
  return <div className="property-content spatial-property">
    <div className="entity-kind">{selected.kind === 'facility' ? '设施边界' : '独立区域'}</div>
    <label className="field-label">稳定 ID<input aria-label="稳定 ID" readOnly value={selected.id} className="id-input" /></label>
    <label className="field-label">名称<input aria-label="名称" disabled={readonly} value={name} onChange={event => setName(event.target.value)} /></label>
    <label className="field-label">类型<select aria-label={selected.kind === 'facility' ? '设施类型' : '区域类型'} disabled={readonly} value={kind} onChange={event => setKind(event.target.value as typeof kind)}>{(selected.kind === 'facility' ? facilityKinds : zoneKinds).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    {selected.kind === 'zone' && <label className="field-label">通行声明<select aria-label="区域通行声明" disabled={readonly} value={passability} onChange={event => setPassability(event.target.value as Zone['passability'])}><option value="unknown">未知</option><option value="allowed">允许</option><option value="forbidden">禁止</option><option value="explicit_access_only">仅显式接入</option></select></label>}
    <div className="measurement-card spatial-measure"><span>世界 XY 包围盒与净面积（派生）</span><p>宽 <output data-testid="polygon-width">{Number((maxX - minX).toPrecision(12))}</output> m × 高 <output data-testid="polygon-height">{Number((maxY - minY).toPrecision(12))}</output> m</p><p>面积 <output data-testid="polygon-area">{Number(polygonArea2D(selected.value.boundary).toPrecision(12))}</output> m²</p></div>
    {selected.kind === 'facility' && <>
      <label className="field-label">设施移动关联点<select aria-label="设施移动关联点" value={facilityMovePolicy} disabled={readonly} onChange={event => onMovePolicyChange(event.target.value as FacilityMovePolicy)}><option value="boundaryOnly">仅边界，关联点保持</option><option value="withAssociatedNodes">边界与关联节点一起</option></select></label>
      <p className="field-note">{selected.value.accessPointIds.length} 个入口 · {selected.value.servicePointIds.length} 个服务点。高度：{selected.value.heightM.state === 'known' ? selected.value.heightM.value + ' m' : selected.value.heightM.state}。</p>
    </>}
    {selected.kind === 'zone' && <><label className="field-label">区域移动关联点<select aria-label="区域移动关联点" disabled={readonly} value={zoneMovePolicy} onChange={event => onZoneMovePolicyChange?.(event.target.value as ZoneMovePolicy)}><option value="boundaryOnly">仅边界，成员点保持</option><option value="withAssociatedNodes">边界与关联节点一起</option></select></label><p className="field-note">显式归属服务点 {zoneServicePointIds(map, selected.id).length} 个；该列表由 servicePoint.zoneId 派生，不因空间覆盖自动纳入。</p></>}
    <p className="field-note">边界尺寸或顶点调整始终只改边界。已有入口和服务点保留原坐标，请核对它们与新边界的空间关系；不会通过移动关联点掩盖问题。</p>
    <p className="field-note" data-testid="spatial-move-impact">整体移动/旋转策略将移动 {impact.selection.nodes.length} 个节点；关联道路 {impact.affectedRoadIds.join('、') || '无'}。共享节点 {impact.sharedNodeIds.join('、') || '无'}；引用相同节点的入口/服务点会同步。</p>
    {rectangle && <label className="field-label">边界编辑模式<select aria-label="边界编辑模式" disabled={readonly} value={boundaryEditMode} onChange={event => onBoundaryModeChange?.(event.target.value as 'auto' | 'polygon')}><option value="auto">矩形约束 · 宽高独立</option><option value="polygon">自由多边形 · 允许改变直角</option></select></label>}
    {rectangular ? <section className="rectangle-editor">
      <p className="field-note">沿矩形自身轴调整宽高，固定所选对角；仅改变边界，入口、服务点与道路保持原位。尺寸下限 {MIN_RECTANGLE_SIZE_M} m。</p>
      <p>本地宽 <output data-testid="rectangle-width">{Number(rectangle.widthM.toPrecision(12))}</output> m × 高 <output data-testid="rectangle-height">{Number(rectangle.heightM.toPrecision(12))}</output> m</p>
      <div className="coordinate-fields">{(['宽', '高'] as const).map((label, index) => <label className="field-label" key={label}>{label} (m)<input aria-label={'矩形' + label + ' (m)'} type="number" step="any" min={MIN_RECTANGLE_SIZE_M} disabled={readonly} value={dimensions[index]} onChange={event => setDimensions(current => current.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>
      <label className="field-label">固定对角<select aria-label="固定对角" disabled={readonly} value={fixedCorner} onChange={event => setFixedCorner(Number(event.target.value) as RectangleCorner)}>{rectangle.corners.map((point, index) => <option key={index} value={index}>角 {index + 1} · {point.map(value => Number(value.toPrecision(8))).join(', ')} m</option>)}</select></label>
    </section> : <details open><summary>边界顶点 · m</summary><p className="field-note">自由多边形编辑，不保持直角。外环逆时针、孔洞顺时针。闭合点自动等于首点；编辑不反转顶点数组。</p>
      {rings.map((ring, ringIndex) => <section key={ringIndex} className="ring-editor"><strong>{ringIndex === 0 ? '外环' : `孔洞 ${ringIndex}`}</strong>
        {ring.map((point, pointIndex) => <div key={pointIndex} className="spatial-vertex"><span>{pointIndex + 1}</span>{(['X', 'Y', 'Z'] as const).map((axis, axisIndex) => <input key={axis} type="number" step="any" disabled={readonly} aria-label={`${ringIndex === 0 ? '外环' : `孔洞 ${ringIndex}`} 顶点 ${pointIndex + 1} ${axis} (m)`} value={point[axisIndex] ?? ''} onChange={event => setRings(current => current.map((r, ri) => ri === ringIndex ? r.map((p, pi) => pi === pointIndex ? p.map((value, ai) => ai === axisIndex ? event.target.value : value) : p) : r))} />)}<button disabled={readonly || ring.length <= 3} aria-label={`删除${ringIndex === 0 ? '外环' : `孔洞 ${ringIndex}`}顶点 ${pointIndex + 1}`} onClick={() => setRings(current => current.map((r, ri) => ri === ringIndex ? r.filter((_, pi) => pi !== pointIndex) : r))}>×</button></div>)}
        <button disabled={readonly} onClick={() => addVertex(ringIndex)}>添加{ringIndex === 0 ? '外环' : `孔洞 ${ringIndex}`}顶点</button>
        {ringIndex > 0 && <button disabled={readonly} onClick={() => setRings(current => current.filter((_, ri) => ri !== ringIndex))}>删除孔洞 {ringIndex}</button>}
      </section>)}
      <button disabled={readonly} onClick={addHole}>添加孔洞草稿</button><p className="field-note">孔洞草稿放在包围盒中部；提交时检查内含、重叠和相交，不保证初始草稿适合凹多边形。</p>
    </details>}
    <button className="primary-button full-width" disabled={readonly} onClick={apply}>应用属性</button>
    <details><summary>数值平移与旋转</summary>
      <div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label className="field-label" key={axis}>{axis} 位移 (m)<input disabled={readonly} type="number" step="any" aria-label={`平移 ${axis} (m)`} value={delta[i]} onChange={event => setDelta(current => current.map((value, j) => j === i ? event.target.value : value))} /></label>)}</div>
      <button disabled={readonly} onClick={() => transform('translateSelection')}>应用平移</button>
      <label className="field-label">旋转角 (rad)<input disabled={readonly} type="number" step="any" aria-label="旋转角 (rad)" value={angle} onChange={event => setAngle(event.target.value)} /></label>
      <div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, i) => <label className="field-label" key={axis}>中心 {axis}<input disabled={readonly} type="number" step="any" aria-label={`旋转中心 ${axis} (m)`} value={pivot[i]} onChange={event => setPivot(current => current.map((value, j) => j === i ? event.target.value : value))} /></label>)}</div>
      <button disabled={readonly} onClick={() => transform('rotateSelection')}>应用旋转</button><button onClick={() => { setDelta(['0', '0', '0']); setAngle('0'); setPivot(initialPivot); }}>重置变换输入</button>
      <p className="field-note">旋转从 +X 逆时针，按当前设施移动策略一起处理节点。Z 作为高程保留；旋转围绕平行于 Z 的轴。</p>
    </details>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="provenance-note">来源声明：{selected.value.provenance.category}。边界不等于车辆入口，面积不自动变成资源容量。</div>
  </div>;
}
