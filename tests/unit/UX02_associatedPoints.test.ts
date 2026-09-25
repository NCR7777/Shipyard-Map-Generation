import { expect, it } from 'vitest';
import type { SceneSnapshot } from '../../src/adapters/contracts';
import { associatedPointGroups } from '../../src/app/canvas/renderer';

it('UX02 groups business identities only by shared node reference, never coincident coordinates', () => {
  const scene = {
    accessPoints: [{ id: 'a', name: 'door', nodeId: 'n', position: [1, 2, 3] }, { id: 'a2', name: 'independent door', nodeId: 'n2', position: [1, 2, 3] }],
    servicePoints: [{ id: 's', name: 'loading', nodeId: 'n', position: [1, 2, 3] }],
  } as Pick<SceneSnapshot, 'accessPoints' | 'servicePoints'>;
  const copy = structuredClone(scene), groups = associatedPointGroups(scene);
  expect(groups.map(g => g.map(p => p.id))).toEqual([['a', 's'], ['a2']]);
  expect(associatedPointGroups(scene, ['accessPoints']).map(g => g.map(p => p.id))).toEqual([['s']]);
  expect(associatedPointGroups(scene, [], new Set(['accessPoints/a', 'accessPoints/a2'])).map(g => g.map(p => p.id))).toEqual([['a', 's'], ['a2']]);
  expect(associatedPointGroups(scene, [], new Set(['accessPoints/a'])).map(g => g.map(p => p.id))).toEqual([['a', 's']]);
  expect(associatedPointGroups(scene, ['servicePoints'], new Set(['accessPoints/a'])).map(g => g.map(p => p.id))).toEqual([['a']]);
  expect(associatedPointGroups(scene, ['accessPoints'], new Set(['accessPoints/a'])).map(g => g.map(p => p.id))).toEqual([]);
  expect(scene).toEqual(copy);
});
