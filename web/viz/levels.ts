import type { DecayLevel } from '../../src/core/types.js';

/** Decay level colours — green (fresh) to grey (lost). */
export const LEVEL_COLORS: Record<DecayLevel, string> = {
  0: '#22c55e',
  1: '#eab308',
  2: '#f97316',
  3: '#ef4444',
  4: '#6b7280',
};

export const LEVEL_LABELS = [
  'L0 — Encoding',
  'L1 — Consolidation',
  'L2 — Stable',
  'L3 — Fragile',
  'L4 — Dormant',
] as const;

/** Short level name, without the prefix. */
export function levelName(level: DecayLevel): string {
  return LEVEL_LABELS[level].split('—')[1]?.trim() ?? String(level);
}

/** Context handed to imperative views: what they need from the rest of the app. */
export interface VizContext {
  onSelectMemory?: (id: string) => void;
}
