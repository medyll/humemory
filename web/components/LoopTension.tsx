import type { Intention } from '../../src/core/types.js';
import { intentionSaillance } from '../../src/core/cues.js';

/**
 * Tension of an open loop.
 *
 * The value is not recomputed here: it comes from `intentionSaillance`, the same
 * function the backend uses. The front end displays the rule, it does not
 * reinvent it — otherwise the two would drift apart at the first adjustment.
 *
 * Reading it: `armed` stays pinned at 100 (an open loop is not forgotten),
 * `fired` relaxes as days pass (the Zeigarnik pull fades), `closed` and
 * `expired` sit flat.
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
        aria-label={`Tension ${value} out of 100`}
      >
        <span className="tension-fill" style={{ width: `${value}%` }} />
      </div>
      <span className="tension-value">
        {value}
        {pinned && (
          <span className="tension-pin" title="Salience pinned while the loop stays open">
            {' '}
            pinned
          </span>
        )}
      </span>
    </div>
  );
}
