import { useCallback, useRef } from 'react';

/** Stable subscription identity; dispatch always reads the current render's guards and actions. */
export function useCurrentCallback<Args extends unknown[], Result>(callback: (...args: Args) => Result) {
  const current = useRef(callback); current.current = callback;
  return useCallback((...args: Args) => current.current(...args), []);
}
