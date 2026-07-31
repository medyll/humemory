import { useEffect, useRef, useState } from 'react';

/**
 * React host for a view that owns its own DOM (d3, three.js, canvas).
 *
 * These visualisations are imperative by nature: d3 owns its SVG subtree,
 * three.js its WebGL canvas. Rewriting them in JSX would gain nothing and cost a
 * lot — we lend them a container and stop touching its contents. React only ever
 * sees an empty `<div>`, which is exactly right.
 *
 * The module is loaded dynamically: three.js and d3 are heavy, and there is no
 * reason to make someone who never opens the tab download them.
 */

/** Contract of an imperative view: it takes a container and returns its teardown. */
export type ImperativeMount = (container: HTMLElement) => Promise<() => void> | (() => void);

export interface ImperativeViewProps {
  /** Dynamic import of the view module. */
  load: () => Promise<{ mount: ImperativeMount }>;
  /** Replayed as is; changing the key remounts the view. */
  viewKey: string;
  height?: number;
  label: string;
}

export function ImperativeView({ load, viewKey, height = 600, label }: ImperativeViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    setLoading(true);
    setError(null);

    load()
      .then(({ mount }) => mount(container))
      .then((dispose) => {
        // Unmounted before loading finished: clean up right away, otherwise an
        // animation keeps running inside a detached container.
        if (disposed) {
          dispose?.();
          return;
        }
        cleanup = dispose ?? null;
        setLoading(false);
      })
      .catch((err) => {
        if (disposed) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });

    return () => {
      disposed = true;
      cleanup?.();
      container.innerHTML = '';
    };
  }, [viewKey]);

  return (
    <div className="imperative-view">
      {loading && <p role="status">Loading {label}…</p>}
      {error && (
        <p role="alert" className="error">
          {label} unavailable: {error.message}
        </p>
      )}
      <div ref={ref} className="imperative-canvas" style={{ height }} aria-label={label} />
    </div>
  );
}
