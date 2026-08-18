import { describe, test, expect, afterEach } from 'bun:test';
import { Hono } from 'hono';
import { serverErrorBody } from '../src/api/errors.js';

/**
 * Regression for SECURITY_AUDIT.md L-01: handlers returned `String(error)` to
 * the caller, so a SQLite failure handed out the schema, a constraint name or an
 * absolute local path. The detail now goes to the server log under a correlation
 * id and the client gets only that id.
 */

const SECRET = 'SQLITE_CONSTRAINT: UNIQUE constraint failed: memories.id (D:\\dev\\humemory\\data\\humemory.db)';

/** Runs `fn` with console.error captured rather than printed. */
function withCapturedLog<T>(fn: () => T): { result: T; logged: string } {
  const original = console.error;
  let logged = '';
  console.error = (...args: unknown[]) => {
    logged += args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  };
  try {
    return { result: fn(), logged };
  } finally {
    console.error = original;
  }
}

afterEach(() => {
  delete process.env.HUMEMORY_VERBOSE_ERRORS;
});

describe('serverErrorBody (L-01)', () => {
  test('never returns the underlying message to the caller', () => {
    const { result } = withCapturedLog(() => serverErrorBody('POST /memories', new Error(SECRET)));

    expect(result.success).toBe(false);
    expect(result.error).toBe('Internal server error');
    expect(JSON.stringify(result)).not.toContain('SQLITE_CONSTRAINT');
    expect(JSON.stringify(result)).not.toContain('humemory.db');
  });

  test('logs the full detail server-side under the returned id', () => {
    const { result, logged } = withCapturedLog(() =>
      serverErrorBody('POST /memories', new Error(SECRET))
    );

    expect(logged).toContain(SECRET);
    expect(logged).toContain(result.errorId);
    expect(logged).toContain('POST /memories');
  });

  test('gives every failure a distinct correlation id', () => {
    const { result: a } = withCapturedLog(() => serverErrorBody('ctx', new Error('x')));
    const { result: b } = withCapturedLog(() => serverErrorBody('ctx', new Error('x')));

    expect(a.errorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.errorId).not.toBe(b.errorId);
  });

  test('handles a non-Error throw without leaking it', () => {
    const { result } = withCapturedLog(() => serverErrorBody('ctx', { secret: SECRET }));
    expect(result.error).toBe('Internal server error');
    expect(JSON.stringify(result)).not.toContain('SQLITE_CONSTRAINT');
  });

  test('HUMEMORY_VERBOSE_ERRORS=1 re-enables detail for local debugging', () => {
    process.env.HUMEMORY_VERBOSE_ERRORS = '1';
    const { result } = withCapturedLog(() => serverErrorBody('ctx', new Error(SECRET)));
    expect(result.error).toBe(SECRET);
  });
});

describe('a failing route (L-01)', () => {
  test('answers 500 with the generic body, not the thrown message', async () => {
    const app = new Hono();
    app.get('/boom', (c) => {
      try {
        throw new Error(SECRET);
      } catch (error) {
        return c.json(serverErrorBody(`${c.req.method} ${c.req.path}`, error), 500);
      }
    });

    const { result } = withCapturedLog(() => app.request('http://local/boom'));
    const res = await result;
    const body = (await res.json()) as any;

    expect(res.status).toBe(500);
    expect(body.error).toBe('Internal server error');
    expect(body.errorId).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('humemory.db');
  });
});
