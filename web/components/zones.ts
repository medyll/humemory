import type { Memory, DecayLevel } from '../../src/core/types.js';

/**
 * Temporal zones of the palace — ported from `public/js/dashboard.js`.
 *
 * A zone is not a decay level: it reads age, level and strength together. A
 * young but already drained trace lands in "fragile", not in "encoding".
 */
export const ZONES = {
  encoding: { label: 'Recently encoded', maxHours: 24 },
  consolidating: { label: 'Consolidating', maxHours: 24 * 7 },
  consolidated: { label: 'Consolidated', maxHours: 24 * 30 },
  fragile: { label: 'Fragile', maxHours: 24 * 90 },
  dormant: { label: 'Dormant', maxHours: Infinity },
} as const;

export type Zone = keyof typeof ZONES;

export const ZONE_ORDER: Zone[] = ['encoding', 'consolidating', 'consolidated', 'fragile', 'dormant'];

const CONSOLIDATION_LABELS = ['Encoding', 'Consolidation', 'Stable', 'Fragile', 'Dormant'];

export function consolidationLabel(level: DecayLevel): string {
  return CONSOLIDATION_LABELS[level] ?? 'Unknown';
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
  episodic: { icon: '📅', label: 'Episodic' },
  semantic: { icon: '📖', label: 'Semantic' },
  procedural: { icon: '⚡', label: 'Procedural' },
} as const;

export function typeMeta(type: Memory['memoryType']) {
  return TYPE_META[type] ?? TYPE_META.semantic;
}

/** "3d ago", "just now". */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const ms = now.getTime() - new Date(date).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)} months ago`;
}
