import { describe, test, expect, beforeEach } from 'bun:test';
import { SQLiteStore } from '../src/store/sqlite.js';
import { FakeClock, systemClock } from '../src/core/clock.js';
import { InMemoryEventBus, type AppEvent } from '../src/core/event-bus.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0, HOURS } from './helpers/clock.js';
import { useStubLLM } from './helpers/llm.js';
import { seedMemories, eventFixtures, memoryFixtures } from './helpers/fixtures.js';

/**
 * Fondation de l'env de test autonome (story S5-00b, docs/TESTING.md).
 * Ces tests valident les seams eux-mêmes — si l'un casse, aucune assertion
 * time-driven ou event-driven de la Phase 5 n'est digne de confiance.
 */

describe('Pilier 1 — DB isolée', () => {
  test('freshStore() est en mémoire et ne partage rien entre instances', async () => {
    const a = freshStore();
    const b = freshStore();

    await a.add({
      content: 'trace du store A',
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

  test('ouvrir la DB de prod sous NODE_ENV=test lève', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      // Chemin par défaut = data/humemory.db → doit être refusé.
      expect(() => new SQLiteStore()).toThrow(/production/i);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('Pilier 2 — Clock injectable', () => {
  test('FakeClock n\'avance que sur demande', () => {
    const clock = new FakeClock(T0);
    expect(clock.now().toISOString()).toBe(T0.toISOString());

    clock.advanceHours(25);
    expect(clock.now().getTime() - T0.getTime()).toBe(25 * 3600_000);

    clock.advanceDays(2);
    expect(clock.now().getTime() - T0.getTime()).toBe((25 + 48) * 3600_000);
  });

  test('now() renvoie une copie — muter le retour ne décale pas l\'horloge', () => {
    const clock = new FakeClock(T0);
    const d = clock.now();
    d.setFullYear(1999);
    expect(clock.now().getUTCFullYear()).toBe(2026);
  });

  test('systemClock reste l\'horloge par défaut du store', () => {
    // Garde-fou de non-régression pour la prod : pas d'horloge figée par accident.
    const before = Date.now();
    const t = systemClock.now().getTime();
    expect(t).toBeGreaterThanOrEqual(before);
  });

  test('le store horodate via l\'horloge injectée, pas l\'heure système', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });

    const m = await store.add({
      content: 'trace horodatée par la FakeClock',
      directory: '/src/core',
      day: '2026-01-01',
      keywords: ['clock'],
      sessionId: 's-clock',
    });

    expect(m.createdAt.toISOString()).toBe(T0.toISOString());
    store.close();
  });

  test('recall() horodate lui aussi via l\'horloge injectée', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const m = await store.add({
      content: 'trace rappelée plus tard',
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

describe('Pilier 3 — LLM stubbé', () => {
  beforeEach(() => {
    useStubLLM();
  });

  test('autoGenerate passe par le stub, sans réseau', async () => {
    const client = useStubLLM({ levels: { level3Keywords: 'alpha, beta, gamma' } });
    const store = freshStore();

    const m = await store.add(
      {
        content: 'Une trace qui doit être résumée par le stub déterministe',
        directory: '/src/core',
        day: '2026-01-01',
        keywords: ['stub'],
        sessionId: 's-llm',
      },
      { autoGenerate: true }
    );

    expect(client.calls.length).toBe(1);
    expect(m.level3Keywords).toBe('alpha, beta, gamma');
    expect(m.level1Summary).toContain('résumé:');
    store.close();
  });

  test('aucune clé API n\'est requise', () => {
    // La CI tourne sans ANTHROPIC_API_KEY : le stub doit suffire.
    expect(() => useStubLLM()).not.toThrow();
  });
});

describe('Pilier 4 — Event bus injectable', () => {
  test('publish() atteint les abonnés du type, et eux seuls', async () => {
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

  test('subscribeAll() voit tous les types', async () => {
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

  test('publish() attend les handlers asynchrones — pas de setTimeout en test', async () => {
    const bus = new InMemoryEventBus();
    let done = false;

    bus.subscribe('commit', async () => {
      await Promise.resolve();
      done = true;
    });

    await bus.publish(eventFixtures()['commit-closes-loop']);
    expect(done).toBe(true); // vrai immédiatement après l'await
  });

  test('se désabonner pendant la diffusion ne casse pas l\'itération', async () => {
    const bus = new InMemoryEventBus();
    const calls: string[] = [];

    const off = bus.subscribe('file_open', () => {
      calls.push('premier');
      off(); // se retire pendant la diffusion
    });
    bus.subscribe('file_open', () => {
      calls.push('second');
    });

    const event = eventFixtures()['open-auth-service'];
    await bus.publish(event);
    await bus.publish(event);

    expect(calls).toEqual(['premier', 'second', 'second']);
  });

  test('le journal permet d\'assertion sans abonnement', async () => {
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
  test('seedMemories() alimente le store depuis le fichier, pas des littéraux', async () => {
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

describe('Bout-en-bout — decay piloté uniquement par FakeClock.advance()', () => {
  test('une trace descend L0 → L1 → L2 → L3 sans attente réelle', async () => {
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

  test('une trace photographic ne se dégrade jamais, même à +1 an', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedMemories(store);
    const id = seeded['photographic-note'].id;

    clock.advanceDays(365);
    await store.updateDecay();

    expect((await store.getById(id))!.currentLevel).toBe(0);
    store.close();
  });

  test('un rappel ralentit la dégradation par rapport à une trace jamais rappelée', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const seeded = await seedMemories(store);

    const rappelee = seeded['auth-bug'].id;
    const oubliee = seeded['sqlite-wal'].id;

    clock.advanceHours(HOURS.L1 + 1);
    await store.recall(rappelee);
    await store.updateDecay();

    const a = (await store.getById(rappelee))!;
    const b = (await store.getById(oubliee))!;

    expect(a.saillance).toBeGreaterThan(b.saillance);
    expect(a.currentLevel).toBeLessThanOrEqual(b.currentLevel);

    store.close();
  });
});
