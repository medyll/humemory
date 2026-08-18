import { describe, test, expect } from 'bun:test';
import { createMemoryRoutes } from '../src/api/memory-routes.js';
import { createIntentionRoutes } from '../src/api/intentions-routes.js';
import { createScriptRoutes } from '../src/api/scripts-routes.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';
import {
  boundedInt,
  boundedString,
  boundedStringArray,
  LimitExceeded,
  MAX_CONTENT_LENGTH,
  MAX_KEYWORDS,
  MAX_COLLECTION_ITEMS,
  MAX_RESULT_LIMIT,
} from '../src/api/limits.js';

/**
 * Regression for SECURITY_AUDIT.md M-02: creation routes read `c.req.json()`
 * with no size ceiling and parsed cost parameters with a bare `parseInt`, so
 * `?limit=999999999`, `?limit=abc` or a multi-megabyte field reached the store
 * unchecked. Bodies, collections and numeric parameters are now bounded, and a
 * violation is the caller's 400 rather than our 500.
 */

function harness(makeApp: (store: any) => any) {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const app = makeApp(store);

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

const memories = () => harness(createMemoryRoutes);
const intentions = () => harness(createIntentionRoutes);
const scripts = () => harness(createScriptRoutes);

describe('bounded helpers', () => {
  test('boundedInt rejects NaN, floats and out-of-range values', () => {
    const opts = { fallback: 10, min: 1, max: 100, name: 'limit' };
    expect(boundedInt(undefined, opts)).toBe(10);
    expect(boundedInt('42', opts)).toBe(42);
    for (const bad of ['abc', 'NaN', 'Infinity', '1.5', '0', '101', '-5', '999999999']) {
      expect(() => boundedInt(bad, opts)).toThrow(LimitExceeded);
    }
  });

  test('boundedString and boundedStringArray enforce their caps', () => {
    expect(() => boundedString('x'.repeat(11), 10, 'f')).toThrow(/at most 10/);
    expect(() => boundedString(42, 10, 'f')).toThrow(/must be a string/);
    expect(boundedStringArray(undefined, { maxItems: 2, maxItemLength: 5, name: 'k' })).toEqual([]);
    expect(() =>
      boundedStringArray(['a', 'b', 'c'], { maxItems: 2, maxItemLength: 5, name: 'k' })
    ).toThrow(/at most 2 items/);
    expect(() =>
      boundedStringArray(['toolong'], { maxItems: 2, maxItemLength: 5, name: 'k' })
    ).toThrow(/k\[0\]/);
  });
});

describe('POST /memories limits', () => {
  test('refuses oversized content with 400, not 500', async () => {
    const { post } = memories();
    const { status, body } = await post('/memories', {
      content: 'x'.repeat(MAX_CONTENT_LENGTH + 1),
      directory: '/src',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/content/);
  });

  test('refuses an unbounded keyword collection', async () => {
    const { post } = memories();
    const { status, body } = await post('/memories', {
      content: 'ok',
      directory: '/src',
      keywords: Array.from({ length: MAX_KEYWORDS + 1 }, (_, i) => `k${i}`),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/keywords/);
  });

  test('still accepts an ordinary trace', async () => {
    const { post } = memories();
    const { status } = await post('/memories', {
      content: 'a normal learning trace',
      directory: '/src',
      keywords: ['sqlite', 'wal'],
    });
    expect(status).toBe(201);
  });
});

describe('cost parameters', () => {
  test('GET /memories refuses a limit past the ceiling', async () => {
    const { call } = memories();
    const { status, body } = await call(`/memories?limit=${MAX_RESULT_LIMIT + 1}`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/limit/);
  });

  test('GET /memories refuses a non-numeric limit instead of coercing it', async () => {
    const { call } = memories();
    // Previously `parseInt('abc')` produced NaN and went straight to the store.
    expect((await call('/memories?limit=abc')).status).toBe(400);
  });

  test('GET /memories/:id/similar bounds limit and threshold', async () => {
    const { call } = memories();
    expect((await call('/memories/x/similar?limit=999999')).status).toBe(400);
    expect((await call('/memories/x/similar?threshold=500')).status).toBe(400);
  });

  test('a limit inside the range is honoured', async () => {
    const { call } = memories();
    const { status } = await call(`/memories?limit=${MAX_RESULT_LIMIT}`);
    expect(status).toBe(200);
  });
});

describe('POST /intentions limits', () => {
  test('refuses oversized content', async () => {
    const { post } = intentions();
    const { status, body } = await post('/intentions', {
      content: 'x'.repeat(MAX_CONTENT_LENGTH + 1),
      directory: '/src',
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/content/);
  });

  test('refuses an unbounded cue collection', async () => {
    const { post } = intentions();
    const { status, body } = await post('/intentions', {
      content: 'ok',
      directory: '/src',
      cues: Array.from({ length: MAX_COLLECTION_ITEMS + 1 }, () => ({
        kind: 'event',
        type: 'branch_switch',
        branch: 'main',
      })),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/cues/);
  });
});

describe('POST /scripts limits', () => {
  test('refuses an unbounded step collection', async () => {
    const { post } = scripts();
    const { status, body } = await post('/scripts', {
      name: 'big',
      description: 'too many steps',
      directory: '/src',
      steps: Array.from({ length: MAX_COLLECTION_ITEMS + 1 }, (_, i) => `step ${i}`),
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/steps/);
  });

  test('refuses an oversized single step', async () => {
    const { post } = scripts();
    const { status, body } = await post('/scripts', {
      name: 'big',
      description: 'one huge step',
      directory: '/src',
      steps: ['x'.repeat(MAX_CONTENT_LENGTH + 1)],
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/steps\[0\]/);
  });
});

describe('transport-level body limit', () => {
  test('a body past MAX_BODY_BYTES is refused with 413', async () => {
    // The server mounts hono's bodyLimit ahead of every route; this exercises
    // the same middleware in isolation so the test needs no listening socket.
    const { Hono } = await import('hono');
    const { bodyLimit } = await import('hono/body-limit');
    const { MAX_BODY_BYTES } = await import('../src/api/limits.js');

    const app = new Hono();
    app.use('*', bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => c.json({ success: false, error: 'Request body too large' }, 413),
    }));
    app.post('/echo', async (c) => c.json({ ok: true }));

    const oversized = JSON.stringify({ content: 'x'.repeat(MAX_BODY_BYTES + 100) });
    const res = await app.request('http://local/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversized,
    });
    expect(res.status).toBe(413);

    const ok = await app.request('http://local/echo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'small' }),
    });
    expect(ok.status).toBe(200);
  });
});
