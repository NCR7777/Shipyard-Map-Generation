import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { CanvasView } from './canvas/CanvasView';
import { MapRenderer } from './canvas/renderer';
import { availability, bridge, isEditableTarget, operation, operationForKey, runOperation } from './ops/registry';
import { openFiles } from './files/open';
import { checkFile, localState, useLocalFile } from './state/localFile';
import { checkOtherTabs, projects, startProjects, unsavedMap } from './state/project';
import { nudge } from './state/editOps';
import { addBackground, cancelMeasure, deleteBackground, nudgeBackground, pickedFile, replaceBackground, stopAdjust } from './state/backgroundEdit';
import { notify, store, useApp } from './state/store';
import { MenuBar, StatusBar, Toast, Toolbar } from './ui/Chrome';
import { Icon } from './ui/icons';
import { Inspector } from './ui/Inspector';
import { IssuesDrawer } from './ui/IssuesDrawer';
import { DeleteDialog, RotateDialog, UpgradeDialog } from './ui/EditDialogs';
import { ToolOptions } from './ui/ToolOptions';
import { CommandPalette, HelpPanel, MapChoice } from './ui/Overlays';
import { ConfirmLinkDialog, ConflictBanner, DiscardMemoryDialog, FileConflictDialog, NewMapDialog, ProjectsDialog, RecoveryDialog, ReloadDialog } from './ui/ProjectDialogs';
import { ProjectPanel } from './ui/ProjectPanel';

export function App() {
  const panels = useApp(state => state.panels);
  const overlay = useApp(state => state.overlay);
  const title = useApp(state => state.session?.map.metadata.name ?? '');
  const phase = useApp(state => state.project.phase);
  const fileConflict = useLocalFile().conflict;
  const [size, setSize] = useState(() => ({ left: 272, right: 320, drawer: Math.round(Math.min(260, window.innerHeight * 0.35)) }));
  const input = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const backgroundInput = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null), replacing = useRef('');

  useEffect(() => {
    bridge.openFile = () => input.current?.click();
    bridge.openImages = () => imageInput.current?.click();
    bridge.pickBackground = replace => { if (replace) { replacing.current = replace; replaceInput.current?.click(); } else backgroundInput.current?.click(); };
    void startProjects();
    const key = (event: KeyboardEvent) => {
      // Ctrl+S saves from anywhere, a field included: the field is committed first (it commits when left).
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 's' && !event.isComposing) {
        event.preventDefault();
        if (!store.get().overlay && !localState().conflict) { (document.activeElement as HTMLElement | null)?.blur?.(); runOperation(operation('file.save')!); }
        return;
      }
      // The file conflict dialog is modal too: no shortcut (switching projects included) acts behind it.
      if (event.defaultPrevented || event.isComposing || store.get().overlay || localState().conflict || isEditableTarget(event.target)) return;
      // Arrow keys nudge the selection: 0.1 m, Shift 1 m. Focused controls with their own arrow keys prevent this first.
      const step = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] } as Record<string, [number, number]>)[event.key];
      const onCanvas = event.target === document.body || (event.target instanceof HTMLElement && !!event.target.closest('[data-testid="map-canvas"]'));
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey, adjusting = store.get().adjusting;
      const deleting = event.key === 'Delete' || event.key === 'Backspace';
      // Adjusting a background: arrows move the image, Escape ends measuring and then adjusting, Delete removes the layer
      // (undoable) when the focus is on the canvas or on that layer's own controls; Backspace never does.
      if (adjusting && plain) {
        if (step && onCanvas) { event.preventDefault(); const size = event.shiftKey ? 1 : 0.1; nudgeBackground(step[0] * size, step[1] * size); return; }
        if (event.key === 'Escape') { event.preventDefault(); if (adjusting.measure) cancelMeasure(); else stopAdjust(); return; }
        const onLayer = onCanvas || (event.target instanceof HTMLElement && !!event.target.closest('.inspector, .background-layer.adjusting'));
        if (event.key === 'Delete' && onLayer) { event.preventDefault(); deleteBackground(adjusting.id); return; }
        if (deleting) { event.preventDefault(); notify('删除底图：焦点在画布或底图面板上按 Delete，或点「删除底图」。'); return; }
      }
      // A background selected but not being adjusted is locked: say how to move or delete it instead of a generic refusal.
      const selection = store.get().selection;
      if (!adjusting && plain && selection.length === 1 && selection[0]!.startsWith('backgroundLayers/') && ((step && onCanvas) || deleting)) {
        event.preventDefault();
        notify(deleting ? '底图用「删除底图」按钮删除（属性栏或图层页）。' : '底图平时锁定：点「调整位置与比例」后才能移动。');
        return;
      }
      if (step && onCanvas && store.get().selection.length && plain) {
        event.preventDefault(); const size = event.shiftKey ? 1 : 0.1; nudge(step[0] * size, step[1] * size); return;
      }
      const op = operationForKey(event); if (!op) return;
      event.preventDefault();
      // Escape with nothing to cancel is silent; other unavailable shortcuts explain why.
      if (availability(op) === true || op.keys?.[0] !== 'Escape') runOperation(op);
    };
    const over = (event: DragEvent) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); };
    const drop = (event: DragEvent) => { if (!event.dataTransfer?.files.length) return; event.preventDefault(); void openFiles([...event.dataTransfer.files]); };
    // Saved edits need no warning; only edits not yet stored (pending, failed, in conflict, or in memory) do.
    const leave = (event: BeforeUnloadEvent) => { if (unsavedMap() || projects.state.saving) event.preventDefault(); };
    // Another tab may have saved this project while this one was in the background.
    const focus = () => { checkOtherTabs(); void checkFile(); };
    window.addEventListener('keydown', key); window.addEventListener('dragover', over); window.addEventListener('drop', drop); window.addEventListener('beforeunload', leave); window.addEventListener('focus', focus);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('dragover', over); window.removeEventListener('drop', drop); window.removeEventListener('beforeunload', leave); window.removeEventListener('focus', focus); };
  }, []);

  return <div className="app">
    <header className="topbar">
      <div className="brand"><span className="logo" aria-hidden="true">Y</span><strong>船厂地图</strong></div>
      <MenuBar />
      <div className="doc-title" title={title}>{title || '未打开地图'}</div>
    </header>
    <Toolbar />
    <main className={'workspace' + (panels.right ? ' right-open' : '')} style={{ '--right-width': size.right + 'px' } as CSSProperties}>
      {panels.left ? <>
        <aside className="side left" style={{ width: size.left }}><ProjectPanel /></aside>
        <Splitter label="调整项目内容栏宽度" value={size.left} min={200} max={480} onChange={left => setSize(current => ({ ...current, left }))} />
      </> : <EdgeToggle side="left" />}
      <div className="canvas-area"><CanvasView /><CanvasControls /><ToolOptions /><ConflictBanner /></div>
      {panels.right ? <>
        <Splitter label="调整属性栏宽度" value={size.right} min={260} max={520} invert onChange={right => setSize(current => ({ ...current, right }))} />
        <aside className="side right" style={{ width: size.right }}><Inspector /></aside>
      </> : <EdgeToggle side="right" />}
    </main>
    {panels.drawer && <div className="drawer-wrap" style={{ height: size.drawer }}>
      <Splitter label="调整问题抽屉高度" value={size.drawer} min={120} max={600} invert vertical onChange={drawer => setSize(current => ({ ...current, drawer }))} />
      <IssuesDrawer />
    </div>}
    <StatusBar />
    <Toast />
    {overlay === 'palette' && <CommandPalette />}
    {overlay === 'help' && <HelpPanel />}
    {overlay === 'mapChoice' && <MapChoice />}
    {overlay === 'delete' && <DeleteDialog />}
    {overlay === 'rotate' && <RotateDialog />}
    {overlay === 'upgrade' && <UpgradeDialog />}
    {overlay === 'projects' && <ProjectsDialog />}
    {overlay === 'newMap' && <NewMapDialog />}
    {overlay === 'reloadProject' && <ReloadDialog />}
    {overlay === 'discardMemory' && <DiscardMemoryDialog />}
    {phase === 'failed' && !overlay && <RecoveryDialog />}
    {fileConflict && !overlay && <FileConflictDialog key={fileConflict.token} />}
    {overlay === 'confirmLink' && <ConfirmLinkDialog />}
    <input ref={input} type="file" multiple accept=".json,.zip,.png,.jpg,.jpeg,.webp" hidden data-testid="open-file-input"
      onChange={event => { void openFiles([...event.target.files ?? []]); event.target.value = ''; }} />
    <input ref={imageInput} type="file" multiple accept=".png,.jpg,.jpeg,.webp" hidden data-testid="background-image-input"
      onChange={event => { void openFiles([...event.target.files ?? []]); event.target.value = ''; }} />
    <input ref={backgroundInput} type="file" multiple accept=".png,.jpg,.jpeg,.webp,.json" hidden data-testid="add-background-input"
      onChange={event => { const files = [...event.target.files ?? []].map(pickedFile); event.target.value = ''; if (files.length) void addBackground(files); }} />
    <input ref={replaceInput} type="file" accept=".png,.jpg,.jpeg,.webp" hidden data-testid="replace-background-input"
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void replaceBackground(replacing.current, pickedFile(file)); }} />
  </div>;
}

function EdgeToggle({ side }: { side: 'left' | 'right' }) {
  return <button className={'edge-toggle ' + side} aria-label={side === 'left' ? '展开项目内容栏' : '展开属性栏'}
    onClick={() => store.set(({ panels }) => ({ panels: { ...panels, [side]: true } }))}><Icon name={side === 'left' ? 'chevronRight' : 'chevronLeft'} size={16} /></button>;
}

/** Pointer drag or arrow keys (±16 px) resize the adjacent panel. */
function Splitter({ label, value, min, max, onChange, invert = false, vertical = false }: { label: string; value: number; min: number; max: number; onChange: (next: number) => void; invert?: boolean; vertical?: boolean }) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  const coordinate = (event: React.PointerEvent) => vertical ? event.clientY : event.clientX;
  return <div className={'splitter' + (vertical ? ' vertical' : '')} role="separator" tabIndex={0} aria-label={label}
    aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-valuenow={value} aria-valuemin={min} aria-valuemax={max}
    onPointerDown={event => { drag.current = { start: coordinate(event), value }; event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (drag.current) onChange(clamp(drag.current.value + (coordinate(event) - drag.current.start) * (invert ? -1 : 1))); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onKeyDown={event => {
      // Keys move the splitter along its axis, like the pointer; invert turns that into panel growth.
      const grow = vertical ? { ArrowDown: 16, ArrowUp: -16 } : { ArrowRight: 16, ArrowLeft: -16 };
      const delta = grow[event.key as keyof typeof grow]; if (delta === undefined) return;
      event.preventDefault(); onChange(clamp(value + delta * (invert ? -1 : 1)));
    }} />;
}

function CanvasControls() {
  const hasMap = useApp(state => !!state.session);
  const scale = useApp(state => state.scale);
  if (!hasMap) return null;
  const step = MapRenderer.gridStep(scale);
  return <>
    <div className="canvas-controls" role="group" aria-label="视图">
      <button className="icon-button" aria-label="缩小（-）" title="缩小（-）" onClick={() => runOperation(operation('view.zoomOut'))}><Icon name="minus" /></button>
      <button className="button subtle" title="适应地图（F）" onClick={() => runOperation(operation('view.fit'))}><Icon name="fit" size={16} />适应</button>
      <button className="icon-button" aria-label="放大（=）" title="放大（=）" onClick={() => runOperation(operation('view.zoomIn'))}><Icon name="plus" /></button>
    </div>
    <div className="scale-bar" aria-label={`比例尺 ${step} 米`}>
      <span className="scale-line" style={{ width: step * scale }} /><span className="num">{step} m</span>
      <span className="frame-note">本地米制 XY · Z 向上</span>
      <button className="icon-button small help-button" aria-label="快捷键与显示约定（?）" title="快捷键与显示约定（?）" onClick={() => runOperation(operation('help.shortcuts'))}>?</button>
    </div>
  </>;
}
