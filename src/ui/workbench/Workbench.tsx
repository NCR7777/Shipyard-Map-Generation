import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import type { WorkbenchPreferences } from '../../editor/workbench';
import './workbench.css';

export interface WorkbenchProps {
  header: ReactNode;
  tools: ReactNode;
  context?: ReactNode;
  left: ReactNode;
  right: ReactNode;
  canvas: ReactNode;
  diagnostics: ReactNode;
  messages?: ReactNode;
  status: ReactNode;
  preferences: WorkbenchPreferences;
  onPreferencesChange: (patch: Partial<WorkbenchPreferences>) => void;
  drawerOpen: boolean;
  onDrawerOpenChange: (open: boolean) => void;
}

type ResizeKind = 'leftWidth' | 'rightWidth' | 'drawerHeight';
const limits: Record<ResizeKind, [number, number]> = { leftWidth: [180, 360], rightWidth: [240, 420], drawerHeight: [120, 600] };
const clamp = (kind: ResizeKind, value: number) => Math.max(limits[kind][0], Math.min(limits[kind][1], value));

export function Workbench(props: WorkbenchProps) {
  const { preferences, onPreferencesChange } = props;
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const menus = () => Array.from(headerRef.current?.querySelectorAll<HTMLDetailsElement>('.workbench-menu[open]') ?? []);
    const outside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      for (const menu of menus()) if (target instanceof Node && !menu.contains(target)) menu.open = false;
    };
    const key = (event: KeyboardEvent) => {
      const opened = menus();
      if (!opened.length) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        opened.forEach(menu => { menu.open = false; });
        opened[0]?.querySelector<HTMLElement>('summary')?.focus();
      } else if (event.target instanceof Node && opened.some(menu => menu.contains(event.target as Node))) {
        event.stopPropagation();
        if ((event.ctrlKey || event.metaKey) && ['s', 'z', 'y', 'k'].includes(event.key.toLowerCase())) event.preventDefault();
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  }, []);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1279px)').matches);
  const [resize, setResize] = useState<{ kind: ResizeKind; start: number; initial: number; value: number } | null>(null);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1279px)');
    const changed = () => setCompact(media.matches);
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  useEffect(() => {
    const cancel = () => setResize(null);
    window.addEventListener('blur', cancel);
    return () => window.removeEventListener('blur', cancel);
  }, []);
  const leftClosed = preferences.leftCollapsed === 'auto' ? compact : preferences.leftCollapsed;
  const rightClosed = preferences.rightCollapsed === 'auto' ? compact : preferences.rightCollapsed;
  const dimension = (kind: ResizeKind) => resize?.kind === kind ? resize.value : preferences[kind];
  const style = {
    '--workbench-left': dimension('leftWidth') + 'px', '--workbench-right': dimension('rightWidth') + 'px',
    '--workbench-left-column': leftClosed || compact ? '0px' : dimension('leftWidth') + 'px',
    '--workbench-right-column': rightClosed || compact ? '0px' : dimension('rightWidth') + 'px',
    '--workbench-drawer': dimension('drawerHeight') + 'px',
    '--workbench-message-right': (compact && !rightClosed ? dimension('rightWidth') + 8 : 8) + 'px',
  } as CSSProperties;

  function moved(event: PointerEvent<HTMLDivElement>) {
    if (!resize) return 0;
    const position = resize.kind === 'drawerHeight' ? event.clientY : event.clientX;
    return clamp(resize.kind, resize.initial + (position - resize.start) * (resize.kind === 'leftWidth' ? 1 : -1));
  }
  function handle(kind: ResizeKind, label: string) {
    return <div className={'workbench-resizer workbench-resizer-' + kind} role="separator" tabIndex={0}
      aria-label={label} aria-orientation={kind === 'drawerHeight' ? 'horizontal' : 'vertical'}
      aria-valuemin={limits[kind][0]} aria-valuemax={limits[kind][1]} aria-valuenow={dimension(kind)}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        setResize({ kind, start: kind === 'drawerHeight' ? event.clientY : event.clientX, initial: preferences[kind], value: preferences[kind] });
      }}
      onPointerMove={event => { if (resize?.kind === kind) setResize({ ...resize, value: moved(event) }); }}
      onPointerUp={event => {
        if (resize?.kind !== kind) return;
        onPreferencesChange({ [kind]: moved(event) }); setResize(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => setResize(null)} onLostPointerCapture={() => setResize(null)}
      onKeyDown={event => {
        if (event.key === 'Escape') { setResize(null); return; }
        const increment = kind === 'leftWidth' ? 16 : -16;
        const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? increment
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -increment : 0;
        if (delta) { event.preventDefault(); onPreferencesChange({ [kind]: clamp(kind, preferences[kind] + delta) }); }
      }} />;
  }

  return <main className="app-shell workbench" style={style} data-testid="workbench">
    <header ref={headerRef} className="workbench-header" onClick={event => {
      const target = event.target as HTMLElement;
      const menu = target.closest<HTMLDetailsElement>('.workbench-menu');
      if (menu && target.closest('button:not(:disabled)')) menu.open = false;
    }}>{props.header}</header>
    <nav className="workbench-toolbar" aria-label="地图工具">
      <button className="workbench-panel-toggle" aria-label="切换对象面板" aria-expanded={!leftClosed}
        onClick={() => onPreferencesChange({ leftCollapsed: !leftClosed })}>对象</button>
      <div className="workbench-tools">{props.tools}</div>
      <button className="workbench-panel-toggle" aria-label="切换属性面板" aria-expanded={!rightClosed}
        onClick={() => onPreferencesChange({ rightCollapsed: !rightClosed })}>属性</button>
    </nav>
    {props.context && <div className="workbench-context workbench-context-bar">{props.context}</div>}
    <div className="workspace workbench-workspace">
      <aside className="left-panel sidebar workbench-side workbench-left" aria-label="对象与图层" hidden={leftClosed}>
        <div className="workbench-panel-heading"><strong>对象与图层</strong><button aria-label="收起对象面板" onClick={() => onPreferencesChange({ leftCollapsed: true })}>‹</button></div>
        <div className="workbench-panel-content">{props.left}</div>{handle('leftWidth', '调整对象面板宽度')}
      </aside>
      <section className="center-panel canvas-shell workbench-center" aria-label="地图工作区">
        <div className="workbench-canvas">{props.canvas}</div>
        <div className="workbench-messages" aria-label="工作区提示">{props.messages}</div>
      </section>
      <aside className="right-panel sidebar workbench-side workbench-right" aria-label="对象属性" hidden={rightClosed}>
        <div className="workbench-panel-heading"><strong>对象属性</strong><button aria-label="收起属性面板" onClick={() => onPreferencesChange({ rightCollapsed: true })}>›</button></div>
        <div className="workbench-panel-content">{props.right}</div>{handle('rightWidth', '调整属性面板宽度')}
      </aside>
      <section className="workbench-drawer" aria-label="检查与问题" hidden={!props.drawerOpen}>
        {handle('drawerHeight', '调整检查抽屉高度')}
        <div className="workbench-panel-heading"><strong>检查与问题</strong><button aria-label="收起检查抽屉" onClick={() => props.onDrawerOpenChange(false)}>收起</button></div>
        <div className="workbench-drawer-content">{props.diagnostics}</div>
      </section>
    </div>
    <footer className="app-footer workbench-status"><button aria-expanded={props.drawerOpen} onClick={() => props.onDrawerOpenChange(!props.drawerOpen)}>检查与问题</button>{props.status}</footer>
  </main>;
}
