import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKBENCH_PREFERENCES, validateWorkbenchPreferences } from '../../src/editor/workbench';
import { validateEditorState, ProjectPersistenceError, DEFAULT_DRAWING_CONFIG } from '../../src/editor/projectController';
describe('RF01 exclusive interaction and editor-only preferences', () => {
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
