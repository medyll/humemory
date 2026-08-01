import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { seedIntentions, intentionFixtures } from './helpers/fixtures.js';
import type { TriggerSpec } from '../src/core/types.js';

/**
 * Phase 5.1 — prospective data model (story S5-01).
 * Data layer only: arm, list, transition. Firing
 * (resolveTimeCues / resolveEventCues / expireStale) lands in S5-02.
 */

const FILE_CUE: TriggerSpec = { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' };
const TIME_CUE: TriggerSpec = { kind: 'time', at: '2026-01-08T09:00:00.000Z' };

describe('Schema — idempotent migrations', () => {
  test('replaying initSchema on an existing database loses nothing', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { SQLiteStore } = await import('../src/store/sqlite.js');

    const dir = mkdtempSync(join(tmpdir(), 'humemory-mig-'));
    const dbPath = join(dir, 'mig.db');

    try {
      const first = new SQLiteStore(dbPath, { clock: fakeClock() });
      const intention = await first.addIntention(
        { content: 'survives reopening', directory: '/src' },
        [FILE_CUE]
      );
      first.close();

      // Reopening: CREATE TABLE IF NOT EXISTS replayed over populated tables.
      const second = new SQLiteStore(dbPath, { clock: fakeClock() });
      const reloaded = await second.getIntention(intention.id);

      expect(reloaded).not.toBeNull();
      expect(reloaded!.content).toBe('survives reopening');
      expect((await second.listCues({ intentionId: intention.id })).length).toBe(1);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Intentions — writing and reading', () => {
  test('addIntention arms with salience 100 by default', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'refactor fn X', directory: '/src/auth' });

    expect(i.status).toBe('armed');
    expect(i.saillance).toBe(100); // open loop = salience pinned at the maximum
    expect(i.createdAt.toISOString()).toBe(T0.toISOString());
    expect(i.expiresAt).toBeUndefined(); // intention with no deadline
    store.close();
  });

  test('timestamps come from the injected clock', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });

    clock.advanceHours(5);
    const i = await store.addIntention({ content: 'later', directory: '/src' });

    expect(i.createdAt.getTime()).toBe(T0.getTime() + 5 * 3600_000);
    store.close();
  });

  test('addIntention arms its cues in the same write', async () => {
    const store = freshStore();
    const i = await store.addIntention(
      { content: 'refactor auth', directory: '/src/auth' },
      [FILE_CUE, TIME_CUE]
    );

    const cues = await store.listCues({ intentionId: i.id });
    expect(cues.length).toBe(2);
    expect(cues.map((c) => c.kind).sort()).toEqual(['event', 'time']);
    expect(cues.every((c) => c.status === 'armed')).toBe(true);
    store.close();
  });

  test('the triggerSpec round-trips through JSON without losing its type', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'c', directory: '/d' }, [FILE_CUE]);

    const [cue] = await store.listCues({ intentionId: i.id });
    expect(cue.triggerSpec).toEqual(FILE_CUE);
    // The discriminant survives — the resolver reads it in 5.2.
    expect(cue.triggerSpec.kind).toBe('event');
    store.close();
  });

  test('getIntention returns null for an unknown id', async () => {
    const store = freshStore();
    expect(await store.getIntention('inexistant')).toBeNull();
    store.close();
  });
});

describe('Intentions — list filters', () => {
  test('filters by status, single or multiple', async () => {
    const store = freshStore();
    const a = await store.addIntention({ content: 'a', directory: '/x' });
    const b = await store.addIntention({ content: 'b', directory: '/x' });
    await store.addIntention({ content: 'c', directory: '/x' });

    await store.updateIntentionStatus(a.id, 'fired');
    await store.updateIntentionStatus(b.id, 'closed');

    expect((await store.listIntentions({ status: 'armed' })).length).toBe(1);
    expect((await store.listIntentions({ status: ['fired', 'closed'] })).length).toBe(2);
    store.close();
  });

  test('filters by mental place', async () => {
    const store = freshStore();
    await store.addIntention({ content: 'here', directory: '/src/auth' });
    await store.addIntention({ content: 'elsewhere', directory: '/src/core' });

    const found = await store.listIntentions({ directory: '/src/auth' });
    expect(found.length).toBe(1);
    expect(found[0].content).toBe('here');
    store.close();
  });

  test('an exotic status does not break the query (bound value, no concatenated SQL)', async () => {
    const store = freshStore();
    await store.addIntention({ content: 'a', directory: '/x' });

    const hostile = "armed'; DROP TABLE intentions; --" as any;
    expect(await store.listIntentions({ status: hostile })).toEqual([]);
    // The table is still there.
    expect((await store.listIntentions()).length).toBe(1);
    store.close();
  });
});

describe('Intentions — status transitions', () => {
  test('fired sets fired_at only once', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' });

    clock.advanceHours(2);
    const fired = await store.updateIntentionStatus(i.id, 'fired');
    const firstFiredAt = fired.firedAt!.getTime();
    expect(firstFiredAt).toBe(T0.getTime() + 2 * 3600_000);

    // Firing again must not rewrite the original timestamp.
    clock.advanceHours(3);
    const again = await store.updateIntentionStatus(i.id, 'fired');
    expect(again.firedAt!.getTime()).toBe(firstFiredAt);
    store.close();
  });

  test('closed sets closed_at and the SHA of the commit that closed the loop', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' });

    clock.advanceDays(1);
    const closed = await store.updateIntentionStatus(i.id, 'closed', { closedByCommit: 'deadbee' });

    expect(closed.status).toBe('closed');
    expect(closed.closedAt!.getTime()).toBe(T0.getTime() + 24 * 3600_000);
    expect(closed.closedByCommit).toBe('deadbee');
    store.close();
  });

  test('expired is a soft delete: the row stays readable', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'overdue', directory: '/d' });

    await store.updateIntentionStatus(i.id, 'expired');

    const still = await store.getIntention(i.id);
    expect(still).not.toBeNull();
    expect(still!.status).toBe('expired');
    store.close();
  });

  test('transitioning an unknown intention throws', async () => {
    const store = freshStore();
    await expect(store.updateIntentionStatus('inexistant', 'fired')).rejects.toThrow(/not found/);
    store.close();
  });
});

describe('Cues', () => {
  test('addCue refuses a non-existent intention', async () => {
    const store = freshStore();
    await expect(store.addCue({ intentionId: 'inexistant', triggerSpec: TIME_CUE })).rejects.toThrow(
      /not found/
    );
    store.close();
  });

  test('fired sets fired_at, cancelled does not', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);
    const [timeCue, eventCue] = await store.listCues({ intentionId: i.id, kind: 'time' }).then(
      async (t) => [t[0], (await store.listCues({ intentionId: i.id, kind: 'event' }))[0]]
    );

    clock.advanceHours(4);
    const fired = await store.updateCueStatus(timeCue.id, 'fired');
    const cancelled = await store.updateCueStatus(eventCue.id, 'cancelled');

    expect(fired.firedAt!.getTime()).toBe(T0.getTime() + 4 * 3600_000);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.firedAt).toBeUndefined();
    store.close();
  });

  test('filters by kind', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);

    expect((await store.listCues({ intentionId: i.id, kind: 'time' })).length).toBe(1);
    expect((await store.listCues({ intentionId: i.id, kind: 'event' })).length).toBe(1);
    store.close();
  });

  test('deleting the intention takes its cues with it (ON DELETE CASCADE)', async () => {
    const store = freshStore();
    const i = await store.addIntention({ content: 'x', directory: '/d' }, [TIME_CUE, FILE_CUE]);
    expect((await store.listCues({ intentionId: i.id })).length).toBe(2);

    await store.deleteIntention(i.id);

    expect(await store.getIntention(i.id)).toBeNull();
    expect((await store.listCues({ intentionId: i.id })).length).toBe(0); // no orphans
    store.close();
  });
});

describe('Fixtures — open loops', () => {
  test('seedIntentions arms the loops and their cues from the file', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedIntentions(store, { now: clock.now() });

    expect(Object.keys(seeded).sort()).toEqual(
      intentionFixtures()
        .map((f) => f.key)
        .sort()
    );

    // doc-prospective carries two cues: one event, one cron.
    const doc = seeded['doc-prospective'];
    const cues = await store.listCues({ intentionId: doc.id });
    expect(cues.length).toBe(2);
    expect(doc.expiresAt).toBeUndefined(); // no deadline declared

    store.close();
  });

  test('deadlines are relative to the clock, not absolute', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedIntentions(store, { now: clock.now() });

    // refactor-auth declares expiresInHours: 168
    expect(seeded['refactor-auth'].expiresAt!.getTime()).toBe(T0.getTime() + 168 * 3600_000);
    // expired-loop declares 1h — already overdue after a one-day jump.
    expect(seeded['expired-loop'].expiresAt!.getTime()).toBeLessThan(
      clock.advanceDays(1).now().getTime()
    );

    store.close();
  });

  test('every seeded loop is armed', async () => {
    const store = freshStore();
    const seeded = await seedIntentions(store);

    expect(Object.values(seeded).every((i) => i.status === 'armed')).toBe(true);
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(
      intentionFixtures().length
    );
    store.close();
  });
});
