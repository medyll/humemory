import type { Intention } from '../../src/core/types.js';
import { intentionSaillance } from '../../src/core/cues.js';

/**
 * Tension d'une boucle ouverte.
 *
 * La valeur n'est pas recalculée ici : elle vient d'`intentionSaillance`, la
 * même fonction que le back. Le front affiche la règle, il ne la réinvente pas —
 * sinon les deux divergeraient au premier ajustement.
 *
 * Lecture : `armed` reste tendue à 100 (une boucle ouverte ne s'oublie pas),
 * `fired` se relâche avec les jours (le Zeigarnik s'émousse), `closed` et
 * `expired` sont à plat.
 */
export function LoopTension({ intention, now }: { intention: Intention; now: Date }) {
  const value = intentionSaillance(intention, now);
  const pinned = intention.status === 'armed';

  return (
    <div className="tension" data-status={intention.status}>
      <div
        className="tension-bar"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Tension ${value} sur 100`}
      >
        <span className="tension-fill" style={{ width: `${value}%` }} />
      </div>
      <span className="tension-value">
        {value}
        {pinned && (
          <span className="tension-pin" title="Saillance figée tant que la boucle est ouverte">
            {' '}
            figée
          </span>
        )}
      </span>
    </div>
  );
}
