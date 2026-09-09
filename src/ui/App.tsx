import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { newMap, newNode, newRoad, newFacility, newZone } from '../domain/factory';
import { contentHash, serializeMap } from '../domain/serialization';
import { mapCapabilities } from '../domain/capabilities';
import { SELECTION_KINDS as selectionKinds, closureSelection, normalizeSelection, selectionImpact, type FullSelection, type MapCommand, type Selection } from '../domain/commands';
import type { Facility, Zone, Polygon, Issue, Vec3 } from '../domain/model';
import { createSession, editSession, isDirty, acknowledgeMap, prepareImport, redoSession, resolveImport, undoSession, type EditorSession, type ImportProposal } from '../editor/session';
import { toSceneSnapshot } from '../compiler/scene';
import { validateMap } from '../validation/validate';
import { downloadMap, readJsonFile } from '../adapters/files';
import { MapCanvas, type DraftRoad, type Tool } from '../renderers/2d/MapCanvas';
import type { Camera } from '../geometry/coordinates';
import { PropertyPanel } from './PropertyPanel';
import { Modal } from './Modal';
import { PointCreationPanel, makePointCreationDraft, applyPointPick, buildPointCreationCommand, type PointCreationDraft } from './PointCreationPanel';
import './workspace.css';
import { useProjectWorkspace } from './useProjectWorkspace';
import { LocalFileController } from '../adapters/localFiles';
import { DEFAULT_DRAWING_CONFIG, type DrawingConfig } from '../editor/projectController';
type FileConflict = Extract<Awaited<ReturnType<LocalFileController['check']>>, { status: 'conflict' }>;

type SelectionKind = keyof FullSelection;
const selectionNames: Record<SelectionKind, string> = { nodes: '节点', roads: '道路', facilities: '设施', zones: '区域', accessPoints: '入口', servicePoints: '服务点' };
const emptySelection = (): FullSelection => normalizeSelection({ nodes: [], roads: [] });
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
  const [copyRetainFacility, setCopyRetainFacility] = useState(false);
  const [drawingConfig, setDrawingConfig] = useState<DrawingConfig>(() => ({ ...DEFAULT_DRAWING_CONFIG }));
  const { facilityKind, zoneKind, facilityMovePolicy, zoneMovePolicy, snapGrid, snapNodes } = drawingConfig;
  const editorState = useMemo(() => ({ camera, drawing: drawingConfig }), [camera, drawingConfig]);
  const [pointDraft, setPointDraft] = useState<PointCreationDraft | null>(null);
  const [leaveIntent, setLeaveIntent] = useState<{ label: string; action: () => void } | null>(null);
  const [formEpoch, setFormEpoch] = useState(0);
  const [draftResetToken, setDraftResetToken] = useState(0);
  const [upgradeDialog, setUpgradeDialog] = useState(false);
  const [schemaUpgrading, setSchemaUpgrading] = useState(false);
  const upgrading = useRef(false);
  const [deleteDialog, setDeleteDialog] = useState(false);
  const [deleteMembers, setDeleteMembers] = useState(false);
  const [deleteUnusedNodes, setDeleteUnusedNodes] = useState(false);
  const [rotateDialog, setRotateDialog] = useState(false);
  const [rotateRadians, setRotateRadians] = useState('0');
  const [rotatePivot, setRotatePivot] = useState(['0', '0', '0']);
  const [splitDialog, setSplitDialog] = useState(false);
  const [splitDistance, setSplitDistance] = useState('');
  const [splitExistingNode, setSplitExistingNode] = useState('');
  const [mapName, setMapName] = useState(session.map.metadata.name);
  const [fileLoading, setFileLoading] = useState(false);
  const importSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const initializedCanvas = useRef(false);
  const [propertyDirty, setPropertyDirty] = useState(false);
  const [polygonDraftDirty, setPolygonDraftDirty] = useState(false);
  const [boundaryEditMode, setBoundaryEditMode] = useState<'auto' | 'polygon'>('auto');
  const [boundaryEditing, setBoundaryEditing] = useState(false);
  const boundaryInteraction = useRef(false);
  const onBoundaryInteractionChange = useCallback((active: boolean) => {
    boundaryInteraction.current = active; setBoundaryEditing(active);
  }, []);
  const onPropertyDirty = useCallback((value: boolean) => setPropertyDirty(value), []);
  const [saveDialog, setSaveDialog] = useState(false);
  const [recentDialog, setRecentDialog] = useState(false);
  const [storageConflictDialog, setStorageConflictDialog] = useState(false);
  const [local] = useState(() => new LocalFileController());
  const [localState, setLocalState] = useState(local.snapshot());
  const [localMessage, setLocalMessage] = useState('');
  const [fileConflict, setFileConflict] = useState<FileConflict | null>(null);
  const [overwriteReady, setOverwriteReady] = useState<{ token: number; mapHash: string } | null>(null);
  const preserveNative = useRef(false);
  const nativeTransition = useRef(false);
  const [exportMessage, setExportMessage] = useState('尚未导出 JSON');
  const projects = useProjectWorkspace({
    map: session.map, editorState,
    onAcknowledged: hash => updateSession(acknowledgeMap(sessionRef.current, hash)),
    onRestore: recovery => {
      importSequence.current++; setFileLoading(false);
      if (!preserveNative.current && !local.reset()) throw new Error('本地文件仍在处理中，工程界面未切换；请等待并重试。');
      updateSession({ ...createSession(recovery.map, true), changeToken: sessionRef.current.changeToken + 1 });
      setMapName(recovery.map.metadata.name); setSelection(emptySelection()); setDraftRoad(null); setTool('select');
      setBoundaryEditMode('auto'); onBoundaryInteractionChange(false);
      setPropertyDirty(false); setPolygonDraftDirty(false); setRecentDialog(false); setStorageConflictDialog(false); setNewDialog(false); setProposal(null); setOverwriteReady(null); setPointDraft(null); setLeaveIntent(null); setUpgradeDialog(false); setDraftResetToken(value => value + 1); setCopyDialog(false); setDeleteDialog(false); setRotateDialog(false); setSplitDialog(false); setSaveDialog(false); setOperationIssues([]); initializedCanvas.current = true;
      setCamera(recovery.editorState?.camera ?? { offsetX: 80, offsetY: 460, scale: 4 });
      setDrawingConfig({ ...(recovery.editorState?.drawing ?? DEFAULT_DRAWING_CONFIG) });
      if (!preserveNative.current) { setLocalState(local.snapshot()); setFileConflict(null); setLocalMessage(''); }
      setExportMessage('尚未导出 JSON');
      setStatus(recovery.source === 'new' ? '新工程已打开；浏览器草稿将自动保存。' : '已恢复浏览器工程，地图经共同校验与派生路径重建。');
    },
  });
  const unapplied = propertyDirty || mapName !== session.map.metadata.name || draftRoad !== null || polygonDraftDirty || pointDraft !== null || copyDialog || rotateDialog || splitDialog;
  const saveGuard = useRef({ browserDirty: true, unapplied: false });
  saveGuard.current = { browserDirty: projects.editorDirty || projects.state.active?.draftHash !== contentHash(session.map), unapplied: unapplied || boundaryEditing };
  useEffect(() => setMapName(session.map.metadata.name), [session.map.metadata.name]);
  const scene = useMemo(() => toSceneSnapshot(session.map), [session.map]);
  const capabilities = useMemo(() => mapCapabilities(session.map), [session.map]);
  const report = useMemo(() => validateMap(session.map), [session.map]);
  const domainReadonly = !capabilities.editable;
  const readonly = domainReadonly || !projects.ready || projects.transitioning || localState.busy || schemaUpgrading;
  const dirty = isDirty(session);
  const validSelection = useMemo(() => {
    const current = normalizeSelection(selection);
    return Object.fromEntries(selectionKinds.map(kind => [kind, current[kind].filter(id => Object.hasOwn(session.map[kind], id))])) as FullSelection;
  }, [selection, session.map]);
  const selectedCount = selectionKinds.reduce((total, kind) => total + validSelection[kind].length, 0);
  const closure = useMemo(() => closureSelection(session.map, validSelection), [session.map, validSelection]);
  const impact = useMemo(() => selectionImpact(session.map, validSelection, facilityMovePolicy, zoneMovePolicy), [session.map, validSelection, facilityMovePolicy, zoneMovePolicy]);  const issues = [...operationIssues, ...report.issues];
  const errorCount = issues.filter(i => i.severity === 'error').length;

  const onCanvasSize = useCallback((size: { width: number; height: number }) => {
    setCanvasSize(size);
    if (!initializedCanvas.current) { initializedCanvas.current = true; setCamera({ offsetX: 80, offsetY: size.height - 80, scale: 4 }); }
  }, []);
  function updateDrawingConfig(patch: Partial<DrawingConfig>) {
    if (!projects.ready || projects.isNavigating()) return;
    setDrawingConfig(current => ({ ...current, ...patch }));
  }
  function updateSession(next: EditorSession) { sessionRef.current = next; setSession(next); }
  function operationsBlocked() { return !projects.ready || projects.isNavigating() || local.snapshot().busy || nativeTransition.current || upgrading.current; }
  function apply(command: MapCommand): boolean {
    if (operationsBlocked()) { setStatus('工程或文件操作进行中，暂不接受地图修改。'); return false; }
    const result = editSession(sessionRef.current, command);
    setOperationIssues(result.issues);
    if (!result.ok) { setStatus('操作被拒绝，地图及历史记录保持不变。'); return false; }
    updateSession(result.session); setStatus('编辑已提交为一个可撤销事务。'); return true;
  }
  function cancelBoundaryInteraction() {
    if (!boundaryInteraction.current) return;
    onBoundaryInteractionChange(false); setDraftResetToken(value => value + 1);
  }
  function commitBoundary(kind: 'facilities' | 'zones', id: string, boundary: Polygon, baseMapHash: string, baseChangeToken: number): boolean {
    const current = sessionRef.current;
    if (readonly || operationsBlocked() || tool !== 'select' || propertyDirty || mapName !== current.map.metadata.name
      || selectedCount !== 1 || validSelection[kind][0] !== id || baseChangeToken !== current.changeToken || baseMapHash !== contentHash(current.map)) {
      setStatus('边界预览的编辑上下文已变化，未提交旧几何。'); return false;
    }
    return apply(kind === 'facilities' ? { type: 'updateFacility', id, patch: { boundary } } : { type: 'updateZone', id, patch: { boundary } });
  }
  function changeBoundaryMode(mode: 'auto' | 'polygon') {
    requestLeave('切换边界编辑模式', () => { setBoundaryEditMode(mode); setFormEpoch(value => value + 1); });
  }
  function requestLeave(label: string, action: () => void, protect = unapplied): boolean {
    if (operationsBlocked() || leaveIntent) return false;
    cancelBoundaryInteraction();
    if (protect) { setLeaveIntent({ label, action }); return false; }
    action(); return true;
  }
  function discardAndContinue() {
    const intent = leaveIntent;
    if (!intent || operationsBlocked()) return;
    setLeaveIntent(null); setPropertyDirty(false); setMapName(sessionRef.current.map.metadata.name);
    setFormEpoch(value => value + 1); setDraftResetToken(value => value + 1);
    setDraftRoad(null); setPolygonDraftDirty(false); setPointDraft(null);
    setCopyDialog(false); setRotateDialog(false); setSplitDialog(false);
    setStatus('已明确丢弃未应用输入，继续所选操作。'); intent.action();
  }
  function choose(kind: SelectionKind, id: string, additive: boolean) {
    return requestLeave('切换所选对象', () => {
      if (additive || selectedCount !== 1 || validSelection[kind][0] !== id) setBoundaryEditMode('auto');
      setSelection(current => {
        const normalized = normalizeSelection(current);
        if (!additive) return { ...emptySelection(), [kind]: [id] };
        return { ...normalized, [kind]: normalized[kind].includes(id) ? normalized[kind].filter(value => value !== id) : [...normalized[kind], id] };
      });
      setTool('select');
    });
  }
  function changeTool(value: Tool) { requestLeave('切换绘制工具', () => { setTool(value); setDraftRoad(null); }); }
  async function upgradeSchema() {
    if (operationsBlocked() || unapplied || sessionRef.current.map.schemaVersion !== '0.1.0') return;
    const before = sessionRef.current;
    const result = editSession(before, { type: 'upgradeSchema', targetVersion: '0.2.0' });
    if (!result.ok) { setOperationIssues(result.issues); return; }
    upgrading.current = true; setSchemaUpgrading(true);
    try {
      const backup = await projects.backup(before.map);
      if (sessionRef.current.changeToken !== before.changeToken) throw new Error('备份期间地图已变化，请重新执行升级。');
      if (!local.reset()) throw new Error('本地文件仍在处理中，未应用升级。');
      updateSession({ ...result.session, acknowledgedHash: sessionRef.current.acknowledgedHash });
      refreshLocal(); setFileConflict(null); setOverwriteReady(null); setUpgradeDialog(false);
      setLocalMessage('升级前原图已保留为浏览器备份；文件关联已解除，请将升级版本另存为新文件。');
      setStatus('Schema 0.1.0 → 0.2.0；revision ' + before.map.revision + ' → ' + result.session.map.revision + '。其余声明数据不变。备份：' + backup.projectId);
    } catch (error) { setOperationIssues([localIssue('SCHEMA_UPGRADE_FAILED', String(error))]); }
    finally { upgrading.current = false; setSchemaUpgrading(false); }
  }
  function exportCurrent() {
    cancelBoundaryInteraction();
    try {
      const current = sessionRef.current;
      const filename = downloadMap(current.map);
      setExportMessage('已发起 JSON 下载；不改变浏览器或本地文件保存状态。');
      setStatus('已发起下载 ' + filename + '；单 JSON 不包含底图二进制。');
    } catch (error) { setOperationIssues([localIssue('EXPORT_FAILED', error instanceof Error ? error.message : String(error))]); }
  }
  function saveProject(confirmed = false) {
    cancelBoundaryInteraction();
    if (unapplied && !confirmed) { setSaveDialog(true); return; }
    setSaveDialog(false);
    void projects.save().then(saved => { if (saved) setStatus('已提交地图和绘图配置已保存到浏览器工程；未应用输入仍留在表单中。'); }).catch(error => setOperationIssues([localIssue('PROJECT_SAVE_FAILED', String(error))]));
  }
  function showRecent() {
    cancelBoundaryInteraction();
    void projects.showRecent().then(() => setRecentDialog(true)).catch(error => setOperationIssues([localIssue('PROJECT_LIST_FAILED', String(error))]));
  }
  async function openProject(id: string) {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    if (unapplied) { setStatus('有未应用输入，请先应用或恢复输入后再切换工程。'); return; }
    try { await projects.open(id); setRecentDialog(false); } catch (error) { setOperationIssues([localIssue('PROJECT_OPEN_FAILED', String(error))]); }
  }
  async function reloadStoredProject() {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    try { await projects.reloadStored(); setStorageConflictDialog(false); } catch (error) { setStatus(String(error)); }
  }
  async function copyProject() {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    if (unapplied) { setSaveDialog(true); return; }
    try { await projects.recoveryCopy(); setStorageConflictDialog(false); setFileConflict(null); setStatus('已另存浏览器恢复副本；地图 ID 保留，存储项目 ID 独立。'); }
    catch (error) { setOperationIssues([localIssue('PROJECT_COPY_FAILED', String(error))]); }
  }
  function refreshLocal() { setLocalState(local.snapshot()); }
  async function checkFile() {
    if (operationsBlocked()) return;
    const pending = local.check(); refreshLocal();
    const result = await pending; refreshLocal();
    if (result.status === 'conflict') { setFileConflict(result); setOverwriteReady(null); }
    else if (result.status !== 'unchanged' && result.status !== 'unlinked' && result.status !== 'busy') setLocalMessage(result.message);
  }
  async function openNative(reload = false) {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    nativeTransition.current = true;
    const pending = reload ? local.readCurrent() : local.open(); refreshLocal();
    const result = await pending; refreshLocal();
    if (result.status !== 'opened') { nativeTransition.current = false; setLocalMessage(result.message); if (result.issues) setOperationIssues(result.issues); return; }
    if (saveGuard.current.unapplied) { nativeTransition.current = false; local.cancelOpen(result.token); setLocalMessage('有未应用输入；先应用或撤销输入，再关联文件。'); return; }
    preserveNative.current = true;
    try {
      await projects.create(result.loaded.map);
      const accepted = local.acceptOpen(result.token);
      setLocalMessage(accepted.status === 'linked' ? '文件已关联；写回需要单独操作。' : accepted.message);
      setFileConflict(null); setOverwriteReady(null);
    } catch (error) { local.cancelOpen(result.token); setLocalMessage(String(error)); }
    finally { preserveNative.current = false; nativeTransition.current = false; refreshLocal(); }
  }
  async function writeNative(saveAs = false, overwriteToken?: number) {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    if (unapplied) { setLocalMessage('有未应用输入，请先应用属性；未写回文件。'); return; }
    const map = sessionRef.current.map;
    if (overwriteToken !== undefined && (overwriteReady?.token !== overwriteToken || overwriteReady.mapHash !== contentHash(map))) {
      setLocalMessage('当前地图或外部版本已变化，请重新保留恢复副本后确认。'); return;
    }
    const pending = saveAs ? local.saveAs(map) : local.write(map, overwriteToken); refreshLocal();
    const result = await pending; refreshLocal();
    if (result.status === 'conflict') { setFileConflict(result); setOverwriteReady(null); }
    else if (result.status === 'saved') { setLocalMessage('文件写回并关闭成功：' + result.name); setFileConflict(null); setOverwriteReady(null); }
    else setLocalMessage(result.message);
  }
  async function prepareOverwrite() {
    if (operationsBlocked()) return;
    const startingHash = contentHash(sessionRef.current.map);
    if (!fileConflict?.loaded?.ok) { setLocalMessage('外部文件非法，保留原件；可另存当前地图到新文件。'); return; }
    try {
      await projects.save();
      await projects.backup(fileConflict.loaded.map);
      if (contentHash(sessionRef.current.map) !== startingHash) { setOverwriteReady(null); setLocalMessage('备份期间产生新编辑，请重新保存双方副本再确认。'); return; }
      setOverwriteReady({ token: fileConflict.token, mapHash: startingHash });
      setLocalMessage('当前版本和外部版本已各自存入浏览器，可明确确认覆盖。');
    } catch (error) { setLocalMessage('恢复副本保存失败，未覆盖外部文件：' + String(error)); }
  }
  useEffect(() => {
    const focus = () => { void checkFile(); };
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  });
  function undo() { requestLeave('撤销地图事务', () => { updateSession(undoSession(sessionRef.current)); setOperationIssues([]); setDraftRoad(null); setStatus('已撤销一个事务。'); }); }
  function redo() { requestLeave('重做地图事务', () => { updateSession(redoSession(sessionRef.current)); setOperationIssues([]); setDraftRoad(null); setStatus('已重做一个事务。'); }); }
  function addPolygon(kind: 'facilities' | 'zones', boundary: Polygon) {
    const id = uid(kind === 'facilities' ? 'facility' : 'zone');
    const command: MapCommand = kind === 'facilities'
      ? { type: 'addFacility', id, facility: newFacility(boundary, '设施 ' + (scene.facilities.length + 1), facilityKind) }
      : { type: 'addZone', id, zone: newZone(boundary, '区域 ' + (scene.zones.length + 1), zoneKind) };
    let accepted = false;
    requestLeave('提交绘制的空间对象', () => { accepted = apply(command); if (accepted) { setSelection({ ...emptySelection(), [kind]: [id] }); setTool('select'); } }, propertyDirty || mapName !== session.map.metadata.name);
    return accepted;
  }
  function openPointDialog(kind: 'accessPoints' | 'servicePoints') {
    if (readonly) return;
    requestLeave('添加关联点', () => { setPointDraft(makePointCreationDraft(kind, validSelection, session.map)); setOperationIssues([]); });
  }
  function createPoint() {
    if (!pointDraft || operationsBlocked()) return;
    const result = buildPointCreationCommand(pointDraft, session.map, uid);
    if (!result.ok) { setOperationIssues(result.issues); return; }
    if (apply(result.command)) { setSelection({ ...emptySelection(), [result.kind]: [result.id] }); setPointDraft(null); setTool('select'); }
  }
  function rotate() {
    if (!rotateRadians.trim() || !Number.isFinite(Number(rotateRadians)) || rotatePivot.some(value => !value.trim() || !Number.isFinite(Number(value)))) { setOperationIssues([localIssue('INVALID_ROTATION', '旋转角度为有限弧度，旋转中心为有限 XYZ 米制坐标。')]); return; }
    if (apply({ type: 'rotateSelection', selection: validSelection, pivot: rotatePivot.map(Number) as Vec3, angleRad: Number(rotateRadians), facilityMovePolicy, zoneMovePolicy })) setRotateDialog(false);
  }
  function splitRoad() {
    const id = validSelection.roads[0];
    if (!id || !splitDistance.trim() || !Number.isFinite(Number(splitDistance))) { setOperationIssues([localIssue('INVALID_SPLIT_DISTANCE', '请明确输入自道路起点量起的内部切分距离（m）。')]); return; }
    const newRoadIds: [string, string] = [uid('road'), uid('road')];
    const nodeId = splitExistingNode || uid('node');
    if (apply({ type: 'splitRoad', id, distanceM: Number(splitDistance), nodeId, existingNode: !!splitExistingNode, newRoadIds })) { setSelection({ ...emptySelection(), nodes: [nodeId], roads: newRoadIds }); setSplitDialog(false); }
  }
  function confirmDelete() {
    if (apply({ type: 'deleteSelection', selection: validSelection, facilityPolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', zonePolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', orphanNodes: deleteUnusedNodes ? 'deleteUnused' : 'keep' })) { setSelection(emptySelection()); setDeleteDialog(false); }
  }
  function remove() {
    if (selectedCount === 0 || readonly) return;
    requestLeave('删除所选对象', () => {
      if (validSelection.facilities.length || validSelection.zones.length || validSelection.accessPoints.length || validSelection.servicePoints.length) { setDeleteMembers(false); setDeleteUnusedNodes(false); setOperationIssues([]); setDeleteDialog(true); return; }
      if (apply({ type: 'deleteSelection', selection: validSelection })) setSelection(emptySelection());
    });
  }
  function fit() {
    cancelBoundaryInteraction();
    const bounds = scene.bounds;
    if (!bounds) { setCamera({ offsetX: 80, offsetY: canvasSize.height - 80, scale: 4 }); return; }
    const width = Math.max(10, bounds.max[0] - bounds.min[0]);
    const height = Math.max(10, bounds.max[1] - bounds.min[1]);
    const scale = Math.min(10, Math.max(0.02, Math.min((canvasSize.width - 100) / width, (canvasSize.height - 100) / height)));
    const next = { scale, offsetX: canvasSize.width / 2 - (bounds.min[0] / 2 + bounds.max[0] / 2) * scale, offsetY: canvasSize.height / 2 + (bounds.min[1] / 2 + bounds.max[1] / 2) * scale };
    if (!Object.values(next).every(Number.isFinite)) { setStatus('当前坐标超出视图可表示范围；请通过数值属性调整坐标。'); return; }
    setCamera(next);
  }
  async function finishImport(candidate: ImportProposal, isNew: boolean) {
    if (operationsBlocked()) return;
    const result = resolveImport(sessionRef.current, candidate, 'replace');
    setOperationIssues(result.issues);
    if (!result.ok) { setProposal(null); setStatus('候选已过期或无效，请重新导入。'); return; }
    try {
      await projects.create(result.session.map);
      setProposal(null);
      setStatus(isNew ? '已新建 synthetic 工程；上一工程保留在浏览器中。' : '已从 JSON 新建浏览器工程，原工程保存版本保留。');
    } catch (error) { setOperationIssues([localIssue('PROJECT_SWITCH_FAILED', String(error))]); }
  }  function prepare(text: string, isNew = false) {
    if (operationsBlocked()) return;
    const result = prepareImport(sessionRef.current, text);
    if (result.status === 'invalid') { setOperationIssues(result.issues); setStatus('导入失败；当前地图、历史和保存基线保持不变。'); return; }
    if (result.status === 'conflict' || saveGuard.current.unapplied) setProposal({ value: result, isNew });
    else finishImport(result, isNew);
  }
  async function importFile(file: File) {
    const sequence = ++importSequence.current; setFileLoading(true);
    try { const text = await readJsonFile(file); if (sequence === importSequence.current) prepare(text); }
    catch (error) { if (sequence === importSequence.current) setOperationIssues([localIssue('FILE_READ_FAILED', error instanceof Error ? error.message : String(error))]); }
    finally { if (sequence === importSequence.current) setFileLoading(false); }
  }
  function createNew() {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    if (!newName.trim()) return;
    importSequence.current++; setFileLoading(false); setNewDialog(false);
    prepare(serializeMap(newMap(uid('map'), newName.trim())), true);
  }
  function duplicate() {
    if (copyDelta.some(value => !value.trim() || !Number.isFinite(Number(value)))) { setOperationIssues([localIssue('INVALID_COPY_OFFSET', '复制偏移必须为有限米制数值。')]); return; }
    const idMap = Object.fromEntries(selectionKinds.flatMap(kind => closure[kind].map(id => [id, uid(({ nodes: 'node', roads: 'road', facilities: 'facility', zones: 'zone', accessPoints: 'access', servicePoints: 'service' })[kind])])));
    if (apply({ type: 'duplicateSelection', selection: validSelection, delta: copyDelta.map(Number) as Vec3, idMap, associationPolicy: copyRetainFacility ? 'retainOwner' : 'rejectExternal' })) {
      setSelection(Object.fromEntries(selectionKinds.map(kind => [kind, closure[kind].map(id => idMap[id]!)])) as FullSelection); setCopyDialog(false);
    }
  }
  function locate(issue: Issue) {
    const kind = issue.entityType as SelectionKind | undefined;
    if (kind && selectionKinds.includes(kind) && issue.entityId && Object.hasOwn(session.map[kind], issue.entityId)) { choose(kind, issue.entityId, false); }
    const point = issue.location?.position;
    if (point) setCamera(current => ({ ...current, offsetX: canvasSize.width / 2 - point[0] * current.scale, offsetY: canvasSize.height / 2 + point[1] * current.scale }));
  }
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (saveGuard.current.browserDirty || saveGuard.current.unapplied) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); if (!leaveIntent && !upgradeDialog) saveProject(); return; }
      const target = event.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (proposal || newDialog || copyDialog || saveDialog || recentDialog || storageConflictDialog || fileConflict || pointDraft || deleteDialog || rotateDialog || splitDialog || leaveIntent || upgradeDialog) {
        if ((modifier && ['z', 'y'].includes(event.key.toLowerCase())) || ['Delete', 'Backspace'].includes(event.key)) event.preventDefault();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
      else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
      else if (event.key === 'Escape') { event.preventDefault(); requestLeave('取消绘制和选择', () => { setDraftRoad(null); setDraftResetToken(value => value + 1); setTool('select'); setSelection(emptySelection()); }); }
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const selectedNodeId = selectedCount === 1 && validSelection.nodes.length === 1 ? validSelection.nodes[0] : undefined;
  const selectedRoadId = selectedCount === 1 && validSelection.roads.length === 1 ? validSelection.roads[0] : undefined;
  const selected = selectedNodeId ? { kind: 'node' as const, id: selectedNodeId, value: session.map.nodes[selectedNodeId]! }
    : selectedRoadId ? { kind: 'road' as const, id: selectedRoadId, value: session.map.roads[selectedRoadId]!, lengthM: scene.roads.find(road => road.id === selectedRoadId)!.lengthM }
    : selectedCount === 1 && validSelection.facilities[0] ? { kind: 'facility' as const, id: validSelection.facilities[0], value: session.map.facilities[validSelection.facilities[0]]! }
    : selectedCount === 1 && validSelection.zones[0] ? { kind: 'zone' as const, id: validSelection.zones[0], value: session.map.zones[validSelection.zones[0]]! }
    : selectedCount === 1 && validSelection.accessPoints[0] ? { kind: 'accessPoint' as const, id: validSelection.accessPoints[0], value: session.map.accessPoints[validSelection.accessPoints[0]]! }
    : selectedCount === 1 && validSelection.servicePoints[0] ? { kind: 'servicePoint' as const, id: validSelection.servicePoints[0], value: session.map.servicePoints[validSelection.servicePoints[0]]! } : null;
  const hint = readonly ? '只读检查：可查看、定位并原样导出 JSON。'
    : tool === 'node' ? '点击空白位置创建节点。坐标可在右侧精确修改。'
    : tool === 'road' ? (draftRoad ? '点击空白处添加内部折点，再点击目标节点完成道路。Esc 取消。' : '先点击已有起点节点；道路交叉不会自动连接。')
    : tool === 'facilityRect' || tool === 'zoneRect' ? '依次点击矩形的两个对角点；几何按世界米制坐标保存。'
    : tool === 'facilityPolygon' || tool === 'zonePolygon' ? '依次点击顶点，点击起点或 Enter 完成多边形；Esc 取消。'
    : tool === 'pan' ? '按住鼠标拖动平移，滚轮缩放。'
    : '拖动节点移动；Shift 点击多选；滚轮缩放；中键平移。';

  return <main className="app-shell">
    <header className="app-header"><div className="brand-mark">Y</div><div><h1>船厂空间布局编辑器</h1><p>轻量拓扑绘制 · 外部系统数据准备</p></div><div className="header-actions"><button onClick={showRecent} disabled={!projects.ready || projects.transitioning || localState.busy}>最近项目</button><button onClick={() => void copyProject()} disabled={!projects.ready || projects.transitioning || localState.busy}>浏览器另存为</button><button className="primary-button" onClick={() => saveProject()} disabled={!projects.ready || projects.transitioning}>保存工程</button><button disabled={!projects.ready || projects.transitioning || localState.busy} onClick={() => { setNewName('新建布局'); setNewDialog(true); }}>新建地图</button><button onClick={() => fileInput.current?.click()} disabled={fileLoading || !projects.ready || projects.transitioning || localState.busy}>{fileLoading ? '读取中…' : '导入 JSON'}</button><button className="primary-button" onClick={exportCurrent}>导出 JSON</button><button disabled title="M2B 将实现底图资源和 ZIP 工程往返；当前请导出 JSON 备份">工程 ZIP（M2B）</button></div></header>
    <input ref={fileInput} data-testid="json-file-input" type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
    <div className="document-bar"><strong>{session.map.metadata.name}</strong><span className="basis-chip">{session.map.metadata.layoutBasis}</span><span className={dirty ? 'save-status dirty' : 'save-status'} data-testid="save-status"><span data-testid="browser-save-status">{projects.browserStatus}</span></span><span className="document-meta">v{session.map.schemaVersion} · r{session.map.revision} · 本地坐标 · m / rad / kg / s</span></div>
    {session.map.schemaVersion === '0.1.0' && <div className="project-note">旧版 0.1.0 原样兼容。区域归属和到达语义需要显式升级。<button onClick={() => requestLeave('升级 Schema', () => setUpgradeDialog(true))} disabled={!projects.ready || projects.transitioning || localState.busy || schemaUpgrading || projects.temporary}>升级到 0.2.0</button></div>}
    <div className="project-save-bar">
      <span data-testid="local-save-status">{localState.busy ? '本地文件处理中…' : localState.conflict ? '本地文件冲突' : !localState.linkedName ? '本地文件未关联' : localState.confirmedContentHash === scene.mapContentHash ? '本地文件已确认：' + localState.linkedName : '本地文件有未写回变化：' + localState.linkedName}</span>
      <button onClick={() => void openNative()} disabled={!local.capabilities().open || localState.busy || projects.transitioning} title="浏览器能力检测；点击后才请求文件授权">关联本地 JSON</button>
      <button onClick={() => void writeNative()} disabled={!localState.linkedName || localState.busy || projects.transitioning}>写回关联文件</button>
      <button onClick={() => void writeNative(true)} disabled={!local.capabilities().saveAs || localState.busy || projects.transitioning}>文件另存为</button>
      <button onClick={() => void checkFile()} disabled={!localState.linkedName || localState.busy}>检查外部变化</button>
      <button onClick={() => void openNative(true)} disabled={!localState.linkedName || localState.busy}>重新载入文件</button>
      <span data-testid="export-status">{exportMessage}</span>
    </div>
    {projects.warning && <div className="project-note">{projects.warning}</div>}
    {localMessage && <div className="project-note" role="status">{localMessage}</div>}
    {unapplied && <div className="project-note pending" data-testid="unapplied-inputs">有未应用输入：属性、操作表单或绘制尚未提交；请应用属性或完成当前操作。</div>}
    {projects.state.error?.code === 'PROJECT_CONFLICT' && <div className="project-note conflict" role="alert">其他标签页已保存此工程，当前编辑尚未覆盖远程浏览器版本。<button onClick={() => void copyProject()}>保留当前恢复副本</button><button onClick={() => { if (!operationsBlocked()) setStorageConflictDialog(true); }}>重新载入浏览器版本</button></div>}
    <div className="workspace">
      <aside className="left-panel">
        <div className="panel-title">绘制工具<span>M2A.1</span></div>
        <div className="tool-grid">{([{ id: 'select', label: '选择', icon: '↖' }, { id: 'node', label: '节点', icon: '⊙' }, { id: 'road', label: '道路折线', icon: '⌁' }, { id: 'pan', label: '平移', icon: '✥' }, { id: 'facilityRect', label: '矩形设施', icon: '▭' }, { id: 'facilityPolygon', label: '多边形设施', icon: '⬡' }, { id: 'zoneRect', label: '矩形区域', icon: '▧' }, { id: 'zonePolygon', label: '多边形区域', icon: '◇' }] as const).map(item => <button key={item.id} className={tool === item.id ? 'tool-button active' : 'tool-button'} aria-label={item.label} aria-pressed={tool === item.id} disabled={readonly && item.id !== 'select' && item.id !== 'pan'} onClick={() => changeTool(item.id)}><b>{item.icon}</b>{item.label}</button>)}</div>
        <div className="spatial-controls">
          <label className="field-label">设施类型<select aria-label="新建设施类型" value={facilityKind} disabled={readonly} onChange={event => updateDrawingConfig({ facilityKind: event.target.value as Facility['kind'] })}>{Object.entries({ workshop: '厂房', yard: '堆场', assembly: '总组', dock: '坞区', quay: '码头', other: '其他' }).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label className="field-label">区域类型<select aria-label="新建区域类型" value={zoneKind} disabled={readonly} onChange={event => updateDrawingConfig({ zoneKind: event.target.value as Zone['kind'] })}>{Object.entries({ work: '作业', buffer: '缓冲', waiting: '等待', water: '水域', obstacle: '障碍', forbidden: '禁入', drivable: '可行驶' }).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <div className="tool-grid"><button onClick={() => openPointDialog('accessPoints')} disabled={readonly}>添加入口</button><button onClick={() => openPointDialog('servicePoints')} disabled={readonly}>添加服务点</button></div>
          <label className="field-label">网格吸附<select aria-label="网格吸附" disabled={!projects.ready || projects.transitioning} value={snapGrid} onChange={event => updateDrawingConfig({ snapGrid: Number(event.target.value) as DrawingConfig['snapGrid'] })}><option value="0">关闭</option><option value="1">1 m</option><option value="5">5 m</option><option value="10">10 m</option></select></label>
          <label className="check-field"><input type="checkbox" aria-label="节点吸附" disabled={!projects.ready || projects.transitioning} checked={snapNodes} onChange={event => updateDrawingConfig({ snapNodes: event.target.checked })} />节点吸附（坐标，不自动接路）</label>
          <label className="field-label">设施移动策略<select aria-label="设施移动策略" disabled={!projects.ready || projects.transitioning} value={facilityMovePolicy} onChange={event => updateDrawingConfig({ facilityMovePolicy: event.target.value as typeof facilityMovePolicy })}><option value="boundaryOnly">仅移动边界，关联点保持</option><option value="withAssociatedNodes">边界和关联节点一起移动</option></select></label>
          <label className="field-label">区域移动策略<select aria-label="区域移动策略" disabled={!projects.ready || projects.transitioning} value={zoneMovePolicy} onChange={event => updateDrawingConfig({ zoneMovePolicy: event.target.value as typeof zoneMovePolicy })}><option value="boundaryOnly">仅移动边界，服务点保持</option><option value="withAssociatedNodes">边界和服务节点一起移动</option></select></label>
          <button className="subtle-button full-width" disabled={!projects.ready || projects.transitioning} onClick={() => updateDrawingConfig(DEFAULT_DRAWING_CONFIG)}>恢复绘图默认配置</button>
          {(validSelection.facilities.length > 0 || validSelection.zones.length > 0) && <p className="field-note" data-testid="move-impact">将移动 {impact.selection.nodes.length} 个节点，影响 {impact.affectedRoadIds.length} 条道路；{facilityMovePolicy === 'boundaryOnly' ? '设施入口/服务点留在原地。' : '共享节点会使相邻道路端点一起变化。'}<br/>{impact.affectedRoadIds.join('、')}<br/>区域策略：{zoneMovePolicy === 'boundaryOnly' ? '仅移动边界，服务点保持原位。' : '边界和关联服务节点一起移动。'}共享节点：{impact.sharedNodeIds.join('、') || '无'}</p>}
        </div>
        <div className="panel-title">地图信息</div>
        <div className="map-name-editor"><label className="field-label">地图名称<input aria-label="地图名称" value={mapName} disabled={readonly || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty} onChange={event => setMapName(event.target.value)} /></label><button className="subtle-button full-width" disabled={readonly || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty || !mapName.trim()} onClick={() => requestLeave('应用地图名称', () => apply({ type: 'renameMap', name: mapName }), propertyDirty)}>应用地图名称</button></div>
        <div className="panel-title">对象<span><span data-testid="node-count">{scene.nodes.length}</span> 节点 · <span data-testid="road-count">{scene.roads.length}</span> 道路</span></div>
        <div className="object-list">{selectionKinds.every(kind => Object.keys(session.map[kind]).length === 0) && <p className="empty-note">地图为空。选择“节点”工具，在画布上开始绘制。</p>}
          {scene.nodes.map(node => <button key={node.id} data-testid={'node-item-' + node.id} className={validSelection.nodes.includes(node.id) ? 'object-item selected' : 'object-item'} onClick={event => { choose('nodes', node.id, event.shiftKey); }}><i className="object-node">●</i><span>{node.name || '(未命名节点)'}<small>{node.id}</small></span></button>)}
          {scene.roads.map(road => <button key={road.id} data-testid={'road-item-' + road.id} className={validSelection.roads.includes(road.id) ? 'object-item selected' : 'object-item'} onClick={event => { choose('roads', road.id, event.shiftKey); }}><i className="object-road">━</i><span>{road.name || '(未命名道路)'}<small>{road.id}</small></span></button>)}
          {(['facilities', 'zones', 'accessPoints', 'servicePoints'] as const).map(kind => <div className="spatial-object-group" key={kind}><div className="object-group-label">{selectionNames[kind]} <span data-testid={kind + '-count'}>{Object.keys(session.map[kind]).length}</span></div>{Object.entries(session.map[kind]).map(([id, value]) => <button key={id} data-testid={kind + '-item-' + id} className={validSelection[kind].includes(id) ? 'object-item selected' : 'object-item'} onClick={event => { choose(kind, id, event.shiftKey); }}><i>{kind === 'facilities' ? '▣' : kind === 'zones' ? '◇' : '⊕'}</i><span>{value.name}<small>{id}</small></span></button>)}</div>)}
        </div>
        <div className="left-footer"><b>数据独立于画布</b><p>JSON 保存全部语义几何。平移和缩放仅改变视图。</p><code>{session.map.mapId}</code></div>
      </aside>
      <section className="center-panel">
        <div className="canvas-toolbar"><div className="history-actions"><button onClick={undo} disabled={!session.past.length || projects.transitioning || localState.busy} title="Ctrl+Z">撤销</button><button onClick={redo} disabled={!session.future.length || projects.transitioning || localState.busy} title="Ctrl+Shift+Z">重做</button><span className="toolbar-separator" /><button onClick={() => requestLeave('复制所选对象', () => { setOperationIssues([]); setCopyRetainFacility(false); setCopyDialog(true); })} disabled={readonly || selectedCount === 0}>复制</button><button onClick={remove} disabled={readonly || selectedCount === 0}>删除</button><button onClick={() => requestLeave('旋转所选对象', () => { setOperationIssues([]); setRotateDialog(true); })} disabled={readonly || selectedCount === 0}>旋转</button><button onClick={() => requestLeave('拆分道路', () => { setOperationIssues([]); setSplitDistance(''); setSplitExistingNode(''); setSplitDialog(true); })} disabled={readonly || selectedCount !== 1 || validSelection.roads.length !== 1}>拆分道路</button></div><div><button onClick={fit}>适应地图</button><span className="zoom-value">{Number(camera.scale.toPrecision(3))} px/m</span></div></div>
        {domainReadonly && <div className="readonly-banner" data-testid="readonly-notice"><strong>只读地图</strong> · 含尚未支持的行为、资源或底图等数据；保留完整 JSON，编辑已锁定。</div>}
        <div className="tool-hint">{hint}</div>
        <MapCanvas boundaryEditMode={boundaryEditMode} boundaryChangeToken={session.changeToken} onBoundaryCommit={commitBoundary} onBoundaryInteractionChange={onBoundaryInteractionChange} hasUnappliedInput={propertyDirty || mapName !== session.map.metadata.name} draftResetToken={draftResetToken} {...(pointDraft?.canvasMode ? { pointPick: { mode: pointDraft.canvasMode }, onPointPick: result => setPointDraft(current => current ? applyPointPick(current, result) : null) } : {})} onDraftChange={setPolygonDraftDirty} onPolygonCreate={addPolygon} snap={{ gridM: Number(snapGrid) || null, nodes: snapNodes }} movingNodeIds={impact.selection.nodes} scene={scene} camera={camera} onCamera={setCamera} onSize={onCanvasSize} tool={tool} readonly={readonly || !!(proposal || newDialog || copyDialog || saveDialog || recentDialog || storageConflictDialog || fileConflict || (!pointDraft?.canvasMode && pointDraft) || deleteDialog || rotateDialog || splitDialog || leaveIntent || upgradeDialog)} selection={validSelection} onSelect={choose} onClearSelection={() => requestLeave('取消选择', () => setSelection(emptySelection()))} onCursor={setCursor} draftRoad={draftRoad}
          onAddNode={point => requestLeave('绘制节点', () => { const id = uid('node'); if (apply({ type: 'addNode', id, node: newNode(point, '节点 ' + (scene.nodes.length + 1)) })) setSelection({ nodes: [id], roads: [] }); })}
          onRoadNode={id => requestLeave('绘制道路', () => {
            if (!draftRoad) { setDraftRoad({ fromNodeId: id, points: [] }); return; }
            const roadId = uid('road');
            if (apply({ type: 'addRoad', id: roadId, road: newRoad(draftRoad.fromNodeId, id, draftRoad.points, '道路 ' + (scene.roads.length + 1)) })) {
              setDraftRoad(null); setSelection({ nodes: [], roads: [roadId] }); setTool('select');
            }
          }, propertyDirty || mapName !== session.map.metadata.name)}
          onRoadPoint={point => { if (draftRoad) setDraftRoad({ ...draftRoad, points: [...draftRoad.points, point] }); else setStatus('先点击已有节点作为道路起点。'); }}
          onTranslate={delta => { requestLeave('移动所选对象', () => apply({ type: 'translateSelection', selection: validSelection, delta, facilityMovePolicy, zoneMovePolicy })); }}
        />
        <div className="canvas-status"><span>{cursor ? `X ${cursor[0].toFixed(3)} m  ·  Y ${cursor[1].toFixed(3)} m` : '本地 XY；屏幕 Y 方向仅影响显示'}</span><span>{selectedCount} 个选中 · {session.past.length} 个撤销事务</span></div>
        <section className="issue-panel" data-testid="issue-panel"><div className="issue-heading"><strong>检查器</strong><span className={errorCount ? 'error-count' : 'warning-count'}>{errorCount} 错误 · {issues.length - errorCount} 提示</span><span>draft 校验；不代表现场安全</span></div><div className="issue-list">{issues.map((issue, index) => <button key={issue.code + index} className={'issue-item ' + issue.severity} onClick={() => locate(issue)}><span className="issue-symbol">{issue.severity === 'error' ? '!' : '△'}</span><span><strong>{issue.code}</strong> {issue.message}<small>{issue.jsonPath || '/'} · {issue.suggestedAction}</small></span></button>)}</div></section>
      </section>
      <aside className="right-panel"><div className="panel-title">属性与引用<span>{selected ? selected.kind.toUpperCase() : 'INSPECT'}</span></div><PropertyPanel boundaryEditMode={boundaryEditMode} onBoundaryModeChange={changeBoundaryMode} map={session.map} facilityMovePolicy={facilityMovePolicy} zoneMovePolicy={zoneMovePolicy} onZoneMovePolicyChange={value => updateDrawingConfig({ zoneMovePolicy: value })} onMovePolicyChange={value => updateDrawingConfig({ facilityMovePolicy: value })} onDirtyChange={onPropertyDirty} key={(selected?.id ?? 'none') + '-' + session.changeToken + '-' + formEpoch} selected={selected} readonly={readonly || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty || upgradeDialog} count={selectedCount} onApply={apply} />
        {domainReadonly && <div className="capability-box"><h3>保留但未支持</h3>{capabilities.reasons.map(reason => <p key={reason}>{reason}</p>)}<h3>未渲染</h3><p>{capabilities.unrendered.join('、') || '无'}</p></div>}
        <div className="capability-box"><h3>本阶段未校验</h3><p>{capabilities.unchecked.join(' · ')}</p></div>
      </aside>
    </div>
    <footer className="app-footer"><span role="status">{status}</span><code data-testid="map-hash" title={scene.mapContentHash}>{scene.mapContentHash}</code></footer>


    {recentDialog && <Modal title="最近项目" onCancel={() => setRecentDialog(false)}><p>浏览器数据按站点保存，可能被清理；请保留导出备份。切换前将确认保存当前已提交版本。</p><div className="recent-projects">{projects.recent.map(item => <button key={item.projectId} data-testid={'project-item-' + item.projectId} onClick={() => void openProject(item.projectId)}><strong>{item.name}</strong><small>{item.projectId} · 存储版本 {item.storageVersion} · {new Date(item.updatedAt).toLocaleString()}</small></button>)}</div><div className="dialog-actions"><button data-cancel onClick={() => setRecentDialog(false)}>关闭</button></div></Modal>}
    {storageConflictDialog && <Modal title="重新载入浏览器版本" onCancel={() => setStorageConflictDialog(false)}><p>重新载入会放弃当前未保存输入。建议先“保留当前恢复副本”；其他标签页已保存版本不会被覆盖。</p><div className="dialog-actions"><button data-cancel onClick={() => setStorageConflictDialog(false)}>取消</button><button onClick={() => void copyProject()}>保留当前恢复副本</button><button className="danger-button" onClick={() => void reloadStoredProject()}>明确放弃并重新载入</button></div></Modal>}
    {fileConflict && <Modal title="外部文件内容已变化" onCancel={() => setFileConflict(null)}><p>文件 {fileConflict.name} 与已确认基线不同。当前地图保持不变，写回前会再次读取外部内容。</p><p>{localMessage}</p>{fileConflict.issues.map((issue, index) => <p key={index} className="inline-error">{issue.code} · {issue.jsonPath || "/"} · {issue.message}</p>)}<div className="dialog-actions"><button data-cancel onClick={() => setFileConflict(null)}>取消</button><button onClick={() => void openNative(true)}>重新载入文件</button><button onClick={() => void copyProject()}>保留当前恢复副本</button><button onClick={() => void writeNative(true)}>文件另存为</button>{overwriteReady?.token === fileConflict.token ? <button className="danger-button" onClick={() => void writeNative(false, fileConflict.token)}>明确覆盖外部版本</button> : <button onClick={() => void prepareOverwrite()} disabled={!fileConflict.loaded?.ok}>先保存双方恢复副本</button>}</div><p className="field-note">写前比对不能锁定其他应用；不保证跨应用原子写入。非法外部文件保留原件，不能直接覆盖。</p></Modal>}
    {newDialog && <Modal title="新建地图" onCancel={() => setNewDialog(false)}><p>创建本地米制 synthetic 布局。地图 ID 独立生成。</p><label className="field-label">新地图名称<input aria-label="新地图名称" value={newName} onChange={event => setNewName(event.target.value)} /></label><div className="dialog-actions"><button data-cancel onClick={() => setNewDialog(false)}>取消</button><button className="primary-button" onClick={createNew} disabled={!newName.trim()}>创建地图</button></div></Modal>}
    {proposal && <Modal title="未保存编辑冲突" onCancel={() => { resolveImport(sessionRef.current, proposal.value, 'cancel'); setProposal(null); }}><p>当前存在尚未确认的编辑或未应用输入。候选 JSON 已校验；继续前会保存原工程的已提交地图，未应用输入将丢弃。</p><div className="conflict-summary"><strong>当前：{session.map.metadata.name}</strong><span>候选：{proposal.value.loaded.map.metadata.name}</span></div><p className="field-note">“先导出当前版本”会下载独立文件并保留此对话。下载不是工程保存。原工程保留在最近项目；文件写回单独授权。</p><div className="dialog-actions"><button data-cancel onClick={() => setProposal(null)}>取消</button><button onClick={exportCurrent}>先导出当前版本</button><button className="danger-button" onClick={() => finishImport(proposal.value, proposal.isNew)}>放弃编辑并重载</button></div></Modal>}
    {copyDialog && <Modal title="复制选中对象" onCancel={() => setCopyDialog(false)}><p>将复制 <strong>{closure.nodes.length} 个节点</strong>、<strong>{closure.roads.length} 条道路</strong>、{closure.facilities.length} 个设施、{closure.zones.length} 个区域、{closure.accessPoints.length} 个入口和 {closure.servicePoints.length} 个服务点。道路端点/设施和区域成员自动纳入并重映射新 ID；外部道路不复制。</p><div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">{axis} 偏移 (m)<input aria-label={axis + ' 偏移 (m)'} type="number" step="any" value={copyDelta[index] ?? ''} onChange={event => setCopyDelta(values => values.map((v, i) => i === index ? event.target.value : v))} /></label>)}</div><p className="field-note">复制为一个事务；不会连接回原节点。对象扩展含未知引用语义时拒绝复制。</p><label className="check-field"><input type="checkbox" checked={copyRetainFacility} onChange={event => setCopyRetainFacility(event.target.checked)} />允许单独复制的入口/服务点关联原设施或区域</label>{operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map(issue => <p key={issue.code}>{issue.code}：{issue.message}</p>)}</div>}<div className="dialog-actions"><button data-cancel onClick={() => setCopyDialog(false)}>取消</button><button className="primary-button" onClick={duplicate}>确认复制</button></div></Modal>}
    {pointDraft && <PointCreationPanel draft={pointDraft} map={session.map} readonly={readonly} issues={operationIssues} onChange={setPointDraft} onCreate={createPoint} onCancel={() => setPointDraft(null)} />}
    {leaveIntent && <Modal title="未应用输入保护" onCancel={() => setLeaveIntent(null)}><p>即将{leaveIntent.label}。当前属性或绘制输入尚未应用到地图，也未包含在自动保存或 JSON 导出中。</p><p>取消会保留当前对象、工具和输入；明确丢弃后才继续。</p><div className="dialog-actions"><button data-cancel onClick={() => setLeaveIntent(null)}>取消，保留输入</button><button className="danger-button" onClick={discardAndContinue}>丢弃未应用输入并继续</button></div></Modal>}
    {upgradeDialog && <Modal title="显式升级地图契约" onCancel={() => { if (!schemaUpgrading) setUpgradeDialog(false); }}><p>Schema 0.1.0 → 0.2.0；revision {session.map.revision} → {session.map.revision + 1}。其他声明数据、ID、来源和扩展保持原值，不自动补充到达语义。</p><p>先在浏览器中保留原版备份，再提交一个可撤销升级事务。解除原文件关联，升级版本请另存为新文件。浏览器备份可能被清理，请同时保留原 JSON 文件。</p>{operationIssues.map((issue, i) => <p key={i} className="inline-error">{issue.code}：{issue.message}</p>)}<div className="dialog-actions"><button data-cancel disabled={schemaUpgrading} onClick={() => setUpgradeDialog(false)}>取消</button><button onClick={exportCurrent} disabled={schemaUpgrading}>导出升级前原图</button><button className="primary-button" disabled={schemaUpgrading} onClick={() => void upgradeSchema()}>{schemaUpgrading ? '备份中…' : '保留原图并升级'}</button></div></Modal>}
    {deleteDialog && <Modal title="删除空间对象" onCancel={() => setDeleteDialog(false)}>
      <p>选中 {selectedCount} 个对象。删除有依赖对象时会拒绝整个事务，当前地图保持不变。</p>
      <label className="check-field"><input type="checkbox" checked={deleteMembers} onChange={event => setDeleteMembers(event.target.checked)} />一并删除设施或区域成员入口和服务点</label>
      <label className="check-field"><input type="checkbox" checked={deleteUnusedNodes} onChange={event => setDeleteUnusedNodes(event.target.checked)} />清理成员点不再使用的节点</label>
      <p className="field-note">共享道路仍使用的节点会保留。若显式选中的节点仍被未选对象引用，操作将被拒绝。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code} · {issue.jsonPath}：{issue.message}</p>)}</div>}
      <div className="dialog-actions"><button data-cancel onClick={() => setDeleteDialog(false)}>取消</button><button className="danger-button" onClick={confirmDelete}>确认删除</button></div>
    </Modal>}
    {rotateDialog && <Modal title="旋转选中对象" onCancel={() => setRotateDialog(false)}>
      <p>绕穿过指定中心的 Z 轴旋转；正角度在世界 XY 平面为逆时针，单位 rad。</p>
      <label className="field-label">旋转角度 (rad)<input aria-label="旋转角度 (rad)" type="number" step="any" value={rotateRadians} onChange={event => setRotateRadians(event.target.value)} /></label>
      <div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">中心 {axis} (m)<input aria-label={'中心 ' + axis + ' (m)'} type="number" step="any" value={rotatePivot[index] ?? ''} onChange={event => setRotatePivot(values => values.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>
      <p className="field-note">当前区域策略：{zoneMovePolicy === 'boundaryOnly' ? '仅边界' : '边界和服务节点'}；设施策略：{facilityMovePolicy === 'boundaryOnly' ? '仅边界，成员点留在原地' : '边界和关联节点一起旋转'}。将影响 {impact.affectedRoadIds.length} 条道路：{impact.affectedRoadIds.join('、') || '无'}。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code}：{issue.message}</p>)}</div>}
      <div className="dialog-actions"><button data-cancel onClick={() => setRotateDialog(false)}>取消</button><button className="primary-button" onClick={rotate}>确认旋转</button></div>
    </Modal>}
    {splitDialog && <Modal title="拆分道路" onCancel={() => setSplitDialog(false)}>
      <p>明确在水平弧长位置插入节点，把原道路替换为两条新道路并记录 ID 映射。相交或节点吸附不会自动执行此操作。</p>
      <label className="field-label">距起点距离 (m)<input aria-label="距起点距离 (m)" type="number" step="any" value={splitDistance} onChange={event => setSplitDistance(event.target.value)} /></label>
      <label className="field-label">复用节点（可选）<select aria-label="复用节点（可选）" value={splitExistingNode} onChange={event => setSplitExistingNode(event.target.value)}><option value="">新建专用节点</option>{Object.entries(session.map.nodes).map(([id, value]) => <option key={id} value={id}>{value.name} · {id}</option>)}</select></label>
      <p className="field-note">复用节点须位于切分点 1e-6 m 内；方向、物理属性和来源保留。尚不支持安全重写的资源或扩展引用会阻止拆分。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code}：{issue.message}</p>)}</div>}
      <div className="dialog-actions"><button data-cancel onClick={() => setSplitDialog(false)}>取消</button><button className="primary-button" onClick={splitRoad}>确认拆分</button></div>
    </Modal>}
    {saveDialog && <Modal title="有未应用输入" onCancel={() => setSaveDialog(false)}><p>表单或绘制中的改动尚未成为地图事务。保存只包含已提交地图，未应用输入仍留在当前表单中。</p><div className="dialog-actions"><button data-cancel onClick={() => setSaveDialog(false)}>返回应用属性</button><button onClick={() => saveProject(true)}>仅保存已提交地图</button></div></Modal>}
    {!projects.ready && <Modal title="恢复浏览器工程" onCancel={() => {}}><p>{projects.error || '正在读取 IndexedDB；恢复完成前不会写入空地图。'}</p>{projects.error && <div className="dialog-actions"><button onClick={projects.retry}>重试恢复</button><button onClick={projects.continueTemporary}>仅内存继续编辑</button></div>}</Modal>}
  </main>;
}