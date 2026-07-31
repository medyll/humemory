import type { IntentionStatus } from '../../src/core/types.js';

/**
 * État d'une boucle, rendu tel qu'il se lit dans le modèle : `armed` est en
 * tension (saillance figée à 100), `fired` se relâche, `closed` est purgée.
 */
const LABELS: Record<IntentionStatus, { icon: string; label: string }> = {
  armed: { icon: '🔁', label: 'ouverte' },
  fired: { icon: '⏰', label: 'remontée' },
  closed: { icon: '✅', label: 'fermée' },
  expired: { icon: '💤', label: 'expirée' },
};

export function LoopBadge({ status }: { status: IntentionStatus }) {
  const { icon, label } = LABELS[status];
  return (
    <span className="loop-badge" data-status={status} title={`Boucle ${label}`}>
      <span aria-hidden="true">{icon}</span> {label}
    </span>
  );
}
