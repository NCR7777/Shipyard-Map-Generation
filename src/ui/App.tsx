import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newMap, newNode, newRoad } from '../domain/factory';
import { contentHash, serializeMap } from '../domain/serialization';
import { mapCapabilities } from '../domain/capabilities';
import { closureSelection, type MapCommand, type Selection } from '../domain/commands';
import type { Issue, Vec3 } from '../domain/model';
import { createSession, editSession, isDirty, markExported, prepareImport, redoSession, resolveImport, undoSession, type EditorSession, type ImportProposal } from '../editor/session';
import { toSceneSnapshot } from '../compiler/scene';
import { validateMap } from '../validation/validate';
import { downloadMap, readJsonFile } from '../adapters/files';
import { MapCanvas, type DraftRoad, type Tool } from '../renderers/2d/MapCanvas';
import type { Camera } from '../geometry/coordinates';
import { PropertyPanel } from './PropertyPanel';
import { Modal } from './Modal';

const emptySelection = (): Selection => ({ nodes: [], roads: [] });
const uid = (prefix: string) => prefix + '_' + crypto.randomUUID();
function localIssue(code: string, message: string): Issue { return { code, severity: 'error', jsonPath: '', message, suggestedAction: '检查输入，当前有效地图未被替换。' }; }

export function App() {
  const [session, setSession] = useState(() => createSession(newMap(uid('map'), '未命名布局'), true));
  const sessionRef = useRef<EditorSession>(session);
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const [camera, setCamera] = useState<Camera>({ offsetX: 80, offsetY: 460, scale: 4 });
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 540 });
  const [cursor, setCursor] = useState<Vec3 | null>(null);
  const [draftRoad, setDraftRoad] = useState<DraftRoad | null>(null);
  const [operationIssues, setOperationIssues] = useState<Issue[]>([]);
  const [status, setStatus] = useState('从节点开始绘制，或导入本地 map.json。');
  const [proposal, setProposal] = useState<{ value: ImportProposal; isNew: boolean } | null>(null);
  const [newDialog, setNewDialog] = useState(false);
  const [newName, setNewName] = useState('新建布局');
  const [copyDialog, setCopyDialog] = useState(false);
  const [copyDelta, setCopyDelta] = useState(['10', '10', '0']);
  const [mapName, setMapName] = useState(session.map.metadata.name);
  const [fileLoading, setFileLoading] = useState(false);
  const importSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const initializedCanvas = useRef(false);
  useEffect(() => setMapName(session.map.metadata.name), [session.map.metadata.name]);
  const scene = useMemo(() => toSceneSnapshot(session.map), [session.map]);
  const capabilities = useMemo(() => mapCapabilities(session.map), [session.map]);
  const report = useMemo(() => validateMap(session.map), [session.map]);
  const readonly = !capabilities.editable;
  const dirty = isDirty(session);
  const validSelection = useMemo(() => ({
    nodes: selection.nodes.filter(id => Object.hasOwn(session.map.nodes, id)),
    roads: selection.roads.filter(id => Object.hasOwn(session.map.roads, id)),
  }), [selection, session.map]);
  const selectedCount = validSelection.nodes.length + validSelection.roads.length;
  const closure = useMemo(() => closureSelection(session.map, validSelection), [session.map, validSelection]);
  const issues = [...operationIssues, ...report.issues];
  const errorCount = issues.filter(i => i.severity === 'error').length;

  const onCanvasSize = useCallback((size: { width: number; height: number }) => {
    setCanvasSize(size);
    if (!initializedCanvas.current) { initializedCanvas.current = true; setCamera({ offsetX: 80, offsetY: size.height - 80, scale: 4 }); }
  }, []);
  function updateSession(next: EditorSession) { sessionRef.current = next; setSession(next); }
  function apply(command: MapCommand): boolean {
    const result = editSession(sessionRef.current, command);
    setOperationIssues(result.issues);
    if (!result.ok) { setStatus('操作被拒绝，地图及历史记录保持不变。'); return false; }
    updateSession(result.session); setStatus('编辑已提交为一个可撤销事务。'); return true;
  }
  function choose(kind: 'nodes' | 'roads', id: string, additive: boolean) {
    setSelection(current => {
      if (!additive) return kind === 'nodes' ? { nodes: [id], roads: [] } : { nodes: [], roads: [id] };
      return { ...current, [kind]: current[kind].includes(id) ? current[kind].filter(value => value !== id) : [...current[kind], id] };
    });
  }
  function changeTool(value: Tool) { setTool(value); setDraftRoad(null); }
  function exportCurrent() {
    try {
      const current = sessionRef.current; const hash = contentHash(current.map);
      const filename = downloadMap(current.map);
      updateSession(markExported(sessionRef.current, hash));
      setStatus('已发起下载 ' + filename + '；单 JSON 不包含底图二进制。');
    } catch (error) { setOperationIssues([localIssue('EXPORT_FAILED', error instanceof Error ? error.message : String(error))]); }
  }
  function undo() { updateSession(undoSession(sessionRef.current)); setOperationIssues([]); setDraftRoad(null); setStatus('已撤销一个事务。'); }
  function redo() { updateSession(redoSession(sessionRef.current)); setOperationIssues([]); setDraftRoad(null); setStatus('已重做一个事务。'); }
  function remove() {
    if (selectedCount === 0 || readonly) return;
    if (apply({ type: 'deleteSelection', selection: validSelection })) setSelection(emptySelection());
  }
  function fit() {
    const bounds = scene.bounds;
    if (!bounds) { setCamera({ offsetX: 80, offsetY: canvasSize.height - 80, scale: 4 }); return; }
    const width = Math.max(10, bounds.max[0] - bounds.min[0]);
    const height = Math.max(10, bounds.max[1] - bounds.min[1]);
    const scale = Math.min(10, Math.max(0.02, Math.min((canvasSize.width - 100) / width, (canvasSize.height - 100) / height)));
    const next = { scale, offsetX: canvasSize.width / 2 - (bounds.min[0] / 2 + bounds.max[0] / 2) * scale, offsetY: canvasSize.height / 2 + (bounds.min[1] / 2 + bounds.max[1] / 2) * scale };
    if (!Object.values(next).every(Number.isFinite)) { setStatus('当前坐标超出视图可表示范围；请通过数值属性调整坐标。'); return; }
    setCamera(next);
  }
  function finishImport(candidate: ImportProposal, isNew: boolean) {
    const result = resolveImport(sessionRef.current, candidate, 'replace');
    setOperationIssues(result.issues);
    if (!result.ok) { setProposal(null); setStatus('候选已过期或无效，请重新导入。'); return; }
    const next = isNew ? { ...result.session, savedHash: null } : result.session;
    updateSession(next); setMapName(next.map.metadata.name);
    setSelection(emptySelection()); setDraftRoad(null); setTool('select'); setProposal(null);
    setCamera({ offsetX: 80, offsetY: canvasSize.height - 80, scale: 4 });
    setStatus(isNew ? '已新建 synthetic 地图，尚未导出。' : '已从 JSON 重建地图与派生几何。');
  }
  function prepare(text: string, isNew = false) {
    const result = prepareImport(sessionRef.current, text);
    if (result.status === 'invalid') { setOperationIssues(result.issues); setStatus('导入失败；当前地图、历史和保存基线保持不变。'); return; }
    if (result.status === 'conflict') setProposal({ value: result, isNew });
    else finishImport(result, isNew);
  }
  async function importFile(file: File) {
    const sequence = ++importSequence.current; setFileLoading(true);
    try { const text = await readJsonFile(file); if (sequence === importSequence.current) prepare(text); }
    catch (error) { if (sequence === importSequence.current) setOperationIssues([localIssue('FILE_READ_FAILED', error instanceof Error ? error.message : String(error))]); }
    finally { if (sequence === importSequence.current) setFileLoading(false); }
  }
  function createNew() {
    if (!newName.trim()) return;
    importSequence.current++; setFileLoading(false); setNewDialog(false);
    prepare(serializeMap(newMap(uid('map'), newName.trim())), true);
  }
  function duplicate() {
    if (copyDelta.some(value => !value.trim() || !Number.isFinite(Number(value)))) { setOperationIssues([localIssue('INVALID_COPY_OFFSET', '复制偏移必须为有限米制数值。')]); return; }
    const idMap = Object.fromEntries([...closure.nodes.map(id => [id, uid('node')]), ...closure.roads.map(id => [id, uid('road')])]);
    if (apply({ type: 'duplicateSelection', selection: validSelection, delta: copyDelta.map(Number) as Vec3, idMap })) {
      setSelection({ nodes: closure.nodes.map(id => idMap[id]!), roads: closure.roads.map(id => idMap[id]!) }); setCopyDialog(false);
    }
  }
  function locate(issue: Issue) {
    if (issue.entityType === 'nodes' && issue.entityId && Object.hasOwn(session.map.nodes, issue.entityId)) choose('nodes', issue.entityId, false);
    if (issue.entityType === 'roads' && issue.entityId && Object.hasOwn(session.map.roads, issue.entityId)) choose('roads', issue.entityId, false);
    const point = issue.location?.position;
    if (point) setCamera(current => ({ ...current, offsetX: canvasSize.width / 2 - point[0] * current.scale, offsetY: canvasSize.height / 2 + point[1] * current.scale }));
  }
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (isDirty(sessionRef.current)) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]') || proposal || newDialog || copyDialog) return;
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); exportCurrent(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
      else if (event.key === 'Escape') { setDraftRoad(null); setTool('select'); setSelection(emptySelection()); }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const selectedNodeId = validSelection.nodes.length === 1 && validSelection.roads.length === 0 ? validSelection.nodes[0] : undefined;
  const selectedRoadId = validSelection.roads.length === 1 && validSelection.nodes.length === 0 ? validSelection.roads[0] : undefined;
  const selected = selectedNodeId ? { kind: 'node' as const, id: selectedNodeId, value: session.map.nodes[selectedNodeId]! }
    : selectedRoadId ? { kind: 'road' as const, id: selectedRoadId, value: session.map.roads[selectedRoadId]!, lengthM: scene.roads.find(road => road.id === selectedRoadId)!.lengthM } : null;
  const hint = readonly ? '只读检查：可查看、定位并原样导出 JSON。'
    : tool === 'node' ? '点击空白位置创建节点。坐标可在右侧精确修改。'
    : tool === 'road' ? (draftRoad ? '点击空白处添加内部折点，再点击目标节点完成道路。Esc 取消。' : '先点击已有起点节点；道路交叉不会自动连接。')
    : tool === 'pan' ? '按住鼠标拖动平移，滚轮缩放。'
    : '拖动节点移动；Shift 点击多选；滚轮缩放；中键平移。';

  return <main className="app-shell">
    <header className="app-header"><div className="brand-mark">Y</div><div><h1>船厂空间布局编辑器</h1><p>YARD SPACE / M1 · 本地米制布局</p></div><div className="header-actions"><button onClick={() => { setNewName('新建布局'); setNewDialog(true); }}>新建地图</button><button onClick={() => fileInput.current?.click()} disabled={fileLoading}>{fileLoading ? '读取中…' : '导入 JSON'}</button><button className="primary-button" onClick={exportCurrent}>导出 JSON</button></div></header>
    <input ref={fileInput} data-testid="json-file-input" type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
    <div className="document-bar"><strong>{session.map.metadata.name}</strong><span className="basis-chip">{session.map.metadata.layoutBasis}</span><span className={dirty ? 'save-status dirty' : 'save-status'} data-testid="save-status">{dirty ? '● 有未导出编辑' : '○ 相对导入/导出基线无修改'}</span><span className="document-meta">r{session.map.revision} · 本地坐标 · m / rad / kg / s</span></div>
    <div className="workspace">
      <aside className="left-panel">
        <div className="panel-title">绘制工具<span>M1</span></div>
        <div className="tool-grid">{([{ id: 'select', label: '选择', icon: '↖' }, { id: 'node', label: '节点', icon: '⊙' }, { id: 'road', label: '道路折线', icon: '⌁' }, { id: 'pan', label: '平移', icon: '✥' }] as const).map(item => <button key={item.id} className={tool === item.id ? 'tool-button active' : 'tool-button'} aria-label={item.label} aria-pressed={tool === item.id} disabled={readonly && (item.id === 'node' || item.id === 'road')} onClick={() => changeTool(item.id)}><b>{item.icon}</b>{item.label}</button>)}</div>
        <div className="panel-title">地图信息</div>
        <div className="map-name-editor"><label className="field-label">地图名称<input aria-label="地图名称" value={mapName} disabled={readonly} onChange={event => setMapName(event.target.value)} /></label><button className="subtle-button full-width" disabled={readonly || !mapName.trim()} onClick={() => apply({ type: 'renameMap', name: mapName })}>应用地图名称</button></div>
        <div className="panel-title">对象<span><span data-testid="node-count">{scene.nodes.length}</span> 节点 · <span data-testid="road-count">{scene.roads.length}</span> 道路</span></div>
        <div className="object-list">{scene.nodes.length === 0 && scene.roads.length === 0 && <p className="empty-note">地图为空。选择“节点”工具，在画布上开始绘制。</p>}
          {scene.nodes.map(node => <button key={node.id} data-testid={'node-item-' + node.id} className={validSelection.nodes.includes(node.id) ? 'object-item selected' : 'object-item'} onClick={event => { choose('nodes', node.id, event.shiftKey); setTool('select'); }}><i className="object-node">●</i><span>{node.name || '(未命名节点)'}<small>{node.id}</small></span></button>)}
          {scene.roads.map(road => <button key={road.id} data-testid={'road-item-' + road.id} className={validSelection.roads.includes(road.id) ? 'object-item selected' : 'object-item'} onClick={event => { choose('roads', road.id, event.shiftKey); setTool('select'); }}><i className="object-road">━</i><span>{road.name || '(未命名道路)'}<small>{road.id}</small></span></button>)}
        </div>
        <div className="left-footer"><b>数据独立于画布</b><p>JSON 保存全部语义几何。平移和缩放仅改变视图。</p><code>{session.map.mapId}</code></div>
      </aside>
      <section className="center-panel">
        <div className="canvas-toolbar"><div className="history-actions"><button onClick={undo} disabled={!session.past.length} title="Ctrl+Z">撤销</button><button onClick={redo} disabled={!session.future.length} title="Ctrl+Shift+Z">重做</button><span className="toolbar-separator" /><button onClick={() => { setOperationIssues([]); setCopyDialog(true); }} disabled={readonly || selectedCount === 0}>复制</button><button onClick={remove} disabled={readonly || selectedCount === 0}>删除</button></div><div><button onClick={fit}>适应地图</button><span className="zoom-value">{Number(camera.scale.toPrecision(3))} px/m</span></div></div>
        {readonly && <div className="readonly-banner" data-testid="readonly-notice"><strong>只读地图</strong> · 含 M1 未支持的数据；保留完整 JSON，编辑已锁定。</div>}
        <div className="tool-hint">{hint}</div>
        <MapCanvas scene={scene} camera={camera} onCamera={setCamera} onSize={onCanvasSize} tool={tool} readonly={readonly} selection={validSelection} onSelect={choose} onClearSelection={() => setSelection(emptySelection())} onCursor={setCursor} draftRoad={draftRoad}
          onAddNode={point => { const id = uid('node'); if (apply({ type: 'addNode', id, node: newNode(point, '节点 ' + (scene.nodes.length + 1)) })) setSelection({ nodes: [id], roads: [] }); }}
          onRoadNode={id => {
            if (!draftRoad) { setDraftRoad({ fromNodeId: id, points: [] }); return; }
            const roadId = uid('road');
            if (apply({ type: 'addRoad', id: roadId, road: newRoad(draftRoad.fromNodeId, id, draftRoad.points, '道路 ' + (scene.roads.length + 1)) })) {
              setDraftRoad(null); setSelection({ nodes: [], roads: [roadId] }); setTool('select');
            }
          }}
          onRoadPoint={point => { if (draftRoad) setDraftRoad({ ...draftRoad, points: [...draftRoad.points, point] }); else setStatus('先点击已有节点作为道路起点。'); }}
          onTranslate={delta => { apply({ type: 'translateSelection', selection: validSelection, delta }); }}
        />
        <div className="canvas-status"><span>{cursor ? `X ${cursor[0].toFixed(3)} m  ·  Y ${cursor[1].toFixed(3)} m` : '本地 XY；屏幕 Y 方向仅影响显示'}</span><span>{selectedCount} 个选中 · {session.past.length} 个撤销事务</span></div>
        <section className="issue-panel" data-testid="issue-panel"><div className="issue-heading"><strong>检查器</strong><span className={errorCount ? 'error-count' : 'warning-count'}>{errorCount} 错误 · {issues.length - errorCount} 提示</span><span>draft 校验；不代表现场安全</span></div><div className="issue-list">{issues.map((issue, index) => <button key={issue.code + index} className={'issue-item ' + issue.severity} onClick={() => locate(issue)}><span className="issue-symbol">{issue.severity === 'error' ? '!' : '△'}</span><span><strong>{issue.code}</strong> {issue.message}<small>{issue.jsonPath || '/'} · {issue.suggestedAction}</small></span></button>)}</div></section>
      </section>
      <aside className="right-panel"><div className="panel-title">属性与引用<span>{selected ? selected.kind === 'node' ? 'NODE' : 'ROAD' : 'INSPECT'}</span></div><PropertyPanel key={(selected?.id ?? 'none') + '-' + session.changeToken} selected={selected} readonly={readonly} count={selectedCount} onApply={apply} />
        {readonly && <div className="capability-box"><h3>保留但未支持</h3>{capabilities.reasons.map(reason => <p key={reason}>{reason}</p>)}<h3>未渲染</h3><p>{capabilities.unrendered.join('、') || '无'}</p></div>}
        <div className="capability-box"><h3>本阶段未校验</h3><p>{capabilities.unchecked.join(' · ')}</p></div>
      </aside>
    </div>
    <footer className="app-footer"><span role="status">{status}</span><code data-testid="map-hash" title={scene.mapContentHash}>{scene.mapContentHash}</code></footer>
    {newDialog && <Modal title="新建地图" onCancel={() => setNewDialog(false)}><p>创建本地米制 synthetic 布局。地图 ID 独立生成。</p><label className="field-label">新地图名称<input aria-label="新地图名称" value={newName} onChange={event => setNewName(event.target.value)} /></label><div className="dialog-actions"><button data-cancel onClick={() => setNewDialog(false)}>取消</button><button className="primary-button" onClick={createNew} disabled={!newName.trim()}>创建地图</button></div></Modal>}
    {proposal && <Modal title="未保存编辑冲突" onCancel={() => { resolveImport(sessionRef.current, proposal.value, 'cancel'); setProposal(null); }}><p>当前地图有未导出编辑。候选 JSON 已完成校验，选择后才会替换当前地图。</p><div className="conflict-summary"><strong>当前：{session.map.metadata.name}</strong><span>候选：{proposal.value.loaded.map.metadata.name}</span></div><p className="field-note">“先导出当前版本”会下载独立文件并保留此对话。M1 不监听磁盘，不覆盖原文件。</p><div className="dialog-actions"><button data-cancel onClick={() => setProposal(null)}>取消</button><button onClick={exportCurrent}>先导出当前版本</button><button className="danger-button" onClick={() => finishImport(proposal.value, proposal.isNew)}>放弃编辑并重载</button></div></Modal>}
    {copyDialog && <Modal title="复制选中对象" onCancel={() => setCopyDialog(false)}><p>将复制 <strong>{closure.nodes.length} 个节点</strong>、<strong>{closure.roads.length} 条道路</strong>，道路端点自动包含并重映射为新 ID。</p><div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">{axis} 偏移 (m)<input aria-label={axis + ' 偏移 (m)'} type="number" step="any" value={copyDelta[index] ?? ''} onChange={event => setCopyDelta(values => values.map((v, i) => i === index ? event.target.value : v))} /></label>)}</div><p className="field-note">复制为一个事务；不会连接回原节点。对象扩展含未知引用语义时拒绝复制。</p>{operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map(issue => <p key={issue.code}>{issue.code}：{issue.message}</p>)}</div>}<div className="dialog-actions"><button data-cancel onClick={() => setCopyDialog(false)}>取消</button><button className="primary-button" onClick={duplicate}>确认复制</button></div></Modal>}
  </main>;
}