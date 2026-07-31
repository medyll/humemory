import type { Memory, DecayLevel } from '../../src/core/types.js';

/**
 * Zones temporelles du palais — portage de `public/js/dashboard.js`.
 *
 * Une zone n'est pas un niveau de dégradation : c'est une lecture croisée de
 * l'âge, du niveau et de la force. Une trace jeune mais déjà exsangue tombe en
 * « fragile », pas en « encodage ».
 */
export const ZONES = {
  encoding: { label: 'Encodage récent', maxHours: 24 },
  consolidating: { label: 'En consolidation', maxHours: 24 * 7 },
  consolidated: { label: 'Consolidé', maxHours: 24 * 30 },
  fragile: { label: 'Fragile', maxHours: 24 * 90 },
  dormant: { label: 'En sommeil', maxHours: Infinity },
} as const;

export type Zone = keyof typeof ZONES;

export const ZONE_ORDER: Zone[] = ['encoding', 'consolidating', 'consolidated', 'fragile', 'dormant'];

const CONSOLIDATION_LABELS = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];

export function consolidationLabel(level: DecayLevel): string {
  return CONSOLIDATION_LABELS[level] ?? 'Inconnu';
}

export function memoryZone(memory: Memory, now: Date = new Date()): Zone {
  const hours = (now.getTime() - new Date(memory.createdAt).getTime()) / 3600_000;

  if (memory.currentLevel === 4) return 'dormant';
  if (memory.saillance < 30) return 'fragile';
  if (hours < ZONES.encoding.maxHours) return 'encoding';
  if (hours < ZONES.consolidating.maxHours) return 'consolidating';
  if (hours < ZONES.consolidated.maxHours) return 'consolidated';
  if (hours < ZONES.fragile.maxHours) return 'fragile';
  return 'dormant';
}

export function countByZone(memories: Memory[], now: Date = new Date()): Record<Zone, number> {
  const counts = { encoding: 0, consolidating: 0, consolidated: 0, fragile: 0, dormant: 0 };
  for (const memory of memories) counts[memoryZone(memory, now)]++;
  return counts;
}

const TYPE_META = {
  episodic: { icon: '📅', label: 'Épisodique' },
  semantic: { icon: '📖', label: 'Sémantique' },
  procedural: { icon: '⚡', label: 'Procédurale' },
} as const;

export function typeMeta(type: Memory['memoryType']) {
  return TYPE_META[type] ?? TYPE_META.semantic;
}

/** « il y a 3j », « à l'instant ». */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(date).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes}min`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days}j`;
  return `il y a ${Math.floor(days / 30)} mois`;
}
