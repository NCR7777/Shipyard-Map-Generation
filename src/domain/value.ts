/** Exact JSON value equality; object key order is not semantic. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
  return Object.keys(aa).length === Object.keys(bb).length && Object.keys(aa).every(key => Object.hasOwn(bb, key) && sameValue(aa[key], bb[key]));
}
