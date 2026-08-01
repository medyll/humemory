import { describe, test, expect } from 'bun:test';
import {
  SqliteCueResolver,
  attachResolverToBus,
  intentionSaillance,
  parseCron,
  cronMatches,
  cronDueSince,
  eventTriggerMatches,
  CRON_CATCHUP_MINUTES,
} from '../src/core/cues.js';
import { InMemoryEventBus } from '../src/core/event-bus.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { seedIntentions } from './helpers/fixtures.js';
import type { Intention, TriggerSpec } from '../src/core/types.js';

/**
 * Phase 5.2 — cue resolver (story S5-02).
 * Everything is driven by the FakeClock and the InMemoryEventBus: no real waiting,
 * no filesystem access, no git call.
 */

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const resolver = new SqliteCueResolver(store, { clock });
  return { clock, store, resolver };
}

describe('Cron — parsing', () => {
  test('accepts the usual forms', () => {
    expect(parseCron('0 9 * * 1')).not.toBeNull(); // Monday 9am
    expect(parseCron('*/15 * * * *')).not.toBeNull();
    expect(parseCron('0 0-6/2 1,15 * *')).not.toBeNull();
  });

  test('rejects invalid expressions without throwing', () => {
    expect(parseCron('0 9 * *')).toBeNull(); // 4 fields
    expect(parseCron('60 * * * *')).toBeNull(); // minute out of range
    expect(parseCron('0 9 * * 9')).toBeNull(); // day of week out of range
    expect(parseCron('abc * * * *')).toBeNull();
    expect(parseCron('*/0 * * * *')).toBeNull(); // no zero step
  });

  test('an invalid cron is never due, rather than crashing', () => {
    expect(cronDueSince('not cron at all', T0, new Date(T0.getTime() + 86_400_000))).toBe(false);
  });
});

describe('Cron — matching', () => {
  const lundi9h = parseCron('0 9 * * 1')!;

  test('matches the exact minute', () => {
    // 2026-01-05 is a Monday.
    expect(cronMatches(lundi9h, new Date('2026-01-05T09:00:00Z'))).toBe(true);
    expect(cronMatches(lundi9h, new Date('2026-01-05T09:01:00Z'))).toBe(false);
    expect(cronMatches(lundi9h, new Date('2026-01-06T09:00:00Z'))).toBe(false); // Tuesday
  });

  test('day-of-month and day-of-week combine with OR (standard cron)', () => {
    const parsed = parseCron('0 9 1 * 1')!; // the 1st of the month OR on a Monday
    expect(cronMatches(parsed, new Date('2026-01-01T09:00:00Z'))).toBe(true); // Thursday the 1st
    expect(cronMatches(parsed, new Date('2026-01-05T09:00:00Z'))).toBe(true); // Monday the 5th
    expect(cronMatches(parsed, new Date('2026-01-06T09:00:00Z'))).toBe(false);
  });

  test('cronDueSince catches an occurrence missed between two sessions', () => {
    const since = new Date('2026-01-04T00:00:00Z'); // Sunday
    const now = new Date('2026-01-05T18:00:00Z'); // Monday evening, 9am has passed
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(true);
  });

  test('but does not reach past the catch-up window', () => {
    const since = new Date('2025-01-01T00:00:00Z');
    const now = new Date('2026-01-05T18:00:00Z');
    // Last Monday's occurrence is still inside the window, so it is due.
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(true);

    // A yearly occurrence, however, falls outside it.
    expect(cronDueSince('0 9 1 7 *', since, now)).toBe(false);
    expect(CRON_CATCHUP_MINUTES).toBe(7 * 24 * 60);
  });

  test('nothing is due when the reference is later than the occurrence', () => {
    const since = new Date('2026-01-05T12:00:00Z'); // after 9am
    const now = new Date('2026-01-05T18:00:00Z');
    expect(cronDueSince('0 9 * * 1', since, now)).toBe(false);
  });
});

describe('resolveTimeCues', () => {
  test('a dated cue only surfaces once its deadline is reached', async () => {
    const { clock, store, resolver } = setup();
    const at = new Date(T0.getTime() + 24 * 3600_000).toISOString();
    await store.addIntention({ content: 'tomorrow', directory: '/src' }, [{ kind: 'time', at }]);

    expect(await resolver.resolveTimeCues()).toEqual([]);

    clock.advanceHours(24);
    const due = await resolver.resolveTimeCues();
    expect(due.length).toBe(1);
    store.close();
  });

  test('a cue whose intention is no longer armed does not surface', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    await store.updateIntentionStatus(i.id, 'closed');

    clock.advanceDays(2);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });

  test('an invalid date is never due', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: 'not a date' },
    ]);

    clock.advanceDays(365);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });

  test('event cues do not come out through the time path', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    clock.advanceDays(30);
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });
});

describe('resolveEventCues', () => {
  test('branch_switch matches exactly', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'doc', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'feature/x' },
    ]);

    expect(
      (await resolver.resolveEventCues({ type: 'branch_switch', branch: 'feature/x', directory: '/src' }))
        .length
    ).toBe(1);
    expect(
      (await resolver.resolveEventCues({ type: 'branch_switch', branch: 'main', directory: '/src' })).length
    ).toBe(0);
    store.close();
  });

  test('file_open matches the exact path or a suffix', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'refactor', directory: '/src/auth' }, [
      { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' },
    ]);

    const exact = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'src/auth/service.ts',
      directory: '/src/auth',
    });
    const absolute = await resolver.resolveEventCues({
      type: 'file_open',
      path: '/home/dev/projet/src/auth/service.ts',
      directory: '/src/auth',
    });
    const other = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'src/auth/other.ts',
      directory: '/src/auth',
    });

    expect(exact.length).toBe(1);
    expect(absolute.length).toBe(1);
    expect(other.length).toBe(0);
    store.close();
  });

  test('Windows separators match like POSIX ones', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src/auth' }, [
      { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' },
    ]);

    const found = await resolver.resolveEventCues({
      type: 'file_open',
      path: 'D:\\projet\\src\\auth\\service.ts',
      directory: '/src/auth',
    });
    expect(found.length).toBe(1);
    store.close();
  });

  test('error_pattern accepts a regex, and falls back to a literal when invalid', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'regex', directory: '/src' }, [
      { kind: 'event', type: 'error_pattern', pattern: 'SQLITE_(BUSY|LOCKED)' },
    ]);
    await store.addIntention({ content: 'literal', directory: '/src' }, [
      { kind: 'event', type: 'error_pattern', pattern: 'segfault((' },
    ]);

    const regex = await resolver.resolveEventCues({
      type: 'error_pattern',
      text: 'Error: SQLITE_BUSY: database is locked',
      directory: '/src',
    });
    const literal = await resolver.resolveEventCues({
      type: 'error_pattern',
      text: 'boom: segfault(( at 0x0',
      directory: '/src',
    });

    expect(regex.length).toBe(1);
    expect(literal.length).toBe(1); // invalid pattern falls back to a literal search, no crash
    store.close();
  });

  test('an event from another mental place wakes nothing', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'auth', directory: '/src/auth' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    const elsewhere = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/autre/projet',
    });
    const subdirectory = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/src/auth/middleware',
    });

    expect(elsewhere.length).toBe(0); // database shared across projects: no leak
    expect(subdirectory.length).toBe(1);
    store.close();
  });

  test('a commit wakes no intention — it closes them (S5-03b)', async () => {
    const { store, resolver } = setup();
    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
    ]);

    const found = await resolver.resolveEventCues({
      type: 'commit',
      sha: 'deadbee',
      message: 'fix: x',
      files: ['src/a.ts'],
      directory: '/src',
    });
    expect(found).toEqual([]);
    store.close();
  });
});

describe('fire', () => {
  test('marks cue and intention as fired', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.advanceHours(3);
    const fired = await resolver.fire(cue.id);

    expect(fired.status).toBe('fired');
    expect(fired.firedAt!.getTime()).toBe(T0.getTime() + 3 * 3600_000);
    expect((await store.getCue(cue.id))!.status).toBe('fired');
    store.close();
  });

  test('a cron cue is re-armed after firing — otherwise the recurrence is a one-shot', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'weekly', directory: '/src' }, [
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.set('2026-01-05T09:00:00Z');
    await resolver.fire(cue.id);

    const after = await store.getCue(cue.id);
    expect(after!.status).toBe('armed'); // still armed for the following week
    expect(after!.firedAt).not.toBeUndefined(); // but the firing is recorded
    store.close();
  });

  test('a cron does not surface twice in the same minute, but does the week after', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'weekly', directory: '/src' }, [
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });

    clock.set('2026-01-05T09:00:00Z');
    expect((await resolver.resolveTimeCues()).length).toBe(1);
    await resolver.fire(cue.id);
    // The intention moved to fired: no more wake-ups until it is re-armed.
    expect((await resolver.resolveTimeCues()).length).toBe(0);

    await store.updateIntentionStatus(i.id, 'armed');
    expect((await resolver.resolveTimeCues()).length).toBe(0); // same minute, already fired

    clock.set('2026-01-12T09:00:00Z'); // the following Monday
    expect((await resolver.resolveTimeCues()).length).toBe(1);
    store.close();
  });

  test('firing an unknown cue throws', async () => {
    const { store, resolver } = setup();
    await expect(resolver.fire('inexistant')).rejects.toThrow(/not found/);
    store.close();
  });
});

describe('expireStale', () => {
  test('expires intentions past their deadline and cancels their cues', async () => {
    const { clock, store, resolver } = setup();
    const seeded = await seedIntentions(store, { now: clock.now() });

    expect(await resolver.expireStale()).toBe(0); // nothing is overdue yet

    clock.advanceHours(2); // expired-loop expires at +1h
    expect(await resolver.expireStale()).toBe(1);

    const expired = await store.getIntention(seeded['expired-loop'].id);
    expect(expired!.status).toBe('expired');

    const cues = await store.listCues({ intentionId: expired!.id });
    expect(cues.every((c) => c.status === 'cancelled')).toBe(true); // no ghost wake-up
    store.close();
  });

  test('an intention with no deadline never expires', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({ content: 'no deadline', directory: '/src' });

    clock.advanceDays(3650);
    expect(await resolver.expireStale()).toBe(0);
    store.close();
  });

  test('expireStale is idempotent', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention({
      content: 'overdue',
      directory: '/src',
      expiresAt: new Date(T0.getTime() + 3600_000),
    });

    clock.advanceHours(2);
    expect(await resolver.expireStale()).toBe(1);
    expect(await resolver.expireStale()).toBe(0); // second pass: nothing left to do
    store.close();
  });

  test('an expired cue no longer surfaces', async () => {
    const { clock, store, resolver } = setup();
    await store.addIntention(
      { content: 'x', directory: '/src', expiresAt: new Date(T0.getTime() + 3600_000) },
      [{ kind: 'time', at: T0.toISOString() }]
    );

    clock.advanceHours(2);
    await resolver.expireStale();
    expect(await resolver.resolveTimeCues()).toEqual([]);
    store.close();
  });
});

describe('Decay rules for intentions', () => {
  test('armed → salience pinned at 100, however much time passes', async () => {
    const { store } = setup();
    const i = await store.addIntention({ content: 'open loop', directory: '/src' });

    expect(intentionSaillance(i, new Date(T0.getTime() + 365 * 86_400_000))).toBe(100);
    store.close();
  });

  test('fired and not closed → declines over time (the Zeigarnik pull fading)', async () => {
    const { clock, store, resolver } = setup();
    const i = await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'time', at: T0.toISOString() },
    ]);
    const [cue] = await store.listCues({ intentionId: i.id });
    const fired = await resolver.fire(cue.id);

    expect(intentionSaillance(fired, clock.now())).toBe(100);
    expect(intentionSaillance(fired, new Date(T0.getTime() + 2 * 86_400_000))).toBe(80);
    expect(intentionSaillance(fired, new Date(T0.getTime() + 20 * 86_400_000))).toBe(0);
    store.close();
  });

  test('closed and expired → 0, archived', async () => {
    const { store } = setup();
    const base = await store.addIntention({ content: 'x', directory: '/src' });

    const closed: Intention = { ...base, status: 'closed' };
    const expired: Intention = { ...base, status: 'expired' };

    expect(intentionSaillance(closed, T0)).toBe(0);
    expect(intentionSaillance(expired, T0)).toBe(0);
    store.close();
  });
});

describe('Wiring onto the event bus', () => {
  test('publishing an event wakes the intentions that match', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    const woken: string[] = [];

    const detach = attachResolverToBus(bus, resolver, {
      onFired: (intention) => {
        woken.push(intention.content);
      },
    });

    await store.addIntention({ content: 'document the resolver', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'feature/prospective-memory' },
    ]);

    await bus.publish({
      type: 'branch_switch',
      branch: 'feature/prospective-memory',
      directory: '/src',
    });

    // publish() awaits its handlers: the effect is observable here, no setTimeout.
    expect(woken).toEqual(['document the resolver']);
    expect((await store.listIntentions({ status: 'fired' })).length).toBe(1);

    detach();
    store.close();
  });

  test('after detaching, nothing wakes any more', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    const detach = attachResolverToBus(bus, resolver);

    await store.addIntention({ content: 'x', directory: '/src' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    detach();
    await bus.publish({ type: 'branch_switch', branch: 'main', directory: '/src' });

    expect((await store.listIntentions({ status: 'fired' })).length).toBe(0);
    store.close();
  });

  test('end to end: a fixture open loop, woken by a file_open', async () => {
    const { store, resolver } = setup();
    const bus = new InMemoryEventBus();
    attachResolverToBus(bus, resolver);

    const seeded = await seedIntentions(store);

    await bus.publish({
      type: 'file_open',
      path: 'src/auth/service.ts',
      directory: '/src/auth',
    });

    const awoken = await store.getIntention(seeded['refactor-auth'].id);
    expect(awoken!.status).toBe('fired');
    expect(awoken!.firedAt).not.toBeUndefined();

    // The other loops are still asleep.
    expect((await store.listIntentions({ status: 'armed' })).length).toBe(3);
    store.close();
  });
});
