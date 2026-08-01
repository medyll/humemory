import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SQLiteStore } from '../../src/store/sqlite.js';
import type { Memory, Intention, TriggerSpec } from '../../src/core/types.js';
import type { AppEvent } from '../../src/core/event-bus.js';
import { T0 } from './clock.js';

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
  /** Offset from the clock's "now", in hours. */
  offsetHours?: number;
}

/** Raw traces from the fixture file, without inserting them. */
export function memoryFixtures(file = 'memories.basic.json'): MemoryFixture[] {
  return readFixture<{ memories: MemoryFixture[] }>(file).memories;
}

/**
 * Seeds a store from a fixture file. Returns the inserted traces keyed by their
 * fixture `key`, so assertions read well:
 *
 * ```ts
 * const seeded = await seedMemories(store);
 * expect(seeded['auth-bug'].currentLevel).toBe(0);
 * ```
 *
 * Fixtures replace ad hoc literals in the suites (docs/TESTING.md → Fixtures).
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

interface IntentionFixture {
  key: string;
  content: string;
  directory: string;
  /** Deadline expressed in hours from "now" — never an absolute date. */
  expiresInHours?: number;
  cues?: TriggerSpec[];
}

/** Raw open loops from the fixture file, without inserting them. */
export function intentionFixtures(file = 'loops.open.json'): IntentionFixture[] {
  return readFixture<{ intentions: IntentionFixture[] }>(file).intentions;
}

/**
 * Arms the fixture intentions (with their cues) in the store.
 * `expiresInHours` is resolved against `now` — pass your FakeClock's `now()` so
 * deadlines stay deterministic.
 */
export async function seedIntentions(
  store: SQLiteStore,
  options: { now?: Date; file?: string } = {}
): Promise<Record<string, Intention>> {
  const { now = new Date(T0), file = 'loops.open.json' } = options;
  const seeded: Record<string, Intention> = {};

  for (const fixture of intentionFixtures(file)) {
    const expiresAt =
      fixture.expiresInHours === undefined
        ? undefined
        : new Date(now.getTime() + fixture.expiresInHours * 3600_000);

    seeded[fixture.key] = await store.addIntention(
      { content: fixture.content, directory: fixture.directory, expiresAt },
      fixture.cues ?? []
    );
  }

  return seeded;
}

interface EventFixture extends Record<string, unknown> {
  key: string;
}

/** Fixture events keyed by `key`, ready to publish on the bus. */
export function eventFixtures(file = 'events.basic.json'): Record<string, AppEvent> {
  const { events } = readFixture<{ events: EventFixture[] }>(file);
  const byKey: Record<string, AppEvent> = {};
  for (const { key, ...event } of events) {
    byKey[key] = event as unknown as AppEvent;
  }
  return byKey;
}
