import { useEffect, useState } from 'react';
import { changedFields } from './propertyFields';
import type { AccessPoint, ServicePoint, YardMap } from '../domain/model';
import type { MapCommand } from '../domain/commands';
import { inspectServiceConnection } from '../topology/serviceConnections';
import { makeServiceArrivalDraft, parseServiceArrivalDraft, ServiceSemanticsFields } from './ServiceSemanticsFields';
import { usePropertyDraft, type PropertyDraftProps } from '../editor/drafts';

type PointSelection = { kind: 'accessPoint'; id: string; value: AccessPoint } | { kind: 'servicePoint'; id: string; value: ServicePoint };
export function PointPropertyPanel({ selected, map, readonly, onApply, onDirtyChange, draftContext, onDraftChange, onRelocatePoint }: PropertyDraftProps & {
  selected: PointSelection; map: YardMap; readonly: boolean;
  onRelocatePoint?: (kind: 'accessPoints' | 'servicePoints', id: string) => void;
  onApply: (command: MapCommand) => boolean; onDirtyChange?: (dirty: boolean) => void;
}) {
  const originalZone = selected.kind === 'servicePoint' ? selected.value.zoneId ?? '' : '';
  const originalOwner = selected.value.facilityId ? 'facility' : originalZone ? 'zone' : 'none';
  const [name, setName] = useState(selected.value.name); const [nodeId, setNodeId] = useState(selected.value.nodeId);
  const [ownerKind, setOwnerKind] = useState<'none' | 'facility' | 'zone'>(originalOwner);
  const [facilityId, setFacilityId] = useState(selected.value.facilityId ?? ''); const [zoneId, setZoneId] = useState(originalZone);
  const [accessId, setAccessId] = useState(selected.kind === 'servicePoint' ? selected.value.accessPointId ?? '' : '');
  const [kind, setKind] = useState<ServicePoint['kind']>(selected.kind === 'servicePoint' ? selected.value.kind : 'other');
  const [arrival, setArrival] = useState(() => makeServiceArrivalDraft(selected.kind === 'servicePoint' ? selected.value.arrival : undefined));
  const [error, setError] = useState('');
  const arrivalPending = selected.kind === 'servicePoint' && JSON.stringify(arrival) !== JSON.stringify(makeServiceArrivalDraft(selected.value.arrival));
  const pending = name !== selected.value.name || nodeId !== selected.value.nodeId || facilityId !== (selected.value.facilityId ?? '') || zoneId !== originalZone || ownerKind !== originalOwner || arrivalPending || (selected.kind === 'servicePoint' && (kind !== selected.value.kind || accessId !== (selected.value.accessPointId ?? '')));
  useEffect(() => { onDirtyChange?.(pending); return () => onDirtyChange?.(false); }, [pending, onDirtyChange]);
  const node = map.nodes[nodeId];
  const connection = selected.kind === 'servicePoint' ? inspectServiceConnection(map, selected.id) : null;
  usePropertyDraft(draftContext, pending, apply, onDraftChange);
  function apply(): boolean {
    if (readonly) { setError('当前关联点不可编辑，未应用属性。'); return false; }
    if (!nodeId || !node) { setError('请选择一个有效的权威位置节点。'); return false; }
    if (selected.kind === 'accessPoint') {
      if (!facilityId || !map.facilities[facilityId]) { setError('入口必须关联一个有效设施。'); return false; }
      const patch = changedFields(selected.value, { name, nodeId, facilityId });
      if (!Object.keys(patch).length) { setError(''); return true; }
      const accepted = onApply({ type: 'updateAccessPoint', id: selected.id, patch });
      if (accepted) setError('');
      return accepted;
    }
    if (ownerKind === 'zone' && (!zoneId || !map.zones[zoneId])) { setError('请选择服务点所属的有效区域。'); return false; }
    if (ownerKind === 'facility' && (!facilityId || !map.facilities[facilityId])) { setError('请选择服务点所属的有效设施。'); return false; }
    const patch: Extract<MapCommand, { type: 'updateServicePoint' }>['patch'] = changedFields(selected.value, { name, kind, nodeId });
    const nextFacility = ownerKind === 'facility' ? facilityId || undefined : undefined;
    const nextAccess = ownerKind === 'facility' ? accessId || undefined : undefined;
    const nextZone = ownerKind === 'zone' ? zoneId || undefined : undefined;
    if (nextFacility !== selected.value.facilityId) patch.facilityId = nextFacility ?? null;
    if (nextAccess !== selected.value.accessPointId) patch.accessPointId = nextAccess ?? null;
    if (map.schemaVersion !== '0.1.0' && nextZone !== selected.value.zoneId) patch.zoneId = nextZone ?? null;
    if (arrivalPending && map.schemaVersion !== '0.1.0') {
      const result = parseServiceArrivalDraft(ownerKind === 'facility' ? { ...arrival, entryNodeId: '' } : arrival);
      if (!result.ok) { setError(result.message); return false; }
      const arrivalPatch = changedFields(selected.value, { arrival: result.arrival });
      if ('arrival' in arrivalPatch) patch.arrival = result.arrival ?? null;
    }
    if (!Object.keys(patch).length) { setError(''); setArrival(makeServiceArrivalDraft(selected.value.arrival)); return true; }
    const accepted = onApply({ type: 'updateServicePoint', id: selected.id, patch });
    if (accepted) setError('');
    return accepted;
  }
  return <div className="property-content spatial-property">
    <div className="entity-kind">{selected.kind === 'accessPoint' ? '设施入口' : '服务点'}</div>
    <label className="field-label">名称<input aria-label="名称" disabled={readonly} value={name} onChange={event => setName(event.target.value)} /></label>
    {selected.kind === 'servicePoint' && <label className="field-label">主归属类型<select aria-label="主归属类型" value={ownerKind} disabled={readonly} onChange={event => { setOwnerKind(event.target.value as typeof ownerKind); setFacilityId(''); setZoneId(''); setAccessId(''); setArrival(value => ({ ...value, entryNodeId: '' })); }}><option value="none">未声明主归属</option><option value="facility">设施（含堆场、总组区）</option><option value="zone" disabled={map.schemaVersion === '0.1.0'}>独立区域（0.2）</option></select></label>}
    {(selected.kind === 'accessPoint' || ownerKind !== 'zone') && <label className="field-label">关联设施<select aria-label="关联设施" disabled={readonly} value={facilityId} onChange={event => { setFacilityId(event.target.value); setOwnerKind(event.target.value || selected.kind === 'accessPoint' ? 'facility' : 'none'); setZoneId(''); if (map.accessPoints[accessId]?.facilityId !== event.target.value) { setAccessId(''); setArrival(value => ({ ...value, entryNodeId: '' })); } }}><option value="">{selected.kind === 'accessPoint' ? '必须选择设施' : '独立服务点'}</option>{Object.entries(map.facilities).map(([id, value]) => <option key={id} value={id}>{value.name} · {id}</option>)}</select></label>}
    {ownerKind === 'zone' && <label className="field-label">关联区域<select aria-label="关联区域" disabled={readonly} value={zoneId} onChange={event => setZoneId(event.target.value)}><option value="">请选择区域</option>{Object.entries(map.zones).map(([id, value]) => <option key={id} value={id}>{value.name} · {value.kind} · {id}</option>)}</select></label>}
    <details><summary>位置与技术详情</summary><label className="field-label">稳定 ID<input aria-label="稳定 ID" value={selected.id} readOnly /></label><label className="field-label">权威位置节点<select aria-label="权威位置节点" disabled={readonly} value={nodeId} onChange={event => setNodeId(event.target.value)}>{Object.entries(map.nodes).map(([id, value]) => <option key={id} value={id}>{value.name} · {id}</option>)}</select></label>
    <p className="field-note" data-testid="point-position">节点坐标：{node ? node.position.join(', ') + ' m' : '节点不存在'}。此处保存 nodeId；位置由该节点唯一保存，重新定位通过业务命令维护引用。</p></details>
    {onRelocatePoint && <button disabled={readonly || pending} onClick={() => onRelocatePoint(selected.kind === 'accessPoint' ? 'accessPoints' : 'servicePoints', selected.id)}>在画布重新定位</button>}
    {selected.kind === 'servicePoint' && <>
      <label className="field-label">服务类型<select aria-label="服务类型" disabled={readonly} value={kind} onChange={event => setKind(event.target.value as ServicePoint['kind'])}><option value="loading">装载</option><option value="unloading">卸载</option><option value="parking">停车</option><option value="berth">泊位</option><option value="other">其他</option></select></label>
      {ownerKind !== 'zone' && <label className="field-label">接入入口<select aria-label="接入入口" disabled={readonly} value={accessId} onChange={event => { setAccessId(event.target.value); setArrival(value => ({ ...value, entryNodeId: '' })); if (event.target.value) { setFacilityId(map.accessPoints[event.target.value]!.facilityId); setOwnerKind('facility'); setZoneId(''); } }}><option value="">未声明入口</option>{Object.entries(map.accessPoints).filter(([, point]) => !facilityId || point.facilityId === facilityId).map(([id, point]) => <option key={id} value={id}>{point.name} · {id}</option>)}</select></label>}
      <details><summary>接入方式与作业</summary><ServiceSemanticsFields draft={arrival} onChange={setArrival} map={map} accessPointId={accessId} ownerKind={ownerKind} readonly={readonly} /></details>
    </>}
    {error && <p role="alert" className="inline-error">{error}</p>}
    <button className="primary-button full-width" disabled={readonly || !nodeId || (selected.kind === 'accessPoint' && !facilityId) || (ownerKind === 'zone' && !zoneId)} onClick={apply}>应用属性</button>
    {connection && <details data-testid="service-connection-summary" className="service-connection-summary"><summary>接路检查与完整引用</summary>
      <strong>已提交目标的接路检查 · {connection.status}</strong>
      <p>节点 {connection.nodeId} · 显式端点道路 {connection.incidentRoadIds.length} 条：{connection.incidentRoadIds.join('、') || '无'}</p>
      <p>到达语义：{connection.arrivalMode}；内部路径：{connection.internalPathStatus}{connection.internalPathLengthM === null ? '' : ' · ' + Number(connection.internalPathLengthM.toPrecision(12)) + ' m'}</p>
      {connection.issues.map((issue, index) => <p key={index} className="field-note">{issue.code} · {issue.jsonPath} · {issue.message}</p>)}
      <p className="field-note">未检查：{connection.unchecked.join('、')}。本阶段不宣布完整路径可达。</p>
      <p className="field-note">需要接路时，从权威节点绘制显式道路；若节点在旧道路中部，请选择该道路 → 拆分道路 → 复用此节点。几何接近不会连接。</p>
    </details>}
    <details className="provenance-note"><summary>来源与资源</summary>{selected.value.provenance.category}。归属以 ID 显式声明，资源引用保留；同址点不新增容量。</details>
  </div>;
}