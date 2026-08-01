import { FakeClock } from '../../src/core/clock.js';

/**
 * Reference epoch for the tests. Every suite that needs a date starts here, so
 * assertions stay readable ("+25h" rather than an opaque timestamp).
 */
export const T0 = new Date('2026-01-01T00:00:00.000Z');

/** Test clock positioned at T0 unless told otherwise. */
export function fakeClock(start: Date | string | number = T0): FakeClock {
  return new FakeClock(start);
}

/** Decay thresholds in hours (mirrors DECAY_CONFIG.levelThresholds). */
export const HOURS = {
  L1: 24, // 1 jour
  L2: 168, // 1 semaine
  L3: 720, // 1 mois
  L4: 2160, // 3 mois
} as const;
