import { memo, useState } from 'react';
import { SCENE_KINDS, type SceneItem, type SceneKind } from '../adapters/contracts';
import type { DrawingConfig } from '../editor/projectController';
import type { YardMap } from '../domain/model';
import { itemValue } from '../compiler/catalog';

export const sceneNames: Record<SceneKind, string> = { nodes: '节点', roads: '道路', facilities: '设施', zones: '区域', accessPoints: '入口', servicePoints: '服务点', siteBoundary: '厂界', junctions: '路口', resources: '资源', slots: '储位/停车位', movements: '转向', sources: '来源', assets: '资产', backgroundLayers: '底图', extensions: '扩展' };
interface Props {
  items: SceneItem[]; drawing: DrawingConfig; disabled: boolean; domainReadonly: boolean;
  onDrawing: (patch: Partial<DrawingConfig>) => void;
  isSelected: (item: SceneItem) => boolean;
  onSelect: (item: SceneItem, additive: boolean) => void;
  onLocate: (item: SceneItem) => void;
}
export function ObjectDirectory(props: Props) {
  const { items, drawing } = props;
  const search = drawing.objectSearch.trim().toLocaleLowerCase();
  // Folded groups skip their rows; a search always shows its matches. Turn movements (often thousands of logical rows) start folded.
  const [folded, setFolded] = useState<ReadonlySet<SceneKind>>(() => new Set(['movements']));
  const hidden = items.filter(i => drawing.hiddenTypes.includes(i.kind) && i.status === 'geometry').length;
  const geometry = items.filter(i => i.status === 'geometry').length;
  return <>
    <details className="layer-controls"><summary>基础图层与标签</summary>
      <label className="field-label">标签模式<select data-testid="label-mode" aria-label="标签模式" value={drawing.labelMode} disabled={props.disabled} onChange={e => props.onDrawing({ labelMode: e.target.value as DrawingConfig['labelMode'] })}><option value="auto">自动分级</option><option value="focus">仅关注对象</option><option value="off">关闭标签与悬停详情</option><option value="debug_all">排查当前视口全部标签</option></select></label>{drawing.labelMode === 'debug_all' && <p role="status">排查模式允许标签重叠；不代表默认显示效果。</p>}
      {SCENE_KINDS.map(kind => <div className="layer-row" key={kind}><span>{sceneNames[kind]}</span>
        <label><input type="checkbox" aria-label={'显示' + sceneNames[kind]} data-testid={'layer-visible-' + kind} disabled={props.disabled} checked={!drawing.hiddenTypes.includes(kind)} onChange={e => props.onDrawing({ hiddenTypes: e.target.checked ? drawing.hiddenTypes.filter(k => k !== kind) : [...drawing.hiddenTypes, kind] })}/>显示</label>
        <label><input type="checkbox" aria-label={'锁定' + sceneNames[kind]} data-testid={'layer-locked-' + kind} disabled={props.disabled} checked={drawing.lockedTypes.includes(kind)} onChange={e => props.onDrawing({ lockedTypes: e.target.checked ? [...drawing.lockedTypes, kind] : drawing.lockedTypes.filter(k => k !== kind) })}/>锁定</label>
      </div>)}
    </details>
    <label className="field-label">搜索对象<input data-testid="object-search" aria-label="搜索对象" maxLength={200} value={drawing.objectSearch} disabled={props.disabled} onChange={e => props.onDrawing({ objectSearch: e.target.value })}/></label>
    <p className="field-note" data-testid="directory-summary">目录 {items.length} · 可见几何 {geometry - hidden} · 隐藏几何 {hidden} · 逻辑对象 {items.filter(i => i.status === 'logical').length} · 未支持 {items.filter(i => i.status === 'unsupported').length} · 独立只读 {props.domainReadonly ? items.length : items.filter(i => !['nodes', 'roads', 'facilities', 'zones', 'accessPoints', 'servicePoints'].includes(i.kind)).length} · 图层锁定 {items.filter(i => drawing.lockedTypes.includes(i.kind)).length}</p>
    <div className="object-list">{SCENE_KINDS.map(kind => {
      const all = items.filter(item => item.kind === kind);
      const matches = all.filter(item => !search || [item.id, item.name, item.jsonPath].some(value => value.toLocaleLowerCase().includes(search)));
      return <div className="spatial-object-group" key={kind}>
        <button className="object-group-label" aria-expanded={!folded.has(kind)} onClick={() => setFolded(current => { const next = new Set(current); if (!next.delete(kind)) next.add(kind); return next; })}>
          <span className="object-group-caret">{folded.has(kind) && !search ? '▸' : '▾'}</span>{sceneNames[kind]} <span data-testid={'scene-count-' + kind}>{all.length}</span>{['facilities', 'zones', 'accessPoints', 'servicePoints'].includes(kind) && <span className="sr-only" data-testid={kind + '-count'}>{all.length}</span>}{search && <span className="object-group-matches"> · 匹配 {matches.length}</span>}</button>
        {(!folded.has(kind) || !!search) && matches.map(item => <DirectoryRow key={item.key} item={item} selected={props.isSelected(item)} hidden={drawing.hiddenTypes.includes(kind)} locked={drawing.lockedTypes.includes(kind)} onSelect={props.onSelect} onLocate={props.onLocate}/>)}
      </div>;
    })}</div>
  </>;
}
/** Rows of unchanged scene items keep their identity across edits, so only changed or reselected rows re-render. */
const DirectoryRow = memo(function DirectoryRow({ item, selected, hidden, locked, onSelect, onLocate }: { item: SceneItem; selected: boolean; hidden: boolean; locked: boolean; onSelect: Props['onSelect']; onLocate: Props['onLocate'] }) {
  const kind = item.kind;
  return <div className="directory-row">
    <button data-testid={kind === 'nodes' ? 'node-item-' + item.id : kind === 'roads' ? 'road-item-' + item.id : ['facilities', 'zones', 'accessPoints', 'servicePoints'].includes(kind) ? kind + '-item-' + item.id : 'inspect-item-' + kind + '-' + item.id}
      className={selected ? 'object-item selected' : 'object-item'} onClick={e => onSelect(item, e.shiftKey)}>
      <span>{item.name || item.id}<small>{item.id}{hidden ? ' · 隐藏' : ''}{locked ? ' · 锁定' : ''}{item.status === 'unsupported' ? ' · 未支持' : ''}{item.status === 'logical' ? ' · 目录对象' : ''}</small></span>
    </button><button className="locate-object" aria-label={'定位 ' + item.id} onClick={() => onLocate(item)}>⌖</button>
  </div>;
});
export function ObjectInspector({ item, map, onLocate }: { item: SceneItem; map: YardMap; onLocate: () => void }) {
  return <section className="capability-box" data-testid="object-inspector"><h3>{item.name || item.id}</h3><code>{item.id}</code><p>{item.reason || '声明数据只读查看。'}</p>
    <p>{item.status === 'unsupported' ? '未支持，数据完整保留。' : item.status === 'logical' ? '逻辑对象，没有可推断的独立几何。' : '几何来自地图声明或明确引用。'}</p>
    <button onClick={onLocate}>定位对象</button><pre className="object-json">{JSON.stringify(itemValue(map, item), null, 2)}</pre>
  </section>;
}
