import { FakeClock } from '../../src/core/clock.js';

/**
 * Époque de référence des tests. Toute suite qui a besoin d'une date part d'ici,
 * pour que les assertions soient lisibles (« +25h » plutôt qu'un timestamp opaque).
 */
export const T0 = new Date('2026-01-01T00:00:00.000Z');

/** Horloge de test positionnée sur T0, sauf indication contraire. */
export function fakeClock(start: Date | string | number = T0): FakeClock {
  return new FakeClock(start);
}

/** Seuils de decay en heures (miroir de DECAY_CONFIG.levelThresholds). */
export const HOURS = {
  L1: 24, // 1 jour
  L2: 168, // 1 semaine
  L3: 720, // 1 mois
  L4: 2160, // 3 mois
} as const;
