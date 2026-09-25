import { memo, useMemo, useState } from 'react';
import type { Issue } from '../../domain/model';
import { frame, framePoint, issuesOf, itemOf, notify, sceneOf, select, store, useApp } from '../state/store';
import { Icon } from './icons';
import { SEVERITY_LABELS } from './labels';

// Hints of one code group from 20 rows; errors stay listed one by one up to a page, so no section mounts thousands of rows.
const GROUP_FROM = 20, PAGE = 200;

/** Selects and frames the issue's entity when it still exists; otherwise centres its recorded position, or reports where it points. */
function locate(issue: Issue): void {
  const map = store.get().session?.map; if (!map) return;
  const key = issue.entityType && issue.entityId ? issue.entityType + '/' + issue.entityId : null;
  const item = key ? itemOf(sceneOf(map), key) : undefined;
  if (key && item) { select([key]); if (item.status === 'geometry') frame([key]); store.set(({ panels }) => ({ panels: { ...panels, right: true } })); }
  else if (issue.location?.position) framePoint(issue.location.position);
  else notify(`该问题指向 ${issue.jsonPath || '整张地图'}，没有可在画布上定位的对象。`);
}

function IssueRow({ issue }: { issue: Issue }) {
  return <li className={'issue ' + issue.severity}>
    <button className="issue-main" onClick={() => locate(issue)}>
      <Icon name={issue.severity === 'error' ? 'alert' : 'info'} size={16} />
      <span className="issue-text"><span>{issue.message}</span>{issue.suggestedAction && <small>{issue.suggestedAction}</small>}</span>
      {issue.entityId && <span className="issue-entity">{issue.entityId}</span>}
    </button>
    <details className="issue-detail"><summary>详情</summary><code>{issue.code}</code> · <code>{issue.jsonPath || '/'}</code></details>
  </li>;
}

/** A long run of one hint collapses to one line; its rows mount only when opened. */
function IssueGroup({ issues }: { issues: Issue[] }) {
  const [open, setOpen] = useState(false), [shown, setShown] = useState(PAGE);
  const first = issues[0]!;
  return <li className={'issue-group ' + first.severity}>
    <button className="issue-group-head" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} /><span>{first.message}</span><span className="count">{issues.length} 条</span>
    </button>
    {open && <ul>{issues.slice(0, shown).map((issue, index) => <IssueRow key={index} issue={issue} />)}</ul>}
    {open && issues.length > shown && <button className="button subtle" onClick={() => setShown(count => count + PAGE)}>再显示 {Math.min(PAGE, issues.length - shown)} 条</button>}
  </li>;
}

export const IssuesDrawer = memo(function IssuesDrawer() {
  const map = useApp(state => state.session?.map ?? null);
  const issues = map ? issuesOf(map) : [];
  const sections = useMemo(() => (['error', 'warning'] as const).map(severity => {
    const byCode = new Map<string, Issue[]>();
    for (const issue of issues) if (issue.severity === severity) { const list = byCode.get(issue.code); if (list) list.push(issue); else byCode.set(issue.code, [issue]); }
    return { severity, count: [...byCode.values()].reduce((sum, list) => sum + list.length, 0), groups: [...byCode.values()] };
  }), [issues]);
  return <section className="drawer" aria-label="检查问题">
    <header className="drawer-header"><h2>检查与问题</h2>
      <span className="summary">{sections.map(section => <span key={section.severity} className={'pill ' + section.severity}>{SEVERITY_LABELS[section.severity]} {section.count}</span>)}</span>
      <span className="muted">草稿校验结果；不代表现场运输安全。</span>
      <button className="icon-button" aria-label="关闭问题抽屉" onClick={() => store.set(({ panels }) => ({ panels: { ...panels, drawer: false } }))}><Icon name="close" /></button>
    </header>
    <div className="drawer-body">
      {!map ? <p className="panel-empty">打开地图后显示检查结果。</p> : issues.length === 0 ? <p className="panel-empty">草稿校验没有发现问题。</p>
        : sections.filter(section => section.count).map(section => <section key={section.severity} className="issue-section">
          <h3>{SEVERITY_LABELS[section.severity]}</h3>
          <ul className="issue-list">{section.groups.map(group => group.length >= (section.severity === 'error' ? PAGE : GROUP_FROM)
            ? <IssueGroup key={group[0]!.code} issues={group} />
            : group.map((issue, index) => <IssueRow key={issue.code + index} issue={issue} />))}</ul>
        </section>)}
    </div>
  </section>;
});
