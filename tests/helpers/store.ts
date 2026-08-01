import { SQLiteStore } from '../../src/store/sqlite.js';
import type { Clock } from '../../src/core/clock.js';
import { fakeClock } from './clock.js';

/**
 * Hermetic store: `:memory:` database, nothing on disk, nothing shared between
 * tests. The clock is frozen at T0 by default — pass your own to drive time.
 *
 * ```ts
 * const clock = fakeClock();
 * const store = freshStore({ clock });
 * clock.advanceHours(25);
 * await store.updateDecay();
 * ```
 */
export function freshStore(options: { clock?: Clock } = {}): SQLiteStore {
  return new SQLiteStore(':memory:', { clock: options.clock ?? fakeClock() });
}
