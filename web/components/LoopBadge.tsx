import type { IntentionStatus } from '../../src/core/types.js';

/**
 * A loop's state, rendered the way the model reads: `armed` is under tension
 * (salience pinned at 100), `fired` relaxes, `closed` has been purged.
 */
const LABELS: Record<IntentionStatus, { icon: string; label: string }> = {
  armed: { icon: '🔁', label: 'open' },
  fired: { icon: '⏰', label: 'surfaced' },
  closed: { icon: '✅', label: 'closed' },
  expired: { icon: '💤', label: 'expired' },
};

export function LoopBadge({ status }: { status: IntentionStatus }) {
  const { icon, label } = LABELS[status];
  return (
    <span className="loop-badge" data-status={status} title={`Loop ${label}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}
