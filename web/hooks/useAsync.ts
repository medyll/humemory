import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Re-runs the request. Stable, so it can be used as an effect dependency. */
  reload: () => void;
}

/**
 * Loads an asynchronous value and tracks its state.
 *
 * Two precautions that avoid the classic bugs:
 * - an unmounted component receives no more `setState` (no React warning);
 * - a response arriving after a newer request is ignored, otherwise a slow load
 *   would overwrite a fresher result.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  const mounted = useRef(true);
  const requestId = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);

    fn().then(
      (value) => {
        if (!mounted.current || id !== requestId.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err) => {
        if (!mounted.current || id !== requestId.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, reload };
}
