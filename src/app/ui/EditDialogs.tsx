import { useMemo, useRef, useState } from 'react';
import type { SceneKind } from '../../adapters/contracts';
import { commandSupport, type CommandSupport, type MapCommand } from '../../domain/commands';
import type { YardMap } from '../../domain/model';
import { splitPosition, type TopologyCommand } from '../../domain/topologyEditing';
import { MOVE_POLICY, uid } from '../canvas/movePreview';
import { deleteCommand } from '../canvas/servicePoints';
import { incidentRoads, proposedTurns, topologyRefusal, withTurns } from '../canvas/topology';
import { refusalMessage } from '../state/properties';
import { setTool } from '../state/draft';
import { apply, lockedMessage } from '../state/edit';
import { selectionOf } from '../state/editOps';
import { localState, unlinkForUpgrade } from '../state/localFile';
import { backupBeforeUpgrade } from '../state/project';
import { displayIndexOf, itemOf, notify, sceneOf, select, store, useApp } from '../state/store';
import { Icon } from './icons';
import { KIND_LABELS } from './labels';
import { Dialog } from './Overlays';

const close = () => store.set({ overlay: null });
/** A dialog confirms against the map it was opened on; an undo or edit in between makes it stale. */
function useOpenedToken() { return useRef(store.get().session?.changeToken).current; }
function stale(token: number | undefined): boolean {
  if (store.get().session?.changeToken === token) return false;
  notify('地图在对话框打开后已改变，请重新打开再确认。', 'error'); close(); return true;
}

/** Delete with an impact preview. Options start conservative, as in ../map: dependencies refuse the delete until allowed. The
 *  one exception: the internal routes only the deleted service points use go with them unless unticked (left behind, a route
 *  and its node would stay in the building, and a click there would land on the stray node), as long as that touches nothing
 *  else the options guard (`deleteCommand`). */
export function DeleteDialog() {
  const session = useApp(state => state.session), keys = useApp(state => state.selection), token = useOpenedToken();
  const [cascade, setCascade] = useState(false), [members, setMembers] = useState(false), [orphans, setOrphans] = useState(false), [routes, setRoutes] = useState(true);
  const selection = selectionOf(keys);
  const built = useMemo(() => session && typeof selection !== 'string' ? deleteCommand(session.map, selection, { cascade, members, orphans, routes }) : null,
    [session, keys, cascade, members, orphans, routes]);
  const command: MapCommand | null = built?.command ?? null, own = built?.own ?? { roads: [], nodes: [] };
  const support = useMemo(() => session && command ? commandSupport(session.map, command) : null, [session, command]);
  const confirm = () => {
    if (!command || !support?.allowed || stale(token)) return;
    if (apply(command, `删除 ${keys.length} 个对象`)) { select([]); close(); }
  };
  return <Dialog label="删除选中对象" onClose={close} className="help edit-dialog">
    <header className="overlay-header"><h2>删除选中对象</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    {typeof selection === 'string' ? <p className="warn">{selection}</p> : <>
      <fieldset className="settings-group"><legend>一并处理</legend>
        <label className="check"><input type="checkbox" checked={cascade} onChange={event => setCascade(event.target.checked)} />关联的道路、转向和因此变空的路口（资源容量保留）</label>
        <label className="check"><input type="checkbox" checked={members} onChange={event => setMembers(event.target.checked)} />建筑与区域的成员入口和作业点</label>
        <label className="check"><input type="checkbox" checked={orphans} onChange={event => setOrphans(event.target.checked)} />之后不再使用的节点</label>
        {own.roads.length > 0 && <label className="check"><input type="checkbox" checked={routes} onChange={event => setRoutes(event.target.checked)} />作业点独用的内部通道（{own.roads.length} 条道路，连同其上的转向与作业点的节点）</label>}
        {built?.held && <p className="muted">{built.held}</p>}
      </fieldset>
      <Impact map={session?.map ?? null} support={support} keys={keys} title={support?.allowed ? '将删除或改动' : '所选对象'} refused="不能删除。" />
    </>}
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={close}>取消</button>
      <button className="button danger" disabled={!support?.allowed} onClick={confirm}>删除</button>
    </footer>
  </Dialog>;
}

/** What an edit changes, by the kernel's preview grouped by kind; a refused edit has no list from the kernel, so the objects it
 *  was asked for are shown, with the kernel's reason. */
function Impact({ map, support, keys, title, refused, reason }: { map: YardMap | null; support: CommandSupport | null; keys: readonly string[]; title: string; refused: string; reason?: string | null }) {
  const groups = useMemo(() => {
    const byKind = new Map<string, string[]>(), scene = map ? sceneOf(map) : null;
    const refs = support?.affectedRefs.length ? support.affectedRefs : keys.map(key => ({ kind: key.slice(0, key.indexOf('/')), id: key.slice(key.indexOf('/') + 1) }));
    for (const ref of refs) {
      const names = byKind.get(ref.kind) ?? []; byKind.set(ref.kind, names);
      names.push(scene && itemOf(scene, ref.kind + '/' + ref.id)?.name || (map && Object.hasOwn(map[ref.kind as SceneKind & keyof YardMap] ?? {}, ref.id) ? ref.id : '（新建）'));
    }
    return [...byKind];
  }, [map, support, keys]);
  return <section className="impact" aria-label="影响">
    <h3 className="section-title">{title}</h3>
    {groups.length ? <ul>{groups.map(([kind, names]) => <li key={kind}><b>{KIND_LABELS[kind as SceneKind] ?? kind} {names.length}</b>
      <span className="muted">{names.slice(0, 12).join('、')}{names.length > 12 ? ` 等` : ''}</span></li>)}</ul> : <p className="muted">—</p>}
    {!support?.allowed && <p className="warn" role="alert">{reason ?? <>{support?.issues[0]?.message ?? refused}{support?.issues[0]?.suggestedAction ? ' ' + support.issues[0].suggestedAction : ''}</>}</p>}
  </section>;
}

const TOPOLOGY_TITLES: Record<TopologyCommand['type'], string> = { mergeNodes: '合并节点', connectNodeToRoad: '把节点接到道路', suppressDegree2Node: '删除节点并接通两条道路' };
const turnKey = (turn: { incomingArc: { roadId: string; direction: string }; outgoingArc: { roadId: string; direction: string } }) =>
  `${turn.incomingArc.roadId}/${turn.incomingArc.direction}>${turn.outgoingArc.roadId}/${turn.outgoingArc.direction}`;
/** Confirms a topology edit prepared from a drop or the edit menu: what it does in words, the choices it has (the node kept,
 *  the road kept), the new turns it would allow at the joined node (each ticked by default, as drawing a road onto a node
 *  allows them all; never a U-turn), and the kernel's impact list. Any change to the map after it opens makes it stale. */
export function TopologyDialog() {
  const session = useApp(state => state.session), draft = useApp(state => state.topology), map = session?.map ?? null, token = useOpenedToken();
  const [command, setCommand] = useState(draft), [unticked, setUnticked] = useState<ReadonlySet<string>>(new Set());
  const turns = useMemo(() => {
    try { return map && command ? proposedTurns(map, command).map(turn => ({ ...turn, id: uid('movement') })) : []; } catch { return []; }
  }, [map, command]);
  const full = useMemo(() => command ? withTurns(command, turns.filter(turn => !unticked.has(turnKey(turn))), true) : null, [command, turns, unticked]);
  const support = useMemo(() => map && full ? commandSupport(map, full) : null, [map, full]);
  const cancel = () => store.set({ overlay: null, topology: null });
  if (!map || !command || !full) return null;
  const node = (id: string) => `「${map.nodes[id]?.name ?? id}」`, road = (id: string) => `「${map.roads[id]?.name ?? id}」`;
  // A connection's turns name the two halves of the road it splits, which have no names yet.
  const roadName = (id: string) => command.type === 'connectNodeToRoad' && command.newRoadIds.includes(id)
    ? `${map.roads[command.roadId]?.name ?? command.roadId}（${id === command.newRoadIds[0] ? '前段' : '后段'}）` : map.roads[id]?.name ?? id;
  let text: string, choice: React.ReactNode = null, keys: string[];
  if (command.type === 'mergeNodes') {
    const { sourceNodeId: source, targetNodeId: target } = command;
    const points = Object.values(map.accessPoints).some(point => point.nodeId === source) || Object.values(map.servicePoints).some(point => point.nodeId === source);
    text = `${node(source)}并入${node(target)}：连到${node(source)}的 ${incidentRoads(map, source).length} 条道路改连${node(target)}${points ? `，${node(source)}上的入口与作业点也移过去` : ''}；${node(source)}删除，${node(target)}留在原处。`;
    choice = <div className="dialog-fields"><label>保留的节点<select value={target} aria-label="保留的节点" onChange={event => { if (event.target.value !== target) { setCommand({ ...command, sourceNodeId: target, targetNodeId: source }); setUnticked(new Set()); } }}>
      {[target, source].map(id => <option key={id} value={id}>{map.nodes[id]?.name ?? id}</option>)}</select></label></div>;
    keys = ['nodes/' + source, 'nodes/' + target];
  } else if (command.type === 'connectNodeToRoad') {
    let moved = '';
    try { const at = splitPosition(map, command.roadId, command.distanceM), from = map.nodes[command.nodeId]!.position; moved = `（移动 ${Math.hypot(at[0] - from[0], at[1] - from[1]).toFixed(2)} m）`; } catch { /* the kernel's refusal says why */ }
    text = `${node(command.nodeId)}移到道路${road(command.roadId)}上距起点 ${command.distanceM.toFixed(1)} m 处${moved}，${road(command.roadId)}在那里拆成两段，两段都接到${node(command.nodeId)}。`;
    keys = ['nodes/' + command.nodeId, 'roads/' + command.roadId];
  } else {
    const roads = incidentRoads(map, command.nodeId), other = roads.find(id => id !== command.retainedRoadId) ?? '';
    text = `删除${node(command.nodeId)}，道路${road(command.retainedRoadId)}与${road(other)}合为一条，保留${road(command.retainedRoadId)}的编号与属性；原节点的位置成为这条路的折点。`;
    choice = <div className="dialog-fields"><label>保留的道路<select value={command.retainedRoadId} aria-label="保留的道路" onChange={event => setCommand({ ...command, retainedRoadId: event.target.value })}>
      {roads.map(id => <option key={id} value={id}>{map.roads[id]?.name ?? id}</option>)}</select></label></div>;
    keys = ['nodes/' + command.nodeId, ...roads.map(id => 'roads/' + id)];
  }
  // A locked layer the edit writes: said here, not only after the click.
  const locked = support?.allowed ? lockedMessage(support.affectedRefs, true) : null;
  const approved = full.type !== 'suppressDegree2Node' ? full.approvedMovements?.length ?? 0 : 0;
  const confirm = () => {
    if (!support?.allowed || locked || stale(token) || !apply(full, TOPOLOGY_TITLES[command.type])) return;
    select([command.type === 'mergeNodes' ? 'nodes/' + command.targetNodeId : command.type === 'connectNodeToRoad' ? 'nodes/' + command.nodeId : 'roads/' + command.retainedRoadId]);
    cancel();
    notify(`已${TOPOLOGY_TITLES[command.type]}${approved ? `，允许新增转向 ${approved} 个` : ''}。`);
  };
  const toggle = (key: string, on: boolean) => setUnticked(old => { const next = new Set(old); if (on) next.delete(key); else next.add(key); return next; });
  return <Dialog label={TOPOLOGY_TITLES[command.type]} onClose={cancel} className="help edit-dialog">
    <header className="overlay-header"><h2>{TOPOLOGY_TITLES[command.type]}</h2><button className="icon-button" aria-label="关闭" onClick={cancel}><Icon name="close" /></button></header>
    <p>{text}</p>
    {choice}
    {turns.length > 0 && <fieldset className="settings-group"><legend>接上后的转向</legend>
      <label className="check"><input type="checkbox" checked={!unticked.size} ref={element => { if (element) element.indeterminate = unticked.size > 0 && unticked.size < turns.length; }}
        onChange={event => setUnticked(event.target.checked ? new Set() : new Set(turns.map(turnKey)))} />允许新增的转向（{approved} / {turns.length} 个，不含掉头，与画路接上节点时相同）</label>
      <details><summary className="muted">逐个选择</summary>{turns.map(turn => <label key={turn.id} className="check">
        <input type="checkbox" checked={!unticked.has(turnKey(turn))} onChange={event => toggle(turnKey(turn), event.target.checked)} />{roadName(turn.incomingArc.roadId)} → {roadName(turn.outgoingArc.roadId)}</label>)}</details>
      {approved < turns.length && <p className="muted">没有允许的转向保持「未声明」：调度按已确认的转向找路时不会经过这里。</p>}
    </fieldset>}
    <Impact map={map} support={support} keys={keys} title={support?.allowed ? '将改动' : '涉及的对象'} refused="不能这样改。"
      reason={support && !support.allowed ? topologyRefusal(map, full, support.issues.find(issue => issue.severity === 'error')) ?? refusalMessage(support.issues, map) : null} />
    {locked && <p className="warn" role="alert">{locked}</p>}
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={cancel}>取消</button>
      <button className="button primary" disabled={!support?.allowed || !!locked} onClick={confirm}>确认{TOPOLOGY_TITLES[command.type]}</button>
    </footer>
  </Dialog>;
}

/** Roads, curves and areas need schema 0.3.0; the upgrade is one undoable step and the source file is untouched. */
export function UpgradeDialog() {
  const tool = useApp(state => state.upgradeFor), version = useApp(state => state.session?.map.schemaVersion);
  const cancel = () => store.set({ overlay: null, upgradeFor: null });
  const confirm = async () => {
    // A write still waiting would record the link that the upgrade drops.
    if (localState().busy) { notify('正在读写本地文件（也许在等待浏览器询问权限），稍候再升级。', 'error'); return; }
    // A map just opened may have no checkpoint: its original is kept as a recovery copy before the upgrade is saved over it.
    if (!(await backupBeforeUpgrade())) return;
    if (!apply({ type: 'upgradeSchema', targetVersion: '0.3.0' }, '升级到格式 0.3.0')) return;
    // The file on disk keeps its format: the project stops writing to it (files are written only on Save, never before this).
    unlinkForUpgrade();
    cancel(); if (tool) setTool(tool);
  };
  return <Dialog label="升级地图格式" onClose={cancel} className="help edit-dialog">
    <header className="overlay-header"><h2>升级地图格式</h2><button className="icon-button" aria-label="关闭" onClick={cancel}><Icon name="close" /></button></header>
    <p>当前地图是格式 {version}。绘制道路、弯道、建筑和区域需要格式 0.3.0（支持曲线道路和空间分类）。</p>
    <p className="muted">升级算作一步修改，可以撤销；升级前的原图另存为浏览器中的恢复副本，打开的原文件不会被改动。</p>
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={cancel}>取消</button>
      <button className="button primary" onClick={() => { void confirm(); }}>升级并继续</button>
    </footer>
  </Dialog>;
}

/** Numeric rotation about a pivot (default: the centre of the selection's bounds). */
export function RotateDialog() {
  const session = useApp(state => state.session), keys = useApp(state => state.selection), token = useOpenedToken();
  const centre = useMemo(() => {
    const entries = session ? displayIndexOf(sceneOf(session.map)).entries.filter(entry => keys.includes(entry.key) && entry.bounds) : [];
    if (!entries.length) return [0, 0];
    const min = [Math.min(...entries.map(e => e.bounds!.min[0])), Math.min(...entries.map(e => e.bounds!.min[1]))], max = [Math.max(...entries.map(e => e.bounds!.max[0])), Math.max(...entries.map(e => e.bounds!.max[1]))];
    return [(min[0]! + max[0]!) / 2, (min[1]! + max[1]!) / 2];
  }, [session, keys]);
  const [angle, setAngle] = useState('90'), [x, setX] = useState(centre[0]!.toFixed(2)), [y, setY] = useState(centre[1]!.toFixed(2));
  const values = [angle, x, y].map(Number), valid = [angle, x, y].every(text => text.trim() !== '') && values.every(Number.isFinite) && values[0] !== 0;
  const confirm = () => {
    const selection = selectionOf(keys);
    if (!valid || typeof selection === 'string' || stale(token)) return;
    const [degrees, px, py] = values as [number, number, number];
    if (apply({ type: 'rotateSelection', selection, pivot: [px, py, 0], angleRad: degrees * Math.PI / 180, facilityMovePolicy: MOVE_POLICY, zoneMovePolicy: MOVE_POLICY }, `旋转 ${keys.length} 个对象 ${degrees}°`)) close();
  };
  return <Dialog label="旋转选中对象" onClose={close} className="help edit-dialog">
    <header className="overlay-header"><h2>旋转选中对象</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    <form className="dialog-fields" onSubmit={event => { event.preventDefault(); confirm(); }}>
      <label>角度（°，逆时针为正）<input data-autofocus inputMode="decimal" value={angle} onChange={event => setAngle(event.target.value)} /></label>
      <label>旋转中心 X（m）<input inputMode="decimal" value={x} onChange={event => setX(event.target.value)} /></label>
      <label>旋转中心 Y（m）<input inputMode="decimal" value={y} onChange={event => setY(event.target.value)} /></label>
      <p className="muted">默认以选中对象的外包框中心为旋转中心。建筑与区域的私有内容一起旋转，公共路网的连接点保持不动。</p>
      <footer className="dialog-actions">
        <button type="button" className="button subtle" onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={!valid}>旋转</button>
      </footer>
    </form>
  </Dialog>;
}
