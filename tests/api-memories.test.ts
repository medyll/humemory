import { describe, test, expect } from 'bun:test';
import { createMemoryRoutes } from '../src/api/memory-routes.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';
import { seedMemories } from './helpers/fixtures.js';
import { useStubLLM } from './helpers/llm.js';

/**
 * Routes de la mémoire rétrospective (BUG-08).
 *
 * Ces routes datent du Sprint 1 et n'avaient jamais été testées : le store était
 * construit au chargement de `server.ts`, donc importer le module levait un
 * serveur et visait la base de production. L'extraction en sous-routeur lève
 * l'obstacle.
 */

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const app = createMemoryRoutes(store);

  const call = async (path: string, init?: RequestInit) => {
    const res = await app.request(`http://local${path}`, init);
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };

  const post = (path: string, payload?: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return { clock, store, call, post };
}

describe('POST /memories', () => {
  test('encode une trace et la renvoie', async () => {
    const { post } = setup();
    const { status, body } = await post('/memories', {
      content: 'une trace encodée par HTTP',
      directory: '/src',
      keywords: ['http'],
      sessionId: 's1',
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.memory.currentLevel).toBe(0);
  });

  test('un type inconnu retombe sur semantic plutôt que d\'échouer', async () => {
    const { post } = setup();
    const { body } = await post('/memories', { content: 'x', memoryType: 'télépathique' });
    expect(body.memory.memoryType).toBe('semantic');
  });
});

describe('GET /memories', () => {
  test('liste et filtre par niveau', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const all = await call('/memories?limit=10');
    expect(all.body.memories.length).toBe(4);

    const l0 = await call('/memories?level=0');
    expect(l0.body.memories.every((m: any) => m.currentLevel === 0)).toBe(true);
  });

  test('404 sur une trace inconnue', async () => {
    const { call } = setup();
    expect((await call('/memories/inexistante')).status).toBe(404);
  });
});

describe('Rappel, photographique, suppression', () => {
  test('recall incrémente le compteur et remonte la saillance', async () => {
    const { clock, store, post } = setup();
    const seeded = await seedMemories(store);
    const id = seeded['auth-bug'].id;

    clock.advanceHours(5);
    const { body } = await post(`/memories/${id}/recall`);

    expect(body.memory.recallCount).toBe(1);
    expect(body.memory.saillance).toBe(100);
  });

  test('photo bascule le mode photographique dans les deux sens', async () => {
    const { store, post } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    expect((await post(`/memories/${id}/photo`, { enable: true })).body.memory.photographic).toBe(true);
    expect((await post(`/memories/${id}/photo`, { enable: false })).body.memory.photographic).toBe(false);
    // Corps vide : la route active par défaut.
    expect((await post(`/memories/${id}/photo`)).body.memory.photographic).toBe(true);
  });

  test('delete retire la trace', async () => {
    const { store, call } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    expect((await call(`/memories/${id}`, { method: 'DELETE' })).body.success).toBe(true);
    expect((await call(`/memories/${id}`)).status).toBe(404);
  });
});

describe('GET /search', () => {
  test('exige une requête', async () => {
    const { call } = setup();
    const { status, body } = await call('/search');
    expect(status).toBe(400);
    expect(body.error).toMatch(/q/);
  });

  test('retrouve une trace par ses mots-clés', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { body } = await call('/search?q=sqlite');
    expect(body.success).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
  });

  test('les filtres avancés sont transmis au store', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    // minSaillance très haut : rien ne doit passer.
    const strict = await call('/search?q=sqlite&minSaillance=101');
    expect(strict.body.results.length).toBe(0);
  });
});

describe('Similaires et fusion', () => {
  test('findSimilar ne renvoie jamais la trace elle-même', async () => {
    const { store, call } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    const { body } = await call(`/memories/${id}/similar?threshold=0`);
    expect(body.results.every((r: any) => r.memory.id !== id)).toBe(true);
  });

  test('merge exige une cible', async () => {
    const { store, post } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    const { status, body } = await post(`/memories/${id}/merge`, {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/targetId/);
  });

  test('merge passe la source au niveau 4 et la relie à la cible', async () => {
    useStubLLM();
    const { store, post, call } = setup();
    const seeded = await seedMemories(store);
    const source = seeded['auth-bug'].id;
    const target = seeded['sqlite-wal'].id;

    expect((await post(`/memories/${source}/merge`, { targetId: target })).status).toBe(200);

    const after = await call(`/memories/${source}`);
    expect(after.body.memory.currentLevel).toBe(4);
    expect(after.body.memory.mergedIntoId).toBe(target);
  });
});

describe('GET /status', () => {
  test('compte les traces par niveau et calcule les moyennes', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { body } = await call('/status');
    expect(body.status.total).toBe(4);
    expect(body.status.byLevel.level0).toBe(4);
    expect(body.status.averages.saillance).toBeGreaterThan(0);
  });

  test('une base vide ne divise pas par zéro', async () => {
    const { call } = setup();
    const { body } = await call('/status');

    expect(body.status.total).toBe(0);
    expect(Number.isNaN(body.status.averages.saillance)).toBe(false);
  });
});

describe('Sessions (rejeu)', () => {
  test('regroupe les traces par session', async () => {
    const { store, call } = setup();
    await seedMemories(store); // deux sessions dans les fixtures

    const { body } = await call('/sessions');
    expect(body.sessions.length).toBe(2);
    expect(body.sessions.reduce((n: number, s: any) => n + s.count, 0)).toBe(4);
  });

  test('le détail d\'une session renvoie ses événements', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { status, body } = await call('/sessions/session-fixture-1');
    expect(status).toBe(200);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e: any) => typeof e.type === 'string')).toBe(true);
  });

  test('une session inconnue renvoie une liste vide, pas une erreur', async () => {
    const { call } = setup();
    const { status, body } = await call('/sessions/jamais-vue');

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });
});

describe('POST /decay', () => {
  test('fait avancer la dégradation de toutes les traces', async () => {
    const { clock, store, post, call } = setup();
    const id = (await seedMemories(store))['decay-curve'].id;

    clock.advanceHours(200); // au-delà du seuil L2
    expect((await post('/decay')).body.success).toBe(true);

    const { body } = await call(`/memories/${id}`);
    expect(body.memory.currentLevel).toBeGreaterThan(0);
  });
});
