import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SceneItem, SceneKind } from '../../adapters/contracts';
import type { YardMap } from '../../domain/model';
import { backgroundFrame, type BackgroundTransform } from '../../geometry/backgrounds';
import type { LabelMode } from '../../editor/projectController';
import { bridge, operation, runOperation } from '../ops/registry';
import { deleteBackground, startAdjust, stopAdjust } from '../state/backgroundEdit';
import { backgroundBounds, backgroundLayers } from '../state/backgrounds';
import { frame, frameBounds, sceneOf, select, setDrawing, store, toggleType, useApp, type AppState } from '../state/store';
import { Icon } from './icons';
import { KIND_ICONS, KIND_LABELS, KIND_ORDER, placementText } from './labels';

const ROW = 40;
/** Opens or folds one directory group of the open map. */
function setGroupOpen(kind: SceneKind, open: boolean): void {
  store.set(({ objectGroups, mapEpoch }) => {
    const current = objectGroups.epoch === mapEpoch ? objectGroups.open : [];
    return { objectGroups: { epoch: mapEpoch, open: open ? [...new Set([...current, kind])] : current.filter(other => other !== kind) } };
  });
}
type Row = { type: 'group'; kind: SceneKind; count: number; open: boolean } | { type: 'item'; item: SceneItem };

export function ProjectPanel() {
  const tab = useApp(state => state.leftTab);
  return <section className="panel project-panel" aria-label="项目内容">
    <header className="panel-header"><h2>项目内容</h2>
      <button className="icon-button" aria-label="收起项目内容栏" title="收起" onClick={() => store.set(({ panels }) => ({ panels: { ...panels, left: false } }))}><Icon name="chevronLeft" /></button>
    </header>
    <div className="tabs" role="tablist">
      <button role="tab" id="left-tab-objects" aria-controls="left-panel" aria-selected={tab === 'objects'} onClick={() => store.set({ leftTab: 'objects' })}>对象</button>
      <button role="tab" id="left-tab-layers" aria-controls="left-panel" aria-selected={tab === 'layers'} onClick={() => store.set({ leftTab: 'layers' })}>图层</button>
    </div>
    <div className="tab-panel" role="tabpanel" id="left-panel" aria-labelledby={'left-tab-' + tab}>{tab === 'objects' ? <ObjectList /> : <LayerSettings />}</div>
  </section>;
}

const ObjectList = memo(function ObjectList() {
  const map = useApp(state => state.session?.map ?? null);
  const selection = useApp(state => state.selection);
  const query = useApp(state => state.drawing.objectSearch);
  const hidden = useApp(state => state.drawing.hiddenTypes);
  const locked = useApp(state => state.drawing.lockedTypes);
  // Every group starts folded each time a map is opened or loaded. What the user opens is kept in the store, so it survives
  // switching tabs or folding the panel away. Searching shows every matching group open; folding one then lasts for that search.
  const mapEpoch = useApp(state => state.mapEpoch), groups = useApp(state => state.objectGroups);
  const opened = useMemo(() => new Set(groups.epoch === mapEpoch ? groups.open : []), [groups, mapEpoch]);
  const [searchFolded, setSearchFolded] = useState<{ query: string; kinds: ReadonlySet<SceneKind> }>({ query: '', kinds: new Set() });
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = scroller.current; if (!element) return;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight)); observer.observe(element);
    return () => observer.disconnect();
  }, [map]);

  const scene = map ? sceneOf(map) : null;
  const rows = useMemo(() => {
    if (!scene) return [] as Row[];
    const needle = query.trim().toLowerCase(), byKind = new Map<SceneKind, SceneItem[]>();
    for (const item of scene.items) {
      if (needle && !(item.name.toLowerCase().includes(needle) || item.id.toLowerCase().includes(needle) || item.jsonPath.toLowerCase().includes(needle))) continue;
      const list = byKind.get(item.kind); if (list) list.push(item); else byKind.set(item.kind, [item]);
    }
    const out: Row[] = [];
    for (const kind of KIND_ORDER) {
      const items = byKind.get(kind); if (!items) continue;
      const open = needle ? !(searchFolded.query === query && searchFolded.kinds.has(kind)) : opened.has(kind);
      out.push({ type: 'group', kind, count: items.length, open });
      if (open) for (const item of items) out.push({ type: 'item', item });
    }
    return out;
  }, [scene, query, opened, searchFolded]);
  const selected = useMemo(() => new Set(selection), [selection]);
  const toggle = (kind: SceneKind, open: boolean) => {
    if (query.trim()) {
      setSearchFolded(current => { const kinds = new Set(current.query === query ? current.kinds : []); if (open) kinds.add(kind); else kinds.delete(kind); return { query, kinds }; });
    } else setGroupOpen(kind, !open);
  };
  // One object selected (on the canvas, from an issue, from the list or a search): its group opens and its row scrolls just
  // into view, once per selection. While searching the matching rows are shown anyway; the reveal waits until the search is
  // cleared, so the object is found again in the full list.
  const revealed = useRef<string | null>(null);
  useLayoutEffect(() => {
    const key = selection.length === 1 ? selection[0]! : null;
    if (!key) { revealed.current = null; return; }
    if (revealed.current === key || query.trim()) return;
    const kind = key.slice(0, key.indexOf('/')) as SceneKind;
    if (KIND_ORDER.includes(kind) && !opened.has(kind)) { setGroupOpen(kind, true); return; }
    const index = rows.findIndex(row => row.type === 'item' && row.item.key === key), element = scroller.current;
    if (index < 0 || !element) return;
    revealed.current = key;
    // Nearest edge only: a row clicked at the list's bottom edge moves up a little and stays under the pointer.
    const top = index * ROW;
    if (top < element.scrollTop) element.scrollTop = top;
    else if (top + ROW > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW - element.clientHeight;
  }, [selection, rows, query]);

  if (!scene) return <p className="panel-empty">打开地图后，这里按类型列出全部对象。</p>;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 6), last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 6);
  const choose = (item: SceneItem, shift: boolean) => {
    if (shift) { select([item.key], 'toggle'); return; }
    select([item.key]);
    if (item.status === 'geometry') frame([item.key]);
    store.set(({ panels }) => ({ panels: { ...panels, right: true } }));
  };
  return <>
    <label className="search-field"><Icon name="search" size={16} />
      <input type="search" value={query} placeholder="搜索名称、编号或路径" aria-label="搜索对象" maxLength={200}
        onChange={event => setDrawing({ objectSearch: event.target.value })} />
    </label>
    <div className="object-scroller" ref={scroller} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} role="list" aria-label="对象目录">
      <div style={{ height: rows.length * ROW, position: 'relative' }}>
        {rows.slice(first, last).map((row, offset) => {
          const top = (first + offset) * ROW;
          if (row.type === 'group') return <div key={'g/' + row.kind} role="listitem" className="object-group-row" style={{ top }}>
            <button className="object-group" aria-expanded={row.open} onClick={() => toggle(row.kind, row.open)}>
              <Icon name={row.open ? 'chevronDown' : 'chevronRight'} size={14} /><span>{KIND_LABELS[row.kind]}</span><span className="count">{row.count}</span>
            </button>
          </div>;
          const { item } = row, badges = [hidden.includes(item.kind) && '隐藏', locked.includes(item.kind) && '锁定',
            item.status === 'logical' && '逻辑', item.status === 'unsupported' && '未支持'].filter(Boolean) as string[];
          return <div key={item.key} role="listitem" className={'object-row' + (selected.has(item.key) ? ' selected' : '')} style={{ top }}>
            <button className="object-main" title={item.reason || item.jsonPath} onClick={event => choose(item, event.shiftKey)}>
              <span className="object-icon"><Icon name={KIND_ICONS[item.kind] ?? 'list'} size={16} /></span>
              <span className="object-text"><span className="object-name">{item.name || item.id}</span><span className="object-id">{item.id}</span></span>
              {badges.map(badge => <span key={badge} className="badge">{badge}</span>)}
            </button>
            {item.status === 'geometry' && <button className="icon-button small" aria-label={'定位 ' + (item.name || item.id)} title="只定位，不改变选择" onClick={() => frame([item.key])}><Icon name="target" size={15} /></button>}
          </div>;
        })}
      </div>
    </div>
  </>;
});

const LABEL_MODES: { value: LabelMode; label: string }[] = [
  { value: 'auto', label: '自动分级' }, { value: 'focus', label: '仅选中对象' }, { value: 'off', label: '关闭标签' }, { value: 'debug_all', label: '全部显示（允许重叠）' },
];

const LayerSettings = memo(function LayerSettings() {
  const map = useApp(state => state.session?.map ?? null);
  const drawing = useApp(state => state.drawing);
  const counts = useMemo(() => {
    const result = new Map<SceneKind, number>();
    if (map) for (const item of sceneOf(map).items) result.set(item.kind, (result.get(item.kind) ?? 0) + 1);
    return result;
  }, [map]);
  const percent = (value: number) => Math.round(value * 100);
  return <div className="layer-settings">
    {map && <BackgroundSettings map={map} />}
    <table className="layer-table">
      <thead><tr><th>类型</th><th>数量</th><th>显示</th><th>锁定</th></tr></thead>
      <tbody>{KIND_ORDER.filter(kind => counts.get(kind)).map(kind => {
        const isHidden = drawing.hiddenTypes.includes(kind), isLocked = drawing.lockedTypes.includes(kind);
        return <tr key={kind}><td>{KIND_LABELS[kind]}</td><td className="num">{counts.get(kind)}</td>
          <td><button className="icon-button small" aria-pressed={!isHidden} aria-label={(isHidden ? '显示' : '隐藏') + KIND_LABELS[kind]} onClick={() => toggleType('hiddenTypes', kind)}><Icon name={isHidden ? 'eyeOff' : 'eye'} size={16} /></button></td>
          <td><button className="icon-button small" aria-pressed={isLocked} aria-label={(isLocked ? '解锁' : '锁定') + KIND_LABELS[kind]} onClick={() => toggleType('lockedTypes', kind)}><Icon name={isLocked ? 'lock' : 'unlock'} size={16} /></button></td></tr>;
      })}</tbody>
    </table>
    {!map && <p className="panel-empty">打开地图后可按类型显示或锁定。</p>}
    <fieldset className="settings-group"><legend>显示</legend>
      <label>标签<select value={drawing.labelMode} onChange={event => setDrawing({ labelMode: event.target.value as LabelMode })}>
        {LABEL_MODES.map(mode => <option key={mode.value} value={mode.value}>{mode.label}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={drawing.showRoadBands} onChange={event => setDrawing({ showRoadBands: event.target.checked })} />道路按宽度显示路带</label>
      <label className="check"><input type="checkbox" checked={drawing.showRoadCenterlines} onChange={event => setDrawing({ showRoadCenterlines: event.target.checked })} />显示道路中心线</label>
      <label className="check"><input type="checkbox" checked={drawing.showOrdinaryNodes} onChange={event => setDrawing({ showOrdinaryNodes: event.target.checked })} />显示普通节点</label>
    </fieldset>
    <fieldset className="settings-group"><legend>填充不透明度</legend>
      {([['roadFillOpacity', '道路'], ['facilityFillOpacity', '建筑'], ['zoneFillOpacity', '区域']] as const).map(([field, label]) =>
        <label key={field} className="slider">{label}<input type="range" min={0} max={100} value={percent(drawing[field])}
          onChange={event => setDrawing({ [field]: Number(event.target.value) / 100 })} /><span className="num">{percent(drawing[field])}%</span></label>)}
    </fieldset>
  </div>;
});

const RASTER_STATUS = { loading: ['载入中', ''], ready: ['就绪', 'ok'], missing: ['缺图', 'warn'], error: ['错误', 'error'] } as const;
const setBackgroundView = (patch: (view: AppState['backgroundView']) => Partial<AppState['backgroundView']>) =>
  store.set(({ backgroundView }) => ({ backgroundView: { ...backgroundView, ...patch(backgroundView) } }));

/** Background layers: each one's image state, visibility and opacity, and what can be done with it: adjust, replace, delete.
 *  Visibility and opacity are display settings (saved with the project's view); the other actions change the map. */
function BackgroundSettings({ map }: { map: YardMap }) {
  const rasters = useApp(state => state.rasters), view = useApp(state => state.backgroundView), adjusting = useApp(state => state.adjusting?.id ?? null);
  const layers = useMemo(() => backgroundLayers(map), [map]);
  const add = <button className="button" onClick={() => runOperation(operation('file.addBackground'))}><Icon name="image" size={16} />添加底图…</button>;
  if (!layers.length) return <fieldset className="settings-group backgrounds"><legend>底图</legend>
    <p className="background-note">没有底图。可以把一张影像或图纸加为底图，校准比例后在上面描图。</p>{add}
  </fieldset>;
  // ../map warns about the same image placed twice; both copies are still drawn, as the map says.
  const place = (info: typeof layers[number]) => info.layer.assetId + JSON.stringify(info.layer.imageToWorld);
  const names = layers.map(info => info.layer.name || info.id);
  return <fieldset className="settings-group backgrounds"><legend>底图</legend>
    {layers.map((info, index) => {
      const supported = info.support.supported, asset = info.asset, earlier = layers.slice(0, index).find(other => place(other) === place(info));
      const name = names.filter(other => other === names[index]).length > 1 ? `${names[index]}（第 ${index + 1} 层）` : names[index]!;
      const raster = supported ? rasters[asset!.sha256] : undefined, hidden = view.hidden.includes(info.id), percent = Math.round((view.opacity[info.id] ?? 1) * 100);
      const [status, tone] = supported ? RASTER_STATUS[raster?.status ?? 'missing'] : ['不支持', 'error'];
      const active = adjusting === info.id;
      return <div key={info.id} className={'background-layer' + (active ? ' adjusting' : '')} role="group" aria-label={'底图 ' + name}>
        <div className="background-head">
          <span className="background-name" title={name}>{name}</span><span className={'badge ' + tone}>{status}</span>
          <button className="icon-button small" aria-pressed={!hidden} aria-label={(hidden ? '显示' : '隐藏') + '底图'} title={hidden ? '显示底图' : '隐藏底图'}
            onClick={() => setBackgroundView(current => ({ hidden: hidden ? current.hidden.filter(id => id !== info.id) : [...current.hidden, info.id] }))}><Icon name={hidden ? 'eyeOff' : 'eye'} size={16} /></button>
          <button className="icon-button small" aria-label="适应底图" title="适应底图" disabled={!supported}
            onClick={() => { const bounds = backgroundBounds(map, [info.id]); if (bounds) frameBounds(bounds); }}><Icon name="fit" size={16} /></button>
          <button className="icon-button small" aria-pressed={active} aria-label="调整底图" title={active ? '正在调整；再点一次或按 Esc 结束' : '调整位置与比例'} disabled={!supported}
            onClick={() => { if (active) stopAdjust(); else startAdjust(info.id); }}><Icon name="transform" size={16} /></button>
        </div>
        {supported && <p className="background-note">{placementText(info.layer.method, info.layer.controlPoints.length)} · {asset!.widthPx}×{asset!.heightPx} 像素 · {resolution(info.layer.imageToWorld, asset!.widthPx!, asset!.heightPx!)}</p>}
        {!supported && <p className="background-note">{info.support.reasons.join(' ')}</p>}
        {earlier && <p className="background-note warn">与第 {layers.indexOf(earlier) + 1} 层是同一图片、同一位置的重复图层，会叠画两次；可删除其中一层。</p>}
        {supported && (raster?.status === 'missing' || raster?.status === 'error' || !raster) && <div className="background-note">
          <p>{raster?.message ? raster.message + ' ' : '本浏览器还没有这张图片。'}需要原图：{asset!.widthPx}×{asset!.heightPx}，SHA-256 {asset!.sha256.slice(0, 12)}…（按内容匹配，文件名不限）。</p>
          <button className="button" onClick={() => runOperation(operation('file.backgroundImages'))}>选择图片…</button>
        </div>}
        {supported && <label className="slider">不透明度<input type="range" min={0} max={100} value={percent} aria-label={'底图不透明度'}
          onChange={event => { const value = Number(event.target.value) / 100; setBackgroundView(current => ({ opacity: { ...current.opacity, [info.id]: value } })); }} /><span className="num">{percent}%</span></label>}
        {supported && <div className="background-actions">
          <button className="link" onClick={() => bridge.pickBackground(info.id)}><Icon name="replace" size={14} />替换图片…</button>
          <button className="link danger" onClick={() => deleteBackground(info.id)}><Icon name="trash" size={14} />删除底图</button>
        </div>}
      </div>;
    })}
    <label className="check"><input type="checkbox" checked={view.comparison} onChange={event => { const comparison = event.target.checked; setBackgroundView(() => ({ comparison })); }} />影像对照（进一步淡化填充）</label>
    {add}
  </fieldset>;
}
/** Metres per image pixel, one figure when both axes agree. */
function resolution(t: BackgroundTransform, width: number, height: number): string {
  try {
    const frame = backgroundFrame(t, width, height), x = Number(frame.scaleXMPerPx.toPrecision(4)), y = Number(frame.scaleYMPerPx.toPrecision(4));
    return x === y ? `${x} m/像素` : `横 ${x} / 纵 ${y} m/像素`;
  } catch { return '—'; }
}
