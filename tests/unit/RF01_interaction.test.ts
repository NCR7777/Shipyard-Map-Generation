import { describe, expect, it } from 'vitest';
import { initialInteraction, interactionReducer, sameDraftContext, type EditorDialog } from '../../src/ui/useEditorInteraction';
import { DEFAULT_WORKBENCH_PREFERENCES, validateWorkbenchPreferences } from '../../src/editor/workbench';
import { validateEditorState, ProjectPersistenceError, DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
const context = { projectId: 'project_one', changeToken: 3, mapContentHash: 'before' };
describe('RF01 exclusive interaction and editor-only preferences', () => {
  it('replaces the single dialog, preserves activity on cancel, and clears both on project restore', () => {
    const drawing = interactionReducer(initialInteraction, { type: 'activity', activity: { kind: 'road', value: { fromNodeId: 'n1', points: [] }, context } });
    const opened = interactionReducer(drawing, { type: 'dialog', dialog: { kind: 'save', value: { target: 'browser' }, context } });
    const replaced = interactionReducer(opened, { type: 'dialog', dialog: { kind: 'leave', value: { label: 'leave', action: () => {} }, context } as EditorDialog });
    expect(replaced.dialog?.kind).toBe('leave');
    expect(interactionReducer(replaced, { type: 'dialog', dialog: null }).activity).toEqual(drawing.activity);
    expect(interactionReducer(replaced, { type: 'reset' })).toEqual(initialInteraction);
  });
  it('rejects old project, map and undo/redo tokens independently of camera', () => {
    expect(sameDraftContext(context, { ...context })).toBe(true);
    for (const patch of [{ projectId: 'project_two' }, { changeToken: 4 }, { mapContentHash: 'after' }]) expect(sameDraftContext(context, { ...context, ...patch })).toBe(false);
  });
  it('keeps old editor records compatible and validates every new persisted field', () => {
    const camera = { offsetX: 1, offsetY: 2, scale: 3 };
    expect(validateEditorState({ camera })).toEqual({ camera, drawing: DEFAULT_DRAWING_CONFIG });
    const workbench = { ...DEFAULT_WORKBENCH_PREFERENCES, saveTarget: 'browser' as const, leftWidth: 260 };
    const state = validateEditorState({ camera, workbench });
    expect(state.workbench).toEqual(workbench); expect(validateEditorState(state)).toEqual(state);
    for (const invalid of [{ saveTarget: 'cloud' }, { leftWidth: Infinity }, { rightCollapsed: null }, { unknown: true }]) expect(() => validateEditorState({ camera, workbench: invalid })).toThrow(ProjectPersistenceError);
    expect(validateWorkbenchPreferences(undefined)).toEqual(DEFAULT_WORKBENCH_PREFERENCES);
  });
});
