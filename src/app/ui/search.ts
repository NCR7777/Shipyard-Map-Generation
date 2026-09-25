import type { SceneItem } from '../../adapters/contracts';
import { KIND_ORDER } from './labels';

/** Palette object search: exact ID or name first, then prefixes, then substrings; ties follow the directory's kind order. */
export function findItems(items: readonly SceneItem[], query: string, limit = 30): SceneItem[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const ranked: { item: SceneItem; order: number }[] = [];
  for (const item of items) {
    const id = item.id.toLowerCase(), name = item.name.toLowerCase();
    if (!id.includes(needle) && !name.includes(needle)) continue;
    const quality = id === needle || name === needle ? 0 : id.startsWith(needle) || name.startsWith(needle) ? 1 : 2;
    ranked.push({ item, order: quality * KIND_ORDER.length + KIND_ORDER.indexOf(item.kind) });
  }
  return ranked.sort((a, b) => a.order - b.order).slice(0, limit).map(entry => entry.item);
}
