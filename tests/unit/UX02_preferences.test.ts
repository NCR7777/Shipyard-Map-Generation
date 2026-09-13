import { describe, expect, it } from 'vitest';
import { validateEditorState } from '../../src/editor/projectController';
describe('UX02 preference compatibility', () => {
  const camera = { offsetX: 0, offsetY: 0, scale: 1 };
  it('leaves old editor state unchanged and rejects invalid display units', () => {
    expect(validateEditorState({ camera }).propertyUnits).toBeUndefined();
    expect(validateEditorState({ camera, propertyUnits: { mass: 'kg' } }).propertyUnits).toEqual({ mass: 'kg', speed: 'km/h', angle: 'deg' });
    for (const propertyUnits of [null, { mass: 'lb' }, { speed: 'kn' }, { angle: 'turn' }, { scale: 2 }]) expect(() => validateEditorState({ camera, propertyUnits })).toThrow();
  });
});
