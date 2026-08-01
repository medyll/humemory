import { describe, test, expect } from 'bun:test';
import { createMemoryRoutes } from '../src/api/memory-routes.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';
import { seedMemories } from './helpers/fixtures.js';
import { useStubLLM } from './helpers/llm.js';

/**
 * Retrospective memory routes (BUG-08).
 *
 * These routes date from Sprint 1 and had never been tested: the store was built
 * at `server.ts` load time, so importing the module raised a server and pointed at
 * the production database. Extracting a sub-router removes the obstacle.
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
  test('encodes a trace and returns it', async () => {
    const { post } = setup();
    const { status, body } = await post('/memories', {
      content: 'a trace encoded over HTTP',
      directory: '/src',
      keywords: ['http'],
      sessionId: 's1',
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(body.memory.currentLevel).toBe(0);
  });

  test('an unknown type falls back to semantic instead of failing', async () => {
    const { post } = setup();
    const { body } = await post('/memories', { content: 'x', memoryType: 'telepathic' });
    expect(body.memory.memoryType).toBe('semantic');
  });
});

describe('GET /memories', () => {
  test('lists and filters by level', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const all = await call('/memories?limit=10');
    expect(all.body.memories.length).toBe(4);

    const l0 = await call('/memories?level=0');
    expect(l0.body.memories.every((m: any) => m.currentLevel === 0)).toBe(true);
  });

  test('404 on an unknown trace', async () => {
    const { call } = setup();
    expect((await call('/memories/inexistante')).status).toBe(404);
  });
});

describe('Recall, photographic mode, deletion', () => {
  test('recall increments the counter and lifts salience', async () => {
    const { clock, store, post } = setup();
    const seeded = await seedMemories(store);
    const id = seeded['auth-bug'].id;

    clock.advanceHours(5);
    const { body } = await post(`/memories/${id}/recall`);

    expect(body.memory.recallCount).toBe(1);
    expect(body.memory.saillance).toBe(100);
  });

  test('photo toggles photographic mode both ways', async () => {
    const { store, post } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    expect((await post(`/memories/${id}/photo`, { enable: true })).body.memory.photographic).toBe(true);
    expect((await post(`/memories/${id}/photo`, { enable: false })).body.memory.photographic).toBe(false);
    // Empty body: the route enables it by default.
    expect((await post(`/memories/${id}/photo`)).body.memory.photographic).toBe(true);
  });

  test('delete removes the trace', async () => {
    const { store, call } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    expect((await call(`/memories/${id}`, { method: 'DELETE' })).body.success).toBe(true);
    expect((await call(`/memories/${id}`)).status).toBe(404);
  });
});

describe('GET /search', () => {
  test('requires a query', async () => {
    const { call } = setup();
    const { status, body } = await call('/search');
    expect(status).toBe(400);
    expect(body.error).toMatch(/q/);
  });

  test('finds a trace through its keywords', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { body } = await call('/search?q=sqlite');
    expect(body.success).toBe(true);
    expect(body.results.length).toBeGreaterThan(0);
  });

  test('advanced filters are passed through to the store', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    // minSaillance set very high: nothing should pass.
    const strict = await call('/search?q=sqlite&minSaillance=101');
    expect(strict.body.results.length).toBe(0);
  });
});

describe('Similar traces and merging', () => {
  test('findSimilar never returns the trace itself', async () => {
    const { store, call } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    const { body } = await call(`/memories/${id}/similar?threshold=0`);
    expect(body.results.every((r: any) => r.memory.id !== id)).toBe(true);
  });

  test('merge requires a target', async () => {
    const { store, post } = setup();
    const id = (await seedMemories(store))['auth-bug'].id;

    const { status, body } = await post(`/memories/${id}/merge`, {});
    expect(status).toBe(400);
    expect(body.error).toMatch(/targetId/);
  });

  test('merge drops the source to level 4 and links it to the target', async () => {
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
  test('counts traces per level and computes the averages', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { body } = await call('/status');
    expect(body.status.total).toBe(4);
    expect(body.status.byLevel.level0).toBe(4);
    expect(body.status.averages.saillance).toBeGreaterThan(0);
  });

  test('an empty database does not divide by zero', async () => {
    const { call } = setup();
    const { body } = await call('/status');

    expect(body.status.total).toBe(0);
    expect(Number.isNaN(body.status.averages.saillance)).toBe(false);
  });
});

describe('Sessions (replay)', () => {
  test('groups traces by session', async () => {
    const { store, call } = setup();
    await seedMemories(store); // two sessions in the fixtures

    const { body } = await call('/sessions');
    expect(body.sessions.length).toBe(2);
    expect(body.sessions.reduce((n: number, s: any) => n + s.count, 0)).toBe(4);
  });

  test('a session detail returns its events', async () => {
    const { store, call } = setup();
    await seedMemories(store);

    const { status, body } = await call('/sessions/session-fixture-1');
    expect(status).toBe(200);
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e: any) => typeof e.type === 'string')).toBe(true);
  });

  test('an unknown session returns an empty list, not an error', async () => {
    const { call } = setup();
    const { status, body } = await call('/sessions/never-seen');

    expect(status).toBe(200);
    expect(body.events).toEqual([]);
  });
});

describe('POST /decay', () => {
  test('advances decay for every trace', async () => {
    const { clock, store, post, call } = setup();
    const id = (await seedMemories(store))['decay-curve'].id;

    clock.advanceHours(200); // past the L2 threshold
    expect((await post('/decay')).body.success).toBe(true);

    const { body } = await call(`/memories/${id}`);
    expect(body.memory.currentLevel).toBeGreaterThan(0);
  });
});
