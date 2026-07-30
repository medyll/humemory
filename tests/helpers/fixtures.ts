import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SQLiteStore } from '../../src/store/sqlite.js';
import type { Memory } from '../../src/core/types.js';
import type { AppEvent } from '../../src/core/event-bus.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8')) as T;
}

interface MemoryFixture {
  key: string;
  content: string;
  directory: string;
  keywords: string[];
  sessionId: string;
  memoryType?: string;
  photographic?: boolean;
  /** Décalage par rapport au « maintenant » de l'horloge, en heures. */
  offsetHours?: number;
}

/** Traces brutes du fichier de fixtures, sans insertion. */
export function memoryFixtures(file = 'memories.basic.json'): MemoryFixture[] {
  return readFixture<{ memories: MemoryFixture[] }>(file).memories;
}

/**
 * Seed un store depuis un fichier de fixtures. Retourne les traces insérées
 * indexées par `key`, pour des assertions lisibles :
 *
 * ```ts
 * const seeded = await seedMemories(store);
 * expect(seeded['auth-bug'].currentLevel).toBe(0);
 * ```
 *
 * Les fixtures remplacent les littéraux ad hoc dans les suites (docs/TESTING.md → Fixtures).
 */
export async function seedMemories(
  store: SQLiteStore,
  file = 'memories.basic.json'
): Promise<Record<string, Memory>> {
  const seeded: Record<string, Memory> = {};
  for (const fixture of memoryFixtures(file)) {
    const { key, offsetHours, ...rest } = fixture;
    seeded[key] = await store.add({
      ...rest,
      day: '2026-01-01',
    } as any);
  }
  return seeded;
}

interface EventFixture extends Record<string, unknown> {
  key: string;
}

/** Events de fixtures indexés par `key`, prêts à être publiés sur le bus. */
export function eventFixtures(file = 'events.basic.json'): Record<string, AppEvent> {
  const { events } = readFixture<{ events: EventFixture[] }>(file);
  const byKey: Record<string, AppEvent> = {};
  for (const { key, ...event } of events) {
    byKey[key] = event as unknown as AppEvent;
  }
  return byKey;
}
