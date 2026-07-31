import { useState } from 'react';
import type { Memory } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';

/**
 * Traces similaires et fusion — portage de `showSimilar`/`confirmMerge`.
 *
 * La fusion est irréversible : la trace source passe au niveau 4 et sa saillance
 * est reversée à la cible. L'original s'en remettait à `confirm()`, qui bloque
 * l'onglet et n'affiche que du texte brut ; ici la confirmation est inline et
 * montre les deux traces concernées, pour qu'on voie ce qu'on fusionne.
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
      <h4>Traces similaires</h4>

      {similar.loading && <p role="status">Recherche en cours…</p>}
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
        <p className="empty">Aucune trace assez proche pour être fusionnée.</p>
      )}

      {results.map(({ memory: candidate, score }) => (
        <div key={candidate.id} className="similar-item">
          <p>
            {candidate.content.slice(0, 120)}
            {candidate.content.length > 120 ? '…' : ''}
          </p>
          <span className="score">Score {Math.round(score)}</span>
          <button type="button" className="secondary" onClick={() => setPending(candidate)} disabled={busy}>
            🔀 Fusionner
          </button>
        </div>
      ))}

      {pending && (
        <div className="merge-confirm" role="alertdialog" aria-label="Confirmer la fusion">
          <p>
            Fusionner cette trace <strong>dans</strong> :
          </p>
          <blockquote>{pending.content.slice(0, 160)}</blockquote>
          <p className="merge-warning">
            La trace courante passera au niveau 4 (fusionnée) et sa force sera reversée à la cible.
            C&apos;est irréversible.
          </p>
          <div className="loop-actions">
            <button type="button" className="danger" onClick={() => merge(pending)} disabled={busy}>
              {busy ? 'Fusion…' : 'Confirmer la fusion'}
            </button>
            <button type="button" className="secondary" onClick={() => setPending(null)} disabled={busy}>
              Annuler
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
