/** Exact JSON value equality; object key order is not semantic. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every(key => Object.hasOwn(bb, key) && sameValue(aa[key], bb[key]));
}

const deepFrozen = new WeakSet<object>();
/** Freeze a JSON tree once. Already frozen subtrees are trusted, so shared unchanged entities cost nothing. */
export function freezeDeep<T>(value: T): T {
  const freeze = (item: unknown): void => { if (item !== null && typeof item === 'object' && !Object.isFrozen(item)) { Object.values(item).forEach(freeze); Object.freeze(item); } };
  // Only a root frozen here is known deep: a root frozen elsewhere may be shallow. Nested frozen values must come from freezeDeep.
  const owned = value !== null && typeof value === 'object' && !Object.isFrozen(value);
  freeze(value);
  if (owned) deepFrozen.add(value as object);
  return value;
}
/** Registered deep-frozen values never change, so derived results may be cached by identity. */
export function isDeepFrozen(value: unknown): value is object { return value !== null && typeof value === 'object' && deepFrozen.has(value); }
/** Identity cache of the 4 most recent results for deep-frozen inputs; results are frozen because every caller shares them.
 * A mutable input is recomputed and its result stays the caller's own. */
export function recentFor<K extends object, V>(entries: { key: K; value: V }[], key: K, compute: () => V): V {
  if (!isDeepFrozen(key)) return compute();
  const hit = entries.findIndex(entry => entry.key === key);
  if (hit >= 0) { const [entry] = entries.splice(hit, 1); entries.unshift(entry!); return entry!.value; }
  const value = freezeDeep(compute()); entries.unshift({ key, value }); entries.length = Math.min(entries.length, 4);
  return value;
}
