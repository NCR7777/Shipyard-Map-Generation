import { useMemo, useRef, useState } from 'react';
import type { SceneKind } from '../../adapters/contracts';
import { commandSupport, type MapCommand } from '../../domain/commands';
import { MOVE_POLICY } from '../canvas/movePreview';
import { setTool } from '../state/draft';
import { apply } from '../state/edit';
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

/** Delete with an impact preview. Options start conservative, as in ../map: dependencies refuse the delete until allowed. */
export function DeleteDialog() {
  const session = useApp(state => state.session), keys = useApp(state => state.selection), token = useOpenedToken();
  const [cascade, setCascade] = useState(false), [members, setMembers] = useState(false), [orphans, setOrphans] = useState(false);
  const selection = selectionOf(keys);
  const command = useMemo((): MapCommand | null => typeof selection === 'string' ? null : {
    type: 'deleteSelection', selection, topologyPolicy: cascade ? 'cascade' : 'reject', orphanNodes: orphans ? 'deleteUnused' : 'keep',
    facilityPolicy: members ? 'withAssociatedPoints' : 'reject', zonePolicy: members ? 'withAssociatedPoints' : 'reject',
  }, [selection, cascade, members, orphans]);
  const support = useMemo(() => session && command ? commandSupport(session.map, command) : null, [session, command]);
  const groups = useMemo(() => {
    const byKind = new Map<string, string[]>(), scene = session ? sceneOf(session.map) : null;
    // A refused delete has no impact list from the kernel; show at least what was selected.
    const refs = support?.affectedRefs.length ? support.affectedRefs : keys.map(key => ({ kind: key.slice(0, key.indexOf('/')), id: key.slice(key.indexOf('/') + 1) }));
    for (const ref of refs) {
      const names = byKind.get(ref.kind) ?? []; byKind.set(ref.kind, names);
      names.push(scene && itemOf(scene, ref.kind + '/' + ref.id)?.name || ref.id);
    }
    return [...byKind];
  }, [session, support, keys]);
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
      </fieldset>
      <section className="impact" aria-label="影响">
        <h3 className="section-title">{support?.allowed ? '将删除或改动' : '所选对象'}</h3>
        {groups.length ? <ul>{groups.map(([kind, names]) => <li key={kind}><b>{KIND_LABELS[kind as SceneKind] ?? kind} {names.length}</b>
          <span className="muted">{names.slice(0, 12).join('、')}{names.length > 12 ? ` 等` : ''}</span></li>)}</ul> : <p className="muted">—</p>}
        {!support?.allowed && <p className="warn" role="alert">{support?.issues[0]?.message ?? '不能删除。'}{support?.issues[0]?.suggestedAction ? ' ' + support.issues[0].suggestedAction : ''}</p>}
      </section>
    </>}
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={close}>取消</button>
      <button className="button danger" disabled={!support?.allowed} onClick={confirm}>删除</button>
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
