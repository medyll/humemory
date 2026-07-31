import { useCallback, useMemo, useState } from 'react';
import type { IntentionStatus, Cue } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { hydrateIntention, hydrateCue } from '../api/hydrate.js';
import { useAsync } from '../hooks/useAsync.js';
import { LoopCard } from './LoopCard.tsx';
import { NewLoopForm } from './NewLoopForm.tsx';

const FILTERS: Array<{ value: IntentionStatus | 'all'; label: string }> = [
  { value: 'armed', label: 'Open' },
  { value: 'fired', label: 'Surfaced' },
  { value: 'closed', label: 'Closed' },
  { value: 'expired', label: 'Expired' },
  { value: 'all', label: 'All' },
];

/**
 * Prospective tab.
 *
 * Shows what the rest of the system only ever rendered as markdown: the open
 * loops, their tension, their triggers, and a way to close them.
 */
export function LoopsTab() {
  const [filter, setFilter] = useState<IntentionStatus | 'all'>('armed');
  const [directory, setDirectory] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Reference instant for this render: tension is computed against it rather
  // than a Date.now() called inside each card, otherwise two loops shown side by
  // side could be evaluated at different moments.
  const now = useMemo(() => new Date(), [filter, directory, notice]);

  const loops = useAsync(async () => {
    const { intentions } = await api.listIntentions({
      status: filter === 'all' ? undefined : filter,
      directory: directory.trim() || undefined,
    });

    // Cues come from a second call, one per loop: the API has no joined list
    // route and inventing one for this screen would be premature.
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
      setNotice(`${intention.loopId} armed.`);
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
    setNotice(`${expired} expired, ${count} woken.`);
    refresh();
  }, [refresh]);

  return (
    <>
      <section aria-labelledby="new-heading">
        <h2 id="new-heading">Arm a loop</h2>
        <NewLoopForm defaultDirectory={directory || '.'} onSubmit={handleCreate} />
      </section>

      <section aria-labelledby="loops-heading">
        <div className="section-head">
          <h2 id="loops-heading">Loops</h2>
          <button type="button" onClick={handleResolve} disabled={loops.loading}>
            Sweep
          </button>
        </div>

        <div className="filters">
          <div className="filter-tabs" role="group" aria-label="Filter by state">
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
            placeholder="Filter by mental place"
            aria-label="Filter by mental place"
          />
        </div>

        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}

        {loops.loading && <p role="status">Loading…</p>}

        {loops.error && (
          <p role="alert" className="error">
            Could not load the loops: {loops.error.message}
          </p>
        )}

        {!loops.loading && !loops.error && loops.data?.length === 0 && (
          <p className="empty">
            {filter === 'armed'
              ? 'No open loop. Nothing is tugging at your sleeve.'
              : 'No loop in this state.'}
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
