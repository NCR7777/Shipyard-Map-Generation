import { sameValue } from '../domain/value';
/** Compare proposals with original values; untouched fields never pass through display text. */
export function changedFields<T extends object>(original: T, proposed: Partial<T>): Partial<T> {
  return Object.fromEntries(Object.entries(proposed).filter(([key, value]) => !sameValue(original[key as keyof T], value))) as Partial<T>;
}
export function unitFactor(unit: string): number {
  return unit === 't' ? 1000 : unit === 'km/h' ? 1 / 3.6 : unit === 'deg' ? Math.PI / 180 : 1;
}
export function readNumber(text: string, factor = 1): number | null {
  if (!text.trim()) return null;
  const value = Number(text) * factor;
  return Number.isFinite(value) ? value : null;
}
