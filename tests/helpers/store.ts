import { SQLiteStore } from '../../src/store/sqlite.js';
import type { Clock } from '../../src/core/clock.js';
import { fakeClock } from './clock.js';

/**
 * Store hermétique : DB `:memory:`, aucune trace disque, aucun partage entre tests.
 * Horloge figée sur T0 par défaut — passe la tienne pour piloter le temps.
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
