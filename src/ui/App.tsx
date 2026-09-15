import { ResultsPanel, type ResultsOverlay } from './ResultsPanel';
import { CompletionPanel } from './CompletionPanel';
import { buildCodexPackage, downloadPackage } from '../adapters/codexPackage';
import { appendDraftLine, appendDraftCurve, draftRoadGeometry, type DraftRoad } from '../editor/roadDrawing';
import { getQuickTraceCrossings } from '../domain/drawingDefaults';
import { RoadBatchPanel } from './RoadBatchPanel';
import { BackgroundPanel } from './BackgroundPanel';
import { useBackgroundAssets } from './useBackgroundAssets';
import { backgroundFrame, translateBackground } from '../geometry/backgrounds';
import { inspectBackground, isBackgroundCommand } from '../domain/backgrounds';
import { DEFAULT_PROPERTY_UNITS, type PropertyUnits, type BackgroundPreferences } from '../editor/projectController';
import type { BackgroundVisual } from '../renderers/2d/BackgroundCanvas';
import { enumerateConnectionTurns, enumerateMergeTurns, type TopologyCommand } from '../domain/topologyEditing';
import { privateNodeOwner, roadOwner, continuousRoadIds } from '../domain/ownerEditing';
import { sameValue } from '../domain/value';
import { DiagnosticsPanel } from './DiagnosticsPanel';
import type { DiagnosticReport } from '../validation/diagnostics';
import type { PathPreviewReport } from '../topology/pathPreview';
import type { SceneItem, SceneKind } from '../adapters/contracts';
import { itemPositions, itemValue } from '../compiler/catalog';
import { ObjectDirectory, ObjectInspector } from './ObjectDirectory';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrameCamera } from './useFrameCamera';
import { useCurrentCallback } from './useCurrentCallback';
import { useEditorInteraction, sameDraftContext } from './useEditorInteraction';
import { usePropertyDraft, type DraftContext, type PropertyDraft } from '../editor/drafts';
import { Workbench } from './workbench/Workbench';
import { DEFAULT_WORKBENCH_PREFERENCES, type WorkbenchPreferences } from '../editor/workbench';
import { newMap, newNode, newFacility, newZone } from '../domain/factory';
import { contentHash, serializeMap } from '../domain/serialization';
import { mapCapabilities } from '../domain/capabilities';
import { SELECTION_KINDS as selectionKinds, closureSelection, normalizeSelection, selectionImpact, commandSupport, canEditBoundary, prepareBoundaryRepair, type CommandAffectedRef, type FullSelection, type MapCommand, type Selection } from '../domain/commands';
import type { Facility, Zone, Polygon, Issue, Vec3, YardMap } from '../domain/model';
import { createSession, editSession, acknowledgeMap, prepareImport, redoSession, resolveImport, undoSession, type EditorSession, type ImportProposal } from '../editor/session';
import { toSceneSnapshot } from '../compiler/scene';
import { validateMap } from '../validation/validate';
import { downloadMap, readJsonFile } from '../adapters/files';
import { MapCanvas, type Tool, type TopologyTarget, type TraceConnection } from '../renderers/2d/MapCanvas';
import { fitCamera } from '../geometry/coordinates';
import { PropertyPanel, type RoadShapePreview } from './PropertyPanel';
import { Modal } from './Modal';
import { PointCreationPanel, makePointCreationDraft, applyPointPick, buildPointCreationCommand } from './PointCreationPanel';
import './workspace.css';
import { useProjectWorkspace } from './useProjectWorkspace';
import { LocalFileController, type LocalOpenCandidate } from '../adapters/localFiles';
import { IndexedDBProjectStore } from '../adapters/projectStore';
import { DEFAULT_DRAWING_CONFIG, type DrawingConfig } from '../editor/projectController';

type SelectionKind = keyof FullSelection;
const emptySelection = (): FullSelection => normalizeSelection({ nodes: [], roads: [] });
const uid = (prefix: string) => prefix + '_' + crypto.randomUUID();
function localIssue(code: string, message: string): Issue { return { code, severity: 'error', jsonPath: '', message, suggestedAction: '检查输入，当前有效地图未被替换。' }; }

export function App() {
  const [session, setSession] = useState(() => createSession(newMap(uid('map'), '未命名布局'), true));
  const sessionRef = useRef<EditorSession>(session);
  const [diagnostics, setDiagnostics] = useState<DiagnosticReport | null>(null);
  const [pathPreview, setPathPreview] = useState<PathPreviewReport | null>(null);
  const [issueMarker, setIssueMarker] = useState<{ hash: string; position: Vec3 } | null>(null);
  const interaction = useEditorInteraction(() => currentDraftContext());
  const tool = interaction.state.tool; const setTool = interaction.setTool;
  const [inspectionKeys, setInspectionKeys] = useState<string[]>([]);
  const [workspaceMode, setWorkspaceMode] = useState<'trace' | 'check' | 'results'>('trace');
  const [runtimePreview,setRuntimePreview]=useState<ResultsOverlay|null>(null);
  const [accessPreview, setAccessPreview] = useState<{hash:string;lines:Vec3[][]}|null>(null);
  const [selection, setSelection] = useState<Selection>(emptySelection);
  const frameCamera = useFrameCamera({ offsetX: 80, offsetY: 460, scale: 4 });
  const { camera, replace: setCamera } = frameCamera;
  const [canvasSize, setCanvasSize] = useState({ width: 800, height: 540 });
  const [locatedKey, setLocatedKey] = useState<string | null>(null);
  const [draftRoad, setDraftRoad] = interaction.activityField('road');
  const [roadShapePreview, setRoadShapePreview] = useState<RoadShapePreview | null>(null);
  const onRoadPreviewChange = useCallback((preview: RoadShapePreview | null) => setRoadShapePreview(preview), []);
  const [operationIssues, setOperationIssues] = useState<Issue[]>([]);
  const operationError = operationIssues.find(issue => issue.severity === 'error');
  const [status, setStatus] = useState('从节点开始绘制，或导入本地 map.json。');
  const [proposal, setProposal] = interaction.dialogField('import');
  const [newDialog, setNewDialog] = interaction.booleanDialog('new');
  const [newName, setNewName] = useState('新建布局');
  const [copyDialog, setCopyDialog] = interaction.booleanDialog('copy');
  const [copyDelta, setCopyDelta] = useState(['10', '10', '0']);
  const [copyRetainFacility, setCopyRetainFacility] = useState(false);
  const [drawingConfig, setDrawingConfig] = useState<DrawingConfig>(() => ({ ...DEFAULT_DRAWING_CONFIG }));
  const drawingRef = useRef(drawingConfig); drawingRef.current = drawingConfig;
  const { facilityKind, zoneKind, snapGrid, snapNodes, showRoadBands, showRoadCenterlines, showOrdinaryNodes, hiddenTypes, lockedTypes, labelMode } = drawingConfig;
  const facilityMovePolicy = 'withStaticContents' as const, zoneMovePolicy = 'withStaticContents' as const;
  const [roadBatch, setRoadBatch] = interaction.dialogField('roadBatch');
  const [roadPreset, setRoadPreset] = interaction.dialogField('roadPreset');
  const [internalOwner, setInternalOwner] = useState<{ kind: 'facilities' | 'zones'; id: string } | null>(null);
  const [pointIdentities, setPointIdentities] = useState<{ kind: 'accessPoints' | 'servicePoints'; id: string }[]>([]);
  const [boundaryRepair, setBoundaryRepair] = interaction.dialogField('boundaryRepair');
  const [relocatingPoint, setRelocatingPoint] = interaction.activityField('relocate');
  const [workbench, setWorkbench] = useState<WorkbenchPreferences>({ ...DEFAULT_WORKBENCH_PREFERENCES });
  const workbenchRef = useRef(workbench); workbenchRef.current = workbench;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [propertyUnits, setPropertyUnits] = useState<PropertyUnits | undefined>();
  const propertyUnitsRef = useRef(propertyUnits); propertyUnitsRef.current = propertyUnits;
  function updatePropertyUnits(units: PropertyUnits) { propertyUnitsRef.current = units; setPropertyUnits(units); }
  const [backgroundPreferences, setBackgroundPreferences] = useState<BackgroundPreferences | undefined>();
  const backgroundRef = useRef(backgroundPreferences); backgroundRef.current = backgroundPreferences;
  const [backgroundAdjustId, setBackgroundAdjustId] = useState<string | null>(null);
  const [backgroundDirty, setBackgroundDirty] = useState(false);
  const [backgroundKeepAspect, setBackgroundKeepAspect] = useState(true);
  const backgroundActive = useRef(false);
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false);
  const resolvedBackgroundPreferences = useMemo(() => backgroundPreferences ?? { comparisonMode: false, layers: {} }, [backgroundPreferences]);
  const onBackgroundDirty = useCallback((dirty: boolean) => setBackgroundDirty(dirty), []);
  const onBackgroundActive = useCallback((active: boolean) => { backgroundActive.current = active; }, []);
  const editorState = useMemo(() => ({ camera, drawing: drawingConfig, workbench, ...(propertyUnits ? { propertyUnits } : {}), ...(backgroundPreferences ? { backgrounds: backgroundPreferences } : {}) }), [camera, drawingConfig, workbench, backgroundPreferences, propertyUnits]);
  const getEditorState = useCallback(() => ({ camera: frameCamera.read(), drawing: drawingRef.current, workbench: workbenchRef.current, ...(propertyUnitsRef.current ? { propertyUnits: propertyUnitsRef.current } : {}), ...(backgroundRef.current ? { backgrounds: backgroundRef.current } : {}) }), [frameCamera.read]);
  function updateWorkbench(patch: Partial<WorkbenchPreferences>) {
    if (!projects.ready || projects.isNavigating()) return;
    const next = { ...workbenchRef.current, ...patch }; workbenchRef.current = next; setWorkbench(next);
  }
  const [pointDraft, setPointDraft] = interaction.activityField('point');
  const [leaveIntent, setLeaveIntent] = interaction.dialogField('leave');
  const [formEpoch, setFormEpoch] = useState(0);
  const [draftResetToken, setDraftResetToken] = useState(0);
  const [upgradeDialog, setUpgradeDialog] = interaction.booleanDialog('upgrade');
  const [upgradeTarget, setUpgradeTarget] = useState<'0.2.0' | '0.3.0'>('0.2.0');
  const [pendingTraceTool, setPendingTraceTool] = useState<Tool | null>(null);
  const [schemaUpgrading, setSchemaUpgrading] = useState(false);
  const upgrading = useRef(false);
  const [deleteDialog, setDeleteDialog] = interaction.booleanDialog('delete');
  const [deleteMembers, setDeleteMembers] = useState(false);
  const [deleteUnusedNodes, setDeleteUnusedNodes] = useState(false);
  const [rotateDialog, setRotateDialog] = interaction.booleanDialog('rotate');
  const [rotateRadians, setRotateRadians] = useState('0');
  const [rotatePivot, setRotatePivot] = useState(['0', '0', '0']);
  const [splitDialog, setSplitDialog] = interaction.booleanDialog('split');
  const [splitDistance, setSplitDistance] = useState('');
  const [splitExistingNode, setSplitExistingNode] = useState('');
  const [splitWidthMode,setSplitWidthMode]=useState(false),[splitWidth,setSplitWidth]=useState('16'),[splitWidthDirection,setSplitWidthDirection]=useState<'forward'|'backward'>('forward');
  const [splitPicking, setSplitPicking] = interaction.booleanActivity('splitPick');
  const [topologySnap, setTopologySnap] = useState(false);
  const [deleteTopology, setDeleteTopology] = useState(false);
  const [operationToken, setOperationToken] = useState(0);
  const operationMap = useRef<YardMap>(session.map);
  const [topologyDraft, setTopologyDraft] = interaction.dialogField('topology');
  useEffect(() => {
    if (!splitPicking) return;
    const cancelPick = () => { setSplitPicking(false); setSplitDialog(false); };
    window.addEventListener('blur', cancelPick);
    return () => window.removeEventListener('blur', cancelPick);
  }, [splitPicking]);
  useEffect(() => {
    function cancelCanvasIntent() {
      const activity = interaction.read().activity;
      if (activity.kind === 'relocate') setRelocatingPoint(null);
      if (activity.kind === 'point' && activity.value.canvasMode) setPointDraft(null);
      if (interaction.read().dialog?.kind === 'boundaryRepair') setBoundaryRepair(null);
    }
    window.addEventListener('blur', cancelCanvasIntent);
    return () => window.removeEventListener('blur', cancelCanvasIntent);
  }, []);
  const [mapName, setMapName] = useState(session.map.metadata.name);
  const [fileLoading, setFileLoading] = useState(false);
  const importSequence = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const initializedCanvas = useRef(false);
  const [propertyDirty, setPropertyDirty] = useState(false);
  const [polygonDraftDirty, updatePolygonDraftDirty] = interaction.booleanActivity('polygon');
  const setPolygonDraftDirty = useCurrentCallback(updatePolygonDraftDirty);
  const [boundaryEditMode, setBoundaryEditMode] = useState<'auto' | 'polygon'>('auto');
  const [boundaryEditing, setBoundaryEditing] = interaction.booleanActivity('boundary');
  const boundaryInteraction = useRef(false);
  const onBoundaryInteractionChange = useCallback((active: boolean) => {
    boundaryInteraction.current = active; setBoundaryEditing(active);
  }, []);
  const onPropertyDirty = useCallback((value: boolean) => setPropertyDirty(value), []);
  const [saveIntent, setSaveIntent] = interaction.dialogField('save');
  const activePropertyDraft = useRef<PropertyDraft | null>(null);
  const registerPropertyDraft = useCallback((draft: PropertyDraft | null) => { activePropertyDraft.current = draft; }, []);
  const [saveRunning, setSaveRunning] = useState(false);
  const saving = useRef(false);
  const [recentDialog, setRecentDialog] = interaction.booleanDialog('recent');
  const [storageConflictDialog, setStorageConflictDialog] = interaction.booleanDialog('storageConflict');
  const [frameConfirmation, setFrameConfirmation] = interaction.dialogField('frame');
  function confirmCoordinateFrame(): Promise<boolean> {
    return new Promise(resolve => setFrameConfirmation({ resolve }));
  }
  function finishFrameConfirmation(accepted: boolean) {
    frameConfirmation?.resolve(accepted); setFrameConfirmation(null);
  }
  const [local] = useState(() => new LocalFileController());
  const [fileStore] = useState(() => new IndexedDBProjectStore());
  const bindingGeneration = useRef(0), bindingRestoring = useRef(false);
  const [bindingLoading, setBindingLoading] = useState(false);
  const [attachCandidate, setAttachCandidate] = interaction.dialogField('attachFile');
  useEffect(() => () => { ++bindingGeneration.current; }, []);
  const [localState, setLocalState] = useState(local.snapshot());
  const [localMessage, setLocalMessage] = useState('');
  const [fileConflict, setFileConflict] = interaction.dialogField('fileConflict');
  const [overwriteReady, setOverwriteReady] = useState<{ token: number; mapHash: string } | null>(null);
  const preserveNative = useRef(false);
  const nativeTransition = useRef(false);
  const [exportMessage, setExportMessage] = useState('尚未导出 JSON');
  const projects = useProjectWorkspace({
    map: session.map, changeToken: session.changeToken, getMap: () => sessionRef.current.map, editorState, getEditorState, confirmCoordinateFrame,
    onAcknowledged: hash => updateSession(acknowledgeMap(sessionRef.current, hash)),
    onRestore: recovery => {
      importSequence.current++; setFileLoading(false);
      if (!preserveNative.current && !local.reset()) throw new Error('本地文件仍在处理中，工程界面未切换；请等待并重试。');
      const token = ++bindingGeneration.current;
      if (!preserveNative.current) {
        bindingRestoring.current = true; setBindingLoading(true);
        void fileStore.readLocalFileBinding(recovery.projectId).then(binding => {
          if (token !== bindingGeneration.current) return;
          if (binding) {
            const restored = local.restoreBinding(binding);
            setLocalMessage(restored.status === 'linked' ? '已恢复原文件关联；保存将写回 ' + restored.name + '。' : restored.message);
            refreshLocal();
          }
        }).catch(error => {
          if (token === bindingGeneration.current) setLocalMessage('原文件关联恢复失败；地图保留，请重新关联：' + String(error));
        }).finally(() => {
          if (token === bindingGeneration.current) { bindingRestoring.current = false; setBindingLoading(false); }
        });
      } else { bindingRestoring.current = false; setBindingLoading(false); }
      updateSession({ ...createSession(recovery.map, true), changeToken: sessionRef.current.changeToken + 1 });
      setMapName(recovery.map.metadata.name); setLocatedKey(null); setInspectionKeys([]); setSelection(emptySelection());
      setBoundaryEditMode('auto'); onBoundaryInteractionChange(false);
      setPropertyDirty(false); setOverwriteReady(null); setDraftResetToken(value => value + 1); setTopologySnap(false); setOperationIssues([]); initializedCanvas.current = true;
      setCamera(recovery.editorState?.camera ?? { offsetX: 80, offsetY: 460, scale: 4 });
      setDrawingConfig({ ...(recovery.editorState?.drawing ?? DEFAULT_DRAWING_CONFIG) });
      const restoredWorkbench = { ...DEFAULT_WORKBENCH_PREFERENCES, ...recovery.editorState?.workbench };
      workbenchRef.current = restoredWorkbench; setWorkbench(restoredWorkbench);
      interaction.reset(); setInternalOwner(null); setPointIdentities([]); activePropertyDraft.current = null; setDrawerOpen(false);
      propertyUnitsRef.current = recovery.editorState?.propertyUnits; setPropertyUnits(recovery.editorState?.propertyUnits);
      backgroundRef.current = recovery.editorState?.backgrounds; setBackgroundPreferences(recovery.editorState?.backgrounds); setBackgroundAdjustId(null); setBackgroundDirty(false); backgroundActive.current = false;
      if (!preserveNative.current) { setLocalState(local.snapshot()); setLocalMessage(''); }
      setExportMessage('尚未导出 JSON');
      setStatus(recovery.source === 'new' ? '新工程已打开；浏览器草稿将自动保存。' : '已恢复浏览器工程，地图经共同校验与派生路径重建。');
    },
  });
  function currentDraftContext(): DraftContext { return { projectId: projects.activeProjectId() ?? null, changeToken: sessionRef.current.changeToken, mapContentHash: contentHash(sessionRef.current.map) }; }
  const draftContext = useMemo(() => currentDraftContext(), [projects.state.active?.projectId, session.changeToken, session.map]);
  const unapplied = relocatingPoint !== null || backgroundDirty || propertyDirty || mapName !== session.map.metadata.name || draftRoad !== null || polygonDraftDirty || pointDraft !== null || copyDialog || rotateDialog || splitDialog || splitPicking || topologyDraft !== null;
  const scene = useMemo(() => toSceneSnapshot(session.map), [session.map]);
  const saveGuard = useRef({ browserDirty: true, unapplied: false });
  saveGuard.current = { browserDirty: projects.editorDirty || projects.state.active?.draftHash !== scene.mapContentHash, unapplied: unapplied || boundaryEditing };
  useEffect(() => setMapName(session.map.metadata.name), [session.map.metadata.name]);
  const visibleBackgroundLayers = useMemo(() => Object.fromEntries(Object.entries(session.map.backgroundLayers).filter(([id]) => !drawingConfig.hiddenTypes.includes('backgroundLayers') && resolvedBackgroundPreferences.layers[id]?.visible !== false)), [session.map.backgroundLayers, resolvedBackgroundPreferences, drawingConfig.hiddenTypes]);
  const backgroundAssets = useBackgroundAssets({ projectId: projects.activeProjectId() ?? null, assets: session.map.assets, layers: visibleBackgroundLayers });
  const backgroundVisuals = useMemo<BackgroundVisual[]>(() => backgroundAssets.items.flatMap(item => {
    const layer = session.map.backgroundLayers[item.id], asset = layer && session.map.assets[layer.assetId];
    if (!item.image || !layer || !asset?.widthPx || !asset.heightPx || !inspectBackground(session.map, item.id).supported) return [];
    return [{ id: item.id, image: item.image, transform: layer.imageToWorld, width: asset.widthPx, height: asset.heightPx, opacity: resolvedBackgroundPreferences.layers[item.id]?.opacity ?? 1 }];
  }), [backgroundAssets.items, session.map, resolvedBackgroundPreferences]);
  const capabilities = useMemo(() => mapCapabilities(session.map), [session.map]);
  const report = useMemo(() => validateMap(session.map), [session.map]);
  const domainReadonly = !capabilities.editable;
  const backgroundDisabled = domainReadonly || bindingLoading || !projects.ready || projects.transitioning || localState.busy || schemaUpgrading || saveRunning;
  usePropertyDraft(mapName !== session.map.metadata.name ? draftContext : undefined, mapName !== session.map.metadata.name, applyMapName, registerPropertyDraft);
  const readonly = backgroundDisabled || !!backgroundAdjustId || backgroundDirty;
  const dirty = session.acknowledgedHash !== scene.mapContentHash;
  const validSelection = useMemo(() => {
    const current = normalizeSelection(selection);
    return Object.fromEntries(selectionKinds.map(kind => [kind, current[kind].filter(id => Object.hasOwn(session.map[kind], id))])) as FullSelection;
  }, [selection, session.map]);
  const selectedCount = selectionKinds.reduce((total, kind) => total + validSelection[kind].length, 0) + inspectionKeys.length;
  const inspected = useMemo(() => scene.items.find(item => inspectionKeys.includes(item.key)), [scene.items, inspectionKeys]);
  const closure = useMemo(() => closureSelection(session.map, validSelection), [session.map, validSelection]);
  const moveSupport = useMemo(() => commandSupport(session.map, { type: 'translateSelection', selection: validSelection, delta: [0, 0, 0], facilityMovePolicy, zoneMovePolicy }), [session.map, validSelection, facilityMovePolicy, zoneMovePolicy]);
  const impact = useMemo(() => moveSupport.impact ?? selectionImpact(session.map, topologySnap && selectedCount === 1 && validSelection.nodes.length === 1 ? validSelection : emptySelection()), [moveSupport, session.map, topologySnap, selectedCount, validSelection]);
  const boundaryPermissions = useMemo(() => {
    const allowed = new Set<string>();
    for (const kind of ['facilities', 'zones'] as const) for (const id of validSelection[kind]) {
      if (canEditBoundary(session.map, kind, id) && !lockedTypes.includes(kind)) allowed.add(kind + '/' + id);
    }
    return allowed;
  }, [session.map, validSelection, lockedTypes]);
  const currentDiagnostics = diagnostics?.mapContentHash === scene.mapContentHash ? diagnostics : null;
  const currentPath = pathPreview?.mapContentHash === scene.mapContentHash ? pathPreview : null;
  const shownPath = currentPath?.confirmed ?? currentPath?.candidate;
  const issues = useMemo(() => [...operationIssues, ...report.issues, ...(currentDiagnostics?.issues ?? []), ...(currentPath?.issues ?? [])], [operationIssues, report, currentDiagnostics, currentPath]);
  const hasLinkedContents = useMemo(() => !!Object.keys(session.map.junctions).length || !!Object.keys(session.map.resources).length || Object.values(session.map.extensionNamespaces).some(value => value.category === 'behavior'), [session.map]);

  const onCanvasSize = useCallback((size: { width: number; height: number }) => {
    setCanvasSize(size);
    if (!initializedCanvas.current) { initializedCanvas.current = true; setCamera({ offsetX: 80, offsetY: size.height - 80, scale: 4 }); }
  }, []);
  function updateDrawingConfig(patch: Partial<DrawingConfig>) {
    if (!projects.ready || projects.isNavigating()) return;
    const displayOnly = Object.keys(patch).every(key => ['objectSearch', 'labelMode', 'roadFillOpacity', 'facilityFillOpacity', 'zoneFillOpacity'].includes(key));
    const change = () => {
      if (!displayOnly) { cancelBoundaryInteraction(); setDraftResetToken(value => value + 1); setRoadShapePreview(null); }
      const next = { ...drawingRef.current, ...patch }; drawingRef.current = next; setDrawingConfig(next);
    };
    if (displayOnly) change(); else requestLeave('修改绘图配置', change);
  }
  function updateSession(next: EditorSession) {
    if (next.changeToken !== sessionRef.current.changeToken) { setRoadShapePreview(null); setLocatedKey(null); }
    sessionRef.current = next; setSession(next);
  }
  function operationsBlocked() { return bindingRestoring.current || !projects.ready || projects.isNavigating() || local.snapshot().busy || nativeTransition.current || upgrading.current || saving.current; }
  function rejectLocked(refs: readonly CommandAffectedRef[]): boolean {
    const locked = refs.filter(ref => drawingRef.current.lockedTypes.includes(ref.kind as SceneKind));
    if (!locked.length) return false;
    setOperationIssues([localIssue('LOCKED_DEPENDENCY', '操作影响已锁定对象：' + locked.map(ref => ref.kind + '/' + ref.id).join('、'))]);
    setStatus('操作被拒绝，地图及历史记录保持不变。'); return true;
  }
  function apply(command: MapCommand): boolean {
    if (operationsBlocked()) { setStatus('工程或文件操作进行中，暂不接受地图修改。'); return false; }
    if (!isBackgroundCommand(command) && (backgroundAdjustId || backgroundDirty)) { setStatus('请先完成底图调整或处理底图候选，再编辑矢量。'); return false; }
    if (!isBackgroundCommand(command) && inspectionKeys.length) { setOperationIssues([localIssue('INSPECTION_SELECTION_READ_ONLY', '所选厂界、资源或扩展对象仅可检查；请先取消检查选择，不能混入编辑事务。')]); return false; }
    if (internalOwner && !internalCommandAllowed(command)) { setOperationIssues([localIssue('INTERNAL_SCOPE_PUBLIC_REFERENCE', '编辑内部时公共路网与外部对象固定。请退出内部编辑后再修改这些对象。')]); return false; }
    const state = interaction.read();
    if ((state.dialog && !sameDraftContext(state.dialog.context, currentDraftContext())) || ('context' in state.activity && !sameDraftContext(state.activity.context, currentDraftContext()))) {
      setOperationIssues([localIssue('STALE_EDIT_CONTEXT', '工程或地图已变化，请取消旧草稿后重新编辑。')]); return false;
    }
    const support = commandSupport(sessionRef.current.map, command);
    if (rejectLocked(support.affectedRefs)) return false;
    const result = editSession(sessionRef.current, command);
    setOperationIssues(result.issues);
    if (!result.ok) {
      setStatus('操作被拒绝，地图及历史记录保持不变。');
      if (command.type === 'updateFacility' && command.patch.boundary && !command.entranceAdjustments && result.issues.some(issue => issue.code.startsWith('OWNER_') || issue.code.includes('SLOT'))) {
        const repair = prepareBoundaryRepair(sessionRef.current.map, command.id, command.patch.boundary);
        setBoundaryRepair({ kind: 'facilities', id: command.id, boundary: command.patch.boundary, ...repair, command: { ...command, entranceAdjustments: repair.command.entranceAdjustments } });
      }
      return false;
    }
    const changed = result.session !== sessionRef.current;
    if (changed && rejectLocked(result.session.past.at(-1)?.affectedRefs ?? [])) return false;
    updateSession(result.session); setStatus(changed ? '编辑已提交为一个可撤销事务。' : '内容未变化，未创建事务。'); return true;
  }
  function cancelBoundaryInteraction() {
    if (backgroundActive.current) { backgroundActive.current = false; setDraftResetToken(value => value + 1); }
    if (!boundaryInteraction.current) return;
    onBoundaryInteractionChange(false); setDraftResetToken(value => value + 1);
  }
  function commitBoundary(kind: 'facilities' | 'zones', id: string, boundary: Polygon, baseMapHash: string, baseChangeToken: number): boolean {
    const current = sessionRef.current;
    if (readonly || drawingRef.current.lockedTypes.includes(kind) || !boundaryPermissions.has(kind + '/' + id) || operationsBlocked() || tool !== 'select' || propertyDirty || mapName !== current.map.metadata.name
      || selectedCount !== 1 || validSelection[kind][0] !== id || baseChangeToken !== current.changeToken || baseMapHash !== contentHash(current.map)) {
      setStatus('边界预览的编辑上下文已变化，未提交旧几何。'); return false;
    }
    const command: MapCommand = kind === 'facilities' ? { type: 'updateFacility', id, patch: { boundary } } : { type: 'updateZone', id, patch: { boundary } };
    if (apply(command)) return true;
    if (kind === 'facilities' && interaction.read().dialog?.kind === 'boundaryRepair') return false;
    const repair = kind === 'facilities' ? prepareBoundaryRepair(current.map, id, boundary) : null;
    setBoundaryRepair({ kind, id, boundary, command: repair?.command ?? command, issues: repair?.issues ?? [], allowed: repair?.allowed ?? false });
    return false;
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
    setLeaveIntent(null); setBackgroundDirty(false); setPropertyDirty(false); setMapName(sessionRef.current.map.metadata.name);
    setFormEpoch(value => value + 1); setDraftResetToken(value => value + 1); setRoadShapePreview(null);
    setDraftRoad(null); setPolygonDraftDirty(false); setPointDraft(null); setRelocatingPoint(null);
    setCopyDialog(false); setDeleteDialog(false); setRotateDialog(false); setSplitDialog(false); setSplitPicking(false); setTopologyDraft(null);
    setStatus('已明确丢弃未应用输入，继续所选操作。'); intent.action();
  }
  function choose(kind: SelectionKind, id: string, additive: boolean, protect = unapplied, revealPanel = true) {
    if (backgroundAdjustId) { setStatus('底图调整期间暂停矢量选择；请完成调整并锁定。'); return false; }
    return requestLeave('切换所选对象', () => {
      setLocatedKey(null);
      if (additive || selectedCount !== 1 || validSelection[kind][0] !== id) setBoundaryEditMode('auto');
      if (!additive) setInspectionKeys([]);
      setSelection(current => {
        const normalized = normalizeSelection(current);
        if (!additive) return { ...emptySelection(), [kind]: [id] };
        return { ...normalized, [kind]: normalized[kind].includes(id) ? normalized[kind].filter(value => value !== id) : [...normalized[kind], id] };
      });
      setTool('select'); if(revealPanel)updateWorkbench({ rightCollapsed: false });
    }, protect);
  }
  function changeTool(value: Tool) { if (!propertyDirty && mapName===session.map.metadata.name && draftRoad && (tool==='road'||tool==='curve') && (value==='road'||value==='curve')) { const next=value==='road'&&draftRoad.curveEnd?{...appendDraftLine(draftRoad,draftRoad.curveEnd.point),endConnection:draftRoad.curveEnd.connection}:draftRoad;setDraftRoad({...next,standaloneCurve:false});setTool(value);return;} if (backgroundAdjustId) { setStatus('请先完成底图调整并锁定。'); return; } requestLeave('切换绘制工具', () => {
    setInspectionKeys([]);
    if (sessionRef.current.map.schemaVersion !== '0.3.0' && (value === 'road' || value === 'curve' || value.startsWith('facility') || value.startsWith('zone'))) { setUpgradeTarget('0.3.0'); setPendingTraceTool(value); setUpgradeDialog(true); return; }
    setTool(value); setDraftRoad(null);
  }); }

  async function upgradeSchema() {
    if (operationsBlocked() || unapplied || sessionRef.current.map.schemaVersion === upgradeTarget) return;
    const before = sessionRef.current;
    const result = editSession(before, { type: 'upgradeSchema', targetVersion: upgradeTarget });
    if (!result.ok) { setOperationIssues(result.issues); return; }
    upgrading.current = true; setSchemaUpgrading(true);
    try {
      const backup = await projects.backup(before.map);
      if (sessionRef.current.changeToken !== before.changeToken) throw new Error('备份期间地图已变化，请重新执行升级。');
      const projectId = projects.activeProjectId();
      if (projectId && !projects.temporary) await fileStore.writeLocalFileBinding(projectId, null);
      if (!local.reset()) throw new Error('本地文件仍在处理中，未应用升级。');
      updateSession({ ...result.session, acknowledgedHash: sessionRef.current.acknowledgedHash });
      refreshLocal(); setFileConflict(null); setOverwriteReady(null); setUpgradeDialog(false);
      setLocalMessage('升级前原图已保留为浏览器备份；文件关联已解除，请将升级版本另存为新文件。');
      if (pendingTraceTool) { setTool(pendingTraceTool); setPendingTraceTool(null); }
      setStatus('Schema ' + before.map.schemaVersion + ' → ' + upgradeTarget + '；revision ' + before.map.revision + ' → ' + result.session.map.revision + '。其余声明数据不变。备份：' + backup.projectId);
    } catch (error) { setOperationIssues([localIssue('SCHEMA_UPGRADE_FAILED', String(error))]); }
    finally { upgrading.current = false; setSchemaUpgrading(false); }
  }
  async function exportCodexPackage() {
    const map = sessionRef.current.map, drawing = structuredClone(drawingRef.current), projectId = projects.activeProjectId();
    if (!projectId) throw new Error('当前工程还未准备好，请等待恢复完成。');
    const result = await buildCodexPackage({ map, drawing, projectId, store: fileStore });
    downloadPackage(result.blob, result.filename);
    setStatus(contentHash(sessionRef.current.map) === result.manifest.baseMapContentHash ? '已导出当前地图、原始底图与坐标对照补标包。' : '导出的是点击时的地图快照；当前地图已有后续修改，补丁须绑定包内版本。');
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
  function saveProject(confirmed = false, target?: 'file' | 'browser', saveAs = false, overwriteToken?: number) {
    if (operationsBlocked()) return;
    const dialog = interaction.read().dialog;
    if (dialog?.kind === 'save' && !sameDraftContext(dialog.context, currentDraftContext())) {
      setOperationIssues([localIssue('STALE_SAVE_REQUEST', '地图或工程已变化，请取消并重新保存。')]); return;
    }
    cancelBoundaryInteraction();
    const chosen = target ?? 'file';
    if (unapplied && !confirmed) { setSaveIntent({ target: chosen, saveAs, overwriteToken }); return; }
    setSaveIntent(null);
    void persistTargets(chosen, saveAs, overwriteToken);
  }
  function applyMapName(): boolean {
    if (readonly || !mapName.trim()) { setStatus('地图名称不能为空；输入已保留。'); return false; }
    return apply({ type: 'renameMap', name: mapName });
  }
  function applyThenSave() {
    if (!saveIntent || operationsBlocked()) return;
    const dialog = interaction.read().dialog;
    if (!dialog || !sameDraftContext(dialog.context, currentDraftContext())) { setStatus('保存请求已过期，请重新保存。'); return; }
    if (draftRoad || polygonDraftDirty || pointDraft || splitPicking || boundaryEditing) { setStatus('请先完成当前绘制；不会自动闭合或补造节点。'); return; }
    const draft = activePropertyDraft.current;
    const request = saveIntent;
    if (backgroundDirty || propertyDirty || mapName !== sessionRef.current.map.metadata.name) {
      if (!draft || !sameDraftContext(draft.context, currentDraftContext())) { setStatus('属性输入已过期，请重新选择对象。'); return; }
      if (!draft.apply()) { setSaveIntent(null); return; }
    }
    setSaveIntent(null);
    void persistTargets(request.target ?? 'file', !!request.saveAs, request.overwriteToken);
  }
  async function persistTargets(target: 'file' | 'browser', saveAs = false, overwriteToken?: number) {
    if (saving.current || operationsBlocked()) return;
    const context = currentDraftContext(); const map = sessionRef.current.map;
    if (overwriteToken !== undefined && (overwriteReady?.token !== overwriteToken || overwriteReady.mapHash !== context.mapContentHash)) {
      setLocalMessage('覆盖确认已过期，请重新保存双方副本。'); return;
    }
    saving.current = true; setSaveRunning(true);
    try {
      // Start the native picker in this user gesture; neither controller is replaced.
      let file: Promise<import('../adapters/localFiles').LocalWriteResult | { status: 'downloaded' }>;
      if (target === 'browser') file = Promise.resolve({ status: 'downloaded' });
      else if (saveAs) {
        if (local.capabilities().saveAs) file = local.saveAs(map);
        else { downloadMap(map); file = Promise.resolve({ status: 'downloaded' }); }
      } else file = local.write(map, overwriteToken);
      refreshLocal();
      const results = await Promise.allSettled([projects.save(), file]);
      const browserResult = results[0]; const fileResult = results[1];
      let bindingMessage = '';
      if (target === 'file' && context.projectId && local.snapshot().linkedName) {
        // Never pair a newer file baseline with a browser map whose checkpoint failed.
        if (browserResult.status === 'fulfilled' && browserResult.value) {
          try { await persistFileBinding(context.projectId); }
          catch (error) { bindingMessage = '文件关联未能持久保存；刷新后需重新关联：' + String(error); }
        } else bindingMessage = '浏览器恢复未保存，保留旧文件关联基线；刷新后需核对原文件。';
      }
      if (!sameDraftContext(context, currentDraftContext())) return;
      refreshLocal();
      const browserMessage = browserResult.status === 'fulfilled' && browserResult.value ? '浏览器恢复已保存' : '浏览器恢复未确认保存';
      if (browserResult.status === 'rejected') setOperationIssues([localIssue('PROJECT_SAVE_FAILED', String(browserResult.reason))]);
      let fileMessage = '';
      if (target === 'file') {
        if (fileResult.status === 'rejected') fileMessage = '本地文件保存失败：' + String(fileResult.reason);
        else {
          const result = fileResult.value;
          if (result.status === 'saved') { fileMessage = '文件写回并关闭成功：' + result.name; setFileConflict(null); setOverwriteReady(null); }
          else if (result.status === 'downloaded') { fileMessage = '已发起 JSON 下载；未确认写回本地文件。'; setExportMessage(fileMessage); }
          else if (result.status === 'conflict') { fileMessage = '本地文件冲突；当前版本已保留，未覆盖外部内容。'; setFileConflict(result); setOverwriteReady(null); }
          else if (result.status === 'unlinked') fileMessage = '未关联原文件，本次未写入本地文件；已有文件请用“文件 → 关联原文件”授权一次，新文件请用“导出 JSON”或“另存为”。';
          else fileMessage = result.message;
        }
        fileMessage = [fileMessage, bindingMessage].filter(Boolean).join('；');
        setLocalMessage(fileMessage);
      }
      setStatus([browserMessage, fileMessage].filter(Boolean).join('；'));
    } catch (error) { setOperationIssues([localIssue('SAVE_FAILED', String(error))]); }
    finally { saving.current = false; setSaveRunning(false); refreshLocal(); }
  }
  function showRecent() {
    cancelBoundaryInteraction();
    const context = currentDraftContext();
    void projects.showRecent().then(() => { if (sameDraftContext(context, currentDraftContext()) && !interaction.read().dialog) setRecentDialog(true); }).catch(error => setOperationIssues([localIssue('PROJECT_LIST_FAILED', String(error))]));
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
    try { await projects.reloadStored(confirmCoordinateFrame); setStorageConflictDialog(false); } catch (error) { setStatus(String(error)); }
  }
  async function copyProject() {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    if (unapplied) { requestLeave('另存浏览器恢复副本', () => { void performRecoveryCopy(); }); return; }
    await performRecoveryCopy();
  }
  async function performRecoveryCopy() {
    try { await projects.recoveryCopy(); setStorageConflictDialog(false); setFileConflict(null); setStatus('已另存浏览器恢复副本；地图 ID 保留，存储项目 ID 独立。'); }
    catch (error) { setOperationIssues([localIssue('PROJECT_COPY_FAILED', String(error))]); }
  }
  function refreshLocal() { setLocalState(local.snapshot()); }
  async function persistFileBinding(projectId = projects.activeProjectId()) {
    if (!projectId || projects.temporary) return;
    await fileStore.writeLocalFileBinding(projectId, local.exportBinding());
  }
  async function chooseOriginalFile() {
    if (operationsBlocked()) return;
    const context = currentDraftContext();
    nativeTransition.current = true;
    const pending = local.open(); refreshLocal();
    let candidate: LocalOpenCandidate | null = null;
    try {
      const result = await pending; refreshLocal();
      if (result.status !== 'opened') { setLocalMessage(result.message); return; }
      candidate = result;
      const current = sessionRef.current.map;
      if (!sameDraftContext(context, currentDraftContext())) throw new Error('已提交地图已变化，请重新选择原文件。');
      if (result.loaded.map.mapId !== current.mapId || !sameValue(result.loaded.map.coordinateFrame, current.coordinateFrame))
        throw new Error('所选文件的地图 ID 或坐标框架不匹配，未关联或覆盖；请选原文件，或明确另存为新文件。');
      await projects.backup(result.loaded.map);
      if (!sameDraftContext(context, currentDraftContext())) throw new Error('工程已变化，原文件候选已取消。');
      setAttachCandidate(result); candidate = null;
    } catch (error) { setLocalMessage(String(error)); }
    finally { if (candidate) local.cancelOpen(candidate.token); nativeTransition.current = false; refreshLocal(); }
  }
  function cancelAttachFile() {
    if (attachCandidate) local.cancelOpen(attachCandidate.token);
    setAttachCandidate(null);
  }
  function confirmAttachFile() {
    const dialog = interaction.read().dialog;
    if (operationsBlocked() || !attachCandidate || dialog?.kind !== 'attachFile') return;
    if (!sameDraftContext(dialog.context, currentDraftContext())) {
      cancelAttachFile(); setLocalMessage('关联确认已过期；当前编辑与原文件均保留。'); return;
    }
    const result = local.acceptOpen(attachCandidate.token); setAttachCandidate(null); refreshLocal();
    if (result.status !== 'linked') { setLocalMessage(result.message); return; }
    // Start write permission in this confirmation gesture; keep the current edited map.
    void persistTargets('file');
  }
  async function checkFile() {
    if (operationsBlocked()) return;
    const pending = local.check(); refreshLocal();
    const result = await pending; refreshLocal();
    if (result.status === 'conflict') {
      if (!interaction.read().dialog) setFileConflict(result);
      else setLocalMessage('检测到外部文件冲突；请结束当前对话后检查外部变化。');
      setOverwriteReady(null);
    }
    else if (result.status !== 'unchanged' && result.status !== 'unlinked' && result.status !== 'busy') setLocalMessage(result.message);
  }
  async function openNative(reload = false) {
    cancelBoundaryInteraction();
    if (operationsBlocked()) return;
    nativeTransition.current = true;
    const before = sessionRef.current;
    const projectId = projects.state.active?.projectId;
    const pending = reload ? local.readCurrent() : local.open(); refreshLocal();
    const result = await pending; refreshLocal();
    if (result.status !== 'opened') { nativeTransition.current = false; setLocalMessage(result.message); if (result.issues) setOperationIssues(result.issues); return; }
    if (saveGuard.current.unapplied) { nativeTransition.current = false; local.cancelOpen(result.token); setLocalMessage('有未应用输入；先应用或撤销输入，再关联文件。'); return; }
    try {
      if (reload && !sameValue(before.map.coordinateFrame, result.loaded.map.coordinateFrame)
        && !await confirmCoordinateFrame()) { local.cancelOpen(result.token); return; }
      if (sessionRef.current.changeToken !== before.changeToken || projects.state.active?.projectId !== projectId)
        throw new Error('文件候选准备后当前工程已改变，请重新载入候选。');
      preserveNative.current = true;
      await projects.create(result.loaded.map, initialView(result.loaded.map));
      const accepted = local.acceptOpen(result.token);
      if (accepted.status === 'linked') await persistFileBinding();
      setLocalMessage(accepted.status === 'linked' ? '文件已关联；写回需要单独操作。' : accepted.message);
      setFileConflict(null); setOverwriteReady(null);
    } catch (error) { local.cancelOpen(result.token); setLocalMessage(String(error)); }
    finally { preserveNative.current = false; nativeTransition.current = false; refreshLocal(); }
  }
  function writeNative(saveAs = false, overwriteToken?: number) { saveProject(false, 'file', saveAs, overwriteToken); }
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
  function history(direction: 'undo' | 'redo') {
    requestLeave(direction === 'undo' ? '撤销地图事务' : '重做地图事务', () => {
      const current = sessionRef.current;
      const transaction = (direction === 'undo' ? current.past : current.future).at(-1);
      if (!transaction || rejectLocked(transaction.affectedRefs)) return;
      updateSession(direction === 'undo' ? undoSession(current) : redoSession(current));
      setOperationIssues([]); setDraftRoad(null); setStatus(direction === 'undo' ? '已撤销一个事务。' : '已重做一个事务。');
    });
  }
  function undo() { history('undo'); }
  function redo() { history('redo'); }
  function addPolygon(kind: 'facilities' | 'zones', boundary: Polygon) {
    const id = uid(kind === 'facilities' ? 'facility' : 'zone');
    const generic = kind === 'facilities' ? facilityKind === 'building' : zoneKind === 'unclassified';
    const command: MapCommand = generic ? { type: 'quickTraceBoundary', kind: kind === 'facilities' ? 'building' : 'area', boundary } : kind === 'facilities'
      ? { type: 'addFacility', id, facility: newFacility(boundary, '建筑' + String(scene.facilities.length + 1).padStart(3, '0'), facilityKind) }
      : { type: 'addZone', id, zone: newZone(boundary, '区域' + String(scene.zones.length + 1).padStart(3, '0'), zoneKind) };
    let accepted = false;
    requestLeave('提交绘制的空间对象', () => { accepted = apply(command); if (accepted) setSelection(emptySelection()); }, propertyDirty || mapName !== session.map.metadata.name);
    return accepted;
  }
  function finishRoad(draft: DraftRoad|null = draftRoad) {
    if (!draft || draft.points.length < 2 || draft.curveEnd) { setStatus(draft?.curveEnd?'再点击曲线经过的位置；当前草稿保持未提交。':'道路至少需要两个不同落点；请放大视图或按 Alt 关闭吸附后重试。'); return; }
    const before = new Set(Object.keys(sessionRef.current.map.roads));
    if (apply({ type: 'quickTraceRoad', points:draft.points, geometry:draftRoadGeometry(draft), defaults: { widthM: drawingRef.current.roadWidthM, direction: drawingRef.current.roadDirection, connectNewCrossings: drawingRef.current.connectNewCrossings }, disconnect:draft.disconnect, ...(draft.startConnection?{startConnection:draft.startConnection}:{}), ...(draft.endConnection?{endConnection:draft.endConnection}:{}) })) {
      const ids = Object.keys(sessionRef.current.map.roads).filter(id => !before.has(id));setDraftRoad(null);setSelection({ ...emptySelection(), roads: ids.slice(-1) });
    }
  }
  function traceRoadPoint(point: Vec3, connection?: TraceConnection, finish = false, disconnect = false) {
    requestLeave('绘制道路', () => {
      if (!draftRoad) { setDraftRoad({ points: [point], spans:[], continuity:'corner', standaloneCurve:tool==='curve', disconnect, ...(connection ? { startConnection: connection } : {}), ...(connection?.kind === 'node' ? { fromNodeId: connection.nodeId } : {}) }); return; }
      const current={...draftRoad,disconnect:disconnect||draftRoad.disconnect};
      if (tool === 'curve') {
        if (!current.curveEnd) {setDraftRoad({...current,curveEnd:{point,connection}});return;}
        const next={...appendDraftCurve(current,current.curveEnd.point,point),endConnection:current.curveEnd.connection};
        if(next.points.length===current.points.length){setStatus('曲线端点重合，请选择另一终点。');return;}
        if(current.standaloneCurve||next.endConnection||finish)finishRoad(next);else setDraftRoad(next);return;
      }
      const next={...appendDraftLine(current,point),endConnection:connection};
      if(connection||finish)finishRoad(next);else setDraftRoad(next);
    }, propertyDirty || mapName !== session.map.metadata.name);
  }
  function simpleDraft(kind: 'accessPoints' | 'servicePoints', chosen: Selection) {
    const draft = makePointCreationDraft(kind, chosen, sessionRef.current.map);
    return { ...draft, simple: true, arrival: { ...draft.arrival, mode: 'undeclared' as const }, ids: { pointId: uid(kind === 'accessPoints' ? 'access' : 'service'), nodeId: uid('node'), connectorRoadId: uid('road'), junctionId: uid('junction'), sourceId: uid('source') } };
  }
  function changePointDraft(next: import('./PointCreationPanel').PointCreationDraft) {
    const geometry = (value: import('./PointCreationPanel').PointCreationDraft) => [value.ownerKind, value.facilityId, value.zoneId, value.accessPointId, value.position, value.connection, value.connectorDirection, value.arrival.mode, value.arrival.entryNodeId, value.arrival.internalPath];
    setPointDraft(pointDraft && !sameValue(geometry(pointDraft), geometry(next)) ? { ...next, approvedMovements: [] } : next);
  }
  const pointPath = useMemo(() => {
    if (!pointDraft?.simple || pointDraft.canvasMode !== 'path') return undefined;
    const path = pointDraft.arrival.internalPath, last = path.at(-1), road = last && session.map.roads[last.roadId];
    const end = last && road ? last.direction === 'forward' ? road.toNodeId : road.fromNodeId : session.map.accessPoints[pointDraft.accessPointId]?.nodeId ?? pointDraft.arrival.entryNodeId;
    const ownerId = pointDraft.ownerKind === 'zone' ? pointDraft.zoneId : pointDraft.facilityId;
    const eligibleRoadIds = Object.entries(session.map.roads).filter(([id, candidate]) => {
      const direction = candidate.fromNodeId === end ? 'forward' : candidate.toNodeId === end ? 'backward' : null;
      return !!direction && ['both', direction].includes(candidate.direction) && roadOwner(session.map, id) === ownerId;
    }).map(([id]) => id);
    return { selectedRoadIds: path.map(arc => arc.roadId), eligibleRoadIds };
  }, [pointDraft, session.map]);
  function pickPoint(result: import('../renderers/2d/MapCanvas').PointPickResult) {
    if (!pointDraft) return;
    if (pointDraft.simple && pointDraft.canvasMode === 'existing') {
      if ('nodeId' in result) changePointDraft({ ...pointDraft, canvasMode: null, arrival: { ...pointDraft.arrival, entryNodeId: result.nodeId } }); return;
    }
    if (pointDraft.simple && pointDraft.canvasMode === 'path' && 'roadId' in result) {
      const map = sessionRef.current.map, path = pointDraft.arrival.internalPath;
      const last = path.at(-1), lastRoad = last && map.roads[last.roadId];
      const end = last && lastRoad ? last.direction === 'forward' ? lastRoad.toNodeId : lastRoad.fromNodeId : map.accessPoints[pointDraft.accessPointId]?.nodeId ?? pointDraft.arrival.entryNodeId;
      const road = map.roads[result.roadId];
      const direction = road?.fromNodeId === end ? 'forward' as const : road?.toNodeId === end ? 'backward' as const : null;
      if (!road || !direction || !pointPath?.eligibleRoadIds.includes(result.roadId)) { setStatus('该路段不从当前路径末端沿声明方向出发，请点选连续的内部道路。'); return; }
      setPointDraft({ ...pointDraft, approvedMovements: [], arrival: { ...pointDraft.arrival, internalPath: [...path, { roadId: result.roadId, direction }] }, connection: { kind: 'node', nodeId: direction === 'forward' ? road.toNodeId : road.fromNodeId } }); return;
    }
    let draft = applyPointPick(pointDraft, result);
    if (pointDraft.simple && pointDraft.canvasMode === 'new' && 'position' in result) { const owner = pointDraft.ownerKind === 'zone' ? sessionRef.current.map.zones[pointDraft.zoneId] : sessionRef.current.map.facilities[pointDraft.facilityId]; if (owner) draft = { ...draft, position: [String(result.position[0]), String(result.position[1]), String(owner.boundary.outer[0][2])] }; }
    if (draft.connection?.kind === 'road' && !draft.connection.nodeId) draft = { ...draft, connection: { ...draft.connection, nodeId: uid('node'), newRoadIds: [uid('road'), uid('road')] } };
    changePointDraft(draft);
  }
  function openPointDialog(kind: 'accessPoints' | 'servicePoints') {
    if (readonly) return;
    requestLeave('添加关联点', () => { setPointDraft(simpleDraft(kind, validSelection)); setOperationIssues([]); });
  }
  function placeAction(kind: 'facilities' | 'zones', id: string, action: 'enter' | 'access' | 'service') {
    requestLeave('编辑设施或区域内部', () => {
      setSelection({ ...emptySelection(), [kind]: [id] }); setInspectionKeys([]); setTool('select');
      if (action === 'enter') { setInternalOwner({ kind, id }); setStatus('编辑内部：只修改明确归属的点路；公共路网作为固定参照。'); return; }
      const draft = simpleDraft(action === 'access' ? 'accessPoints' : 'servicePoints', { ...emptySelection(), [kind]: [id] });
      setPointDraft({ ...draft, simple: true }); setOperationIssues([]);
    });
  }
  function relocatePoint(kind: 'accessPoints' | 'servicePoints', id: string) {
    requestLeave('在画布重新定位', () => { setRelocatingPoint({ kind, id }); setTool('select'); setOperationIssues([]); });
  }
  function translateCurrent(delta: Vec3, token: number) {
    if (token !== sessionRef.current.changeToken) { setStatus('地图已变化，取消旧拖动。'); return; }
    requestLeave('移动所选对象', () => {
      const pointKind = validSelection.accessPoints.length === 1 ? 'accessPoints' : validSelection.servicePoints.length === 1 ? 'servicePoints' : null;
      if (selectedCount === 1 && pointKind) {
        const id = validSelection[pointKind][0]!, position = sessionRef.current.map.nodes[sessionRef.current.map[pointKind][id]!.nodeId]!.position;
        apply({ type: 'movePoint', kind: pointKind, id, position: position.map((v, i) => v + delta[i]!) as Vec3 });
      } else apply({ type: 'translateSelection', selection: validSelection, delta, facilityMovePolicy, zoneMovePolicy });
    });
  }
  function createPoint() {
    if (!pointDraft || operationsBlocked()) return;
    const result = buildPointCreationCommand(pointDraft, session.map, uid);
    if (!result.ok) { setOperationIssues(result.issues); return; }
    if (apply(result.command)) { setSelection({ ...emptySelection(), [result.kind]: [result.id] }); setPointDraft(null); setTool('select'); }
  }
  function rotate() {
    if (!rotateRadians.trim() || !Number.isFinite(Number(rotateRadians)) || rotatePivot.some(value => !value.trim() || !Number.isFinite(Number(value)))) { setOperationIssues([localIssue('INVALID_ROTATION', '旋转角度须为当前显示单位下的有限数，旋转中心为有限米制坐标。')]); return; }
    if (apply({ type: 'rotateSelection', selection: validSelection, pivot: rotatePivot.map(Number) as Vec3, angleRad: Number(rotateRadians) * ((propertyUnits?.angle ?? 'deg') === 'deg' ? Math.PI / 180 : 1), facilityMovePolicy, zoneMovePolicy })) setRotateDialog(false);
  }
  function currentOperation(token: number, baseMap: YardMap): boolean {
    if (token === sessionRef.current.changeToken && baseMap === sessionRef.current.map) return true;
    setOperationIssues([localIssue('STALE_TOPOLOGY_PREVIEW', '确认期间地图已变化，请取消并重新预览操作。')]); return false;
  }
  function beginSplit(widen=false) {
    requestLeave(widen?'此处开始变宽':'拆分道路', () => { setOperationIssues([]); setSplitDistance(''); setSplitExistingNode('');setSplitWidthMode(widen);setSplitWidth('16');setSplitWidthDirection('forward'); setOperationToken(sessionRef.current.changeToken); operationMap.current = sessionRef.current.map;if(widen)setSplitPicking(true);else setSplitDialog(true); });
  }
  function openTopology(command: TopologyCommand, token = sessionRef.current.changeToken, baseMap = sessionRef.current.map) {
    if (!currentOperation(token, baseMap)) return;
    requestLeave('预览拓扑编辑', () => {
      if (!currentOperation(token, baseMap)) return;
      setOperationIssues([]);
      try {
        const turns = (command.type === 'connectNodeToRoad' ? enumerateConnectionTurns(sessionRef.current.map, command) : command.type === 'mergeNodes' ? enumerateMergeTurns(sessionRef.current.map, command) : []).map(turn => ({ id: uid('movement'), ...turn }));
        setTopologyDraft({ command, token, baseMap, turns });
      } catch (error) { setOperationIssues([localIssue('TOPOLOGY_PREVIEW_FAILED', error instanceof Error ? error.message : String(error))]); }
    });
  }
  function topologyDrop(nodeId: string, target: TopologyTarget, token: number) {
    if (drawingRef.current.hiddenTypes.includes(target.kind) || drawingRef.current.lockedTypes.includes(target.kind)) {
      setOperationIssues([localIssue('LOCKED_TOPOLOGY_TARGET', '拓扑候选已隐藏或锁定，请重新选择。')]); return;
    }
    openTopology(target.kind === 'nodes' ? { type: 'mergeNodes', sourceNodeId: nodeId, targetNodeId: target.id }
      : { type: 'connectNodeToRoad', nodeId, roadId: target.id, distanceM: target.distanceM,
        newRoadIds: [uid('road'), uid('road')], junctionId: Object.keys(sessionRef.current.map.junctions).find(id => { const nodes = sessionRef.current.map.junctions[id]!.nodeIds; return nodes.length === 1 && nodes[0] === nodeId; }) ?? uid('junction'), approvedMovements: [] }, token);
  }
  function confirmTopology() {
    if (!topologyDraft || !currentOperation(topologyDraft.token, topologyDraft.baseMap)) return;
    const command = topologyDraft.command;
    if (apply(command)) {
      setTopologyDraft(null); setSelection(command.type === 'mergeNodes' ? { ...emptySelection(), nodes: [command.targetNodeId] }
        : command.type === 'connectNodeToRoad' ? { ...emptySelection(), nodes: [command.nodeId] }
        : command.type === 'suppressDegree2Node' ? { ...emptySelection(), roads: [command.retainedRoadId] } : emptySelection());
    }
  }
  function splitRoad() {
    if (!currentOperation(operationToken, operationMap.current)) return;
    const id = validSelection.roads[0];
    if (!id || !splitDistance.trim() || !Number.isFinite(Number(splitDistance))) { setOperationIssues([localIssue('INVALID_SPLIT_DISTANCE', '请明确输入自道路起点量起的内部切分距离（m）。')]); return; }
    if(splitWidthMode){
      const widthM=Number(splitWidth);if(!splitWidth.trim()||!Number.isFinite(widthM)||widthM<=0){setOperationIssues([localIssue('INVALID_ROAD_WIDTH','新宽度须为正的有限米数。')]);return;}
      const before=new Set(Object.keys(sessionRef.current.map.roads));
      if(apply({type:'splitRoadAndSetWidth',roadId:id,distanceM:Number(splitDistance),widthM,direction:splitWidthDirection,designAssumption:{id:uid('source'),origin:'manual_image_estimate',description:'人工影像估计：明确从所选弧长位置开始修改道路宽度。'}})){setSelection({...emptySelection(),roads:Object.keys(sessionRef.current.map.roads).filter(roadId=>!before.has(roadId))});setSplitDialog(false);}return;
    }
    const newRoadIds: [string, string] = [uid('road'), uid('road')];
    const nodeId = splitExistingNode || uid('node');
    if (apply({ type: 'splitRoad', id, distanceM: Number(splitDistance), nodeId, existingNode: !!splitExistingNode, newRoadIds })) { setSelection({ ...emptySelection(), nodes: [nodeId], roads: newRoadIds }); setSplitDialog(false); }
  }
  function confirmDelete() {
    if (!currentOperation(operationToken, operationMap.current)) return;
    if (apply({ type: 'deleteSelection', selection: validSelection, topologyPolicy: deleteTopology ? 'cascade' : 'reject', facilityPolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', zonePolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', orphanNodes: deleteUnusedNodes ? 'deleteUnused' : 'keep' })) { setSelection(emptySelection()); setDeleteDialog(false); }
  }
  function remove() {
    if (selectedCount === 0 || readonly) return;
    requestLeave('删除所选对象', () => {
      setDeleteMembers(false); setDeleteUnusedNodes(false); setDeleteTopology(false);
      setOperationIssues([]); setOperationToken(sessionRef.current.changeToken); operationMap.current = sessionRef.current.map; setDeleteDialog(true);
    });
  }
  function fit() {
    cancelBoundaryInteraction();
    const bounds = scene.bounds;
    if (!bounds) { setCamera({ offsetX: 80, offsetY: canvasSize.height - 80, scale: 4 }); return; }
    const next = fitCamera(bounds, canvasSize.width, canvasSize.height);
    if (!next) { setStatus('当前坐标超出视图可表示范围；请通过数值属性调整坐标。'); return; }
    setCamera(next);
  }
  function initialView(map: YardMap) {
    const bounds = toSceneSnapshot(map).bounds;
    return { camera: bounds ? fitCamera(bounds, canvasSize.width, canvasSize.height) ?? frameCamera.read() : { offsetX: 80, offsetY: canvasSize.height - 80, scale: 4 }, drawing: { ...DEFAULT_DRAWING_CONFIG }, workbench: { ...workbenchRef.current } };
  }
  async function finishImport(candidate: ImportProposal, isNew: boolean) {
    if (operationsBlocked()) return;
    const result = resolveImport(sessionRef.current, candidate, 'replace');
    setOperationIssues(result.issues);
    if (!result.ok) { setProposal(null); setStatus('候选已过期或无效，请重新导入。'); return; }
    try {
      await projects.create(result.session.map, initialView(result.session.map));
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
    duplicateBy(copyDelta.map(Number) as Vec3, copyRetainFacility);
  }
  function duplicateBy(delta: Vec3, retainOwner = false) {
    const idMap = Object.fromEntries(selectionKinds.flatMap(kind => closure[kind].map(id => [id, uid(({ nodes: 'node', roads: 'road', facilities: 'facility', zones: 'zone', accessPoints: 'access', servicePoints: 'service' })[kind])])));
    if (apply({ type: 'duplicateSelection', selection: validSelection, delta, idMap, associationPolicy: retainOwner ? 'retainOwner' : 'rejectExternal' })) {
      setSelection(Object.fromEntries(selectionKinds.map(kind => [kind, closure[kind].map(id => idMap[id]!)])) as FullSelection); setCopyDialog(false);
    }
  }
  function chooseItem(item: SceneItem, additive = false, protect = unapplied, revealPanel = true) {
    if (selectionKinds.includes(item.kind as SelectionKind)) { choose(item.kind as SelectionKind, item.id, additive, protect, revealPanel); return; }
    requestLeave('查看声明对象', () => {
      setLocatedKey(null);
      if (!additive) setSelection(emptySelection());
      setInspectionKeys(current => additive ? current.includes(item.key) ? current.filter(key => key !== item.key) : [...current, item.key] : [item.key]);
      setTool('select'); if(revealPanel)updateWorkbench({ rightCollapsed: false });
    }, protect);
  }
  function locateItem(item: SceneItem, protect = unapplied) {
    requestLeave('定位对象', () => {
      const positions = itemPositions(item);
      if (!positions.length) { setStatus(item.reason || '该逻辑对象没有声明可定位的几何。'); return; }
      const minX = Math.min(...positions.map(p => p[0])); const maxX = Math.max(...positions.map(p => p[0]));
      const minY = Math.min(...positions.map(p => p[1])); const maxY = Math.max(...positions.map(p => p[1]));
      const next = fitCamera({ min: [minX, minY, 0], max: [maxX, maxY, 0] }, canvasSize.width, canvasSize.height);
      if (!next) { setStatus('当前坐标超出视图可表示范围；相机保持不变。'); return; }
      setCamera(next); setLocatedKey(item.key);
      setStatus(hiddenTypes.includes(item.kind) ? '已定位；该类型仍隐藏，可在基础图层中显示。' : '已定位 ' + item.id);
    }, protect);
  }
  function explainDrag(kind: keyof Selection, id: string) {
    const selected = { ...emptySelection(), [kind]: [id] };
    const support = commandSupport(sessionRef.current.map, { type: 'translateSelection', selection: selected, delta: [0, 0, 0], facilityMovePolicy, zoneMovePolicy });
    if (rejectLocked(support.affectedRefs.length ? support.affectedRefs : [{ kind, id }])) return;
    setOperationIssues(support.issues.length ? support.issues : [localIssue('DRAG_SELECTION_REQUIRED', '请先单独选择此节点；道路端点移动仍受依赖保护。')]);
    setStatus('拖动未执行，地图和历史保持不变。');
  }
  const internalNodes = useMemo(() => {
    const result = new Set<string>(); if (!internalOwner) return result;
    const candidates = new Set<string>();
    for (const [id, road] of Object.entries(session.map.roads)) if (roadOwner(session.map, id) === internalOwner.id) { candidates.add(road.fromNodeId); candidates.add(road.toNodeId); }
    for (const point of [...Object.values(session.map.accessPoints), ...Object.values(session.map.servicePoints)]) if (point.facilityId === internalOwner.id || 'zoneId' in point && point.zoneId === internalOwner.id) candidates.add(point.nodeId);
    for (const id of candidates) { try { if (privateNodeOwner(session.map, id) === internalOwner.id) result.add(id); } catch { /* Shared/public dependencies stay fixed and are explained by command support when selected. */ } }
    return result;
  }, [internalOwner, session.map]);
  function inInternalScope(kind: keyof Selection, id: string): boolean {
    if (!internalOwner) return true;
    const map = sessionRef.current.map;
    if (kind === 'nodes') return internalNodes.has(id);
    if (kind === 'roads') return roadOwner(map, id) === internalOwner.id;
    if (kind === 'accessPoints' || kind === 'servicePoints') { const point = map[kind][id]; return !!point && ('facilityId' in point ? point.facilityId : undefined) === (internalOwner.kind === 'facilities' ? internalOwner.id : undefined) && (internalOwner.kind !== 'zones' || 'zoneId' in point && point.zoneId === internalOwner.id); }
    return false;
  }
  function internalCommandAllowed(command: MapCommand): boolean {
    if (!internalOwner) return true;
    if ('selection' in command) return selectionKinds.every(kind => (command.selection[kind] ?? []).every(id => inInternalScope(kind, id)));
    switch (command.type) {
      case 'updateNode': return inInternalScope('nodes', command.id);
      case 'updateRoad': return inInternalScope('roads', command.id);
      case 'updateRoadBatch': return command.ids.every(id => inInternalScope('roads', id));
      case 'movePoint': return inInternalScope(command.kind, command.id);
      case 'detachAccessPoint':
      case 'updateAccessPoint': return inInternalScope('accessPoints', command.id);
      case 'updateServicePoint': return inInternalScope('servicePoints', command.id);
      case 'createConnectedPoint': return command.owner.kind === internalOwner.kind && command.owner.id === internalOwner.id;
      case 'quickTraceRoad': case 'quickTraceBoundary': case 'addNode': case 'addRoad': case 'addAccessPoint': case 'addServicePoint': case 'addFacility': case 'addZone':
      case 'updateFacility': case 'updateZone': case 'mergeNodes': case 'connectNodeToRoad': case 'splitRoad': case 'suppressDegree2Node': return false;
      default: return true;
    }
  }
  function canDrag(kind: keyof Selection, id: string) {
    if (!inInternalScope(kind, id)) return false;
    if (lockedTypes.includes(kind as SceneKind) || inspectionKeys.length) return false;
    if (topologySnap && kind === 'nodes' && selectedCount === 1 && validSelection.nodes[0] === id) {
      // Preview only; release still requires either a confirmed topology command or ordinary move support.
      return !impact.affectedRefs.some(ref => lockedTypes.includes(ref.kind as SceneKind));
    }
    if (!hasLinkedContents) return true;
    return validSelection[kind]?.includes(id) === true && moveSupport.allowed && !moveSupport.affectedRefs.some(ref => lockedTypes.includes(ref.kind as SceneKind));
  }
  function locate(issue: Issue) {
    if (issue.location?.position) setIssueMarker({ hash: scene.mapContentHash, position: [...issue.location.position] });
    const kind = issue.entityType as SelectionKind | undefined;
    if (kind && selectionKinds.includes(kind) && issue.entityId && Object.hasOwn(session.map[kind], issue.entityId)) { choose(kind, issue.entityId, false); }
    const item = scene.items.find(entry => entry.jsonPath === issue.jsonPath || entry.jsonPath === '/' + issue.entityType + '/' + issue.entityId);
    if (item && !selectionKinds.includes(item.kind as SelectionKind)) { chooseItem(item); locateItem(item); return; }
    const point = issue.location?.position;
    if (point) { const next = fitCamera({ min: point, max: point }, canvasSize.width, canvasSize.height); if (next) setCamera(next); else setStatus('当前坐标超出视图可表示范围；相机保持不变。'); }
  }
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (frameCamera.hasPending() || saveGuard.current.browserDirty || saveGuard.current.unapplied) { event.preventDefault(); event.returnValue = ''; } }
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  const handleKey = useCurrentCallback((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const target = event.target as HTMLElement;
    const modifier = event.ctrlKey || event.metaKey;
    const modal = !!interaction.state.dialog || !!(pointDraft && !pointDraft.canvasMode) || !projects.ready;
    if (modal) {
      if (modifier && event.key.toLowerCase() === 's' && pointDraft && !interaction.read().dialog && projects.ready) { event.preventDefault(); saveProject(); return; }
      if ((modifier && event.key.toLowerCase() === 's') ||
        (!target.closest('input, textarea, select, [contenteditable="true"]') &&
          ((modifier && ['z', 'y'].includes(event.key.toLowerCase())) || ['Delete', 'Backspace'].includes(event.key)))) event.preventDefault();
      return;
    }
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); saveProject(); return; }
    if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (backgroundAdjustId && !modifier) {
      if (event.key === 'Escape') { event.preventDefault(); if (backgroundActive.current) cancelBoundaryInteraction(); else adjustBackground(null); return; }
      const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (delta[event.key]) {
        event.preventDefault(); const layer = sessionRef.current.map.backgroundLayers[backgroundAdjustId];
        if (layer && !backgroundDirty && !backgroundActive.current && !resolvedBackgroundPreferences.layers[backgroundAdjustId]?.locked) {
          const step = event.shiftKey ? 1 : 0.1; const d = delta[event.key]!;
          applyBackground({ type: 'updateBackgroundTransform', id: backgroundAdjustId, imageToWorld: translateBackground(layer.imageToWorld, [d[0] * step, d[1] * step]) }, currentDraftContext());
        } return;
      }
      if (!['f'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
    }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
    else if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
    else if (modifier && event.key.toLowerCase() === 'd') { event.preventDefault(); if (selectedCount && !readonly) requestLeave('快速复制', () => duplicateBy([10, 10, 0])); }
    else if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); updateWorkbench({ leftCollapsed: false }); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="object-search"]')?.focus()); }
    else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); remove(); }
    else if (event.key === 'Escape') {
      event.preventDefault();
      if (boundaryInteraction.current) { cancelBoundaryInteraction(); return; }
      if (relocatingPoint) { setRelocatingPoint(null); return; }
      if (pointIdentities.length) { setPointIdentities([]); return; }
      if (internalOwner && !unapplied) { setInternalOwner(null); return; }
      if ((draftRoad || polygonDraftDirty) && !propertyDirty && mapName === session.map.metadata.name) { setDraftRoad(null); setPolygonDraftDirty(false); setDraftResetToken(value => value + 1); }
      else if (pointDraft || splitPicking || propertyDirty || mapName !== session.map.metadata.name) {
        requestLeave('取消当前输入', () => { setDraftRoad(null); setPointDraft(null); setPolygonDraftDirty(false); setSplitPicking(false); setDraftResetToken(value => value + 1); });
      } else if (tool !== 'select') changeTool('select');
      else { setLocatedKey(null); setInspectionKeys([]); setSelection(emptySelection()); }
    } else if (!modifier && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'f') { event.preventDefault(); if (event.shiftKey) { const item = scene.items.find(item => item.key === focusKey); if (item) locateItem(item); } else fit(); }
      else if (event.key === 'Enter' && draftRoad) { event.preventDefault(); finishRoad(); }
      else { const tools: Record<string, Tool> = { v: 'select', h: 'pan', r: 'road', c: 'curve', b: 'facilityRect', a: 'zonePolygon', g: 'zoneRect', m: 'measure' }; if (tools[key]) { event.preventDefault(); changeTool(tools[key]); } }
    }
  });
  useEffect(() => {
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleKey]);
  const topologyPreview = useMemo(() => topologyDraft ? commandSupport(session.map, topologyDraft.command) : null, [session.map, topologyDraft]);
  const deletePreview = useMemo(() => deleteDialog ? commandSupport(session.map, { type: 'deleteSelection', selection: validSelection,
    topologyPolicy: deleteTopology ? 'cascade' : 'reject', facilityPolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', zonePolicy: deleteMembers ? 'withAssociatedPoints' : 'reject', orphanNodes: deleteUnusedNodes ? 'deleteUnused' : 'keep' }) : null,
    [session.map, validSelection, deleteDialog, deleteTopology, deleteMembers, deleteUnusedNodes]);
  const selectedNodeId = selectedCount === 1 && validSelection.nodes.length === 1 ? validSelection.nodes[0] : undefined;
  const selectedRoadId = selectedCount === 1 && validSelection.roads.length === 1 ? validSelection.roads[0] : undefined;
  const selected = useMemo(() => selectedNodeId ? { kind: 'node' as const, id: selectedNodeId, value: session.map.nodes[selectedNodeId]! }
    : selectedRoadId ? { kind: 'road' as const, id: selectedRoadId, value: session.map.roads[selectedRoadId]!, lengthM: scene.roads.find(road => road.id === selectedRoadId)!.lengthM }
    : selectedCount === 1 && validSelection.facilities[0] ? { kind: 'facility' as const, id: validSelection.facilities[0], value: session.map.facilities[validSelection.facilities[0]]! }
    : selectedCount === 1 && validSelection.zones[0] ? { kind: 'zone' as const, id: validSelection.zones[0], value: session.map.zones[validSelection.zones[0]]! }
    : selectedCount === 1 && validSelection.accessPoints[0] ? { kind: 'accessPoint' as const, id: validSelection.accessPoints[0], value: session.map.accessPoints[validSelection.accessPoints[0]]! }
    : selectedCount === 1 && validSelection.servicePoints[0] ? { kind: 'servicePoint' as const, id: validSelection.servicePoints[0], value: session.map.servicePoints[validSelection.servicePoints[0]]! } : null, [selectedNodeId, selectedRoadId, selectedCount, validSelection, session.map, scene.roads]);
  const directoryDrawing = useCurrentCallback(updateDrawingConfig);
  const directoryChoose = useCurrentCallback((item: SceneItem, additive: boolean) => {
    requestLeave('选择并定位对象', () => { chooseItem(item, additive, false); if (!additive) locateItem(item, false); updateWorkbench({ rightCollapsed: false, ...(window.matchMedia('(max-width: 1279px)').matches ? { leftCollapsed: true } : {}) }); }, unapplied);
  });
  const directoryLocate = useCurrentCallback(locateItem);
  const directorySelected = useCallback((item: SceneItem) => selectionKinds.includes(item.kind as SelectionKind) ? validSelection[item.kind as SelectionKind].includes(item.id) : inspectionKeys.includes(item.key), [validSelection, inspectionKeys]);
  function updateBackgroundPreferences(value: BackgroundPreferences) {
    if (!projects.ready || projects.isNavigating()) return;
    backgroundRef.current = value; setBackgroundPreferences(value);
  }
  function adjustBackground(id: string | null) {
    requestLeave('切换底图调整', () => {
      const target = id ?? backgroundAdjustId;
      if (id && (backgroundDisabled || !inspectBackground(sessionRef.current.map, id).supported)) return;
      if (id && drawingRef.current.lockedTypes.includes('backgroundLayers')) { setStatus('底图类型已锁定，请先在基础图层解除该类型锁定。'); return; }
      if (target) { const current = backgroundRef.current ?? resolvedBackgroundPreferences; updateBackgroundPreferences({ ...current, layers: { ...current.layers, [target]: { visible: true, opacity: 1, ...current.layers[target], locked: !id } } }); }
      setBackgroundAdjustId(id); setBackgroundKeepAspect(true); setFormEpoch(value => value + 1);
      setSelection(emptySelection()); setInspectionKeys([]); setTool('select'); setDraftRoad(null); setDraftResetToken(value => value + 1);
    });
  }
  function applyBackground(command: MapCommand, context: DraftContext): boolean {
    if (!sameDraftContext(context, currentDraftContext()) || backgroundDisabled || !isBackgroundCommand(command)) { setStatus('底图候选已过期或当前地图受保护，未提交。'); return false; }
    return apply(command);
  }
  function fitBackground(id: string) {
    const layer = sessionRef.current.map.backgroundLayers[id], asset = layer && sessionRef.current.map.assets[layer.assetId];
    if (!layer || !asset?.widthPx || !asset.heightPx || !inspectBackground(sessionRef.current.map, id).supported) return;
    const points = backgroundFrame(layer.imageToWorld, asset.widthPx, asset.heightPx).corners;
    const next = fitCamera({ min: [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])), 0], max: [Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1])), 0] }, canvasSize.width, canvasSize.height);
    if (next) setCamera(next);
  }
  const backgroundContextKey = [draftContext.projectId, session.changeToken, draftResetToken, backgroundDisabled, !!interaction.state.dialog, backgroundDirty].join('/');
  const backgroundError = useCurrentCallback((message: string) => { if (message) setStatus(message); });
  const backgroundCommit = useCurrentCallback((id: string, transform: import('../geometry/backgrounds').BackgroundTransform, context: string) => {
    if (context !== backgroundContextKey || id !== backgroundAdjustId || resolvedBackgroundPreferences.layers[id]?.locked || !resolvedBackgroundPreferences.layers[id]?.visible || backgroundDirty || backgroundDisabled) return false;
    return applyBackground({ type: 'updateBackgroundTransform', id, imageToWorld: transform }, currentDraftContext());
  });
  const propertyKeys = useCurrentCallback((event: import('react').KeyboardEvent) => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.property-content') || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      event.preventDefault(); event.stopPropagation();
      const draft = activePropertyDraft.current;
      if (propertyDirty && draft && sameDraftContext(draft.context, currentDraftContext())) draft.apply();
    } else if (event.key === 'Escape' && (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)) {
      event.preventDefault(); event.stopPropagation();
      activePropertyDraft.current = null; setPropertyDirty(false); setRoadShapePreview(null); setFormEpoch(value => value + 1); setStatus('已取消此对象未应用的属性输入。');
    }
  });
  const propertyApply = useCurrentCallback(apply);
  const propertyBoundaryMode = useCurrentCallback(changeBoundaryMode);
  const propertyUnitsChange = useCurrentCallback(updatePropertyUnits);
  const propertyPlaceAction = useCurrentCallback(placeAction);
  const propertyRelocatePoint = useCurrentCallback(relocatePoint);
  const propertyRoadPreset = useCurrentCallback((id: string) => requestLeave('采用后续新路预设', () => setRoadPreset({ roadId: id })));
  const propertyRoadBatch = useCurrentCallback((id: string) => requestLeave('预览连续道路范围', () => setRoadBatch({ ids: continuousRoadIds(sessionRef.current.map, id) })));
  const inspectLocate = useCurrentCallback(() => { if (inspected) locateItem(inspected); });
  const locateIssue = useCurrentCallback(locate);
  const describeItem = useCallback((key: string) => {
    const item = scene.items.find(value => value.key === key); if (!item) return null;
    const value = itemValue(session.map, item) as { provenance?: { category?: string; sourceRefs?: string[] } } | undefined;
    const provenance = value?.provenance;
    return { id: item.id, name: item.name, source: provenance ? [provenance.category, ...(provenance.sourceRefs ?? [])].filter(Boolean).join(' · ') : item.reason || '未单独声明来源；完整声明见属性与引用。' };
  }, [scene.items, session.map]);
  const focusKey = locatedKey ?? inspected?.key ?? selectionKinds.flatMap(kind => validSelection[kind].map(id => kind + '/' + id))[0];
  const hint = backgroundAdjustId ? '底图调整：矢量编辑暂停。左上为位置锚点，拖角固定对角；完成后锁定。' : readonly ? '只读检查：可查看、定位并原样导出 JSON。'
    : tool === 'node' ? '点击空白位置创建节点。坐标可在右侧精确修改。'
    : tool === 'curve' ? '依次点击起点、终点、弯曲位置；或拖选中道路的中点变弯，双击弯曲柄恢复直线。'
    : tool === 'road' ? (draftRoad ? '点击添加折角；Enter / 双击完成，绿圈确认接路，Alt 不连接。' : '点击起点直接画路，软件创建端点；绿圈为明确接路目标。')
    : tool === 'facilityOrientedRect' || tool === 'zoneOrientedRect' ? '依次点击基边两端和侧边，自动保持四个直角。'
    : tool === 'facilityRect' || tool === 'zoneRect' ? '依次点击矩形的两个对角点；几何按世界米制坐标保存。'
    : tool === 'facilityPolygon' || tool === 'zonePolygon' ? '依次点击顶点，点击起点或 Enter 完成多边形；Esc 取消。'
    : tool === 'pan' ? '按住鼠标拖动平移，滚轮缩放。'
    : '拖动节点移动；Shift 点击多选；滚轮缩放；中键平移。';

  return <>
    <input ref={fileInput} data-testid="json-file-input" type="file" accept=".json,application/json" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importFile(file); }} />
    <Workbench preferences={workbench} onPreferencesChange={updateWorkbench} drawerOpen={drawerOpen} onDrawerOpenChange={setDrawerOpen}
      header={<>
      <details className="workbench-menu"><summary>文件</summary><div className="workbench-menu-items">
        <button onClick={showRecent} disabled={!projects.ready || projects.transitioning || saveRunning}>最近项目</button>
        <button onClick={() => void copyProject()} disabled={!projects.ready || projects.transitioning || saveRunning}>浏览器另存为</button>
        <button disabled={!projects.ready || projects.transitioning || localState.busy || saveRunning} onClick={() => { setNewName('新建布局'); setNewDialog(true); }}>新建地图</button>
        <button onClick={() => { if (local.capabilities().open) void openNative(); else fileInput.current?.click(); }} disabled={bindingLoading || fileLoading || !projects.ready || projects.transitioning || localState.busy || saveRunning} title="支持文件授权的浏览器会关联原文件，后续保存直接写回">导入 JSON</button>
        <button onClick={() => fileInput.current?.click()} disabled={bindingLoading || fileLoading || !projects.ready || projects.transitioning || localState.busy || saveRunning} title="创建浏览器副本，不取得原文件写入权限">导入 JSON 副本</button>
        <button onClick={exportCurrent}>导出 JSON</button>
              <button onClick={() => void openNative()} disabled={!local.capabilities().open || localState.busy || projects.transitioning} title="浏览器能力检测；点击后才请求文件授权">关联本地 JSON</button>
      <button onClick={() => void chooseOriginalFile()} disabled={!local.capabilities().open || bindingLoading || localState.busy || projects.transitioning || saveRunning}>关联原文件</button>
      <button onClick={() => void writeNative()} disabled={!localState.linkedName || localState.busy || projects.transitioning}>写回关联文件</button>
      <button onClick={() => void writeNative(true)} disabled={localState.busy || projects.transitioning || saveRunning}>文件另存为</button>
      <button onClick={() => void checkFile()} disabled={!localState.linkedName || localState.busy}>检查外部变化</button>
      <button onClick={() => void openNative(true)} disabled={!localState.linkedName || localState.busy}>重新载入文件</button>
        <span data-testid="export-status">{exportMessage}</span>
      </div></details>
      <details className="workbench-menu"><summary>编辑</summary><div className="workbench-menu-items"><button disabled={readonly} onClick={() => { updateWorkbench({ leftCollapsed: false }); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="地图名称"]')?.focus()); }}>地图信息</button><button onClick={() => { updateWorkbench({ leftCollapsed: false }); requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[data-testid="object-search"]')?.focus()); }}>搜索对象</button></div></details>
      <details className="workbench-menu"><summary>视图</summary><div className="workbench-menu-items"><button onClick={() => updateWorkbench({ leftCollapsed: false, rightCollapsed: false })}>显示两侧面板</button><button onClick={() => updateWorkbench({ leftCollapsed: true, rightCollapsed: true })}>收起两侧面板</button><button onClick={() => updateWorkbench({ leftWidth: 240, rightWidth: 300, leftCollapsed: 'auto', rightCollapsed: 'auto' })}>恢复工作台布局</button></div></details>
      <button onClick={() => requestLeave('打开底图面板', () => { setBackgroundPanelOpen(true); updateWorkbench({ leftCollapsed: false }); requestAnimationFrame(() => document.querySelector('[data-testid="background-panel"]')?.scrollIntoView({ block: 'nearest' })); })}>底图</button>
      <button onClick={() => setDrawerOpen(!drawerOpen)}>检查</button>
      <strong className="workbench-project-name" title={session.map.metadata.name}>{session.map.metadata.name}</strong>
      <span className="workbench-save-status"><span data-testid="browser-save-status">{projects.browserStatus}</span><span data-testid="local-save-status">{bindingLoading ? '正在恢复原文件关联…' : localState.busy ? '本地文件处理中…' : localState.conflict ? '本地文件冲突' : !localState.linkedName ? '本地文件未关联' : localState.confirmedContentHash === scene.mapContentHash ? '本地文件已确认：' + localState.linkedName : '本地文件有未写回变化：' + localState.linkedName}</span></span>
      <button className="primary-button" aria-label="保存工程" onClick={() => saveProject()} disabled={bindingLoading || !projects.ready || projects.transitioning || saveRunning}>{saveRunning ? '保存中…' : '保存'}</button>
      <details className="workbench-menu"><summary aria-label="保存选项">▾</summary><div className="workbench-menu-items"><button onClick={() => saveProject(false, 'browser')}>仅保存浏览器恢复</button><button onClick={() => writeNative(true)}>另存为</button></div></details>
    </>}
      tools={<><div role="tablist" aria-label="工作区">{([{id:'trace',label:'描图'},{id:'check',label:'检查与补全'},{id:'results',label:'调度结果'}] as const).map(mode=><button key={mode.id} role="tab" aria-selected={workspaceMode===mode.id} onClick={()=>requestLeave('切换工作区',()=>{setWorkspaceMode(mode.id);setTool('select');if(mode.id!=='trace')updateWorkbench({rightCollapsed:false});})}>{mode.label}</button>)}</div>{/* Existing creation tools and one command toolbar. */}        <div className="tool-grid">{([{ id: 'select', label: '选择', icon: '↖' }, { id: 'road', label: '道路', icon: '⌁' }, { id: 'curve', label: '弯曲', icon: '∿' }, { id: 'pan', label: '平移', icon: '✥' }, {id:'measure',label:'量距',icon:'↔'}, { id: 'facilityRect', label: '建筑', icon: '▭' }, { id: 'zonePolygon', label: '区域', icon: '◇' }] as const).map(item => <button key={item.id} className={tool === item.id ? 'tool-button active' : 'tool-button'} aria-label={item.label} aria-pressed={tool === item.id} disabled={(readonly || workspaceMode!=='trace') && item.id !== 'select' && item.id !== 'pan' && item.id !== 'measure'} onClick={() => changeTool(item.id)}><b>{item.icon}</b>{item.label}</button>)}</div></>}
      context={<>{draftRoad&&<label className="trace-width">本次接续<select aria-label="本次道路接续" value={draftRoad.continuity} onChange={event=>setDraftRoad({...draftRoad,continuity:event.target.value as 'smooth'|'corner'})}><option value="corner">折角（保留落点初形）</option><option value="smooth">平滑（调整当前草稿切柄）</option></select></label>}<label className="trace-width">新道路宽度 <input aria-label="新道路默认宽度" type="number" min="0.1" max="1000" step="0.5" value={drawingConfig.roadWidthM} onChange={event => { const value = Number(event.target.value); if (value > 0 && value <= 1000) updateDrawingConfig({ roadWidthM: value }); }}/> m</label><label className="check-field"><input type="checkbox" aria-label="描图接路吸附" checked={snapNodes} onChange={event => updateDrawingConfig({ snapNodes: event.target.checked })}/>接路吸附</label>        {workspaceMode==='trace'&&!draftRoad&&validSelection.roads.length>0&&<div className="selected-road-actions" role="group" aria-label="所选道路快捷操作"><button disabled={readonly} onClick={()=>requestLeave('批量修改所选道路',()=>setRoadBatch({ids:[...validSelection.roads],scope:'selection'}))}>所选道路改宽</button>{([{value:'both',label:'双向'},{value:'forward',label:'正向'},{value:'backward',label:'反向'}] as const).map(direction=><button key={direction.value} disabled={readonly} aria-label={'所选道路设为'+direction.label} onClick={()=>requestLeave('修改所选道路方向',()=>{apply({type:'updateRoadBatch',ids:[...validSelection.roads],patch:{direction:direction.value}});})}>{direction.label}</button>)}</div>}<div className="canvas-toolbar"><div className="history-actions"><button onClick={undo} disabled={!session.past.length || projects.transitioning || localState.busy} title="Ctrl+Z">撤销</button><button onClick={redo} disabled={!session.future.length || projects.transitioning || localState.busy} title="Ctrl+Shift+Z">重做</button><span className="toolbar-separator" /><button onClick={() => requestLeave('复制所选对象', () => { setOperationIssues([]); setCopyRetainFacility(false); setCopyDialog(true); })} disabled={readonly || selectedCount === 0}>复制</button><button onClick={remove} disabled={readonly || selectedCount === 0}>删除</button><button onClick={() => requestLeave('旋转所选对象', () => { setOperationIssues([]); setRotateDialog(true); })} disabled={readonly || selectedCount === 0}>旋转</button><button onClick={()=>beginSplit()} disabled={readonly || selectedCount !== 1 || validSelection.roads.length !== 1}>拆分道路</button><button onClick={()=>beginSplit(true)} disabled={readonly || selectedCount!==1 || validSelection.roads.length!==1}>此处开始变宽</button><button disabled={readonly || selectedCount !== 2 || validSelection.nodes.length !== 2} onClick={() => openTopology({ type: 'mergeNodes', sourceNodeId: validSelection.nodes[0]!, targetNodeId: validSelection.nodes[1]! })}>合并节点</button><button disabled={readonly || selectedCount !== 1 || validSelection.nodes.length !== 1} onClick={() => {
          const nodeId = validSelection.nodes[0]!; const roadId = Object.keys(session.map.roads).find(id => session.map.roads[id]!.fromNodeId === nodeId || session.map.roads[id]!.toNodeId === nodeId);
          if (roadId) openTopology({ type: 'suppressDegree2Node', nodeId, retainedRoadId: roadId });
          else { setOperationIssues([localIssue('DEGREE_TWO_REQUIRED', '此节点没有两条关联道路，不能保持道路连通删除。')]); }
        }}>保持道路连通删除节点</button></div><div><button onClick={fit}>适应地图</button><span className="zoom-value">{Number(camera.scale.toPrecision(3))} px/m</span></div></div></>}
      left={<><div className="workbench-settings-area" role="region" aria-label="绘图设置与地图信息" tabIndex={0}><details className="workbench-settings" open={backgroundPanelOpen} onToggle={event => setBackgroundPanelOpen(event.currentTarget.open)}><summary>底图显示与调整</summary><BackgroundPanel key={[draftContext.projectId, session.changeToken, formEpoch].join('/')} map={session.map} context={draftContext} draftContext={draftContext} preferences={resolvedBackgroundPreferences} assets={backgroundAssets} disabled={backgroundDisabled || propertyDirty || mapName !== session.map.metadata.name} adjustingId={backgroundAdjustId} onPreferences={updateBackgroundPreferences} onAdjust={adjustBackground} onFit={fitBackground} onApply={applyBackground} onDirtyChange={onBackgroundDirty} onDraftChange={registerPropertyDraft} keepAspect={backgroundKeepAspect} onKeepAspect={setBackgroundKeepAspect}/></details><details className="workbench-settings" open><summary>描图透明度</summary>
          <div className="spatial-controls">
            <p className="field-note">填充不透明度：0% 透明，100% 实色。边界、中心线与编辑控制点保留显示。</p>
            {([['roadFillOpacity', '道路带'], ['facilityFillOpacity', '建筑填充'], ['zoneFillOpacity', '区域填充']] as const).map(([key, label]) => <label className="field-label" key={key}>
              {label} <output>{Math.round(drawingConfig[key] * 100)}%</output>
              <input type="range" aria-label={label + '不透明度'} aria-valuetext={Math.round(drawingConfig[key] * 100) + '% 不透明'} min="0" max="100" step="1" value={Math.round(drawingConfig[key] * 100)} disabled={!projects.ready || projects.transitioning} onChange={event => updateDrawingConfig({ [key]: Number(event.target.value) / 100 })}/>
            </label>)}
            {resolvedBackgroundPreferences.comparisonMode && <p className="field-note">影像对照模式已开启，会进一步淡化填充。</p>}
            <button className="subtle-button full-width" disabled={!projects.ready || projects.transitioning} onClick={() => updateDrawingConfig({ roadFillOpacity: DEFAULT_DRAWING_CONFIG.roadFillOpacity, facilityFillOpacity: DEFAULT_DRAWING_CONFIG.facilityFillOpacity, zoneFillOpacity: DEFAULT_DRAWING_CONFIG.zoneFillOpacity })}>恢复默认不透明度</button>
          </div>
        </details><details className="workbench-settings"><summary>绘图与显示设置</summary>        <div className="spatial-controls">
          <label className="check-field"><input type="checkbox" aria-label="拓扑吸附" checked={topologySnap} disabled={readonly} onChange={event => { const enabled = event.target.checked; requestLeave('切换拓扑吸附', () => { setTopologySnap(enabled); setDraftResetToken(value => value + 1); }); }}/>拓扑吸附（释放后明确确认）</label>
          <label className="check-field"><input type="checkbox" aria-label="节点吸附" disabled={!projects.ready || projects.transitioning} checked={snapNodes} onChange={event => updateDrawingConfig({ snapNodes: event.target.checked })} />同层节点 / 道路中心线接路吸附（Alt 临时关闭）</label>
          <label className="check-field"><input type="checkbox" aria-label="本项目新路平交相连" checked={drawingConfig.connectNewCrossings} onChange={event => updateDrawingConfig({ connectNewCrossings: event.target.checked })}/>本项目新路平交相连（Alt 本次不连）</label>
          <label className="field-label">网格吸附<select aria-label="网格吸附" disabled={!projects.ready || projects.transitioning} value={snapGrid} onChange={event => updateDrawingConfig({ snapGrid: Number(event.target.value) as DrawingConfig['snapGrid'] })}><option value="0">关闭</option><option value="1">1 m</option><option value="5">5 m</option><option value="10">10 m</option></select></label>
          <label className="field-label">设施类型<select aria-label="新建设施类型" value={facilityKind} disabled={readonly} onChange={event => updateDrawingConfig({ facilityKind: event.target.value as Facility['kind'] })}>{Object.entries({ building: '通用建筑（用途待补）', workshop: '厂房', yard: '堆场', assembly: '总组', dock: '坞区', quay: '码头', other: '其他' }).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <label className="field-label">区域类型<select aria-label="新建区域类型" value={zoneKind} disabled={readonly} onChange={event => updateDrawingConfig({ zoneKind: event.target.value as Zone['kind'] })}>{Object.entries({ unclassified: '通用区域（用途待补）', work: '作业', buffer: '缓冲', waiting: '等待', water: '水域', obstacle: '障碍', forbidden: '禁入', drivable: '可行驶' }).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
          <div className="tool-grid">{([{ id: 'node', label: '节点' }, { id: 'facilityRect', label: '矩形设施' }, { id: 'facilityOrientedRect', label: '三点斜矩形建筑' }, { id: 'facilityPolygon', label: '多边形设施' }, { id: 'zoneRect', label: '矩形区域' }, { id: 'zoneOrientedRect', label: '三点斜矩形区域' }] as const).map(item => <button key={item.id} onClick={() => changeTool(item.id)} disabled={readonly}>{item.label}</button>)}</div>
          <div className="tool-grid"><button onClick={() => openPointDialog('accessPoints')} disabled={readonly}>添加入口</button><button onClick={() => openPointDialog('servicePoints')} disabled={readonly}>添加服务点</button></div>
          <div className="property-subheading">道路显示</div>
          <label className="check-field"><input type="checkbox" aria-label="显示道路带" disabled={!projects.ready || projects.transitioning} checked={showRoadBands} onChange={event => updateDrawingConfig({ showRoadBands: event.target.checked })} />显示道路带</label>
          <label className="check-field"><input type="checkbox" aria-label="显示中心线" disabled={!projects.ready || projects.transitioning} checked={showRoadCenterlines} onChange={event => updateDrawingConfig({ showRoadCenterlines: event.target.checked })} />显示中心线</label>
          <label className="check-field"><input type="checkbox" aria-label="显示普通节点" disabled={!projects.ready || projects.transitioning} checked={showOrdinaryNodes} onChange={event => updateDrawingConfig({ showOrdinaryNodes: event.target.checked })} />显示普通节点</label>
          <p className="field-note">只改变视图；隐藏不会删除节点或改变道路连通。入口和服务点保留显示。</p>
          <button className="subtle-button full-width" disabled={!projects.ready || projects.transitioning} onClick={() => updateDrawingConfig(DEFAULT_DRAWING_CONFIG)}>恢复绘图默认配置</button>
          {(validSelection.facilities.length > 0 || validSelection.zones.length > 0) && <p className="field-note" data-testid="move-impact">将移动 {impact.selection.nodes.length} 个节点，影响 {impact.affectedRoadIds.length} 条道路；明确归属的私有内容随主体移动；公共路网保持固定。<br/>{impact.affectedRoadIds.join('、')}<br/>{!moveSupport.allowed && moveSupport.issues.map(issue => issue.message).join('；')}<br/>固定公共锚点：{impact.fixedAnchorNodeIds.join('、') || '无'}<br/>区域策略：私有内容刚体移动；校正轮廓不缩放内容。共享节点：{impact.sharedNodeIds.join('、') || '无'}</p>}
        </div></details><details className="workbench-settings" open><summary>地图信息</summary>        <div className="panel-title">地图信息</div>
        <div className="map-name-editor"><label className="field-label">地图名称<input aria-label="地图名称" value={mapName} disabled={readonly || propertyDirty || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty} onChange={event => setMapName(event.target.value)} /></label><button className="subtle-button full-width" disabled={readonly || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty || !mapName.trim()} onClick={() => requestLeave('应用地图名称', applyMapName, propertyDirty)}>应用地图名称</button></div>{session.map.schemaVersion === '0.1.0' && <div className="project-note">旧版 0.1.0 原样兼容。<button onClick={() => requestLeave('升级 Schema', () => { setUpgradeTarget('0.2.0'); setPendingTraceTool(null); setUpgradeDialog(true); })} disabled={readonly || projects.temporary}>升级到 0.2.0</button></div>}</details></div>
        <div className="workbench-directory-area" role="region" aria-label="对象目录" tabIndex={0}><div className="panel-title">对象<span><span data-testid="node-count">{scene.nodes.length}</span> 节点 · <span data-testid="road-count">{scene.roads.length}</span> 道路</span></div>
        <StableObjectDirectory domainReadonly={domainReadonly} items={scene.items} drawing={drawingConfig} disabled={!projects.ready || projects.transitioning || !!backgroundAdjustId || backgroundDirty} onDrawing={directoryDrawing}
          isSelected={directorySelected} onSelect={directoryChoose} onLocate={directoryLocate}/></div></>}
      right={<><div hidden={workspaceMode!=='results'}><ResultsPanel key={session.map.mapId} map={session.map} mapHash={scene.mapContentHash} active={workspaceMode==='results'} onFrame={setRuntimePreview}/></div><div hidden={workspaceMode!=='check'}><CompletionPanel key={session.map.mapId} map={session.map} mapHash={scene.mapContentHash} disabled={readonly||unapplied} onApply={apply} onRequireUpgrade={()=>requestLeave('启用研究接入',()=>{setUpgradeTarget('0.3.0');setPendingTraceTool(null);setUpgradeDialog(true);})} onExportPackage={exportCodexPackage} onPreview={lines=>setAccessPreview({hash:scene.mapContentHash,lines})} onLocate={target=>{const item=scene.items.find(item=>item.kind===target.kind&&item.id===target.id);if(item)locateItem(item);}}/></div><div hidden={workspaceMode!=='trace'} onKeyDown={propertyKeys}><div className="panel-title">属性与引用<span>{selected ? selected.kind.toUpperCase() : 'INSPECT'}</span></div>
        {selected && ['facility', 'zone', 'accessPoint', 'servicePoint'].includes(selected.kind) && (!moveSupport.allowed || moveSupport.affectedRefs.some(ref => lockedTypes.includes(ref.kind as SceneKind))) && <div className="field-note" data-testid="move-edit-guidance" role="status">
          <strong>当前移动受限</strong>
          {!moveSupport.allowed && moveSupport.issues.map((issue, index) => <p key={index}>{issue.message}</p>)}
          {moveSupport.affectedRefs.filter(ref => lockedTypes.includes(ref.kind as SceneKind)).map(ref => <p key={ref.kind + '/' + ref.id}>关联对象已锁定：{ref.kind}/{ref.id}</p>)}
          {!moveSupport.allowed && <details><summary>关联详情</summary>{moveSupport.issues.map((issue, index) => <p key={index}>{issue.code} · {issue.jsonPath}</p>)}</details>}
        </div>}
        {selectedNodeId && (!moveSupport.allowed || lockedTypes.includes('nodes') || moveSupport.affectedRefs.some(ref => lockedTypes.includes(ref.kind as SceneKind))) && <div className="field-note" data-testid="node-edit-guidance">当前节点拖动受依赖或图层锁定保护。{moveSupport.issues.map((issue, index) => <span key={index}>{issue.code} · {issue.jsonPath} · {issue.message}</span>)}{moveSupport.affectedRefs.filter(ref => lockedTypes.includes(ref.kind as SceneKind)).map(ref => <span key={ref.kind + '/' + ref.id}>LOCKED_DEPENDENCY · {ref.kind}/{ref.id}</span>)}</div>}
        {selectedRoadId && <div className="field-note" data-testid="road-edit-guidance">道路拖动通过节点或折点完成；不会因外观相交建立连接。
          {(['fromNodeId', 'toNodeId'] as const).map((field, index) => <button key={field} disabled={hiddenTypes.includes('nodes')} onClick={() => choose('nodes', session.map.roads[selectedRoadId]![field], false)}>选择{index === 0 ? '起点' : '终点'}节点</button>)}
          {hiddenTypes.includes('nodes') && <span>节点类型已隐藏，请先显示节点再选择端点。</span>}
          {moveSupport.affectedRefs.filter(ref => lockedTypes.includes(ref.kind as SceneKind)).map((ref, index) => <span key={index}>LOCKED_DEPENDENCY · {ref.kind}/{ref.id}</span>)}
          {!moveSupport.allowed && moveSupport.issues.map((issue, index) => <span key={index}>{issue.code} · {issue.jsonPath} · {issue.message}</span>)}
        </div>}

{inspected ? <StableObjectInspector item={inspected} map={session.map} onLocate={inspectLocate}/> : <StablePropertyPanel propertyUnits={propertyUnits ?? DEFAULT_PROPERTY_UNITS} onPropertyUnitsChange={propertyUnitsChange} onRoadPreset={propertyRoadPreset} onRoadBatch={propertyRoadBatch} onPlaceAction={propertyPlaceAction} onRelocatePoint={propertyRelocatePoint} draftContext={draftContext} onDraftChange={registerPropertyDraft} mapContentHash={scene.mapContentHash} onRoadPreviewChange={onRoadPreviewChange} boundaryEditMode={boundaryEditMode} onBoundaryModeChange={propertyBoundaryMode} map={session.map} facilityMovePolicy={facilityMovePolicy} zoneMovePolicy={zoneMovePolicy} onDirtyChange={onPropertyDirty} key={(selected?.id ?? 'none') + '-' + session.changeToken + '-' + formEpoch} selected={selected} readonly={readonly || !!internalOwner && selectionKinds.some(kind => validSelection[kind].some(id => !inInternalScope(kind,id))) || mapName !== session.map.metadata.name || selectionKinds.some(kind => validSelection[kind].length > 0 && lockedTypes.includes(kind)) || boundaryEditing || pointDraft !== null || draftRoad !== null || polygonDraftDirty || upgradeDialog} count={selectedCount} onApply={propertyApply} />}
        {(capabilities.reasons.length > 0 || capabilities.unrendered.length > 0) && <details className="capability-box"><summary>保留但未支持</summary>{capabilities.reasons.map(reason => <p key={reason}>{reason}</p>)}<h3>未渲染</h3><p>{capabilities.unrendered.join('、') || '无'}</p></details>}
        <details className="capability-box"><summary>草稿校验未覆盖</summary><p>手动诊断仅按所列声明范围检查；具体结果见检查器。</p><p>{capabilities.unchecked.join(' · ')}</p></details></div></>}
      canvas={<><div className="canvas-context">{operationError && !interaction.state.dialog && <span role="alert" style={{ display: 'block', maxHeight: '6rem', overflow: 'auto' }}><strong>操作未完成：</strong>{operationError.message}<button onClick={() => setDrawerOpen(true)}>查看原因与定位</button><button onClick={() => setOperationIssues([])}>关闭提示</button></span>}{internalOwner && <span>编辑内部：{session.map[internalOwner.kind][internalOwner.id]?.name} · 公共路网固定 <button onClick={() => requestLeave('退出内部编辑', () => setInternalOwner(null))}>退出内部编辑</button></span>}{relocatingPoint && <span>点选新的入口/作业位置；Esc 取消。<button onClick={() => setRelocatingPoint(null)}>取消定位</button></span>}{pointIdentities.length > 0 && <span>此节点有多个业务身份：{pointIdentities.map(point => <button key={point.kind + point.id} onClick={() => { choose(point.kind, point.id, false); setPointIdentities([]); }}>{point.kind === 'accessPoints' ? '入口' : '作业点'} · {session.map[point.kind][point.id]?.name}</button>)}<button onClick={() => setPointIdentities([])}>取消</button></span>}</div><MapCanvas runtime={workspaceMode==='results'&&runtimePreview?.mapContentHash===scene.mapContentHash?runtimePreview:null} accessPreview={workspaceMode==='check'&&accessPreview?.hash===scene.mapContentHash?accessPreview.lines:[]} repairPreview={boundaryRepair ? { kind: boundaryRepair.kind, id: boundaryRepair.id, boundary: boundaryRepair.boundary, points: boundaryRepair.command.type === 'updateFacility' ? (boundaryRepair.command.entranceAdjustments ?? []).map(value => value.position) : [] } : null} canEditRoad={id => inInternalScope('roads', id)} onRoadWidthCommit={(id, widthM, token) => token === sessionRef.current.changeToken && inInternalScope('roads', id) && apply({ type: 'updateRoadBatch', ids: [id], patch: { widthM: { state: 'known', value: widthM } }, designAssumption: { id: uid('source'), origin: 'manual_image_estimate', description: '人工影像估计：对照底图拖动宽度侧柄。' } })} onRoadGeometryCommit={(id, geometry, token) => inInternalScope('roads',id) && token === sessionRef.current.changeToken && apply({ type: 'updateRoad', id, patch: sessionRef.current.map.schemaVersion === '0.3.0' ? { geometry } : { shapePoints: geometry.anchors } })} onPointIdentities={setPointIdentities} comparisonMode={resolvedBackgroundPreferences.comparisonMode} fillOpacity={drawingConfig} backgrounds={{ items: backgroundVisuals, adjustingId: !backgroundDisabled && !backgroundDirty && !lockedTypes.includes('backgroundLayers') && !interaction.state.dialog && resolvedBackgroundPreferences.layers[backgroundAdjustId ?? '']?.locked === false && resolvedBackgroundPreferences.layers[backgroundAdjustId ?? '']?.visible !== false ? backgroundAdjustId : null, keepAspect: backgroundKeepAspect, contextKey: backgroundContextKey, onCommit: backgroundCommit, onActive: onBackgroundActive, onError: backgroundError }} topologySnap={topologySnap} lockedTypes={lockedTypes} onTopologyDrop={topologyDrop} onDragRejected={explainDrag}
          splitPickRoadId={splitPicking ? validSelection.roads[0] : undefined} onSplitPick={distance => { if (currentOperation(operationToken, operationMap.current)) { setSplitDistance(String(distance)); setSplitPicking(false); setSplitDialog(true); } }} routePreview={shownPath ? { mapContentHash: scene.mapContentHash, points: shownPath.points, confirmed: !!currentPath?.confirmed } : null} diagnosticPosition={issueMarker?.hash === scene.mapContentHash ? issueMarker.position : null} hiddenTypes={hiddenTypes} labelMode={labelMode} focusKey={focusKey} describeItem={describeItem} inspectKey={inspected?.key} onInspect={item => chooseItem(item,false,unapplied,false)} canDrag={canDrag}
          canEditBoundary={(kind, id) => boundaryPermissions.has(kind + '/' + id)}
          movingJunctionIds={impact.junctionIds} rigidRoadIds={impact.rigidRoadIds} roadDisplay={{ showRoadBands, showRoadCenterlines, showOrdinaryNodes }} roadShapePreview={roadShapePreview} boundaryEditMode={boundaryEditMode} boundaryChangeToken={session.changeToken} onBoundaryCommit={commitBoundary} onBoundaryInteractionChange={onBoundaryInteractionChange} hasUnappliedInput={propertyDirty || mapName !== session.map.metadata.name} draftResetToken={draftResetToken} {...(relocatingPoint ? { pointPick: { mode: 'relocate' as const }, onPointPick: (result: import('../renderers/2d/MapCanvas').PointPickResult) => { if (!('position' in result)) return; const point = sessionRef.current.map[relocatingPoint.kind][relocatingPoint.id]; if (!point) return; const z = sessionRef.current.map.nodes[point.nodeId]!.position[2]; if (apply({ type: 'movePoint', ...relocatingPoint, position: [result.position[0], result.position[1], z] })) setRelocatingPoint(null); } } : {})} {...(pointDraft?.canvasMode ? { pointPick: { mode: pointDraft.canvasMode, ...pointPath }, onPointPick: pickPoint } : {})} onDraftChange={setPolygonDraftDirty} onPolygonCreate={addPolygon} snap={{ gridM: Number(snapGrid) || null, nodes: snapNodes }} movingNodeIds={impact.selection.nodes} scene={scene} camera={camera} frameCamera={frameCamera} onSize={onCanvasSize} tool={workspaceMode==='trace'||tool==='measure'?tool:'select'} readonly={workspaceMode==='results' || readonly || !!interaction.state.dialog || !!(pointDraft && !pointDraft.canvasMode)} selection={validSelection} onSelect={(kind,id,additive)=>choose(kind,id,additive,unapplied,false)} onClearSelection={() => requestLeave('取消选择', () => { setLocatedKey(null); setInspectionKeys([]); setSelection(emptySelection()); })} draftRoad={draftRoad} traceCrossingsEnabled={drawingConfig.connectNewCrossings} traceCrossings={(points, geometry) => drawingRef.current.connectNewCrossings ? getQuickTraceCrossings(sessionRef.current.map, points, geometry).map(crossing => crossing.point) : []}
          onAddNode={point => requestLeave('绘制节点', () => { const id = uid('node'); if (apply({ type: 'addNode', id, node: newNode(point, '节点 ' + (scene.nodes.length + 1)) })) setSelection({ nodes: [id], roads: [] }); })}
          onRoadNode={id => { const node = sessionRef.current.map.nodes[id]; if (node) traceRoadPoint(node.position, { kind: 'node', nodeId: id }); }} onRoadPoint={traceRoadPoint} onRoadFinish={()=>finishRoad()}
          onDuplicate={(delta, token) => { if (token === sessionRef.current.changeToken) duplicateBy(delta); }} onTranslate={translateCurrent}
        /></>}
      diagnostics={<>{operationError && <IssuePanel issues={issues} diagnosed={!!(currentDiagnostics || currentPath)} onLocate={locateIssue}/>}<StableDiagnosticsPanel map={session.map} mapContentHash={scene.mapContentHash} disabled={operationsBlocked()} diagnostics={diagnostics} route={pathPreview} onDiagnostics={setDiagnostics} onRoute={setPathPreview}/>{!operationError && <IssuePanel issues={issues} diagnosed={!!(currentDiagnostics || currentPath)} onLocate={locateIssue}/>}</>}
      messages={<>    {projects.warning && <div className="project-note">{projects.warning}</div>}
    {localMessage && <div className="project-note" role="status">{localMessage}</div>}
    {unapplied && <div className="project-note pending" data-testid="unapplied-inputs">有未应用输入：属性、操作表单或绘制尚未提交；请应用属性或完成当前操作。</div>}
    {projects.state.error?.code === 'PROJECT_CONFLICT' && <div className="project-note conflict" role="alert">其他标签页已保存此工程，当前编辑尚未覆盖远程浏览器版本。<button onClick={() => void copyProject()}>保留当前恢复副本</button><button onClick={() => { if (!operationsBlocked()) setStorageConflictDialog(true); }}>重新载入浏览器版本</button></div>}{domainReadonly && <div className="readonly-banner" data-testid="readonly-notice"><strong>只读地图</strong> · 未知行为与尚未支持数据保持保护。</div>}{session.map.coordinateFrame.geographicAnchor && <details className="workbench-notice"><summary data-testid="fixed-coordinate-frame">地理锚点已锁定；本地几何按支持范围编辑</summary><p>整个 coordinateFrame 保持固定；未重新配准，依赖保护仍然生效。</p></details>}{Object.keys(session.map.resources).length > 0 && <details className="workbench-notice"><summary data-testid="static-edit-limits">静态草稿编辑；关联内容受依赖保护</summary><p>联动后需重新检查；旧结果仍绑定旧地图摘要。</p></details>}</>}
      status={<><span className="tool-hint">{hint}</span><span className="canvas-status">{selectedCount} 个选中 · {session.past.length} 个撤销事务</span><span role="status" title={status}>{status}</span><span data-testid="save-status">{dirty ? '已提交版本有变化' : '已确认版本'}</span><code data-testid="map-hash" title={scene.mapContentHash}>{scene.mapContentHash}</code></>}
    />
    {frameConfirmation && <Modal title="确认替换坐标框架" onCancel={() => finishFrameConfirmation(false)}><p>候选文件的整个 coordinateFrame 与当前工程不同。这是导入新的坐标框架，并非本地几何编辑；未重新配准或核验现实位置。取消会保留当前地图、历史和文件关联基线。</p><div className="dialog-actions"><button data-cancel onClick={() => finishFrameConfirmation(false)}>取消</button><button className="danger-button" onClick={() => finishFrameConfirmation(true)}>明确接受候选坐标框架</button></div></Modal>}
    {projects.ready && <>
    {recentDialog && <Modal title="最近项目" onCancel={() => setRecentDialog(false)}><p>浏览器数据按站点保存，可能被清理；请保留导出备份。切换前将确认保存当前已提交版本。</p><div className="recent-projects">{projects.recent.map(item => <button key={item.projectId} data-testid={'project-item-' + item.projectId} onClick={() => void openProject(item.projectId)}><strong>{item.name}</strong><small>{item.projectId} · 存储版本 {item.storageVersion} · {new Date(item.updatedAt).toLocaleString()}</small></button>)}</div><div className="dialog-actions"><button data-cancel onClick={() => setRecentDialog(false)}>关闭</button></div></Modal>}
    {storageConflictDialog && !frameConfirmation && <Modal title="重新载入浏览器版本" onCancel={() => setStorageConflictDialog(false)}><p>重新载入会放弃当前未保存输入。建议先“保留当前恢复副本”；其他标签页已保存版本不会被覆盖。</p><div className="dialog-actions"><button data-cancel onClick={() => setStorageConflictDialog(false)}>取消</button><button onClick={() => void copyProject()}>保留当前恢复副本</button><button className="danger-button" onClick={() => void reloadStoredProject()}>明确放弃并重新载入</button></div></Modal>}
    {fileConflict && !frameConfirmation && <Modal title="外部文件内容已变化" onCancel={() => setFileConflict(null)}><p>文件 {fileConflict.name} 与已确认基线不同。当前地图保持不变，写回前会再次读取外部内容。</p><p>{localMessage}</p>{fileConflict.issues.map((issue, index) => <p key={index} className="inline-error">{issue.code} · {issue.jsonPath || "/"} · {issue.message}</p>)}<div className="dialog-actions"><button data-cancel onClick={() => setFileConflict(null)}>取消</button><button onClick={() => void openNative(true)}>重新载入文件</button><button onClick={() => void copyProject()}>保留当前恢复副本</button><button onClick={() => void writeNative(true)}>文件另存为</button>{overwriteReady?.token === fileConflict.token ? <button className="danger-button" onClick={() => void writeNative(false, fileConflict.token)}>明确覆盖外部版本</button> : <button onClick={() => void prepareOverwrite()} disabled={!fileConflict.loaded?.ok}>先保存双方恢复副本</button>}</div><p className="field-note">写前比对不能锁定其他应用；不保证跨应用原子写入。非法外部文件保留原件，不能直接覆盖。</p></Modal>}
    {roadBatch && <RoadBatchPanel map={session.map} ids={roadBatch.ids} scope={roadBatch.scope} onApply={apply} onCancel={() => setRoadBatch(null)}/>}
    {roadPreset && <Modal title="后续新道路预设" onCancel={() => setRoadPreset(null)}><p>将此道路的宽度与方向用于本工程随后新画的道路。旧道路和导入地图不受影响；新路净高、承载与速度保持未知。</p><button onClick={() => setRoadPreset(null)}>取消</button><button onClick={() => { const road = session.map.roads[roadPreset.roadId]; if (road) updateDrawingConfig({ ...(road.widthM.state === 'known' ? { roadWidthM: road.widthM.value } : {}), ...(road.direction !== 'unknown' ? { roadDirection: road.direction } : {}) }); setRoadPreset(null); }}>确认使用此预设</button></Modal>}
    {boundaryRepair && <Modal title="轮廓局部修复预览" onCancel={() => setBoundaryRepair(null)}><p>内部道路与储位尺寸保持不变。虚线显示拟校正轮廓与可安全重新贴边的专用入口。</p>{boundaryRepair.issues.map((issue, i) => <p key={i}>{issue.message}</p>)}{!boundaryRepair.allowed && <p>当前候选无法安全维护关联。请取消后先在“编辑内部”调整出界内容，再校正轮廓。</p>}<button onClick={() => setBoundaryRepair(null)}>取消轮廓修改</button><button disabled={!boundaryRepair.allowed} onClick={() => { if (apply(boundaryRepair.command)) setBoundaryRepair(null); }}>确认轮廓与入口局部修复</button></Modal>}
    {newDialog && <Modal title="新建地图" onCancel={() => setNewDialog(false)}><p>创建本地米制 synthetic 布局。地图 ID 独立生成。</p><label className="field-label">新地图名称<input aria-label="新地图名称" value={newName} onChange={event => setNewName(event.target.value)} /></label><div className="dialog-actions"><button data-cancel onClick={() => setNewDialog(false)}>取消</button><button className="primary-button" onClick={createNew} disabled={!newName.trim()}>创建地图</button></div></Modal>}
    {proposal && <Modal title="未保存编辑冲突" onCancel={() => { resolveImport(sessionRef.current, proposal.value, 'cancel'); setProposal(null); }}><p>当前存在尚未确认的编辑或未应用输入。候选 JSON 已校验；继续前会保存原工程的已提交地图，未应用输入将丢弃。</p><div className="conflict-summary"><strong>当前：{session.map.metadata.name}</strong><span>候选：{proposal.value.loaded.map.metadata.name}</span></div><p className="field-note">“先导出当前版本”会下载独立文件并保留此对话。下载不是工程保存。原工程保留在最近项目；文件写回单独授权。</p><div className="dialog-actions"><button data-cancel onClick={() => setProposal(null)}>取消</button><button onClick={exportCurrent}>先导出当前版本</button><button className="danger-button" onClick={() => finishImport(proposal.value, proposal.isNew)}>放弃编辑并重载</button></div></Modal>}
    {copyDialog && <Modal title="复制选中对象" onCancel={() => setCopyDialog(false)}><p>将复制 <strong>{closure.nodes.length} 个节点</strong>、<strong>{closure.roads.length} 条道路</strong>、{closure.facilities.length} 个设施、{closure.zones.length} 个区域、{closure.accessPoints.length} 个入口和 {closure.servicePoints.length} 个服务点。道路端点/设施和区域成员自动纳入并重映射新 ID；外部道路不复制。</p><div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">{axis} 偏移 (m)<input aria-label={axis + ' 偏移 (m)'} type="number" step="any" value={copyDelta[index] ?? ''} onChange={event => setCopyDelta(values => values.map((v, i) => i === index ? event.target.value : v))} /></label>)}</div><p className="field-note">复制为一个事务；不会连接回原节点。对象扩展含未知引用语义时拒绝复制。</p><label className="check-field"><input type="checkbox" checked={copyRetainFacility} onChange={event => setCopyRetainFacility(event.target.checked)} />允许单独复制的入口/服务点关联原设施或区域</label>{operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map(issue => <p key={issue.code}>{issue.code}：{issue.message}</p>)}</div>}<div className="dialog-actions"><button data-cancel onClick={() => setCopyDialog(false)}>取消</button><button className="primary-button" onClick={duplicate}>确认复制</button></div></Modal>}
    {projects.ready && pointDraft && !interaction.state.dialog && <PointCreationPanel draft={pointDraft} map={session.map} readonly={readonly} issues={operationIssues} onChange={changePointDraft} onCreate={createPoint} onCancel={() => setPointDraft(null)} />}
    {leaveIntent && <Modal title="未应用输入保护" onCancel={() => setLeaveIntent(null)}><p>即将{leaveIntent.label}。当前属性或绘制输入尚未应用到地图，也未包含在自动保存或 JSON 导出中。</p><p>取消会保留当前对象、工具和输入；明确丢弃后才继续。</p><div className="dialog-actions"><button data-cancel onClick={() => setLeaveIntent(null)}>取消，保留输入</button><button className="danger-button" onClick={discardAndContinue}>丢弃未应用输入并继续</button></div></Modal>}
    {upgradeDialog && <Modal title="显式升级地图契约" onCancel={() => { if (!schemaUpgrading) setUpgradeDialog(false); }}><p>Schema {session.map.schemaVersion} → {upgradeTarget}；revision {session.map.revision} → {session.map.revision + 1}。ID、来源、原几何和引用保持；0.3 将旧折点无损迁移为路径锚点，启用通用类别及快速描图。</p><p>先在浏览器中保留原版备份，再提交一个可撤销升级事务。解除原文件关联，升级版本请另存为新文件。浏览器备份可能被清理，请同时保留原 JSON 文件。</p>{operationIssues.map((issue, i) => <p key={i} className="inline-error">{issue.code}：{issue.message}</p>)}<div className="dialog-actions"><button data-cancel disabled={schemaUpgrading} onClick={() => setUpgradeDialog(false)}>取消</button><button onClick={exportCurrent} disabled={schemaUpgrading}>导出升级前原图</button><button className="primary-button" disabled={schemaUpgrading} onClick={() => void upgradeSchema()}>{schemaUpgrading ? '备份中…' : '保留原图并升级'}</button></div></Modal>}
    {deleteDialog && <Modal title="删除空间对象" onCancel={() => setDeleteDialog(false)}>
      {(validSelection.nodes.length > 0 || validSelection.roads.length > 0) && <label className="check-field"><input type="checkbox" aria-label="允许删除关联道路和转向" checked={deleteTopology} onChange={event => setDeleteTopology(event.target.checked)}/>允许删除关联道路、转向及已空的纯引用路口；保留服务点、槽位和资源及容量，仅清理失效的资源作用引用</label>}
      <p>选中 {selectedCount} 个对象。删除有依赖对象时会拒绝整个事务，当前地图保持不变。</p>
      <label className="check-field"><input type="checkbox" checked={deleteMembers} onChange={event => setDeleteMembers(event.target.checked)} />一并删除设施或区域成员入口和服务点</label>
      <label className="check-field"><input type="checkbox" checked={deleteUnusedNodes} onChange={event => setDeleteUnusedNodes(event.target.checked)} />清理成员点不再使用的节点</label>
      <p className="field-note">共享道路仍使用的节点会保留。若显式选中的节点仍被未选对象引用，操作将被拒绝。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code} · {issue.jsonPath}：{issue.message}</p>)}</div>}
      <div data-testid="delete-impact"><strong>影响对象</strong>{deletePreview?.affectedRefs.map((ref, index) => <p key={ref.kind + '/' + ref.id + '/' + index}>{ref.kind}/{ref.id}</p>)}{deletePreview?.issues.map((issue, index) => <p key={index}>{issue.code} · {issue.jsonPath} · {issue.message}</p>)}</div>
      <div className="dialog-actions"><button data-cancel onClick={() => setDeleteDialog(false)}>取消</button><button className="danger-button" onClick={confirmDelete}>确认删除</button></div>
    </Modal>}
    {rotateDialog && <Modal title="旋转选中对象" onCancel={() => setRotateDialog(false)}>
      <p>绕穿过指定中心的 Z 轴旋转；正角度在世界 XY 平面为逆时针，内部保存弧度。</p>
      <label className="field-label">角度单位<select aria-label="角度单位" value={propertyUnits?.angle ?? 'deg'} onChange={event => { const before = propertyUnits?.angle ?? 'deg', after = event.target.value as PropertyUnits['angle']; if (rotateRadians.trim() && Number.isFinite(Number(rotateRadians)) && before !== after) setRotateRadians(String(Number(rotateRadians) * (after === 'rad' ? Math.PI / 180 : 180 / Math.PI))); updatePropertyUnits({ ...(propertyUnits ?? DEFAULT_PROPERTY_UNITS), angle: after }); }}><option value="deg">度 (°)</option><option value="rad">弧度 (rad)</option></select></label><label className="field-label">旋转角度 ({propertyUnits?.angle === 'rad' ? 'rad' : '°'})<input aria-label={'旋转角度 (' + (propertyUnits?.angle === 'rad' ? 'rad' : '°') + ')'} type="number" step="any" value={rotateRadians} onChange={event => setRotateRadians(event.target.value)} /></label>
      <div className="coordinate-fields">{(['X', 'Y', 'Z'] as const).map((axis, index) => <label key={axis} className="field-label">中心 {axis} (m)<input aria-label={'中心 ' + axis + ' (m)'} type="number" step="any" value={rotatePivot[index] ?? ''} onChange={event => setRotatePivot(values => values.map((value, i) => i === index ? event.target.value : value))} /></label>)}</div>
      <p className="field-note">当前区域策略：明确归属内容一起旋转；设施策略：私有内容同角度旋转，公共路网固定。将影响 {impact.affectedRoadIds.length} 条道路：{impact.affectedRoadIds.join('、') || '无'}。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code}：{issue.message}</p>)}</div>}
      <div className="dialog-actions"><button data-cancel onClick={() => setRotateDialog(false)}>取消</button><button className="primary-button" onClick={rotate}>确认旋转</button></div>
    </Modal>}
    {topologyDraft && <Modal title={topologyDraft.command.type === 'mergeNodes' ? '合并节点' : topologyDraft.command.type === 'connectNodeToRoad' ? '确认连接道路' : '保持道路连通删除节点'} onCancel={() => setTopologyDraft(null)}>
      <p>这是一次明确的拓扑编辑。取消保持原地图与历史；没有维护规则的依赖将拒绝整笔操作。</p>
      {topologyDraft.command.type === 'mergeNodes' && <p>移除节点 {topologyDraft.command.sourceNodeId}，引用重连至保留节点 {topologyDraft.command.targetNodeId} 的原位置。不会自动移除平行道路。</p>}
      {topologyDraft.command.type === 'suppressDegree2Node' && <p>移除节点 {topologyDraft.command.nodeId}，拼接其两条道路并保留道路 {topologyDraft.command.retainedRoadId} 的 ID；原节点位置保留为折点，不把曲线路径强行拉直。</p>}
      {topologyDraft.command.type === 'mergeNodes' && <label className="field-label">保留节点<select aria-label="保留节点" value={topologyDraft.command.targetNodeId} onChange={event => { const command = topologyDraft.command; if (command.type === 'mergeNodes' && event.target.value !== command.targetNodeId && currentOperation(topologyDraft.token, topologyDraft.baseMap)) {
          const next = { ...command, sourceNodeId: command.targetNodeId, targetNodeId: command.sourceNodeId, approvedMovements: [] };
          setTopologyDraft({ ...topologyDraft, command: next, turns: enumerateMergeTurns(sessionRef.current.map, next).map(turn => ({ id: uid('movement'), ...turn })) });
        } }}>
        {[topologyDraft.command.sourceNodeId, topologyDraft.command.targetNodeId].map(id => <option key={id} value={id}>{session.map.nodes[id]?.name} · {id}</option>)}
      </select></label>}
      {topologyDraft.command.type === 'suppressDegree2Node' && <label className="field-label">保留道路<select aria-label="保留道路" value={topologyDraft.command.retainedRoadId} onChange={event => { const command = topologyDraft.command; if (command.type === 'suppressDegree2Node') setTopologyDraft({ ...topologyDraft, command: { ...command, retainedRoadId: event.target.value } }); }}>{Object.entries(session.map.roads).filter(([, road]) => topologyDraft.command.type === 'suppressDegree2Node' && (road.fromNodeId === topologyDraft.command.nodeId || road.toNodeId === topologyDraft.command.nodeId)).map(([id, road]) => <option key={id} value={id}>{road.name} · {id}</option>)}</select></label>}
      {topologyDraft.command.type === 'connectNodeToRoad' && <p>节点 {topologyDraft.command.nodeId} → 道路 {topologyDraft.command.roadId}，里程 {topologyDraft.command.distanceM} m。未明确批准的转向不新增许可。</p>}
      {(topologyDraft.command.type === 'connectNodeToRoad' || topologyDraft.command.type === 'mergeNodes') && topologyDraft.turns.length > 0 && <section>
        <label className="check-field"><input type="checkbox" aria-label="允许新增方向兼容转向" checked={(topologyDraft.command.approvedMovements?.length ?? 0) > 0} onChange={event => { const command = topologyDraft.command; if (command.type === 'connectNodeToRoad' || command.type === 'mergeNodes') setTopologyDraft({ ...topologyDraft, command: { ...command, approvedMovements: event.target.checked ? topologyDraft.turns : [] } }); }}/>明确允许下列新增方向兼容转向</label>
        <ul>{topologyDraft.turns.map(turn => <li key={turn.id}>{turn.incomingArc.roadId}/{turn.incomingArc.direction} → {turn.outgoingArc.roadId}/{turn.outgoingArc.direction}</li>)}</ul>
      </section>}
      <div data-testid="topology-impact"><strong>影响对象</strong>{topologyPreview?.affectedRefs.map((ref, index) => <p key={ref.kind + '/' + ref.id + '/' + index}>{ref.kind}/{ref.id}</p>)}{topologyPreview?.issues.map((issue, index) => <p key={index}>{issue.code} · {issue.jsonPath} · {issue.message}</p>)}</div>
      {operationIssues.map((issue, index) => <p role="alert" className="inline-error" key={index}>{issue.code} · {issue.jsonPath} · {issue.message}</p>)}
      <div className="dialog-actions"><button data-cancel onClick={() => setTopologyDraft(null)}>取消</button><button className="primary-button" onClick={confirmTopology}>确认拓扑编辑</button></div>
    </Modal>}
    {splitDialog && <Modal title={splitWidthMode?'此处开始变宽':'拆分道路'} onCancel={() => setSplitDialog(false)}>
      <p>明确在水平弧长位置插入节点，把原道路替换为两条新道路并记录 ID 映射。相交或节点吸附不会自动执行此操作。</p>
      <button disabled={lockedTypes.includes('roads') || hiddenTypes.includes('roads') || (!showRoadBands && !showRoadCenterlines)} onClick={() => { setSplitDialog(false); setSplitPicking(true); }}>在画布上拾取切分点</button>
      <label className="field-label">距起点距离 (m)<input aria-label="距起点距离 (m)" type="number" step="any" value={splitDistance} onChange={event => setSplitDistance(event.target.value)} /></label>
      {!splitWidthMode&&<label className="field-label">复用节点（可选）<select aria-label="复用节点（可选）" value={splitExistingNode} onChange={event => setSplitExistingNode(event.target.value)}><option value="">新建专用节点</option>{Object.entries(session.map.nodes).map(([id, value]) => <option key={id} value={id}>{value.name} · {id}</option>)}</select></label>}
      {splitWidthMode&&<><label className="field-label">此后宽度 (m)<input aria-label="此后宽度 (m)" type="number" min="0.1" step="0.5" value={splitWidth} onChange={event=>setSplitWidth(event.target.value)}/></label><label className="field-label">变宽方向<select aria-label="变宽方向" value={splitWidthDirection} onChange={event=>setSplitWidthDirection(event.target.value as typeof splitWidthDirection)}><option value="forward">从此处沿原道路正向</option><option value="backward">从此处沿原道路反向</option></select></label><p>另一半宽度、中心线及引用继承不变；拆段和改宽合为一个可撤销事务。</p></>}
      <p className="field-note">复用节点须位于切分点 1e-6 m 内；方向、物理属性和来源保留。尚不支持安全重写的资源或扩展引用会阻止拆分。</p>
      {operationIssues.length > 0 && <div role="alert" className="inline-error">{operationIssues.map((issue, i) => <p key={i}>{issue.code}：{issue.message}</p>)}</div>}
      <div className="dialog-actions"><button data-cancel onClick={() => setSplitDialog(false)}>取消</button><button className="primary-button" onClick={splitRoad}>{splitWidthMode?'确认拆分并改宽':'确认拆分'}</button></div>
    </Modal>}
    {saveIntent && <Modal title="有未应用输入" onCancel={() => setSaveIntent(null)}><p>未应用输入尚未成为地图事务。选择如何保存；未完成的绘制不会自动闭合。</p><div className="dialog-actions"><button data-cancel onClick={() => setSaveIntent(null)}>取消，保留输入</button><button onClick={() => saveProject(true, saveIntent.target, saveIntent.saveAs, saveIntent.overwriteToken)}>仅保存已提交地图</button><button className="primary-button" disabled={!!(draftRoad || polygonDraftDirty || pointDraft || splitPicking || boundaryEditing)} onClick={applyThenSave}>应用后保存</button></div>{(draftRoad || polygonDraftDirty || pointDraft || splitPicking) && <p>当前绘制尚未完成，请返回完成，或仅保存已提交地图。</p>}</Modal>}
    {attachCandidate && <Modal title="关联原文件并写回" onCancel={cancelAttachFile}><p>所选文件：{attachCandidate.name}；地图：{attachCandidate.loaded.map.metadata.name}。地图 ID 和坐标框架一致；所选文件内容已另存浏览器恢复副本。</p><p>确认后将用当前已提交地图写回该文件，尚未应用的表单输入不会被写入、仍保留在界面。不会重新载入旧地图；写入前仍检查外部变化。</p><div className="dialog-actions"><button data-cancel onClick={cancelAttachFile}>取消</button><button className="primary-button" onClick={confirmAttachFile}>确认关联并写回</button></div></Modal>}
    </>}
    {!projects.ready && !frameConfirmation && <Modal title="恢复浏览器工程" onCancel={() => {}}><p>{projects.error || '正在读取 IndexedDB；恢复完成前不会写入空地图。'}</p>{projects.error && <div className="dialog-actions"><button onClick={projects.retry}>重试恢复</button><button onClick={projects.continueTemporary}>仅内存继续编辑</button></div>}</Modal>}
  </>;
}

// Only the heavy side-panel boundaries are memoized; their actions always see current guards.
const StableObjectDirectory = memo(ObjectDirectory);
const StableObjectInspector = memo(ObjectInspector);
const StablePropertyPanel = memo(PropertyPanel);
const StableDiagnosticsPanel = memo(DiagnosticsPanel);
const IssuePanel = memo(function IssuePanel({ issues, diagnosed, onLocate }: { issues: Issue[]; diagnosed: boolean; onLocate: (issue: Issue) => void }) {
  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  return <section className="issue-panel" data-testid="issue-panel"><div className="issue-heading"><strong>检查器</strong><span className={errorCount ? 'error-count' : 'warning-count'}>{errorCount} 错误 · {issues.length - errorCount} 提示</span><span>{diagnosed ? '草稿校验 + 只读诊断' : 'draft 校验'}；不代表现场安全</span></div><div className="issue-list">{issues.map((issue, index) => <div key={issue.code + index} className={'issue-item ' + issue.severity}><span className="issue-symbol">{issue.severity === 'error' ? '!' : '△'}</span><span><button aria-label={issue.code + ' ' + issue.message} onClick={() => onLocate(issue)}>{issue.message}</button><small>{issue.suggestedAction}</small><details><summary>技术详情 · {issue.entityId ?? '地图'}</summary><strong>{issue.code}</strong> · {issue.jsonPath || '/'}</details></span></div>)}</div></section>;
});
