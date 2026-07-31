import { useCallback } from 'react';
import { api } from './api/client.js';
import { useAsync } from './hooks/useAsync.js';
import { LoopBadge } from './components/LoopBadge.tsx';

/**
 * Coquille de l'application React (story S6-01).
 *
 * Elle ne fait pour l'instant que prouver la chaîne complète : bundle bun →
 * servi par Hono → appel de l'API prospective → types partagés avec le back.
 * L'onglet prospectif réel (tension des boucles, cues, fermeture) arrive en
 * S6-02 et remplacera cette liste minimale.
 */
export function App() {
  const loops = useAsync(() => api.listIntentions({ status: 'armed' }), []);

  const handleResolve = useCallback(async () => {
    await api.resolveCues();
    loops.reload();
  }, [loops]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span aria-hidden="true">🧠</span> humemory
        </h1>
        <p className="tagline">Boucles ouvertes — mémoire prospective</p>
      </header>

      <main>
        <section aria-labelledby="loops-heading">
          <div className="section-head">
            <h2 id="loops-heading">Boucles ouvertes</h2>
            <button type="button" onClick={handleResolve} disabled={loops.loading}>
              Passer le balai
            </button>
          </div>

          {loops.loading && <p role="status">Chargement…</p>}

          {loops.error && (
            <p role="alert" className="error">
              Impossible de charger les boucles : {loops.error.message}
            </p>
          )}

          {!loops.loading && !loops.error && loops.data?.count === 0 && (
            <p className="empty">Aucune boucle ouverte. Rien ne tire sur la manche.</p>
          )}

          <ul className="loop-list">
            {loops.data?.intentions.map((intention) => (
              <li key={intention.id} className="loop">
                <div className="loop-head">
                  <code>{intention.loopId}</code>
                  <LoopBadge status={intention.status} />
                </div>
                <p className="loop-content">{intention.content}</p>
                <p className="loop-meta">{intention.directory}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
