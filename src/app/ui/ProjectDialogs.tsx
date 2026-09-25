import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../../editor/projectController';
import { answerLink, dismissConflict, keepBoth, loadFileVersion, overwriteFile, pendingLinkName, saveAs, useLocalFile } from '../state/localFile';
import { answerDiscard, backupCurrent, continueInMemory, createMap, listProjects, openProject, projects, reloadStored, startProjects, useProjectState } from '../state/project';
import { store, useApp } from '../state/store';
import { Icon } from './icons';
import { Dialog } from './Overlays';

const close = () => store.set({ overlay: null });
const time = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false });

/** Maps kept in this browser, newest first; opening one writes the current map first. */
export function ProjectsDialog() {
  const [list, setList] = useState<ProjectSummary[] | null>(null), [error, setError] = useState<string | null>(null);
  const active = useProjectState().active?.projectId;
  useEffect(() => { listProjects().then(setList, failure => setError(failure instanceof Error ? failure.message : String(failure))); }, []);
  return <Dialog label="浏览器工程" onClose={close} className="help projects-dialog">
    <header className="overlay-header"><h2>浏览器工程</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    <p className="muted">打开或新建的地图都保存在本浏览器中，修改后自动保存；Ctrl+S 另存一个检查点。清除浏览器数据会删除它们，重要的地图请导出副本。</p>
    {error ? <p className="warn" role="alert">无法读取浏览器工程：{error}</p>
      : !list ? <p className="muted">正在读取…</p>
        : !list.length ? <p className="muted">还没有浏览器工程。</p>
          : <ul className="project-list" aria-label="浏览器工程列表">{list.map(item => <li key={item.projectId}>
            <button className={'project-row' + (item.projectId === active ? ' current' : '')} data-autofocus={item.projectId === active || undefined}
              onClick={() => { void openProject(item.projectId).then(done => { if (done) close(); }); }}>
              <strong>{item.name}</strong>{item.projectId === active && <span className="badge">当前</span>}
              <span className="muted">更新于 {time(item.updatedAt)}{item.hasCheckpoint ? ' · 有检查点' : ' · 仅自动保存'}</span>
            </button></li>)}</ul>}
    <footer className="dialog-actions">
      <button className="button subtle" onClick={close}>关闭</button>
      <button className="button primary" onClick={() => store.set({ overlay: 'newMap' })}>新建地图…</button>
    </footer>
  </Dialog>;
}

/** A new empty map (format 0.3.0) in its own browser project. */
export function NewMapDialog() {
  const [name, setName] = useState('新建布局');
  const valid = name.trim().length > 0;
  const create = () => { if (valid) void createMap(name.trim()); };
  return <Dialog label="新建地图" onClose={close} className="help edit-dialog">
    <header className="overlay-header"><h2>新建地图</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    <label className="dialog-field">地图名称
      <input value={name} data-autofocus aria-invalid={!valid} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) create(); }} />
    </label>
    {!valid && <p className="warn" role="alert">名称不能为空。</p>}
    <footer className="dialog-actions">
      <button className="button subtle" onClick={close}>取消</button>
      <button className="button primary" disabled={!valid} onClick={create}>创建地图</button>
    </footer>
  </Dialog>;
}

/** Recovery failed at page load: open another stored project, try again, or go on without browser storage.
 *  Nothing stored is changed; one damaged project must not make the others unreachable. */
export function RecoveryDialog() {
  const failure = useApp(state => state.project.failure);
  const [list, setList] = useState<ProjectSummary[]>([]);
  useEffect(() => { listProjects().then(setList, () => setList([])); }, []);
  return <Dialog label="恢复浏览器工程" onClose={continueInMemory} className="help edit-dialog">
    <header className="overlay-header"><h2>恢复浏览器工程</h2></header>
    <p className="warn" role="alert">没有恢复上次的浏览器工程：{failure}</p>
    <p className="muted">浏览器中保存的记录没有被改动。可以打开其他工程、重试，或先在本页继续（此时修改只在内存中，请用「导出副本」保存）。</p>
    {list.length > 0 && <ul className="project-list" aria-label="浏览器工程列表">{list.map(item => <li key={item.projectId}>
      <button className="project-row" onClick={() => { void openProject(item.projectId); }}>
        <strong>{item.name}</strong><span className="muted">更新于 {time(item.updatedAt)}</span>
      </button></li>)}</ul>}
    <footer className="dialog-actions">
      <button className="button subtle" onClick={continueInMemory}>仅在本页继续</button>
      <button className="button primary" data-autofocus onClick={() => { void startProjects(); }}>重试恢复</button>
    </footer>
  </Dialog>;
}

/** In memory only: opening another map would drop edits that were never exported. */
export function DiscardMemoryDialog() {
  return <Dialog label="未导出的修改" onClose={() => answerDiscard('cancel')} className="help edit-dialog">
    <header className="overlay-header"><h2>未导出的修改</h2></header>
    <p>当前地图只在本页内存中，打开另一张地图会丢掉还没有导出的修改。</p>
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={() => answerDiscard('cancel')}>取消</button>
      <button className="button" onClick={() => answerDiscard('export')}>先导出副本再打开</button>
      <button className="button danger" onClick={() => answerDiscard('discard')}>放弃修改并打开</button>
    </footer>
  </Dialog>;
}

/** The linked file was changed elsewhere. Nothing is replaced or overwritten without a choice; overwriting comes only after
 *  both versions are kept as recovery copies. Mounted per conflict (keyed by its token): a copy kept for one external version
 *  never permits overwriting a newer one. */
export function FileConflictDialog() {
  const { conflict, busy } = useLocalFile(), [kept, setKept] = useState(false);
  if (!conflict) return null;
  const valid = !!conflict.loaded?.ok;
  return <Dialog label="外部文件已变化" onClose={dismissConflict} className="help edit-dialog">
    <header className="overlay-header"><h2>外部文件已变化</h2></header>
    <p>{conflict.name} 在别处被修改过（与上次写入或读取时不同），没有写入它。</p>
    {valid ? <p className="muted">可以载入文件中的版本（当前地图先另存为恢复副本）、把当前地图另存到新文件，或先保存双方的恢复副本再覆盖外部文件。</p>
      : <p className="warn">外部文件现在不是有效的地图：既不能载入，也不会被覆盖。请把当前地图另存到新文件，或修复外部文件后再保存。</p>}
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={dismissConflict}>取消</button>
      {valid && <button className="button" disabled={busy} onClick={() => { void loadFileVersion(); }}>载入文件中的版本</button>}
      <button className="button" disabled={busy} onClick={() => { dismissConflict(); void saveAs(); }}>文件另存为…</button>
      {valid && (!kept ? <button className="button" disabled={busy} onClick={() => { void keepBoth().then(setKept); }}>先保存双方恢复副本</button>
        : <button className="button danger" disabled={busy} onClick={() => { void overwriteFile(); }}>用当前地图覆盖外部文件</button>)}
    </footer>
  </Dialog>;
}

/** Linking a file whose map differs from this one: the next Save would write this map over it. */
export function ConfirmLinkDialog() {
  return <Dialog label="关联内容不同的文件" onClose={() => answerLink(false)} className="help edit-dialog">
    <header className="overlay-header"><h2>关联内容不同的文件</h2></header>
    <p>{pendingLinkName()} 中的地图与当前地图不同。关联后，下次保存会用当前地图覆盖这个文件。</p>
    <p className="muted">关联前会先把文件中的版本另存为浏览器中的恢复副本。</p>
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={() => answerLink(false)}>取消</button>
      <button className="button danger" onClick={() => answerLink(true)}>另存文件版本并关联</button>
    </footer>
  </Dialog>;
}

/** Another tab saved this project: saving here stopped. Keep this page's map as a copy, or load the stored version. */
export function ConflictBanner() {
  const conflict = useProjectState().error?.code === 'PROJECT_CONFLICT', session = useApp(state => state.session);
  if (!conflict || !session) return null;
  return <div className="banner error" role="alert">
    <Icon name="alert" size={16} />
    <span>另一个标签页或窗口已保存此工程，本页已停止自动保存，修改还在本页。</span>
    <button className="button" onClick={() => { void backupCurrent(); }}>另存为恢复副本</button>
    <button className="button" onClick={() => store.set({ overlay: 'reloadProject' })}>载入浏览器中的版本…</button>
  </div>;
}
export function ReloadDialog() {
  const name = useProjectState().active?.name ?? projects.state.active?.name;
  return <Dialog label="载入浏览器中的版本" onClose={close} className="help edit-dialog">
    <header className="overlay-header"><h2>载入浏览器中的版本</h2></header>
    <p>放弃本页对「{name}」的修改，改为显示另一个标签页保存的版本？</p>
    <p className="muted">需要保留本页的修改时，先「另存为恢复副本」。</p>
    <footer className="dialog-actions">
      <button className="button subtle" data-autofocus onClick={close}>取消</button>
      <button className="button danger" onClick={() => { close(); void reloadStored(); }}>放弃本页修改并载入</button>
    </footer>
  </Dialog>;
}
