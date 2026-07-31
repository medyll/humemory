import { useEffect, useRef, useState } from 'react';

/**
 * Hôte React pour une vue qui gère elle-même son DOM (d3, three.js, canvas).
 *
 * Ces visualisations sont impératives par nature : d3 possède son sous-arbre SVG,
 * three.js son canvas WebGL. Les réécrire en JSX n'apporterait rien et coûterait
 * cher — on leur prête un conteneur et on ne touche plus à son contenu. React ne
 * voit qu'une `<div>` vide, ce qui est exactement ce qu'il faut.
 *
 * Le module est chargé dynamiquement : three.js et d3 pèsent lourd, et rien ne
 * justifie de les faire télécharger à quelqu'un qui ne visite jamais l'onglet.
 */

/** Contrat d'une vue impérative : elle prend un conteneur, elle rend de quoi se démonter. */
export type ImperativeMount = (container: HTMLElement) => Promise<() => void> | (() => void);

export interface ImperativeViewProps {
  /** Import dynamique du module de la vue. */
  load: () => Promise<{ mount: ImperativeMount }>;
  /** Rejoué à l'identique, un changement de clé remonte la vue. */
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
        // Démonté avant la fin du chargement : on nettoie tout de suite, sinon
        // une animation continue de tourner dans un conteneur détaché.
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
      {loading && <p role="status">Chargement de {label}…</p>}
      {error && (
        <p role="alert" className="error">
          {label} indisponible : {error.message}
        </p>
      )}
      <div ref={ref} className="imperative-canvas" style={{ height }} aria-label={label} />
    </div>
  );
}
