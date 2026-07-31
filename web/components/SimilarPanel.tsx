import { useState } from 'react';
import type { Memory } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';

/**
 * Similar traces and merging — ported from `showSimilar`/`confirmMerge`.
 *
 * A merge is irreversible: the source trace drops to level 4 and its salience is
 * transferred to the target. The original relied on `confirm()`, which blocks the
 * tab and can only render plain text; here the confirmation is inline and shows
 * both traces, so you can see what you are merging.
 */

export interface SimilarPanelProps {
  memory: Memory;
  onMerged: () => void;
}

export function SimilarPanel({ memory, onMerged }: SimilarPanelProps) {
  const [pending, setPending] = useState<Memory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const similar = useAsync(
    () => api.findSimilar(memory.id, { limit: 5, threshold: 30 }),
    [memory.id]
  );

  const merge = async (target: Memory) => {
    setBusy(true);
    setError(null);
    try {
      await api.mergeMemories(memory.id, target.id);
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setPending(null);
    }
  };

  const results = similar.data?.results ?? [];

  return (
    <div className="similar-panel">
      <h4>Similar traces</h4>

      {similar.loading && <p role="status">Searching…</p>}
      {similar.error && (
        <p role="alert" className="error">
          {similar.error.message}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      {!similar.loading && results.length === 0 && (
        <p className="empty">No trace close enough to merge.</p>
      )}

      {results.map(({ memory: candidate, score }) => (
        <div key={candidate.id} className="similar-item">
          <p>
            {candidate.content.slice(0, 120)}
            {candidate.content.length > 120 ? '…' : ''}
          </p>
          <span className="score">Score {Math.round(score)}</span>
          <button type="button" className="secondary" onClick={() => setPending(candidate)} disabled={busy}>
            🔀 Merge
          </button>
        </div>
      ))}

      {pending && (
        <div className="merge-confirm" role="alertdialog" aria-label="Confirm the merge">
          <p>
            Merge this trace <strong>into</strong>:
          </p>
          <blockquote>{pending.content.slice(0, 160)}</blockquote>
          <p className="merge-warning">
            The current trace will drop to level 4 (merged) and its strength will be transferred
            to the target. This is irreversible.
          </p>
          <div className="loop-actions">
            <button type="button" className="danger" onClick={() => merge(pending)} disabled={busy}>
              {busy ? 'Merging…' : 'Confirm the merge'}
            </button>
            <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
