import { downloadMap } from '../../adapters/files';
import { backgroundBounds, backgroundLayers } from '../state/backgrounds';
import { editBlock, redo, undo } from '../state/edit';
import { duplicate, duplicateRefusal, lockedSelection, selectionOf } from '../state/editOps';
import { setTool } from '../state/draft';
import { files, linkFile, openLinked, saveAll, saveAs } from '../state/localFile';
import { frame, frameBounds, notify, sceneOf, select, store, type AppState, type ShapeKind, type Tool } from '../state/store';

export type MenuId = 'file' | 'edit' | 'view' | 'check' | 'help';
export const MENUS: readonly { id: MenuId; label: string }[] = [
  { id: 'file', label: '文件' }, { id: 'edit', label: '编辑' }, { id: 'view', label: '视图' }, { id: 'check', label: '检查' }, { id: 'help', label: '帮助' },
];

export interface Operation {
  id: string;
  label: string;
  menu?: MenuId;
  /** Normalized combos, e.g. `Ctrl+K`, `Shift+F`, `V`, `?`. The first one is shown. */
  keys?: readonly string[];
  tool?: Tool;
  /** true when available; otherwise the reason shown next to the disabled control. */
  enabled?: (state: AppState) => true | string;
  run: () => void;
}

/** UI pieces register the few effects the registry cannot perform itself. */
export const bridge = {
  openFile: () => {},
  openImages: () => {},
  /** Chooses an image (and calibration files) to add as a background, or one image to replace layer `replace`'s. */
  pickBackground: (_replace?: string) => {},
  /** Draft actions the canvas performs (it owns the camera the draft is resolved with). */
  draw: { finish: () => {}, undoPoint: () => {}, cancel: () => {} },
  zoomBy: (_factor: number) => {},
};

const needMap = (state: AppState): true | string => state.session ? true : '请先打开地图';
const needBackground = (state: AppState): true | string => !state.session ? '请先打开地图' : Object.keys(state.session.map.backgroundLayers).length ? true : '当前地图没有底图';
const needSelection = (state: AppState): true | string => state.selection.length ? true : '当前没有选中对象';
/** Editing needs an editable map and a selection of editable, unlocked objects. */
const needEditable = (state: AppState): true | string => {
  const blocked = editBlock(state.session); if (blocked) return blocked;
  const selection = selectionOf(state.selection); if (typeof selection === 'string') return selection;
  return lockedSelection(selection) ?? true;
};
/** Roads, curves and areas need schema 0.3.0 (paths, spatial classes); older maps ask to upgrade first, as in ../map. */
const NEEDS_V03: readonly Tool[] = ['road', 'curve', 'building', 'zone'];
const useTool = (tool: Tool, shape?: ShapeKind) => () => {
  const map = store.get().session?.map;
  if (shape && (tool === 'building' || tool === 'zone')) store.set(({ shapes }) => ({ shapes: { ...shapes, [tool]: shape } }));
  if (map && NEEDS_V03.includes(tool) && map.schemaVersion !== '0.3.0') { store.set({ overlay: 'upgrade', upgradeFor: tool }); return; }
  setTool(tool);
};
const needDrawable = (state: AppState): true | string => editBlock(state.session) ?? true;
/** Entrances need a building to go on, and must not write a locked or hidden layer (the entrance, its node, the building's list). */
const needEntrances = (state: AppState): true | string => {
  const blocked = editBlock(state.session); if (blocked) return blocked;
  if (!Object.keys(state.session!.map.facilities).length) return '地图中还没有建筑';
  const { lockedTypes, hiddenTypes } = state.drawing;
  if ((['accessPoints', 'nodes', 'facilities'] as const).some(kind => lockedTypes.includes(kind))) return '入口、节点或建筑图层已锁定，可在「图层」页解锁';
  if (hiddenTypes.includes('facilities')) return '建筑图层已隐藏';
  if (hiddenTypes.includes('accessPoints')) return '入口图层已隐藏';
  return true;
};
/** Service points need a building or zone to go in, and must not write a locked or hidden layer (the point and its node;
 *  the owner's layer is checked where the click lands). */
const needServices = (state: AppState): true | string => {
  const blocked = editBlock(state.session); if (blocked) return blocked;
  const map = state.session!.map;
  if (map.schemaVersion === '0.1.0') return '0.1.0 地图没有作业点的到达方式与区域归属，请先升级地图版本';
  if (!Object.keys(map.facilities).length && !Object.keys(map.zones).length) return '地图中还没有建筑或区域';
  const { lockedTypes, hiddenTypes } = state.drawing;
  if ((['servicePoints', 'nodes'] as const).some(kind => lockedTypes.includes(kind))) return '作业点或节点图层已锁定，可在「图层」页解锁';
  if (hiddenTypes.includes('servicePoints')) return '作业点图层已隐藏';
  return true;
};
const togglePanel = (panel: keyof AppState['panels']) => () => store.set(({ panels }) => ({ panels: { ...panels, [panel]: !panels[panel] } }));

export const OPERATIONS: readonly Operation[] = [
  { id: 'file.new', label: '新建地图…', menu: 'file', run: () => store.set({ overlay: 'newMap' }) },
  { id: 'file.open', label: '打开地图…', menu: 'file', keys: ['Ctrl+O'], run: () => bridge.openFile() },
  { id: 'file.openLinked', label: '打开并关联本地 JSON…', menu: 'file', enabled: () => files.capabilities().open ? true : '这个浏览器不能直接读写本地文件', run: () => { void openLinked(); } },
  { id: 'file.projects', label: '浏览器工程…', menu: 'file', keys: ['Ctrl+Shift+O'], run: () => store.set({ overlay: 'projects' }) },
  // Changes are saved automatically; Ctrl+S also keeps a checkpoint (the last two are kept for recovery).
  { id: 'file.save', label: '保存', menu: 'file', keys: ['Ctrl+S'], enabled: state => !state.session ? '请先打开地图'
    : state.project.phase === 'open' ? true : state.project.phase === 'memory' ? '地图只在本页内存中，请用「导出副本」' : '浏览器工程尚未就绪', run: () => { void saveAll(); } },
  { id: 'file.saveAs', label: '文件另存为…', menu: 'file', keys: ['Ctrl+Shift+S'], enabled: needMap, run: () => { void saveAs(); } },
  { id: 'file.link', label: '关联原文件…', menu: 'file', enabled: state => !files.capabilities().open ? '这个浏览器不能直接读写本地文件'
    : state.project.phase === 'open' && state.session ? true : '请先打开浏览器工程', run: () => { void linkFile(); } },
  { id: 'file.addBackground', label: '添加底图…', menu: 'file', enabled: state => editBlock(state.session) ?? (state.drawing.lockedTypes.includes('backgroundLayers') ? '底图图层已锁定，可在「图层」页解锁' : true), run: () => bridge.pickBackground() },
  { id: 'file.backgroundImages', label: '重新关联底图图片…', menu: 'file', enabled: needBackground, run: () => bridge.openImages() },
  { id: 'file.export', label: '导出副本（JSON）', menu: 'file', keys: ['Ctrl+Shift+E'], enabled: needMap, run: () => {
    const session = store.get().session; if (!session) return;
    notify(`已下载 ${downloadMap(session.map)}；导出副本不算保存。`);
  } },
  { id: 'edit.undo', label: '撤销', menu: 'edit', keys: ['Ctrl+Z'], enabled: state => state.session?.past.length ? true : '没有可撤销的操作', run: undo },
  { id: 'edit.redo', label: '重做', menu: 'edit', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], enabled: state => state.session?.future.length ? true : '没有可重做的操作', run: redo },
  { id: 'edit.duplicate', label: '复制选中对象（偏移 10 m）', menu: 'edit', keys: ['Ctrl+D'], enabled: state => {
    const editable = needEditable(state); if (editable !== true) return editable;
    return duplicateRefusal(state.session!.map, selectionOf(state.selection) as Exclude<ReturnType<typeof selectionOf>, string>) ?? true;
  }, run: () => {
    const { session, selection } = store.get(), chosen = selectionOf(selection);
    if (session && typeof chosen !== 'string') duplicate(session.map, chosen, [10, 10, 0]);
  } },
  { id: 'edit.rotate', label: '旋转选中对象…', menu: 'edit', enabled: needEditable, run: () => store.set({ overlay: 'rotate' }) },
  { id: 'edit.delete', label: '删除选中对象…', menu: 'edit', keys: ['Delete', 'Backspace'], enabled: needEditable, run: () => store.set({ overlay: 'delete' }) },
  { id: 'edit.selectAll', label: '全选可见对象', menu: 'edit', keys: ['Ctrl+A'], enabled: needMap, run: () => {
    const { session, drawing } = store.get(); if (!session) return;
    const hidden = new Set(drawing.hiddenTypes);
    select(sceneOf(session.map).items.filter(item => item.status === 'geometry' && !hidden.has(item.kind) && item.kind !== 'siteBoundary').map(item => item.key));
  } },
  { id: 'edit.clearSelection', label: '取消选择', menu: 'edit', keys: ['Escape'], enabled: needSelection, run: () => select([]) },
  { id: 'tool.select', label: '选择', keys: ['V'], tool: 'select', run: useTool('select') },
  { id: 'tool.pan', label: '平移', keys: ['H'], tool: 'pan', run: useTool('pan') },
  { id: 'tool.node', label: '节点', keys: ['N'], tool: 'node', enabled: needDrawable, run: useTool('node') },
  { id: 'tool.road', label: '道路', keys: ['R'], tool: 'road', enabled: needDrawable, run: useTool('road') },
  { id: 'tool.curve', label: '弯道', keys: ['C'], tool: 'curve', enabled: needDrawable, run: useTool('curve') },
  { id: 'tool.building', label: '建筑', keys: ['B'], tool: 'building', enabled: needDrawable, run: useTool('building') },
  { id: 'tool.zone', label: '区域', keys: ['A'], tool: 'zone', enabled: needDrawable, run: useTool('zone', 'polygon') },
  { id: 'tool.zoneRect', label: '矩形区域', keys: ['G'], enabled: needDrawable, run: useTool('zone', 'rect2') },
  { id: 'tool.entrance', label: '入口', keys: ['E'], tool: 'entrance', enabled: needEntrances, run: useTool('entrance') },
  { id: 'tool.service', label: '作业点', keys: ['S'], tool: 'service', enabled: needServices, run: useTool('service') },
  { id: 'tool.measure', label: '量距', keys: ['M'], tool: 'measure', run: useTool('measure') },
  { id: 'view.fit', label: '适应地图', menu: 'view', keys: ['F'], enabled: needMap, run: () => frame() },
  { id: 'view.frameSelection', label: '定位选中对象', menu: 'view', keys: ['Shift+F'], enabled: needSelection, run: () => frame(store.get().selection) },
  { id: 'view.zoomIn', label: '放大', menu: 'view', keys: ['=', '+'], enabled: needMap, run: () => bridge.zoomBy(1.25) },
  { id: 'view.zoomOut', label: '缩小', menu: 'view', keys: ['-'], enabled: needMap, run: () => bridge.zoomBy(1 / 1.25) },
  { id: 'view.fitBackgrounds', label: '适应底图', menu: 'view', enabled: state => {
    const ready = needBackground(state); if (ready !== true) return ready;
    return backgroundBounds(state.session!.map) ? true : '底图都不受支持';
  }, run: () => { const map = store.get().session?.map, bounds = map && backgroundBounds(map); if (bounds) frameBounds(bounds); } },
  { id: 'view.toggleBackgrounds', label: '显示/隐藏底图', menu: 'view', enabled: needBackground, run: () => store.set(({ session, backgroundView }) => {
    const ids = session ? backgroundLayers(session.map).map(info => info.id) : [], anyVisible = ids.some(id => !backgroundView.hidden.includes(id));
    return { backgroundView: { ...backgroundView, hidden: anyVisible ? [...new Set([...backgroundView.hidden, ...ids])] : backgroundView.hidden.filter(id => !ids.includes(id)) } };
  }) },
  { id: 'view.toggleLeft', label: '显示/隐藏项目内容栏', menu: 'view', run: togglePanel('left') },
  { id: 'view.toggleRight', label: '显示/隐藏属性栏', menu: 'view', run: togglePanel('right') },
  { id: 'view.toggleDrawer', label: '显示/隐藏问题抽屉', menu: 'view', keys: ['Ctrl+J'], run: togglePanel('drawer') },
  { id: 'check.issues', label: '查看检查问题', menu: 'check', enabled: needMap, run: () => store.set(({ panels }) => ({ panels: { ...panels, drawer: true } })) },
  { id: 'help.palette', label: '命令与对象搜索', menu: 'help', keys: ['Ctrl+K'], run: () => store.set({ overlay: 'palette' }) },
  { id: 'help.shortcuts', label: '快捷键与显示约定', menu: 'help', keys: ['?'], run: () => store.set({ overlay: 'help' }) },
];

export function operation(id: string): Operation {
  const found = OPERATIONS.find(op => op.id === id);
  if (!found) throw new Error('Unknown operation ' + id);
  return found;
}
export function availability(op: Operation, state: AppState = store.get()): true | string { return op.enabled ? op.enabled(state) : true; }
/** Runs an operation only when it is available; a disabled request reports its reason instead of failing silently. */
export function runOperation(op: Operation): void {
  const available = availability(op);
  if (available === true) op.run(); else notify(`${op.label}：${available}`, 'error');
}

/** Keys typed here belong to the control, never to workspace shortcuts. */
export const isEditableTarget = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"],[role="menu"]');

/** `Ctrl+Shift+E`-style name of a key event. Shift is implied by printable symbols such as `?` and `+`. */
export function comboOf(event: KeyboardEvent): string {
  const symbol = event.key.length === 1 && !/[a-z0-9]/i.test(event.key);
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return [event.ctrlKey || event.metaKey ? 'Ctrl' : '', event.altKey ? 'Alt' : '', event.shiftKey && !symbol ? 'Shift' : '', key].filter(Boolean).join('+');
}
export function operationForKey(event: KeyboardEvent): Operation | undefined {
  const combo = comboOf(event);
  return OPERATIONS.find(op => op.keys?.includes(combo));
}
