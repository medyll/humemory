import type { DecayLevel } from '../../src/core/types.js';

/** Couleurs des niveaux de dégradation — vert (frais) vers gris (perdu). */
export const LEVEL_COLORS: Record<DecayLevel, string> = {
  0: '#22c55e',
  1: '#eab308',
  2: '#f97316',
  3: '#ef4444',
  4: '#6b7280',
};

export const LEVEL_LABELS = [
  'L0 — Encodage',
  'L1 — Consolidation',
  'L2 — Stable',
  'L3 — Fragile',
  'L4 — Sommeil',
] as const;

/** Nom court du niveau, sans le préfixe. */
export function levelName(level: DecayLevel): string {
  return LEVEL_LABELS[level].split('—')[1]?.trim() ?? String(level);
}

/** Contexte passé aux vues impératives : ce dont elles ont besoin du reste de l'app. */
export interface VizContext {
  onSelectMemory?: (id: string) => void;
}
