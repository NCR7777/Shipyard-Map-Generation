import { useEffect, useRef, useState } from 'react';
import { MapRenderer } from '../canvas/renderer';
import { useCursor } from '../canvas/CanvasView';
import { MENUS, OPERATIONS, availability, operation, runOperation, type MenuId, type Operation } from '../ops/registry';
import { transactionLabel } from '../state/edit';
import { fileStatus, useLocalFile } from '../state/localFile';
import { saveStatus, useProjectState } from '../state/project';
import { issuesOf, store, useApp } from '../state/store';
import { Icon, type IconName } from './icons';

export const shortcut = (op: Operation) => op.keys?.[0]?.replace('Escape', 'Esc');

export function MenuBar() {
  const [open, setOpen] = useState<MenuId | null>(null);
  const state = useApp(current => current);
  const bar = useRef<HTMLElement>(null);
  const focusFirst = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) { focusFirst.current = false; bar.current?.querySelector<HTMLElement>('[role=menuitem]')?.focus(); }
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) setOpen(null); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keyDown(event: React.KeyboardEvent) {
    const items = [...(bar.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      bar.current?.querySelector<HTMLElement>(`[data-menu="${open}"]`)?.focus();
      setOpen(null);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) return;
      items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if ((event.key === 'ArrowRight' || event.key === 'ArrowLeft') && open) {
      const at = MENUS.findIndex(menu => menu.id === open);
      focusFirst.current = true;
      setOpen(MENUS[(at + (event.key === 'ArrowRight' ? 1 : -1) + MENUS.length) % MENUS.length]!.id);
    }
  }
  return <nav className="menubar" ref={bar} onKeyDown={keyDown} aria-label="主菜单">
    {MENUS.map(menu => <div key={menu.id} className="menu">
      <button className="menu-trigger" data-menu={menu.id} aria-haspopup="menu" aria-expanded={open === menu.id}
        onClick={() => setOpen(open === menu.id ? null : menu.id)} onPointerEnter={() => open && setOpen(menu.id)}>{menu.label}</button>
      {open === menu.id && <div className="menu-popover" role="menu" aria-label={menu.label}>
        {OPERATIONS.filter(op => op.menu === menu.id).map(op => {
          // Unavailable items stay focusable so the reason can be read; activating one reports it.
          const available = availability(op, state);
          return <button key={op.id} role="menuitem" aria-disabled={available !== true} onClick={() => { setOpen(null); runOperation(op); }}>
            <span className="menu-label">{op.label}{available !== true && <small className="reason">{available}</small>}</span>
            {shortcut(op) && <kbd>{shortcut(op)}</kbd>}
          </button>;
        })}
      </div>}
    </div>)}
  </nav>;
}

const TOOL_ICONS: Record<string, IconName> = {
  'tool.select': 'select', 'tool.pan': 'pan', 'tool.node': 'node', 'tool.road': 'road', 'tool.curve': 'curve',
  'tool.building': 'building', 'tool.zone': 'zone', 'tool.entrance': 'point', 'tool.service': 'service', 'tool.measure': 'measure',
};
export function Toolbar() {
  const tool = useApp(state => state.tool);
  const map = useApp(state => state.session?.map ?? null);
  const panels = useApp(state => state.panels);
  const errors = map ? issuesOf(map).filter(issue => issue.severity === 'error').length : 0, warnings = map ? issuesOf(map).length - errors : 0;
  return <div className="toolbar" role="toolbar" aria-label="工具">
    {OPERATIONS.filter(op => op.tool).map(op => <button key={op.id} className="tool-button tool" aria-pressed={tool === op.tool}
      title={`${op.label}（${shortcut(op)}）`} onClick={() => runOperation(op)}>
      <Icon name={TOOL_ICONS[op.id] ?? 'select'} /><span>{op.label}</span><kbd>{shortcut(op)}</kbd>
    </button>)}
    <span className="toolbar-divider" />
    <HistoryButton id="edit.undo" icon="undo" />
    <HistoryButton id="edit.redo" icon="redo" />
    <span className="spacer" />
    <button className="tool-button" onClick={() => runOperation(operation('help.palette'))} title="命令与对象搜索（Ctrl+K）"><Icon name="search" /><span>搜索</span><kbd>Ctrl+K</kbd></button>
    <button className={'tool-button' + (errors ? ' has-errors' : '')} aria-pressed={panels.drawer} title="检查与问题（Ctrl+J）" onClick={() => runOperation(operation('view.toggleDrawer'))}>
      <Icon name={errors ? 'alert' : 'info'} /><span>检查</span>
      {map && (errors ? <span className="count error">错误 {errors}</span> : <span className="count">提示 {warnings}</span>)}
    </button>
  </div>;
}

/** Undo and redo name the step they would take. */
function HistoryButton({ id, icon }: { id: 'edit.undo' | 'edit.redo'; icon: 'undo' | 'redo' }) {
  const session = useApp(state => state.session), op = operation(id);
  const step = session && (id === 'edit.undo' ? session.past.at(-1) : session.future.at(-1));
  const title = step ? `${op.label}：${transactionLabel(step)}（${shortcut(op)}）` : `${op.label}（${shortcut(op)}）：${id === 'edit.undo' ? '没有可撤销的操作' : '没有可重做的操作'}`;
  return <button className="icon-button" aria-label={op.label} title={title} aria-disabled={!step} onClick={() => runOperation(op)}><Icon name={icon} /></button>;
}

const TOOL_HINTS: Record<string, string> = {
  select: '点击选择 · Shift 增减 · 空白处拖动框选（左→右包含，右→左相交）· 拖动已选对象移动，Alt 拖动复制 · 拖动控制柄改形状 · 方向键微移 0.1 m（Shift 1 m）· Space 或中键平移',
  pan: '拖动平移 · 滚轮以指针为中心缩放 · V 回到选择',
  node: '点击放置节点 · Esc 回到选择',
  road: '点击放置折点 · 点到节点或道路即接上 · Alt 不接路 · Shift 水平或竖直 · Enter 或双击完成 · Backspace 撤回一点 · Esc 取消',
  curve: '点终点，再点经过点 · 按 R 接直线段 · Enter 完成 · Esc 取消',
  entrance: '点选建筑外边界添加入口 · 靠近角点取角点 · Enter 或 Esc 结束',
  service: '点选入口：作业点在入口节点上（节点代理）· 点选建筑或区域内部：草稿作业点 · Enter 或 Esc 结束',
  building: '两点矩形可直接拖出 · 多边形点回起点完成 · Shift 水平或竖直 · Esc 取消',
  zone: '两点矩形可直接拖出 · 多边形点回起点完成 · Shift 水平或竖直 · Esc 取消',
  measure: '点击测量 · Enter 或双击结束 · Esc 清除 · 不改动地图',
};
export function StatusBar() {
  const tool = useApp(state => state.tool);
  const selection = useApp(state => state.selection.length);
  const scale = useApp(state => state.scale);
  const session = useApp(state => state.session);
  const fileName = useApp(state => state.fileName);
  const cursor = useCursor();
  const step = MapRenderer.gridStep(scale);
  const project = useApp(state => state.project);
  const status = saveStatus({ session, project }, useProjectState());
  const file = fileStatus(session?.map ?? null, useLocalFile());
  return <footer className="statusbar">
    <span className="hint">{TOOL_HINTS[tool]}</span>
    <span className="spacer" />
    {cursor && <span className="num">X {cursor[0].toFixed(2)} · Y {cursor[1].toFixed(2)} m</span>}
    {status && <span className={'save-status ' + status.tone} data-testid="save-status">{status.text}</span>}
    {file && <span className={'save-status ' + file.tone} data-testid="file-status">{file.text}</span>}
    {session && <span>已选 <b className="num">{selection}</b></span>}
    {session && <span className="num" title="当前比例与网格间距">{scale >= 1 ? scale.toFixed(1) : scale.toPrecision(2)} px/m · 网格 {step} m</span>}
    {session && <span className="file" title={fileName}>{fileName} · {session.map.schemaVersion}</span>}
  </footer>;
}

export function Toast() {
  const message = useApp(state => state.message);
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => { if (store.get().message === message) store.set({ message: null }); }, message.tone === 'error' ? 9000 : 5000);
    return () => window.clearTimeout(timer);
  }, [message]);
  const body = message && <div className={'toast ' + message.tone}>
    <Icon name={message.tone === 'error' ? 'alert' : 'info'} size={16} /><span>{message.text}</span>
    <button className="icon-button small" aria-label="关闭提示" onClick={() => store.set({ message: null })}><Icon name="close" size={14} /></button>
  </div>;
  // Live regions must exist before their content arrives, or screen readers may skip the announcement.
  return <div className="toast-region">
    <div role="status">{message?.tone !== 'error' && body}</div>
    <div role="alert">{message?.tone === 'error' && body}</div>
  </div>;
}
