import type { Issue, ServicePoint, Vec3, YardMap } from '../domain/model';
import { newNode } from '../domain/factory';
import type { MapCommand, Selection } from '../domain/commands';
import { Modal } from './Modal';
import { makeServiceArrivalDraft, parseServiceArrivalDraft, ServiceSemanticsFields, type ServiceArrivalDraft } from './ServiceSemanticsFields';
import './spatial.css';

export interface PointCreationDraft {
  kind: 'accessPoints' | 'servicePoints'; name: string;
  ownerKind: 'none' | 'facility' | 'zone'; facilityId: string; zoneId: string; accessPointId: string;
  serviceKind: ServicePoint['kind']; nodeMode: 'existing' | 'new'; nodeId: string; position: string[];
  canvasMode: 'existing' | 'new' | null; arrival: ServiceArrivalDraft;
}
export function makePointCreationDraft(kind: PointCreationDraft['kind'], selection: Selection, map: YardMap): PointCreationDraft {
  const owners = [...(selection.facilities ?? []).map(id => ({ kind: 'facility' as const, id })), ...(selection.zones ?? []).map(id => ({ kind: 'zone' as const, id }))];
  const owner = owners.length === 1 ? owners[0] : undefined;
  const facilityId = owner?.kind === 'facility' && map.facilities[owner.id] ? owner.id : '';
  const zoneId = kind === 'servicePoints' && owner?.kind === 'zone' && map.zones[owner.id] && map.schemaVersion !== '0.1.0' ? owner.id : '';
  const arrival = makeServiceArrivalDraft(undefined);
  if (map.schemaVersion !== '0.1.0') arrival.mode = 'node_proxy';
  return { kind, name: kind === 'accessPoints' ? '入口' : '服务点', ownerKind: facilityId || kind === 'accessPoints' ? 'facility' : zoneId ? 'zone' : 'none', facilityId, zoneId, accessPointId: '', serviceKind: 'loading', nodeMode: 'new', nodeId: '', position: ['', '', '0'], canvasMode: null, arrival };
}
export function applyPointPick(draft: PointCreationDraft, result: { nodeId: string } | { position: Vec3 }): PointCreationDraft {
  return 'nodeId' in result ? { ...draft, nodeMode: 'existing', nodeId: result.nodeId, canvasMode: null }
    : { ...draft, nodeMode: 'new', position: result.position.map(String), canvasMode: null };
}
function inputIssue(code: string, message: string): Issue {
  return { code, message, severity: 'error', jsonPath: '/servicePoints', suggestedAction: '修正创建表单；尚未生成任何节点或服务点。' };
}
export function buildPointCreationCommand(draft: PointCreationDraft, map: YardMap, allocateId: (prefix: string) => string):
  { ok: true; id: string; kind: PointCreationDraft['kind']; command: MapCommand } | { ok: false; issues: Issue[] } {
  const reject = (code: string, message: string) => ({ ok: false as const, issues: [inputIssue(code, message)] });
  if (!draft.name.trim() || (draft.kind === 'accessPoints' && !draft.facilityId)) return reject('POINT_INPUT_REQUIRED', '请填写名称；入口必须明确选择设施。');
  if (draft.nodeMode === 'new' && (draft.position.length !== 3 || draft.position.some(value => !value.trim() || !Number.isFinite(Number(value))))) return reject('POINT_POSITION_REQUIRED', '请在画布点选或输入专用节点的 XYZ 米制位置；不使用设施中心。');
  if (draft.nodeMode === 'existing' && !map.nodes[draft.nodeId]) return reject('POINT_NODE_REQUIRED', '请选择有效已有节点。');
  if (draft.ownerKind === 'facility' && !map.facilities[draft.facilityId]) return reject('POINT_OWNER_REQUIRED', '请选择明确的所属设施。');
  if (draft.ownerKind === 'zone' && !map.zones[draft.zoneId]) return reject('POINT_OWNER_REQUIRED', '请选择明确的所属区域。');
  if (map.schemaVersion === '0.1.0' && (draft.ownerKind === 'zone' || draft.arrival.mode !== 'undeclared')) return reject('POINT_VERSION_UPGRADE_REQUIRED', '区域归属与到达语义需要显式升级到 0.2.0。');
  const arrivalDraft = draft.ownerKind === 'facility' ? { ...draft.arrival, entryNodeId: '' } : draft.arrival;
  const parsed = draft.kind === 'servicePoints' ? parseServiceArrivalDraft(arrivalDraft) : { ok: true as const, arrival: undefined };
  if (!parsed.ok) return reject('POINT_ARRIVAL_REQUIRED', parsed.message);
  const nodeId = draft.nodeMode === 'new' ? allocateId('node') : draft.nodeId;
  const newPointNode = draft.nodeMode === 'new' ? { id: nodeId, node: { ...newNode(draft.position.map(Number) as Vec3, draft.name + '节点'), kind: draft.kind === 'accessPoints' ? 'access' as const : 'service' as const } } : undefined;
  const id = allocateId(draft.kind === 'accessPoints' ? 'access' : 'service');
  const command: MapCommand = draft.kind === 'accessPoints'
    ? { type: 'addAccessPoint', id, accessPoint: { name: draft.name, facilityId: draft.facilityId, nodeId, provenance: { category: 'synthetic' } }, ...(newPointNode ? { newNode: newPointNode } : {}) }
    : { type: 'addServicePoint', id, servicePoint: { name: draft.name, kind: draft.serviceKind, nodeId,
      ...(draft.ownerKind === 'facility' ? { facilityId: draft.facilityId, ...(draft.accessPointId ? { accessPointId: draft.accessPointId } : {}) } : {}),
      ...(draft.ownerKind === 'zone' ? { zoneId: draft.zoneId } : {}),
      ...(parsed.arrival ? { arrival: parsed.arrival } : {}), resourceIds: [], provenance: { category: 'synthetic' } }, ...(newPointNode ? { newNode: newPointNode } : {}) };
  return { ok: true, id, kind: draft.kind, command };
}
export function PointCreationPanel({ draft, map, readonly = false, issues, onChange, onCreate, onCancel }: {
  draft: PointCreationDraft; map: YardMap; readonly?: boolean; issues: Issue[];
  onChange: (value: PointCreationDraft) => void; onCreate: () => void; onCancel: () => void;
}) {
  const title = draft.kind === 'accessPoints' ? '添加入口' : '添加服务点';
  if (draft.canvasMode) return <aside className="point-pick-panel" aria-label="服务点画布定位">
    <strong>{title}：{draft.name}</strong><p>{draft.canvasMode === 'existing' ? '点选已有节点或关联点标记；将使用同一 nodeId。' : '点选专用节点位置。仅暂存坐标，确认创建时才产生一个领域事务。'}</p>
    <p className="field-note">可用中键平移、滚轮缩放。点位落在道路中部不会自动拆路；同址不同 ID 不连通。</p>
    <button onClick={() => onChange({ ...draft, canvasMode: null })}>返回创建表单</button>
  </aside>;
  const zone = map.zones[draft.zoneId];
  return <Modal title={title} onCancel={onCancel}>
    <p>Node 保存权威米制位置；入口/服务点只保存 nodeId。确认前的定位不会修改地图。</p>
    <fieldset className="point-creation-fields" disabled={readonly}>
      <label className="field-label">名称<input aria-label="名称" value={draft.name} onChange={event => onChange({ ...draft, name: event.target.value })} /></label>
      {draft.kind === 'servicePoints' && <label className="field-label">主归属类型<select aria-label="主归属类型" value={draft.ownerKind} onChange={event => onChange({ ...draft, ownerKind: event.target.value as PointCreationDraft['ownerKind'], facilityId: '', zoneId: '', accessPointId: '', arrival: { ...draft.arrival, entryNodeId: '' } })}><option value="none">未声明主归属</option><option value="facility">设施（含堆场、总组区）</option><option value="zone" disabled={map.schemaVersion === '0.1.0'}>独立区域（0.2）</option></select></label>}
      {(draft.kind === 'accessPoints' || draft.ownerKind !== 'zone') && <label className="field-label">所属设施<select aria-label="所属设施" value={draft.facilityId} onChange={event => onChange({ ...draft, ownerKind: event.target.value || draft.kind === 'accessPoints' ? 'facility' : 'none', facilityId: event.target.value, zoneId: '', accessPointId: '' })}><option value="">{draft.kind === 'accessPoints' ? '请选择设施（必选）' : '无所属设施'}</option>{Object.entries(map.facilities).map(([id, facility]) => <option key={id} value={id}>{facility.name} · {id}</option>)}</select></label>}
      {draft.ownerKind === 'zone' && <><label className="field-label">所属区域<select aria-label="所属区域" value={draft.zoneId} onChange={event => onChange({ ...draft, zoneId: event.target.value })}><option value="">请选择区域</option>{Object.entries(map.zones).map(([id, item]) => <option key={id} value={id}>{item.name} · {item.kind} · {id}</option>)}</select></label><p className="field-note">区域归属由显式 ID 决定，重叠区域不自动成为共同主归属。</p>{zone && (['water', 'forbidden', 'obstacle'].includes(zone.kind) || zone.passability === 'forbidden') && <p className="inline-error">该区域的水域/禁行/障碍规则保持不变；普通陆运服务检查将阻止发布，特殊业务尚不支持。</p>}</>}
      {draft.kind === 'servicePoints' && <>
        <label className="field-label">服务类型<select aria-label="服务类型" value={draft.serviceKind} onChange={event => onChange({ ...draft, serviceKind: event.target.value as ServicePoint['kind'] })}>{Object.entries({ loading: '装载', unloading: '卸载', parking: '停车', berth: '泊位', other: '其他' }).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        {draft.ownerKind !== 'zone' && <label className="field-label">关联入口<select aria-label="关联入口" value={draft.accessPointId} onChange={event => onChange({ ...draft, accessPointId: event.target.value, arrival: { ...draft.arrival, entryNodeId: '' } })}><option value="">无关联入口</option>{Object.entries(map.accessPoints).filter(([, point]) => point.facilityId === draft.facilityId).map(([id, point]) => <option key={id} value={id}>{point.name} · {id}</option>)}</select></label>}
        <ServiceSemanticsFields draft={draft.arrival} onChange={arrival => onChange({ ...draft, arrival })} map={map} accessPointId={draft.accessPointId} ownerKind={draft.ownerKind} />
      </>}
      <label className="field-label">定位方式<select aria-label="定位方式" value={draft.nodeMode} onChange={event => onChange({ ...draft, nodeMode: event.target.value as PointCreationDraft['nodeMode'] })}><option value="new">新建节点</option><option value="existing">已有节点</option></select></label>
      {draft.nodeMode === 'existing' ? <><label className="field-label">关联节点<select aria-label="关联节点" value={draft.nodeId} onChange={event => onChange({ ...draft, nodeId: event.target.value })}><option value="">请选择已有节点</option>{Object.entries(map.nodes).map(([id, node]) => <option key={id} value={id}>{node.name} · {id} [{node.position.join(', ')}] m</option>)}</select></label><button onClick={() => onChange({ ...draft, canvasMode: 'existing' })}>在画布选择已有节点</button><p className="field-note">共享节点移动会同步其道路端点及其他关联点；新增服务点不新增容量。</p></>
        : <><div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">{axis} (m)<input aria-label={axis + ' (m)'} type="number" step="any" value={draft.position[index] ?? ''} onChange={event => onChange({ ...draft, position: draft.position.map((value, i) => i === index ? event.target.value : value) })} /></label>)}</div><button onClick={() => onChange({ ...draft, canvasMode: 'new' })}>在画布放置专用节点</button><p className="field-note">节点与点对象一起创建、一起撤销。专用节点需要显式接路；不会取设施中心或自动连线。</p></>}
    </fieldset>
    {issues.length > 0 && <div role="alert" className="inline-error">{issues.map((issue, i) => <p key={i}>{issue.code} · {issue.jsonPath}：{issue.message}</p>)}</div>}
    <div className="dialog-actions"><button data-cancel onClick={onCancel}>取消</button><button className="primary-button" disabled={readonly} onClick={onCreate}>{draft.kind === 'accessPoints' ? '创建入口' : '创建服务点'}</button></div>
  </Modal>;
}