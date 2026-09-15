import { useMemo, useState } from 'react';
import { commandSupport } from '../domain/commands';
import { buildConnectedPointCreation, hasPointConnectionCandidate, setPointConnectionMode } from './PointCreationPanel';
import type { Issue, YardMap } from '../domain/model';
import type { PointCreationDraft } from './PointCreationPanel';
import { ServiceSemanticsFields } from './ServiceSemanticsFields';
import { Modal } from './Modal';

export function ConnectedPointFields({ draft, map, readonly, issues, onChange, onCreate, onCancel }: {
  draft: PointCreationDraft; map: YardMap; readonly: boolean; issues: Issue[];
  onChange: (draft: PointCreationDraft) => void; onCreate: () => void; onCancel: () => void;
}) {
  const deferred = draft.connectionMode === 'deferred';
  const [resetRequested, setResetRequested] = useState(false);
  const preview = useMemo(() => {
    if (draft.connectionMode === 'deferred' || !draft.ids) return null;
    const built = buildConnectedPointCreation(draft, map, () => 'unallocated_preview', false);
    return built.ok && built.command.type === 'createConnectedPoint' ? commandSupport(map, built.command) : null;
  }, [draft, map]);
  function turnTemplate(mode: 'entry' | 'exit' | 'both') {
    const roadId = draft.ids?.connectorRoadId;
    const turns = (preview?.proposedMovements ?? []).filter(turn => mode === 'entry' ? turn.outgoingArc.roadId === roadId : mode === 'exit' ? turn.incomingArc.roadId === roadId : turn.incomingArc.roadId === roadId || turn.outgoingArc.roadId === roadId);
    onChange({ ...draft, approvedMovements: turns.map(turn => ({ ...turn, id: 'movement_' + crypto.randomUUID() })) });
  }
  const hasCanvasProposal = !!draft.connection || !!draft.resourceIds?.length || !!draft.approvedMovements?.length || !!draft.arrival.internalPath.length || !!draft.connectorWidth?.trim() || !!draft.connectorDirection && draft.connectorDirection !== 'unknown';
  const proxy = !deferred && draft.kind === 'servicePoints' && draft.arrival.mode === 'node_proxy';
  const access = map.accessPoints[draft.accessPointId];
  const title = draft.kind === 'accessPoints' ? '添加入口' : '添加作业点';
  if (draft.canvasMode) return <aside className="point-pick-panel" aria-label="关联点画布定位"><strong>{title}</strong>
    <p>{draft.canvasMode === 'new' ? '点击所选设施边界或真实作业位置。位置先进入候选，不立即修改地图。' : draft.canvasMode === 'path' ? '从入口起按顺序点击连续的内部道路；方向按当前路径末端确定。' : draft.canvasMode === 'existing' ? '点击明确的区域入口节点。' : '点击道路接入位置或已有路口节点。中部接入会显式拆路并维护引用。'}</p>
    <button onClick={() => onChange({ ...draft, canvasMode: null })}>返回关联预览</button><button onClick={onCancel}>取消</button></aside>;
  return <Modal title={title} onCancel={onCancel}><fieldset disabled={readonly}>
    <label className="field-label">创建时接路<select aria-label="创建时接路" value={deferred ? 'deferred' : 'connected'} onChange={event => {
      const mode = event.target.value as 'deferred' | 'connected';
      if (mode === 'deferred' && hasPointConnectionCandidate(draft)) setResetRequested(true);
      else { setResetRequested(false); onChange(setPointConnectionMode(draft, mode)); }
    }}><option value="deferred">先放置节点，稍后画路连接</option><option value="connected">创建时明确接路或到达方式</option></select></label>
    {resetRequested && <div role="alert"><p>切换为稍后接路会重置本次接路、到达路径、入口关联、资源、转向许可及接入段设置，保留名称和点位。</p><button type="button" onClick={() => { setResetRequested(false); onChange(setPointConnectionMode(draft, 'deferred')); }}>确认重置并稍后接路</button><button type="button" onClick={() => setResetRequested(false)}>保留接路候选</button></div>}
    {deferred && <p className="field-note">先在所属对象上放置入口或作业节点；可以稍后用道路工具从该点继续画路。创建时不生成接入线，也不声明运输到达方式。</p>}
    <label className="field-label">名称<input aria-label="名称" value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })}/></label>
    <label className="field-label">所属对象<select aria-label="所属对象" value={draft.ownerKind === 'zone' ? 'zones/' + draft.zoneId : 'facilities/' + draft.facilityId} onChange={event => {
      const [kind, id = ''] = event.target.value.split('/'); onChange({ ...draft, ownerKind: kind === 'zones' ? 'zone' : 'facility', facilityId: kind === 'facilities' ? id : '', zoneId: kind === 'zones' ? id : '', accessPointId: '', connection: undefined, arrival: { ...draft.arrival, internalPath: [], entryNodeId: '' } });
    }}><option value="facilities/">请选择明确归属</option>{Object.entries(map.facilities).map(([id, value]) => <option key={id} value={'facilities/' + id}>{value.name}</option>)}{draft.kind === 'servicePoints' && Object.entries(map.zones).map(([id, value]) => <option key={id} value={'zones/' + id}>{value.name}</option>)}</select></label>
    {draft.kind === 'servicePoints' && <>
      <label className="field-label">作业类型<select aria-label="作业类型" value={draft.serviceKind} onChange={event => onChange({ ...draft, serviceKind: event.target.value as PointCreationDraft['serviceKind'] })}>{Object.entries({ loading: '装载', unloading: '卸载', parking: '停车', berth: '泊位', other: '其他' }).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {draft.ownerKind !== 'zone' && <label className="field-label">经过入口<select aria-label="经过入口" value={draft.accessPointId} onChange={event => onChange({ ...draft, connectionMode: event.target.value ? 'connected' : draft.connectionMode, accessPointId: event.target.value, arrival: { ...draft.arrival, internalPath: [] }, connection: undefined })}><option value="">请选择本设施入口</option>{Object.entries(map.accessPoints).filter(([, value]) => value.facilityId === draft.facilityId).map(([id, value]) => <option key={id} value={id}>{value.name}</option>)}</select></label>}
      <ServiceSemanticsFields map={map} draft={draft.arrival} onChange={arrival => onChange({ ...draft, connectionMode: arrival.mode !== 'undeclared' ? 'connected' : draft.connectionMode, arrival })} ownerKind={draft.ownerKind} accessPointId={draft.accessPointId}/>
      {!deferred && draft.arrival.mode === 'explicit_internal' && <><button onClick={() => onChange({ ...draft, canvasMode: 'path' })}>在画布选择连续内部路径</button><button onClick={() => onChange({ ...draft, arrival: { ...draft.arrival, internalPath: [] } })}>重选内部路径</button>{draft.ownerKind === 'zone' && <button onClick={() => onChange({ ...draft, canvasMode: 'existing' })}>在画布选择区域入口</button>}{(access || draft.arrival.entryNodeId) && <button onClick={() => onChange({ ...draft, connection: { kind: 'node', nodeId: access?.nodeId ?? draft.arrival.entryNodeId }, arrival: { ...draft.arrival, internalPath: [] } })}>直接从入口连接到作业位置</button>}</>}
    </>}
    {!proxy && <><button onClick={() => onChange({ ...draft, canvasMode: 'new' })}>在画布放置{draft.kind === 'accessPoints' ? '入口' : '作业点'}</button><p>位置：{draft.position.every(v => v.trim()) ? draft.position.slice(0,2).join(', ') + ' m' : '尚未选择'}</p><button onClick={() => onChange({ ...draft, connectionMode: 'connected', canvasMode: 'road' })}>在画布选择接入道路</button><p>接入：{draft.connection ? draft.connection.kind === 'node' ? map.nodes[draft.connection.nodeId]?.name : map.roads[draft.connection.roadId]?.name : '尚未选择'}</p></>}
    {!deferred && !proxy && <><label className="field-label">新接入段方向<select aria-label="新接入段方向" value={draft.connectorDirection ?? 'unknown'} onChange={event => onChange({ ...draft, connectorDirection: event.target.value as PointCreationDraft['connectorDirection'] })}><option value="unknown">待配置</option><option value="both">双向</option><option value="forward">接入点 → 业务点</option><option value="backward">业务点 → 接入点</option></select></label><label className="field-label">新接入段宽度 (m)<input aria-label="新接入段宽度 (m)" type="number" step="any" value={draft.connectorWidth ?? ''} onChange={event => onChange({ ...draft, connectorWidth: event.target.value })} placeholder="未知"/></label></>}
    {!deferred && <p className="field-note">预览确认后一次创建，公共路网保持原位置。新接入不会默认放行转向，也不增加已有资源容量。</p>}
    {preview && <section aria-label="关联影响预览"><strong>关联预览</strong>{!!preview.proposedMovements?.length && <div><button onClick={() => turnTemplate('entry')}>仅允许驶入</button><button onClick={() => turnTemplate('exit')}>仅允许驶出</button><button onClick={() => turnTemplate('both')}>明确允许双向接入</button><button onClick={() => onChange({ ...draft, approvedMovements: [] })}>清除本次许可</button></div>}<p>影响 {preview.affectedRefs.length} 项已声明对象；新路口转向只使用下方明确勾选项。</p>{preview.proposedMovements?.map((turn, index) => {
      const key = JSON.stringify([turn.incomingArc, turn.outgoingArc]);
      const checked = draft.approvedMovements?.some(value => JSON.stringify([value.incomingArc, value.outgoingArc]) === key) ?? false;
      return <label key={key}><input type="checkbox" aria-label={'允许新转向 ' + (index + 1)} checked={checked} onChange={event => onChange({ ...draft, approvedMovements: event.target.checked ? [...(draft.approvedMovements ?? []), { ...turn, id: 'movement_' + crypto.randomUUID() }] : (draft.approvedMovements ?? []).filter(value => JSON.stringify([value.incomingArc, value.outgoingArc]) !== key) })}/>{map.roads[turn.incomingArc.roadId]?.name ?? turn.incomingArc.roadId} → {map.roads[turn.outgoingArc.roadId]?.name ?? turn.outgoingArc.roadId}</label>;
    })}{preview.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}</section>}
    {!deferred && draft.kind === 'servicePoints' && <details><summary>复用已有资源（可选）</summary><p>仅扩展这些资源的明确适用对象；原容量与其他占用声明保持不变。不选择表示新点尚未指定资源约束。</p><select multiple aria-label="复用已有资源" value={draft.resourceIds ?? []} onChange={event => onChange({ ...draft, resourceIds: Array.from(event.target.selectedOptions, option => option.value) })}>{Object.entries(map.resources).map(([id, resource]) => <option key={id} value={id}>{resource.name} · {id}</option>)}</select></details>}
    <details><summary>高级关联声明</summary><p>用于检查或录入已有明确节点和到达声明；不会自动完成接路。普通新入口建议继续使用上方画布流程。</p><button disabled={hasCanvasProposal} title={hasCanvasProposal ? '已有接路或资源候选；请先取消本次创建，再打开高级关联表单。' : undefined} onClick={() => onChange({ ...draft, simple: false, arrival: { ...draft.arrival, mode: draft.arrival.mode === 'undeclared' && map.schemaVersion !== '0.1.0' ? 'node_proxy' : draft.arrival.mode } })}>打开高级关联表单</button></details>
    <details><summary>将维护的数据</summary><p>明确归属、权威节点、接入道路、入口反向引用、内部到达路径及设计来源。原有资源、限制与未知扩展保留。</p></details>
  </fieldset>{issues.length > 0 && <div role="alert">{issues.map((issue, index) => <p key={index}>{issue.message}<details><summary>技术详情</summary>{issue.code} · {issue.jsonPath}</details></p>)}</div>}
  <div className="dialog-actions"><button data-cancel onClick={onCancel}>取消</button><button className="primary-button" disabled={readonly} onClick={onCreate}>{deferred ? draft.kind === 'accessPoints' ? '创建入口' : '创建作业点' : '确认关联并创建'}</button></div></Modal>;
}
