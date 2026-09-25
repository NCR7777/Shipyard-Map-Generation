import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SceneItem } from '../../adapters/contracts';
import { MENUS, OPERATIONS, availability, runOperation, type Operation } from '../ops/registry';
import { frame, sceneOf, select, store, useApp } from '../state/store';
import { shortcut } from './Chrome';
import { Icon } from './icons';
import { KIND_LABELS } from './labels';
import { findItems } from './search';

/** Focus trap + Escape + focus return, shared by every overlay. */
export function Dialog({ label, onClose, className, children }: { label: string; onClose: () => void; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])];
    // A disabled autofocus target cannot take focus; the dialog itself then does, so Escape and Tab still work.
    const target = ref.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ?? focusables()[0] ?? ref.current;
    target?.focus({ preventScroll: true });
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // Escape, or the palette shortcut pressed again, closes instead of reaching the browser.
      if (event.key === 'Escape' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k')) { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusables(), first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const element = ref.current; element?.addEventListener('keydown', key);
    return () => { element?.removeEventListener('keydown', key); previous?.focus({ preventScroll: true }); };
  }, []);
  return <div className="overlay-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className={'overlay ' + className} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>{children}</div>
  </div>;
}

type Result = { type: 'op'; op: Operation } | { type: 'item'; item: SceneItem };
const closeOverlay = () => store.set({ overlay: null });

export function CommandPalette() {
  const map = useApp(state => state.session?.map ?? null);
  const state = useApp(current => current);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const results = useMemo((): Result[] => {
    const needle = query.trim().toLowerCase();
    const ops: Result[] = OPERATIONS.filter(op => !needle || op.label.toLowerCase().includes(needle) || op.id.includes(needle) || op.keys?.some(key => key.toLowerCase() === needle))
      .map(op => ({ type: 'op', op }));
    const items: Result[] = !map ? [] : findItems(sceneOf(map).items, needle).map(item => ({ type: 'item', item }));
    return [...ops, ...items];
  }, [query, map]);
  const choose = (result: Result | undefined) => {
    if (!result) return;
    closeOverlay();
    if (result.type === 'op') { runOperation(result.op); return; }
    select([result.item.key]);
    if (result.item.status === 'geometry') frame([result.item.key]);
    store.set(({ panels }) => ({ panels: { ...panels, right: true } }));
  };
  return <Dialog label="命令与对象搜索" onClose={closeOverlay} className="palette">
    <label className="palette-input"><Icon name="search" />
      <input data-autofocus value={query} placeholder="输入功能名称（如「适应」）或对象名称、编号…" aria-label="搜索命令或对象"
        onChange={event => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % Math.max(1, results.length)); }
          else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); choose(results[active]); }
        }} />
    </label>
    <ul className="palette-results" role="listbox" aria-label="搜索结果">
      {results.map((result, index) => {
        const available = result.type === 'op' ? availability(result.op, state) : true;
        return <li key={result.type === 'op' ? result.op.id : result.item.key} role="option" aria-selected={index === active}
          className={index === active ? 'active' : ''} onPointerEnter={() => setActive(index)} onClick={() => choose(result)}>
          {result.type === 'op'
            ? <><span className="kind">命令</span><span className="label">{result.op.label}{available !== true && <small className="reason">{available}</small>}</span>{shortcut(result.op) && <kbd>{shortcut(result.op)}</kbd>}</>
            : <><span className="kind">{KIND_LABELS[result.item.kind]}</span><span className="label">{result.item.name || result.item.id}<small className="muted"> {result.item.id}</small></span></>}
        </li>;
      })}
      {!results.length && <li className="empty">没有匹配的命令或对象</li>}
    </ul>
  </Dialog>;
}

const GESTURES: [string, string][] = [
  ['滚轮', '以指针为中心缩放'], ['中键拖动 / 按住 Space 拖动', '临时平移，松开后回到原工具'], ['点击', '选择对象；点空白处取消选择'],
  ['Shift+点击', '增减选择'], ['空白处拖动', '框选：左→右完整包含，右→左相交'], ['Alt+点击', '在重叠对象之间循环'],
  ['拖动已选对象', '移动（Shift 保持水平或竖直）；建筑、区域、入口、作业点可直接拖；节点和道路要先点选，从未选的节点或道路上拖动是框选'],
  ['Alt+拖动', '在松开处复制'], ['方向键', '微移 0.1 m，Shift 为 1 m；连续微移合并为一步撤销'],
  ['选中一个建筑、区域或道路', '出现控制柄（对象在屏幕上小于 24 px 时不显示，放大即可）；拖动控制柄改形状，松开为一步撤销，Esc 取消；网格开启时顶点、角点、折点落在网格上（Alt 暂不吸附）；Shift+点击控制柄仍是增减选择'],
  ['角点（方块）', '矩形约束下改尺寸，对角固定；属性栏的「轮廓编辑」可切到自由多边形'],
  ['顶点 / 边中点', '拖动顶点移动；拖动边中点插入顶点；Alt+点击顶点删除（至少保留三个）'],
  ['道路控制柄', '黄色折点移动；橙色菱形拖动成曲线，双击拉直；蓝色调切向；绿色宽度柄记为人工影像估计宽度'],
  ['属性栏的输入框', 'Enter 或离开输入框即提交，每个字段一步撤销；Esc 恢复原值；输入法组字时的 Enter 不提交'],
  ['属性栏的物理参数', '选「已声明」后输入数值；清空已声明的数值表示改为未知；新数值记为设计假设，可在「依据」里改选已有来源；单位只影响显示'],
];
const CONVENTIONS = [
  '打开或新建的地图作为「浏览器工程」保存在本浏览器中：修改后自动保存草稿，Ctrl+S 另存检查点；刷新后恢复地图、视图与显示设置（撤销历史不保存）。清除浏览器数据会删除工程，重要的地图请导出副本。',
  '同一工程在两个标签页里编辑时，后保存的一方会停止自动保存并提示，可另存为恢复副本或载入浏览器中的版本。',
  '「打开并关联本地 JSON…」打开的地图与磁盘上的文件关联：保存（Ctrl+S）同时写回该文件；文件在别处被改过时不会覆盖，而是询问。刷新页面后，需用「关联原文件…」重新选择一次同一个文件才能写回（浏览器限制，文件句柄不跨页面保存）。',
  '颜色、图层隐藏与锁定只影响显示和编辑权限，不代表能否通行或资源占用。',
  '道路带按声明宽度绘制；宽度未知的道路只画虚线中心线，未知不等于 0。',
  '「入」为入口，「作」为作业点；同一节点上的多个身份合并为一个标记。',
  '检查结果是草稿校验，不代表现场运输安全。',
];
export function HelpPanel() {
  return <Dialog label="快捷键与显示约定" onClose={closeOverlay} className="help">
    <header className="overlay-header"><h2>快捷键与显示约定</h2><button className="icon-button" data-autofocus aria-label="关闭" onClick={closeOverlay}><Icon name="close" /></button></header>
    <div className="help-grid">
      {MENUS.map(menu => {
        const ops = OPERATIONS.filter(op => op.menu === menu.id && op.keys); if (!ops.length) return null;
        return <section key={menu.id}><h3>{menu.label}</h3><dl>{ops.map(op => <div key={op.id}><dt><kbd>{shortcut(op)}</kbd></dt><dd>{op.label}</dd></div>)}</dl></section>;
      })}
      <section><h3>工具</h3><dl>{OPERATIONS.filter(op => op.tool).map(op => <div key={op.id}><dt><kbd>{shortcut(op)}</kbd></dt><dd>{op.label}</dd></div>)}</dl></section>
      <section><h3>画布</h3><dl>{GESTURES.map(([key, text]) => <div key={key}><dt>{key}</dt><dd>{text}</dd></div>)}</dl></section>
    </div>
    <section className="conventions"><h3>显示约定</h3><ul>{CONVENTIONS.map(text => <li key={text}>{text}</li>)}</ul></section>
    <p className="muted">快捷键在输入框、下拉框和对话框中不生效。</p>
  </Dialog>;
}

/** A package or selection with several maps: the user picks which one to open. */
export function MapChoice() {
  const options = useApp(state => state.mapChoice) ?? [];
  const close = () => store.set({ overlay: null, mapChoice: null });
  return <Dialog label="选择要打开的地图" onClose={close} className="help">
    <header className="overlay-header"><h2>选择要打开的地图</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    <p className="muted">所选内容里有 {options.length} 张地图，一次打开一张。一起选择或包内的图片会按内容自动匹配所选地图的底图。</p>
    <ul className="choice-list">{options.map((option, index) => <li key={option.label}>
      <button className="button" {...(index === 0 ? { 'data-autofocus': true } : {})} onClick={option.open}>
        <span className="choice-label">{option.label}</span><span className="choice-detail">{option.detail}</span></button></li>)}</ul>
  </Dialog>;
}
