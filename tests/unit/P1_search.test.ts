import { expect, it } from 'vitest';
import type { SceneItem } from '../../src/adapters/contracts';
import { findItems } from '../../src/app/ui/search';

const item = (kind: SceneItem['kind'], id: string, name: string) => ({ key: kind + '/' + id, kind, id, name }) as SceneItem;

it('palette search puts the exact ID first, then prefixes, then substrings, ties by directory kind order', () => {
  // Scene order lists the extension first; it only mentions the ID inside its own name.
  const items = [
    item('extensions', 'shipyard.reference:/facilities/F_HW001', 'shipyard.reference · /facilities/F_HW001'),
    item('roads', 'R_F_HW0010', '通往 F_HW001 的道路'),
    item('accessPoints', 'F_HW001_A', '入口'),
    item('facilities', 'F_HW001', '生产厂房 HW001'),
    item('facilities', 'F_HW002', '生产厂房 HW002'),
  ];
  expect(findItems(items, ' f_hw001 ').map(entry => entry.id)).toEqual(['F_HW001', 'F_HW001_A', 'R_F_HW0010', 'shipyard.reference:/facilities/F_HW001']);
  expect(findItems(items, '生产厂房').map(entry => entry.id)).toEqual(['F_HW001', 'F_HW002']);
  expect(findItems(items, '')).toEqual([]);
  expect(findItems(items, 'F_HW', 2)).toHaveLength(2);
});
