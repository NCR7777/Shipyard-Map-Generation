import { useReducer, useRef, type SetStateAction } from 'react';
import type { ArcRef, YardMap, Polygon, Issue } from '../domain/model';
import type { TopologyCommand } from '../domain/topologyEditing';
import type { ImportProposal } from '../editor/session';
import type { DraftContext } from '../editor/drafts';
import type { LocalConflict, LocalOpenCandidate } from '../adapters/localFiles';
import type { DraftRoad, Tool } from '../renderers/2d/MapCanvas';
import type { PointCreationDraft } from './PointCreationPanel';

export interface DialogValues {
  roadBatch: { ids: string[] };
  roadPreset: { roadId: string };
  boundaryRepair: { kind: 'facilities' | 'zones'; id: string; boundary: Polygon; command: import('../domain/commands').MapCommand; issues: Issue[]; allowed: boolean };
  new: true; copy: true; upgrade: true; delete: true; rotate: true; split: true;
  recent: true; storageConflict: true;
  attachFile: LocalOpenCandidate;
  save: { target?: 'file' | 'browser'; saveAs?: boolean; overwriteToken?: number };
  frame: { resolve: (accepted: boolean) => void };
  import: { value: ImportProposal; isNew: boolean };
  leave: { label: string; action: () => void };
  fileConflict: LocalConflict;
  topology: { command: TopologyCommand; token: number; baseMap: YardMap; turns: { id: string; incomingArc: ArcRef; outgoingArc: ArcRef }[] };
}
export type EditorDialog = { [K in keyof DialogValues]: { kind: K; value: DialogValues[K]; context: DraftContext } }[keyof DialogValues];
interface ActivityValues { relocate: { kind: 'accessPoints' | 'servicePoints'; id: string }; road: DraftRoad; polygon: true; point: PointCreationDraft; boundary: true; splitPick: true }
export type EditorActivity = { kind: 'idle' } | { [K in keyof ActivityValues]: { kind: K; value: ActivityValues[K]; context: DraftContext } }[keyof ActivityValues];
export interface InteractionState { tool: Tool; activity: EditorActivity; dialog: EditorDialog | null }
export type InteractionEvent = { type: 'tool'; tool: Tool } | { type: 'activity'; activity: EditorActivity } | { type: 'dialog'; dialog: EditorDialog | null } | { type: 'reset' };
export const initialInteraction: InteractionState = { tool: 'select', activity: { kind: 'idle' }, dialog: null };
export function interactionReducer(state: InteractionState, event: InteractionEvent): InteractionState {
  switch (event.type) {
    case 'reset': return initialInteraction;
    case 'tool': return state.tool === event.tool ? state : { ...state, tool: event.tool };
    case 'activity': return { ...state, activity: event.activity };
    case 'dialog': return { ...state, dialog: event.dialog };
  }
}
export function sameDraftContext(a: DraftContext, b: DraftContext): boolean {
  return a.projectId === b.projectId && a.changeToken === b.changeToken && a.mapContentHash === b.mapContentHash;
}
/** One exclusive activity and one typed dialog; setters preserve existing UI call sites during migration. */
export function useEditorInteraction(context: () => DraftContext) {
  const [state, dispatch] = useReducer(interactionReducer, initialInteraction);
  const current = useRef(state); const getContext = useRef(context); getContext.current = context;
  function send(event: InteractionEvent) { current.current = interactionReducer(current.current, event); dispatch(event); }
  function dialogField<K extends keyof DialogValues>(kind: K): [DialogValues[K] | null, (value: SetStateAction<DialogValues[K] | null>) => void] {
    const shown = state.dialog?.kind === kind ? state.dialog.value as DialogValues[K] : null;
    return [shown, value => {
      const before = current.current.dialog;
      const old = before?.kind === kind ? before.value as DialogValues[K] : null;
      const next = typeof value === 'function' ? value(old) : value;
      if (Object.is(old, next)) return;
      if (next === null) { if (old !== null) send({ type: 'dialog', dialog: null }); return; }
      send({ type: 'dialog', dialog: { kind, value: next, context: before?.kind === kind ? before.context : getContext.current() } as EditorDialog });
    }];
  }
  function booleanDialog(kind: 'new' | 'copy' | 'upgrade' | 'delete' | 'rotate' | 'split' | 'recent' | 'storageConflict'): [boolean, (value: boolean) => void] {
    const [shown, set] = dialogField(kind); return [shown === true, value => set(value ? true : null)];
  }
  function activityField<K extends keyof ActivityValues>(kind: K): [ActivityValues[K] | null, (value: SetStateAction<ActivityValues[K] | null>) => void] {
    const shown = state.activity.kind === kind ? (state.activity as Exclude<EditorActivity, { kind: 'idle' }>).value : null;
    return [shown as ActivityValues[K] | null, value => {
      const before = current.current.activity;
      const old = before.kind === kind ? (before as Exclude<EditorActivity, { kind: 'idle' }>).value as ActivityValues[K] : null;
      const next = typeof value === 'function' ? value(old) : value;
      if (Object.is(old, next)) return;
      if (next === null) { if (old !== null) send({ type: 'activity', activity: { kind: 'idle' } }); return; }
      send({ type: 'activity', activity: { kind, value: next, context: before.kind === kind && 'context' in before ? before.context : getContext.current() } as EditorActivity });
    }];
  }
  function booleanActivity(kind: 'polygon' | 'boundary' | 'splitPick'): [boolean, (value: boolean) => void] {
    const [shown, set] = activityField(kind); return [shown === true, value => set(value ? true : null)];
  }
  return { state, read: () => current.current, reset: () => send({ type: 'reset' }), setTool: (tool: Tool) => send({ type: 'tool', tool }), dialogField, booleanDialog, activityField, booleanActivity };
}
