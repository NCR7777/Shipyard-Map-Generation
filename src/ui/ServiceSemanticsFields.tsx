import type { ArcRef, ServicePoint, YardMap } from '../domain/model';

export interface ServiceArrivalDraft {
  mode: 'undeclared' | 'node_proxy' | 'explicit_internal';
  transferAssumption: 'included_in_service_duration' | 'excluded_from_model';
  note: string;
  entryNodeId: string;
  internalPath: ArcRef[];
}
export function makeServiceArrivalDraft(arrival: ServicePoint['arrival']): ServiceArrivalDraft {
  return {
    mode: arrival?.mode ?? 'undeclared',
    transferAssumption: arrival?.mode === 'node_proxy' ? arrival.transferAssumption : 'included_in_service_duration',
    note: arrival?.mode === 'node_proxy' ? arrival.note : '',
    entryNodeId: arrival?.mode === 'explicit_internal' ? arrival.entryNodeId ?? '' : '',
    internalPath: arrival?.mode === 'explicit_internal' ? arrival.internalPath.map(arc => ({ ...arc })) : [],
  };
}
export function parseServiceArrivalDraft(draft: ServiceArrivalDraft): { ok: true; arrival: ServicePoint['arrival'] } | { ok: false; message: string } {
  if (draft.mode === 'undeclared') return { ok: true, arrival: undefined };
  if (draft.mode === 'node_proxy') {
    if (!draft.note.trim()) return { ok: false, message: '请填写代理到达说明，声明未建模的场内转运如何处理；也可明确选择未声明草稿。' };
    return { ok: true, arrival: { mode: 'node_proxy', transferAssumption: draft.transferAssumption, note: draft.note.trim() } };
  }
  if (draft.internalPath.some(arc => !arc.roadId)) return { ok: false, message: '内部路径的每一段须明确选择道路；空路径可作为待补充草稿。' };
  return { ok: true, arrival: { mode: 'explicit_internal', internalPath: draft.internalPath.map(arc => ({ ...arc })), ...(draft.entryNodeId ? { entryNodeId: draft.entryNodeId } : {}) } };
}
export function ServiceSemanticsFields({ draft, onChange, map, accessPointId, ownerKind = 'none', readonly = false }: {
  draft: ServiceArrivalDraft; onChange: (value: ServiceArrivalDraft) => void; map: YardMap; accessPointId: string; ownerKind?: 'none' | 'facility' | 'zone'; readonly?: boolean;
}) {
  if (map.schemaVersion === '0.1.0') return <p className="field-note">当前为 0.1.0；到达语义与区域主归属需先显式升级到 0.2.0。旧数据不会自动附加研究假设。</p>;
  const access = map.accessPoints[accessPointId];
  return <fieldset className="service-semantics" disabled={readonly}>
    <legend>目标到达声明</legend>
    <label className="field-label">到达语义<select aria-label="到达语义" value={draft.mode} onChange={event => onChange({ ...draft, mode: event.target.value as ServiceArrivalDraft['mode'] })}>
      <option value="node_proxy">node_proxy · 边界代理（推荐）</option><option value="explicit_internal">explicit_internal · 显式内部路径</option><option value="undeclared">未声明（草稿）</option>
    </select></label>
    {draft.mode === 'node_proxy' && <>
      <label className="field-label">场内转运核算<select aria-label="场内转运核算" value={draft.transferAssumption} onChange={event => onChange({ ...draft, transferAssumption: event.target.value as ServiceArrivalDraft['transferAssumption'] })}>
        <option value="included_in_service_duration">纳入服务时长（场景中明确时长）</option><option value="excluded_from_model">明确忽略场内转运</option>
      </select></label>
      <label className="field-label">代理到达说明<textarea aria-label="代理到达说明" value={draft.note} onChange={event => onChange({ ...draft, note: event.target.value })} placeholder="说明代理点代表哪个业务地点、未建模的场内运输如何处理。" /></label>
      <p className="field-note">到达业务目标不等于开始或完成装卸。场景时长不写入 map.json。</p>
    </>}
    {draft.mode === 'explicit_internal' && <>
      {ownerKind === 'facility' && !access ? <p className="inline-error">设施内部路径必须先关联一个设施入口；不能用独立入口节点绕过入口归属。</p> : access ? <p className="field-note">内部路径起点引用入口 {accessPointId} 的节点 {access.nodeId}；不再保存第二份 entryNodeId。</p>
        : <label className="field-label">内部路径入口节点<select aria-label="内部路径入口节点" value={draft.entryNodeId} onChange={event => onChange({ ...draft, entryNodeId: event.target.value })}>
          <option value="">未声明（待补充）</option>{Object.entries(map.nodes).map(([id, node]) => <option key={id} value={id}>{node.name} · {id}</option>)}
        </select></label>}
      {draft.internalPath.map((arc, index) => <div key={index} className="internal-arc">
        <label className="field-label">路段 {index + 1}<select aria-label={'内部路段 ' + (index + 1) + ' 道路'} value={arc.roadId} onChange={event => onChange({ ...draft, internalPath: draft.internalPath.map((value, i) => i === index ? { ...value, roadId: event.target.value } : value) })}>
          <option value="">请选择道路</option>{Object.entries(map.roads).map(([id, road]) => <option key={id} value={id}>{road.name} · {id}</option>)}
        </select></label>
        <label className="field-label">方向<select aria-label={'内部路段 ' + (index + 1) + ' 方向'} value={arc.direction} onChange={event => onChange({ ...draft, internalPath: draft.internalPath.map((value, i) => i === index ? { ...value, direction: event.target.value as ArcRef['direction'] } : value) })}><option value="forward">起点 → 终点</option><option value="backward">终点 → 起点</option></select></label>
        <button type="button" aria-label={'删除内部路段 ' + (index + 1)} onClick={() => onChange({ ...draft, internalPath: draft.internalPath.filter((_, i) => i !== index) })}>删除</button>
      </div>)}
      <button type="button" onClick={() => onChange({ ...draft, internalPath: [...draft.internalPath, { roadId: '', direction: 'forward' }] })}>添加内部路段</button>
      <p className="field-note">按入口到目标节点的顺序显式选择道路和方向。连续几何不等于转向、资源或物理可达性已通过；不会因为绑定入口而瞬移。</p>
    </>}
    {draft.mode === 'undeclared' && <p className="field-note">允许保存草稿；到达抽象尚未声明，不能据此启动运输任务。</p>}
  </fieldset>;
}