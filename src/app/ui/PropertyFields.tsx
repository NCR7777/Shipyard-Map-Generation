import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PhysicalValue, YardMap } from '../../domain/model';
import { displayNumber, physicalDraft, physicalPatch, sourceLabels, STATE_LABELS, type PhysicalDraft, type PhysicalState, type Unit } from '../state/properties';
import { notify } from '../state/store';

/** What a commit did: true applied or nothing to apply, false refused (the gateway already said why), a string is a
 *  problem with the input itself, shown beside the field. */
export type CommitResult = boolean | string;
const composing = (event: KeyboardEvent) => event.nativeEvent.isComposing || event.keyCode === 229;

/** A text field that commits on Enter or when left, and restores the stored value on Escape.
 *  An input problem keeps the text on Enter (to fix it) and is reported and dropped when the field is left. */
export function CommitText({ value, label, onCommit, numeric, suffix, placeholder, onEscape }: {
  value: string; label: string; onCommit: (text: string) => CommitResult; numeric?: boolean; suffix?: string; placeholder?: string;
  /** Escape also cancels what the field belongs to (after restoring it). */
  onEscape?: () => void;
}) {
  const [text, setText] = useState(value), [error, setError] = useState<string | null>(null);
  // Counts commits: the shown value may be the same string after a commit (100 → 100.0001 shows as 100), and must still replace the text.
  const [commits, setCommits] = useState(0);
  // Typed and not yet committed: only then may the stored value not replace the text (not merely while focused).
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) { setText(value); setError(null); } }, [value, commits]);
  const restore = () => { dirty.current = false; setText(value); setError(null); };
  function commit(leaving: boolean) {
    if (text === value) { restore(); return; }
    const result = onCommit(text);
    if (typeof result === 'string') {
      if (leaving) { notify(`${label}：${result}已恢复原值。`, 'error'); restore(); } else setError(result);
    } else if (!result) restore();
    else { dirty.current = false; setError(null); setCommits(count => count + 1); }
  }
  return <span className="prop-input">
    <input type="text" inputMode={numeric ? 'decimal' : undefined} aria-label={label} value={text} aria-invalid={!!error} title={error ?? undefined} placeholder={placeholder}
      onChange={event => { dirty.current = true; setText(event.target.value); setError(null); }}
      onKeyDown={event => {
        if (composing(event)) return;
        if (event.key === 'Enter') { event.preventDefault(); commit(false); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); event.currentTarget.blur(); onEscape?.(); }
      }}
      onBlur={() => { if (dirty.current) commit(true); }} />
    {suffix && <span className="unit">{suffix}</span>}
    {error && <span className="field-error" role="alert">{error}</span>}
  </span>;
}

/** A choice that commits as soon as it changes. An option may be offered but disabled (the third entry says why). */
export function CommitSelect<T extends string>({ value, label, options, onCommit }: {
  value: T; label: string; options: readonly (readonly [T, string, string?])[]; onCommit: (value: T) => void;
}) {
  return <select className="prop-select" aria-label={label} value={value} onChange={event => onCommit(event.target.value as T)}>
    {options.map(([option, text, disabled]) => <option key={option} value={option} disabled={!!disabled} title={disabled}>{text}</option>)}
  </select>;
}

const STATES = Object.entries(STATE_LABELS) as [PhysicalState, string][];
/** A physical value: its state, the number in a display unit, and for a known value the source it rests on;
 *  for other states, the note saying why. Choosing「已声明」only opens the number; other states commit at once. */
export function PhysicalField({ map, value, label, unit, units, onUnit, onCommit }: {
  map: YardMap; value: PhysicalValue | undefined; label: string; unit: Unit; units?: readonly Unit[]; onUnit?: (unit: Unit) => void;
  /** `sourceOnly`: the same number now rests on another source. */
  onCommit: (value: PhysicalValue, needsAssumption: boolean, sourceOnly: boolean) => boolean;
}) {
  const [draft, setDraft] = useState<PhysicalDraft>(() => physicalDraft(value, unit));
  const [error, setError] = useState<string | null>(null);
  // Typed and not yet committed. Choosing another unit blurs the number first, which commits or restores it,
  // so text typed in one unit is never read in another.
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) { setDraft(physicalDraft(value, unit)); setError(null); } }, [value, unit]);
  const restore = () => { dirty.current = false; setDraft(physicalDraft(value, unit)); setError(null); };
  function commit(next: PhysicalDraft, leaving: boolean) {
    // 「已声明」chosen but nothing typed yet: leaving the field simply goes back.
    if (next.state === 'known' && value?.state !== 'known' && !next.touched) { if (leaving) restore(); return; }
    const result = physicalPatch(value, next, unit);
    if (!result.ok) { if (leaving) { notify(`${label}：${result.message}已恢复原值。`, 'error'); restore(); } else setError(result.message); return; }
    const sourceOnly = !!result.value && result.value.state === 'known' && value?.state === 'known' && result.value.value === value.value;
    if (result.value && !onCommit(result.value, result.needsAssumption, sourceOnly)) restore();
    else { dirty.current = false; setError(null); if (!result.value) setDraft(physicalDraft(value, unit)); }
  }
  const overflow = value?.state === 'known' && displayNumber(value.value, unit) === null;
  const source = value?.state === 'known' ? value.sourceRef : undefined;
  return <span className="prop-physical">
    <select className="prop-select" aria-label={label + '状态'} value={draft.state} onChange={event => {
      const state = event.target.value as PhysicalState;
      // Back to the stored state (「已声明」opened and left untyped): nothing to commit, and its note stays.
      if (state === (value?.state ?? 'unknown')) { restore(); return; }
      if (state === 'known') { setDraft({ ...physicalDraft(value, unit), state: 'known' }); return; }
      commit({ state, text: '', touched: false }, true);
    }}>{STATES.map(([state, text]) => <option key={state} value={state}>{text}</option>)}</select>
    {draft.state === 'known' && <span className="prop-input">
      {overflow ? <span className="muted">超出当前单位的有限显示范围</span>
        : <input type="text" inputMode="decimal" aria-label={label} value={draft.text} aria-invalid={!!error} title={error ?? undefined}
          placeholder={value?.state === 'known' ? undefined : '输入数值'}
          onChange={event => { dirty.current = true; setDraft({ ...draft, text: event.target.value, touched: true }); setError(null); }}
          onKeyDown={event => {
            if (composing(event)) return;
            if (event.key === 'Enter') { event.preventDefault(); commit(draft, false); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); restore(); event.currentTarget.blur(); }
          }}
          onBlur={() => { if (dirty.current || draft.state !== (value?.state ?? 'unknown')) commit(draft, true); }} />}
      {units && units.length > 1 && onUnit
        ? <select className="prop-select unit" aria-label={label + '单位'} value={unit} onChange={event => onUnit(event.target.value as Unit)}>
          {units.map(option => <option key={option} value={option}>{option}</option>)}</select>
        : <span className="unit">{unit}</span>}
    </span>}
    {value?.state === 'known' && draft.state === 'known' && <select className="prop-select source" aria-label={label + '依据'} value={source ?? ''}
      title="这个数值所依据的来源；改选即记录新的依据，数值不变"
      onChange={event => commit({ ...physicalDraft(value, unit), source: event.target.value }, true)}>
      {!source && <option value="">（无来源）</option>}
      {sourceLabels(map).map(([id, text]) => <option key={id} value={id}>依据：{text}</option>)}
    </select>}
    {value && value.state !== 'known' && draft.state === value.state && <CommitText label={label + '说明'} value={value.reason ?? ''} placeholder="说明（可选）"
      onCommit={text => onCommit({ state: value.state, ...text.trim() ? { reason: text.trim() } : {} }, false, false)} />}
    {error && <span className="field-error" role="alert">{error}</span>}
  </span>;
}
