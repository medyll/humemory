import { describe, test, expect } from 'bun:test';
import { createScriptRoutes } from '../src/api/scripts-routes.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';

/**
 * Phase 8.3 — HTTP surface of cognitive scripts. Hermetic: each test gets its
 * own `:memory:` store; nothing touches `data/humemory.db`.
 * Trust rule under test: HTTP-authored scripts are agent claims → DRAFT.
 */

function setup() {
  const clock = fakeClock();
  const store = freshStore({ clock });
  const app = createScriptRoutes(store);

  const call = async (path: string, init?: RequestInit) => {
    const res = await app.request(`http://local${path}`, init);
    const body = await res.json().catch(() => null);
    return { status: res.status, body: body as any };
  };

  const post = (path: string, payload?: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

  return { clock, store, call, post };
}

const DRILL = {
  name: 'release-check',
  description: 'Vérifier le bon avant de peser.',
  steps: ['pnpm build passes', 'bun test green'],
  directory: '/src',
};

describe('POST /scripts — the 8.3 draft gate', () => {
  test('HTTP-authored script lands as draft with agent attribution', async () => {
    const { post } = setup();
    const { status, body } = await post('/scripts', DRILL, { 'X-Humemory-Agent': 'kimi' });

    expect(status).toBe(201);
    expect(body.script.status).toBe('draft');
    expect(body.script.source).toBe('agent');
    expect(body.script.agent).toBe('kimi');
    expect(body.script.steps).toEqual(DRILL.steps);
    expect(body.script.shortId.length).toBe(8);
  });

  test('source cannot be overridden from the network', async () => {
    const { post } = setup();
    const { body } = await post('/scripts', { ...DRILL, name: 'sneaky', source: 'human' });
    expect(body.script.status).toBe('draft');
    expect(body.script.source).toBe('agent');
  });

  test('cues are validated and attached to the script target', async () => {
    const { post, call } = setup();
    const created = await post('/scripts', {
      ...DRILL,
      cues: [{ kind: 'event', type: 'branch_switch', branch: 'main' }],
    });
    expect(created.status).toBe(201);

    const fetched = await call(`/scripts/${created.body.script.shortId}`);
    expect(fetched.body.cues.length).toBe(1);
    expect(fetched.body.cues[0].targetKind).toBe('script');
  });

  test('invalid input is a 400, not a 500', async () => {
    const { post } = setup();
    expect((await post('/scripts', { ...DRILL, name: '' })).status).toBe(400);
    expect((await post('/scripts', { ...DRILL, steps: [] })).status).toBe(400);
    expect((await post('/scripts', { ...DRILL, steps: ['ok', ' '] })).status).toBe(400);
    expect((await post('/scripts', { description: 'x', steps: ['a'], directory: '/s' })).status).toBe(400);
    expect(
      (await post('/scripts', { ...DRILL, cues: [{ kind: 'time' }] })).status
    ).toBe(400);
  });
});

describe('Lifecycle endpoints', () => {
  test('activate flips the draft; fire only works on active drills', async () => {
    const { post } = setup();
    const created = await post('/scripts', DRILL);
    const id = created.body.script.shortId;

    // Drafts never fire.
    const earlyFire = await post(`/scripts/${id}/fire`);
    expect(earlyFire.status).toBe(409);

    const activated = await post(`/scripts/${id}/activate`);
    expect(activated.body.script.status).toBe('active');

    const fired = await post(`/scripts/${id}/fire`);
    expect(fired.status).toBe(200);
    expect(fired.body.script.fireCount).toBe(1);
    expect(fired.body.script.saillance).toBe(55);
  });

  test('archive cancels the script and blocks firing', async () => {
    const { post } = setup();
    const created = await post('/scripts', DRILL);
    const id = created.body.script.shortId;

    await post(`/scripts/${id}/activate`);
    const archived = await post(`/scripts/${id}/archive`);
    expect(archived.body.script.status).toBe('archived');
    expect((await post(`/scripts/${id}/fire`)).status).toBe(409);
  });

  test('unknown or ambiguous prefix is a 404', async () => {
    const { post } = setup();
    expect((await post('/scripts/deadbeef/activate')).status).toBe(404);
  });

  test('GET /scripts filters by status', async () => {
    const { post, call } = setup();
    const a = await post('/scripts', { ...DRILL, name: 'a' });
    await post('/scripts', { ...DRILL, name: 'b' });
    await post(`/scripts/${a.body.script.shortId}/activate`);

    const drafts = await call('/scripts?status=draft');
    expect(drafts.body.count).toBe(1);
    const actives = await call('/scripts?status=active');
    expect(actives.body.count).toBe(1);
    const both = await call('/scripts?status=draft,active');
    expect(both.body.count).toBe(2);
    expect((await call('/scripts?status=bogus')).status).toBe(400);
  });
});
