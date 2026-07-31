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

/** Readable duration: "2d ago", "in 3h". */
function relative(from: Date, to: Date): string {
  const ms = to.getTime() - from.getTime();
  const future = ms > 0;
  const abs = Math.abs(ms);

  const hours = Math.floor(abs / 3_600_000);
  const days = Math.floor(hours / 24);

  const value = days >= 1 ? `${days}d` : hours >= 1 ? `${hours}h` : `${Math.floor(abs / 60_000)}min`;
  return future ? `in ${value}` : `${value} ago`;
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
          <span className="loop-overdue" title="Deadline passed — will expire on the next sweep">
            deadline passed
          </span>
        )}
      </div>

      <p className="loop-content">{intention.content}</p>
      <LoopTension intention={intention} now={now} />

      <p className="loop-meta">
        {intention.directory} · armed {relative(intention.createdAt, now)}
        {intention.expiresAt && ` · due ${relative(now, intention.expiresAt)}`}
        {intention.closedByCommit && ` · closed by ${intention.closedByCommit.slice(0, 7)}`}
      </p>

      {cues.length > 0 && (
        <ul className="cue-list" aria-label="Triggers">
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
            Close
          </button>
          {intention.status === 'armed' && (
            <button
              type="button"
              className="secondary"
              onClick={() => run(onFire)}
              disabled={busy || armedCues.length === 0}
              title={armedCues.length === 0 ? 'No armed cue to fire' : 'Force the wake-up (debug)'}
            >
              Wake
            </button>
          )}

          {/* Irreversible deletion: never a single click. */}
          {confirmingDelete ? (
            <>
              <button type="button" className="danger" onClick={() => run(onDelete)} disabled={busy}>
                Confirm deletion
              </button>
              <button type="button" className="secondary" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmingDelete(true)} disabled={busy}>
              Delete
            </button>
          )}
        </div>
      )}
    </li>
  );
}
