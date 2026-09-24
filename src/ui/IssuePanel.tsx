import { memo, useMemo, useState } from 'react';
import type { Issue } from '../domain/model';

const GROUP_FROM = 20, PAGE = 200;
type Locate = (issue: Issue) => void;

function IssueItem({ issue, onLocate }: { issue: Issue; onLocate: Locate }) {
  return <div className={'issue-item ' + issue.severity}><span className="issue-symbol">{issue.severity === 'error' ? '!' : '△'}</span><span><button aria-label={issue.code + ' ' + issue.message} onClick={() => onLocate(issue)}>{issue.message}</button><small>{issue.suggestedAction}</small><details><summary>技术详情 · {issue.entityId ?? '地图'}</summary><strong>{issue.code}</strong> · {issue.jsonPath || '/'}</details></span></div>;
}

/** A long run of one hint (e.g. every road with unknown clearance) is one line; its rows mount only when opened. */
function IssueGroup({ issues, onLocate }: { issues: Issue[]; onLocate: Locate }) {
  const [open, setOpen] = useState(false), [shown, setShown] = useState(PAGE);
  const first = issues[0]!;
  return <details className={'issue-group ' + first.severity} data-code={first.code} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span className="issue-symbol">△</span><span><strong>{first.code}</strong> · {issues.length} 条 · 例：{first.message}</span></summary>
    {open && issues.slice(0, shown).map((issue, index) => <IssueItem key={index} issue={issue} onLocate={onLocate}/>)}
    {open && issues.length > shown && <button className="subtle-button" onClick={() => setShown(count => count + PAGE)}>再显示 {Math.min(PAGE, issues.length - shown)} 条（共 {issues.length} 条）</button>}
  </details>;
}

export const IssuePanel = memo(function IssuePanel({ issues, diagnosed, onLocate }: { issues: Issue[]; diagnosed: boolean; onLocate: Locate }) {
  const errorCount = issues.filter(issue => issue.severity === 'error').length;
  // Errors first; codes keep the order of their first occurrence.
  const groups = useMemo(() => {
    const byCode = new Map<string, Issue[]>();
    for (const issue of [...issues.filter(item => item.severity === 'error'), ...issues.filter(item => item.severity !== 'error')]) {
      const key = issue.severity + '/' + issue.code, list = byCode.get(key);
      if (list) list.push(issue); else byCode.set(key, [issue]);
    }
    return [...byCode.values()];
  }, [issues]);
  return <section className="issue-panel" data-testid="issue-panel"><div className="issue-heading"><strong>检查器</strong><span className={errorCount ? 'error-count' : 'warning-count'}>{errorCount} 错误 · {issues.length - errorCount} 提示</span><span>{diagnosed ? '草稿校验 + 只读诊断' : 'draft 校验'}；不代表现场安全</span></div>
    <div className="issue-list">{groups.map(group => group.length >= GROUP_FROM && group[0]!.severity !== 'error'
      ? <IssueGroup key={'group/' + group[0]!.code} issues={group} onLocate={onLocate}/>
      : group.map((issue, index) => <IssueItem key={issue.severity + issue.code + index} issue={issue} onLocate={onLocate}/>))}</div></section>;
});
