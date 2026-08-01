import { describe, test, expect } from 'bun:test';
import { createIntentionRoutes, validateTriggerSpec, validateAppEvent } from '../src/api/intentions-routes.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';

/**
 * Phase 5.4 — HTTP surface of prospective memory (story S5-04).
 * The sub-router takes its store as a parameter: each test gets its own
 * `:memory:` database, nothing touches `data/humemory.db`.
 */

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const app = createIntentionRoutes(store, { clock });

  const call = async (path: string, init?: RequestInit) => {
    const res = await app.request(`http://local${path}`, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as any };
  };

  const post = (path: string, payload?: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return { clock, store, call, post };
}

describe('Input validation', () => {
  test('a well-formed triggerSpec passes', () => {
    expect(validateTriggerSpec({ kind: 'time', at: '2026-12-01T00:00:00Z' })).toEqual({
      kind: 'time',
      at: '2026-12-01T00:00:00Z',
    });
    expect(validateTriggerSpec({ kind: 'event', type: 'file_open', path: 'a.ts' })).toEqual({
      kind: 'event',
      type: 'file_open',
      path: 'a.ts',
    });
  });

  test('a dubious triggerSpec is rejected, not stored', () => {
    // Storing an invalid spec would give a cue that never wakes anything.
    expect(() => validateTriggerSpec(null)).toThrow();
    expect(() => validateTriggerSpec({ kind: 'time' })).toThrow(/at.*cron|cron/i);
    expect(() => validateTriggerSpec({ kind: 'time', at: 'pas une date' })).toThrow(/ISO/);
    expect(() => validateTriggerSpec({ kind: 'event', type: 'inconnu' })).toThrow();
    expect(() => validateTriggerSpec({ kind: 'event', type: 'file_open' })).toThrow(/path/);
    expect(() => validateTriggerSpec({ kind: 'autre' })).toThrow();
  });

  test('events are validated per variant', () => {
    expect(validateAppEvent({ type: 'branch_switch', branch: 'main', directory: '/x' })).toMatchObject({
      type: 'branch_switch',
    });
    expect(() => validateAppEvent({ type: 'branch_switch', directory: '/x' })).toThrow(/branch/);
    expect(() => validateAppEvent({ type: 'file_open', path: 'a.ts' })).toThrow(/directory/);
    expect(() => validateAppEvent({ type: 'inconnu', directory: '/x' })).toThrow();
  });

  test('a commit with neither message nor files is still accepted', () => {
    expect(validateAppEvent({ type: 'commit', sha: 'abc', directory: '/x' })).toEqual({
      type: 'commit',
      sha: 'abc',
      message: '',
      files: [],
      directory: '/x',
    });
  });
});

describe('POST /intentions', () => {
  test('arms a loop and returns its short id', async () => {
    const { post } = setup();
    const { status, body } = await post('/intentions', {
      content: 'refactor la validation de token',
      directory: '/src/auth',
    });

    expect(status).toBe(201);
    expect(body.intention.status).toBe('armed');
    expect(body.intention.saillance).toBe(100);
    expect(body.intention.loopId).toMatch(/^loop-[0-9a-f]{8}$/);
  });

  test('arms the supplied cues in the same breath', async () => {
    const { post, call } = setup();
    const { body } = await post('/intentions', {
      content: 'x',
      directory: '/src',
      cues: [
        { kind: 'event', type: 'file_open', path: 'src/a.ts' },
        { kind: 'time', at: '2026-12-01T00:00:00Z' },
      ],
    });

    const detail = await call(`/intentions/${body.intention.id}`);
    expect(detail.body.cues.length).toBe(2);
  });

  test('rejects incomplete input with a 400', async () => {
    const { post } = setup();
    expect((await post('/intentions', { directory: '/src' })).status).toBe(400);
    expect((await post('/intentions', { content: '   ', directory: '/src' })).status).toBe(400);
    expect((await post('/intentions', { content: 'x' })).status).toBe(400);
    expect((await post('/intentions', { content: 'x', directory: '/s', expiresAt: 'nope' })).status).toBe(400);
  });

  test('an invalid cue fails the whole creation', async () => {
    const { post, call } = setup();
    const res = await post('/intentions', {
      content: 'x',
      directory: '/src',
      cues: [{ kind: 'event', type: 'file_open' }],
    });

    expect(res.status).toBe(400);
    // Nothing must have been half-created.
    expect((await call('/intentions')).body.count).toBe(0);
  });
});

describe('GET /intentions', () => {
  test('filters by status and by directory', async () => {
    const { post, call } = setup();
    await post('/intentions', { content: 'here', directory: '/src/auth' });
    const autre = await post('/intentions', { content: 'elsewhere', directory: '/other' });
    await post(`/intentions/${autre.body.intention.id}/close`);

    expect((await call('/intentions')).body.count).toBe(2);
    expect((await call('/intentions?status=armed')).body.count).toBe(1);
    expect((await call('/intentions?status=armed,closed')).body.count).toBe(2);
    expect((await call('/intentions?directory=/src/auth')).body.count).toBe(1);
  });

  test('an out-of-range status or limit answers 400', async () => {
    const { call } = setup();
    expect((await call('/intentions?status=zombie')).status).toBe(400);
    expect((await call('/intentions?limit=0')).status).toBe(400);
    expect((await call('/intentions?limit=9999')).status).toBe(400);
    expect((await call('/intentions?limit=abc')).status).toBe(400);
  });

  test('404 on an unknown intention', async () => {
    const { call } = setup();
    expect((await call('/intentions/inexistante')).status).toBe(404);
  });
});

describe('Closing and deleting', () => {
  test('close records the commit and cancels remaining cues', async () => {
    const { post, call } = setup();
    const { body } = await post('/intentions', {
      content: 'x',
      directory: '/src',
      cues: [{ kind: 'event', type: 'file_open', path: 'a.ts' }],
    });

    const closed = await post(`/intentions/${body.intention.id}/close`, { commit: 'deadbee' });
    expect(closed.body.intention.status).toBe('closed');
    expect(closed.body.intention.closedByCommit).toBe('deadbee');

    const detail = await call(`/intentions/${body.intention.id}`);
    // A cue outliving its loop would wake a ghost.
    expect(detail.body.cues.every((c: any) => c.status === 'cancelled')).toBe(true);
  });

  test('fire forces the wake-up', async () => {
    const { post } = setup();
    const { body } = await post('/intentions', { content: 'x', directory: '/src' });

    const fired = await post(`/intentions/${body.intention.id}/fire`);
    expect(fired.body.intention.status).toBe('fired');
    expect(fired.body.intention.firedAt).not.toBeNull();
  });

  test('delete takes the cues with it', async () => {
    const { post, call } = setup();
    const { body } = await post('/intentions', {
      content: 'x',
      directory: '/src',
      cues: [{ kind: 'time', at: '2026-12-01T00:00:00Z' }],
    });

    const res = await call(`/intentions/${body.intention.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await call('/cues')).body.count).toBe(0);
  });

  test('close, fire and delete answer 404 on an unknown loop', async () => {
    const { post, call } = setup();
    expect((await post('/intentions/nope/close')).status).toBe(404);
    expect((await post('/intentions/nope/fire')).status).toBe(404);
    expect((await call('/intentions/nope', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('Cues', () => {
  test('POST /cues attaches a cue to an existing loop', async () => {
    const { post, call } = setup();
    const { body } = await post('/intentions', { content: 'x', directory: '/src' });

    const res = await post('/cues', {
      intentionId: body.intention.id,
      triggerSpec: { kind: 'time', cron: '0 9 * * 1' },
    });

    expect(res.status).toBe(201);
    expect(res.body.cue.kind).toBe('time');
    expect((await call('/cues?kind=time')).body.count).toBe(1);
  });

  test('404 when the target loop does not exist, 400 when the spec is invalid', async () => {
    const { post } = setup();
    expect(
      (await post('/cues', { intentionId: 'nope', triggerSpec: { kind: 'time', at: '2026-01-01T00:00:00Z' } }))
        .status
    ).toBe(404);

    const { body } = await post('/intentions', { content: 'x', directory: '/src' });
    expect((await post('/cues', { intentionId: body.intention.id, triggerSpec: { kind: 'nope' } })).status).toBe(
      400
    );
  });

  test('an invalid kind filter answers 400', async () => {
    const { call } = setup();
    expect((await call('/cues?kind=magique')).status).toBe(400);
  });
});

describe('POST /events', () => {
  test('an event wakes the loops that match', async () => {
    const { post } = setup();
    await post('/intentions', {
      content: 'refactor auth',
      directory: '/src/auth',
      cues: [{ kind: 'event', type: 'file_open', path: 'src/auth/service.ts' }],
    });

    const res = await post('/events', {
      type: 'file_open',
      path: 'src/auth/service.ts',
      directory: '/src/auth',
    });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.fired[0].status).toBe('fired');
  });

  test('an event from another project wakes nothing', async () => {
    const { post } = setup();
    await post('/intentions', {
      content: 'auth',
      directory: '/src/auth',
      cues: [{ kind: 'event', type: 'branch_switch', branch: 'main' }],
    });

    const res = await post('/events', { type: 'branch_switch', branch: 'main', directory: '/autre/projet' });
    expect(res.body.count).toBe(0);
  });

  test('a malformed event answers 400', async () => {
    const { post } = setup();
    expect((await post('/events', { type: 'file_open', directory: '/src' })).status).toBe(400);
    expect((await post('/events', {})).status).toBe(400);
  });
});

describe('POST /cues/resolve', () => {
  test('expires overdue loops and fires deadlines that came due', async () => {
    const { clock, post } = setup();

    await post('/intentions', {
      content: 'deadline',
      directory: '/src',
      cues: [{ kind: 'time', at: new Date(T0.getTime() + 3600_000).toISOString() }],
    });
    await post('/intentions', {
      content: 'overdue',
      directory: '/src',
      expiresAt: new Date(T0.getTime() + 1800_000).toISOString(),
    });

    // Nothing is due yet.
    expect((await post('/cues/resolve')).body).toMatchObject({ expired: 0, count: 0 });

    clock.advanceHours(2);
    const res = await post('/cues/resolve');
    expect(res.body.expired).toBe(1);
    expect(res.body.count).toBe(1);
  });
});
