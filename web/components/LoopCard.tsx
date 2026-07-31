import { useState } from 'react';
import type { Cue } from '../../src/core/types.js';
import type { IntentionView } from '../api/hydrate.js';
import { formatTriggerSpec } from '../../src/core/cue-arg.js';
import { LoopBadge } from './LoopBadge.tsx';
import { LoopTension } from './LoopTension.tsx';

export interface LoopCardProps {
  intention: IntentionView;
  cues: Cue[];
  now: Date;
  onClose: (id: string) => Promise<void>;
  onFire: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

/** Durée lisible : « il y a 2j », « dans 3h ». */
function relative(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const future = ms > 0;
  const abs = Math.abs(ms);

  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);

  const value = days >= 1 ? `${days}j` : hours >= 1 ? `${hours}h` : `${Math.floor(abs / 60_000)}min`;
  return future ? `dans ${value}` : `il y a ${value}`;
}

export function LoopCard({ intention, cues, now, onClose, onFire, onDelete }: LoopCardProps) {
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const run = async (action: (id: string) => Promise<void>) => {
    setBusy(true);
    try {
      await action(intention.id);
    } finally {
      setBusy(false);
    }
  };

  const armedCues = cues.filter((c) => c.status === 'armed');
  const overdue = intention.expiresAt && intention.expiresAt.getTime() < now.getTime();

  return (
    <li className="loop" data-status={intention.status}>
      <div className="loop-head">
        <code>{intention.loopId}</code>
        <LoopBadge status={intention.status} />
        {overdue && intention.status === 'armed' && (
          <span className="loop-overdue" title="Échéance dépassée — sera expirée au prochain balai">
            échéance dépassée
          </span>
        )}
      </div>

      <p className="loop-content">{intention.content}</p>
      <LoopTension intention={intention} now={now} />

      <p className="loop-meta">
        {intention.directory} · armée {relative(intention.createdAt, now)}
        {intention.expiresAt && ` · échéance ${relative(now, intention.expiresAt)}`}
        {intention.closedByCommit && ` · fermée par ${intention.closedByCommit.slice(0, 7)}`}
      </p>

      {cues.length > 0 && (
        <ul className="cue-list" aria-label="Déclencheurs">
          {cues.map((cue) => (
            <li key={cue.id} className="cue" data-status={cue.status}>
              <code>{formatTriggerSpec(cue.triggerSpec)}</code>
              <span className="cue-status">{cue.status}</span>
            </li>
          ))}
        </ul>
      )}

      {intention.status !== 'closed' && (
        <div className="loop-actions">
          <button type="button" onClick={() => run(onClose)} disabled={busy}>
            Fermer
          </button>
          {intention.status === 'armed' && (
            <button
              type="button"
              className="secondary"
              onClick={() => run(onFire)}
              disabled={busy || armedCues.length === 0}
              title={armedCues.length === 0 ? 'Aucun cue armé à déclencher' : 'Forcer le réveil (debug)'}
            >
              Réveiller
            </button>
          )}

          {/* Suppression irréversible : jamais en un seul clic. */}
          {confirmingDelete ? (
            <>
              <button type="button" className="danger" onClick={() => run(onDelete)} disabled={busy}>
                Confirmer la suppression
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>
                Annuler
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Supprimer
            </button>
          )}
        </div>
      )}
    </li>
  );
}
