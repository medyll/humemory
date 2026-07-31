import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Relance la requête. Stable : utilisable en dépendance d'effet. */
  reload: () => void;
}

/**
 * Charge une valeur asynchrone et suit son état.
 *
 * Deux précautions qui évitent les bugs classiques :
 * - un composant démonté ne reçoit plus de `setState` (pas d'avertissement React) ;
 * - une réponse arrivée après une requête plus récente est ignorée, sinon un
 *   chargement lent écraserait un résultat plus frais.
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
