import { useCallback, useEffect, useRef } from 'react';

/** Calls `fn` at most once per `ms`, at the end of the window, however often it is asked. */
export function useThrottle(fn: () => void, ms: number): () => void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  return useCallback(() => {
    if (timer.current !== null) return;
    timer.current = window.setTimeout(() => { timer.current = null; fnRef.current(); }, ms);
  }, [ms]);
}
