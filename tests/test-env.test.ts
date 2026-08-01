import { describe, test, expect, beforeEach } from 'bun:test';
import { SQLiteStore } from '../src/store/sqlite.js';
import { FakeClock, systemClock } from '../src/core/clock.js';
import { InMemoryEventBus, type AppEvent } from '../src/core/event-bus.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0, HOURS } from './helpers/clock.js';
import { useStubLLM } from './helpers/llm.js';
import { seedMemories, eventFixtures, memoryFixtures } from './helpers/fixtures.js';

/**
 * Foundation of the autonomous test environment (story S5-00b, docs/TESTING.md).
 * These tests validate the seams themselves — if one breaks, no time- or
 * event-driven assertion in Phase 5 can be trusted.
 */

describe('Pillar 1 — isolated database', () => {
  test('freshStore() is in memory and shares nothing between instances', async () => {
    const a = freshStore();
    const b = freshStore();

    await a.add({
      content: 'trace from store A',
      directory: '/a',
      day: '2026-01-01',
      keywords: ['a'],
      sessionId: 's-a',
    });

    expect((await a.list({ limit: 10 })).length).toBe(1);
    expect((await b.list({ limit: 10 })).length).toBe(0);

    a.close();
    b.close();
  });

  test('opening the production database under NODE_ENV=test throws', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      // Default path is data/humemory.db, which must be refused.
      expect(() => new SQLiteStore()).toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('Pillar 2 — injectable clock', () => {
  test('FakeClock only advances on demand', () => {
    const clock = new FakeClock(T0);
    expect(clock.now().toISOString()).toBe(T0.toISOString());

    clock.advanceHours(25);
    expect(clock.now().getTime() - T0.getTime()).toBe(25 * 3600_000);

    clock.advanceDays(2);
    expect(clock.now().getTime() - T0.getTime()).toBe((25 + 48) * 3600_000);
  });

  test('now() returns a copy — mutating it does not shift the clock', () => {
    const clock = new FakeClock(T0);
    const d = clock.now();
    d.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  test('systemClock remains the store default clock', () => {
    // Non-regression guard for production: no frozen clock by accident.
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
  });

  test('the store timestamps through the injected clock, not the system time', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });

    const m = await store.add({
      content: 'trace timestamped by the FakeClock',
      directory: '/src/core',
      day: '2026-01-01',
      keywords: ['clock'],
      sessionId: 's-clock',
    });

    expect(m.createdAt.toISOString()).toBe(T0.toISOString());
    store.close();
  });

  test('recall() timestamps through the injected clock too', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const m = await store.add({
      content: 'trace recalled later',
      directory: '/src/core',
      day: '2026-01-01',
      keywords: ['recall'],
      sessionId: 's-recall',
    });

    clock.advanceHours(10);
    const recalled = await store.recall(m.id);

    expect(recalled.lastRecalled?.getTime()).toBe(T0.getTime() + 10 * 3600_000);
    expect(recalled.recallCount).toBe(1);
    store.close();
  });
});

describe('Pillar 3 — stubbed LLM', () => {
  beforeEach(() => {
    useStubLLM();
  });

  test('autoGenerate goes through the stub, no network', async () => {
    const client = useStubLLM({ levels: { level3Keywords: 'alpha, beta, gamma' } });
    const store = freshStore();

    const m = await store.add(
      {
        content: 'A trace to be summarised by the deterministic stub',
        directory: '/src/core',
        day: '2026-01-01',
        keywords: ['stub'],
        sessionId: 's-llm',
      },
      { autoGenerate: true }
    );

    expect(client.calls.length).toBe(1);
    expect(m.level3Keywords).toBe('alpha, beta, gamma');
    expect(m.level1Summary).toContain('summary:');
    store.close();
  });

  test('no API key is required', () => {
    // CI runs without ANTHROPIC_API_KEY: the stub must be enough.
    expect(() => useStubLLM()).not.toThrow();
  });
});

describe('Pillar 4 — injectable event bus', () => {
  test('publish() reaches subscribers of that type, and only those', async () => {
    const bus = new InMemoryEventBus();
    const seen: AppEvent[] = [];
    const others: AppEvent[] = [];

    bus.subscribe('branch_switch', (e) => {
      seen.push(e);
    });
    bus.subscribe('file_open', (e) => {
      others.push(e);
    });

    await bus.publish({ type: 'branch_switch', branch: 'feature/x', directory: '/src' });

    expect(seen.length).toBe(1);
    expect(others.length).toBe(0);
    expect(seen[0]).toMatchObject({ type: 'branch_switch', branch: 'feature/x' });
  });

  test('subscribeAll() sees every type', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribeAll((e) => {
      seen.push(e.type);
    });

    const events = eventFixtures();
    for (const event of Object.values(events)) {
      await bus.publish(event);
    }

    expect(seen).toEqual(['file_open', 'branch_switch', 'error_pattern', 'commit']);
  });

  test('publish() awaits async handlers — no setTimeout in tests', async () => {
    const bus = new InMemoryEventBus();
    let done = false;

    bus.subscribe('commit', async () => {
      await Promise.resolve();
      done = true;
    });

    await bus.publish(eventFixtures()['commit-closes-loop']);
    expect(done).toBe(true); // true immediately after the await
  });

  test('unsubscribing mid-dispatch does not break the iteration', async () => {
    const bus = new InMemoryEventBus();
    const calls: string[] = [];

    const off = bus.subscribe('file_open', () => {
      calls.push('first');
      off(); // removes itself mid-dispatch
    });
    bus.subscribe('file_open', () => {
      calls.push('second');
    });

    const event = eventFixtures()['open-auth-service'];
    await bus.publish(event);
    await bus.publish(event);

    expect(calls).toEqual(['first', 'second', 'second']);
  });

  test('the log allows assertions without subscribing', async () => {
    const bus = new InMemoryEventBus();
    const events = eventFixtures();

    await bus.publish(events['switch-to-feature']);
    await bus.publish(events['commit-closes-loop']);

    expect(bus.published().length).toBe(2);
    expect(bus.publishedOf('commit')[0].sha).toBe('deadbee');

    bus.reset();
    expect(bus.published().length).toBe(0);
  });
});

describe('Fixtures', () => {
  test('seedMemories() feeds the store from the file, not from literals', async () => {
    const store = freshStore();
    const seeded = await seedMemories(store);

    expect(Object.keys(seeded).sort()).toEqual(
      memoryFixtures()
        .map((f) => f.key)
        .sort()
    );
    expect(seeded['auth-bug'].content).toContain('middleware');
    expect(seeded['photographic-note'].photographic).toBe(true);
    expect((await store.list({ limit: 10 })).length).toBe(memoryFixtures().length);

    store.close();
  });
});

describe('End to end — decay driven purely by FakeClock.advance()', () => {
  test('a trace falls L0 → L1 → L2 → L3 with no real waiting', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedMemories(store);
    const id = seeded['decay-curve'].id;

    expect((await store.getById(id))!.currentLevel).toBe(0);

    clock.advanceHours(HOURS.L1 + 1);
    await store.updateDecay();
    expect((await store.getById(id))!.currentLevel).toBe(1);

    clock.advanceHours(HOURS.L2 - HOURS.L1 + 1);
    await store.updateDecay();
    expect((await store.getById(id))!.currentLevel).toBe(2);

    clock.advanceHours(HOURS.L3 - HOURS.L2 + 1);
    await store.updateDecay();
    expect((await store.getById(id))!.currentLevel).toBe(3);

    store.close();
  });

  test('a photographic trace never decays, even a year on', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedMemories(store);
    const id = seeded['photographic-note'].id;

    clock.advanceDays(365);
    await store.updateDecay();

    expect((await store.getById(id))!.currentLevel).toBe(0);
    store.close();
  });

  test('a recall slows decay compared with a trace never recalled', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedMemories(store);

    const recalled = seeded['auth-bug'].id;
    const forgotten = seeded['sqlite-wal'].id;

    clock.advanceHours(HOURS.L1 + 1);
    await store.recall(recalled);
    await store.updateDecay();

    const a = (await store.getById(recalled))!;
    const b = (await store.getById(forgotten))!;

    expect(a.saillance).toBeGreaterThan(b.saillance);
    expect(a.currentLevel).toBeLessThanOrEqual(b.currentLevel);

    store.close();
  });
});
