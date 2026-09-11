import { useState } from 'react';
import type { YardMap } from '../domain/model';
import { diagnoseMap, type DiagnosticReport } from '../validation/diagnostics';
import { previewPath, type PathEndpoint, type PathPreviewReport } from '../topology/pathPreview';

interface Props {
  map: YardMap; mapContentHash: string; disabled: boolean;
  diagnostics: DiagnosticReport | null; route: PathPreviewReport | null;
  onDiagnostics: (report: DiagnosticReport | null) => void; onRoute: (report: PathPreviewReport | null) => void;
}
const pathStatus = { found: '在已声明条件下找到路径', unconfirmed: '未确认：仅有含未知条件的候选路径', disconnected: '声明图中确定无路径', not_checked: '未检查：资料或能力不足' };
const checkStatus = { checked: '已检查', partial: '部分检查', not_checked: '未检查' };
export function DiagnosticsPanel(props: Props) {
  const options = (['servicePoints', 'accessPoints'] as const).flatMap(kind => Object.entries(props.map[kind]).map(([id, point]) => ({ value: kind + ':' + id, label: (kind === 'servicePoints' ? '服务点 ' : '入口 ') + (point.name || id) + ' · ' + id })));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const diagnostic = props.diagnostics?.mapContentHash === props.mapContentHash ? props.diagnostics : null;
  const route = props.route?.mapContentHash === props.mapContentHash ? props.route : null;
  function runPath() {
    const parse = (value: string): PathEndpoint => { const [kind, id] = value.split(':'); return { kind: kind as PathEndpoint['kind'], id: id! }; };
    try { setError(''); props.onRoute(previewPath(props.map, parse(from), parse(to))); }
    catch (failure) { props.onRoute(null); setError('路径检查未完成：' + String(failure)); }
  }
  return <details className="diagnostic-controls" data-testid="diagnostic-controls"><summary>只读地图诊断 · P2A</summary>
    <p>检查已提交地图，包含隐藏和锁定对象。不会修路、改容量或批准运输；未应用输入不参与。</p>
    <button data-testid="run-diagnostics" disabled={props.disabled} onClick={() => {
      try { setError(''); props.onDiagnostics(diagnoseMap(props.map)); }
      catch (failure) { props.onDiagnostics(null); setError('诊断未完成：' + String(failure)); }
    }}>运行只读诊断</button>
    <output data-testid="diagnostic-status" data-map-hash={diagnostic?.mapContentHash ?? ''}>{diagnostic
      ? (diagnostic.status === 'invalid' ? '输入无效' : diagnostic.status === 'complete' ? '已完成声明范围检查' : '已完成部分检查；请查看未检查项') + ' · ' + diagnostic.issues.length + ' 条问题/候选 · ' + diagnostic.rulesVersion
      : props.diagnostics ? '地图已变化，旧诊断已失效；请重新运行。' : '尚未运行。'}</output>
    {diagnostic && <><code className="diagnostic-hash">{diagnostic.mapContentHash}</code><ul>{diagnostic.checks.map(check => <li key={check.id}><b>{check.id} · {checkStatus[check.status]}</b>：{check.detail}</li>)}</ul><p>可定位的清单显示在下方检查器，候选不等于已确认错误。</p></>}
    <div className="path-inputs"><label>路径起点<select aria-label="路径起点" value={from} disabled={props.disabled} onChange={e => { setFrom(e.target.value); props.onRoute(null); }}><option value="">选择服务点/入口</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label>路径终点<select aria-label="路径终点" value={to} disabled={props.disabled} onChange={e => { setTo(e.target.value); props.onRoute(null); }}><option value="">选择服务点/入口</option>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <button data-testid="preview-path" disabled={props.disabled || !from || !to} onClick={runPath}>预览声明路径</button></div>
    <output data-testid="path-status" data-map-hash={route?.mapContentHash ?? ''}>{route ? pathStatus[route.status] : props.route ? '地图已变化，旧路线已失效。' : '尚未预览路径。'}</output>
    {route && <><code className="diagnostic-hash">{route.mapContentHash}</code>
      {([{ label: '声明路径', path: route.confirmed }, { label: '候选路径', path: route.candidate }]).map(({ label, path }) => path && <div key={label}><p>{label}：{path.lengthM.toFixed(3)} m · {path.arcs.map(arc => arc.roadId + '/' + arc.direction).join(' → ') || '零位移'}</p><p>{path.assumptions.join('；')}</p></div>)}
      <p>{route.assumptions.join('；')}</p><p>未检查：{route.unchecked.join('；')}</p></>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
