import { useCallback, useMemo, useState } from 'react';
import type { IntentionStatus, Cue } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { hydrateIntention, hydrateCue } from '../api/hydrate.js';
import { useAsync } from '../hooks/useAsync.js';
import { LoopCard } from './LoopCard.tsx';
import { NewLoopForm } from './NewLoopForm.tsx';

const FILTERS: Array<{ value: IntentionStatus | 'all'; label: string }> = [
  { value: 'armed', label: 'Ouvertes' },
  { value: 'fired', label: 'Remontées' },
  { value: 'closed', label: 'Fermées' },
  { value: 'expired', label: 'Expirées' },
  { value: 'all', label: 'Toutes' },
];

/**
 * Onglet prospectif.
 *
 * Montre ce que le reste du système ne montrait qu'en markdown : les boucles
 * ouvertes, leur tension, leurs déclencheurs, et de quoi les fermer.
 */
export function LoopsTab() {
  const [filter, setFilter] = useState<IntentionStatus | 'all'>('armed');
  const [directory, setDirectory] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Instant de référence de ce rendu : la tension se calcule contre lui, pas
  // contre un Date.now() appelé dans chaque carte, sinon deux boucles affichées
  // côte à côte pourraient être évaluées à des instants différents.
  const now = useMemo(() => new Date(), [filter, directory, notice]);

  const loops = useAsync(async () => {
    const { intentions } = await api.listIntentions({
      status: filter === 'all' ? undefined : filter,
      directory: directory.trim() || undefined,
    });

    // Les cues arrivent par un second appel, un par boucle : l'API n'a pas de
    // route de liste jointe et en inventer une pour l'écran serait prématuré.
    const withCues = await Promise.all(
      intentions.map(async (dto) => {
        const detail = await api.getIntention(dto.id).catch(() => null);
        return {
          intention: hydrateIntention(dto),
          cues: (detail?.cues ?? []).map(hydrateCue) as Cue[],
        };
      })
    );

    return withCues;
  }, [filter, directory]);

  const refresh = loops.reload;

  const handleCreate = useCallback(
    async (input: Parameters<typeof api.createIntention>[0]) => {
      const { intention } = await api.createIntention(input);
      setNotice(`${intention.loopId} armée.`);
      refresh();
    },
    [refresh]
  );

  const handleClose = useCallback(
    async (id: string) => {
      await api.closeIntention(id);
      refresh();
    },
    [refresh]
  );

  const handleFire = useCallback(
    async (id: string) => {
      await api.fireIntention(id);
      refresh();
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await api.deleteIntention(id);
      refresh();
    },
    [refresh]
  );

  const handleResolve = useCallback(async () => {
    const { expired, count } = await api.resolveCues();
    setNotice(`${expired} expirée(s), ${count} réveillée(s).`);
    refresh();
  }, [refresh]);

  return (
    <>
      <section aria-labelledby="new-heading">
          <h2 id="new-heading">Armer une boucle</h2>
          <NewLoopForm defaultDirectory={directory || '.'} onSubmit={handleCreate} />
        </section>

        <section aria-labelledby="loops-heading">
          <div className="section-head">
            <h2 id="loops-heading">Boucles</h2>
            <button type="button" onClick={handleResolve} disabled={loops.loading}>
              Passer le balai
            </button>
          </div>

          <div className="filters">
            <div className="filter-tabs" role="group" aria-label="Filtrer par état">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className={filter === f.value ? 'tab active' : 'tab'}
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                >
                  {f.label}
                </button>
              ))}
            </div>

            <input
              className="filter-directory"
              value={directory}
              onChange={(e) => setDirectory(e.target.value)}
              placeholder="Filtrer par lieu mental"
              aria-label="Filtrer par lieu mental"
            />
          </div>

          {notice && (
            <p role="status" className="notice">
              {notice}
            </p>
          )}

          {loops.loading && <p role="status">Chargement…</p>}

          {loops.error && (
            <p role="alert" className="error">
              Impossible de charger les boucles : {loops.error.message}
            </p>
          )}

          {!loops.loading && !loops.error && loops.data?.length === 0 && (
            <p className="empty">
              {filter === 'armed'
                ? 'Aucune boucle ouverte. Rien ne tire sur la manche.'
                : 'Aucune boucle dans cet état.'}
            </p>
          )}

          <ul className="loop-list">
            {loops.data?.map(({ intention, cues }) => (
              <LoopCard
                key={intention.id}
                intention={intention}
                cues={cues}
                now={now}
                onClose={handleClose}
                onFire={handleFire}
                onDelete={handleDelete}
              />
            ))}
          </ul>
      </section>
    </>
  );
}
