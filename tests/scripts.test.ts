import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import type { TriggerSpec } from '../src/core/types.js';

/**
 * Phase 8.1 — cognitive scripts data model + cues target_kind migration.
 * Hermetic: :memory: stores, frozen clock, no network.
 */

const BRANCH_CUE: TriggerSpec = { kind: 'event', type: 'branch_switch', branch: 'main' };
const CRON_CUE: TriggerSpec = { kind: 'time', cron: '0 9 * * 1' };

const DRILL = {
  name: 'release-check',
  description: 'Vérifier le bon avant de peser.',
  steps: ['pnpm build passes', 'bun test 327/327', 'git status clean'],
  directory: '/src',
};

describe('Scripts — writing and reading', () => {
  test('human-authored script lands active, agent-authored lands draft (8.3 gate)', async () => {
    const store = freshStore();
    const human = await store.addScript({ ...DRILL, name: 'h', source: 'human' });
    const agent = await store.addScript({ ...DRILL, name: 'a', source: 'agent', agent: 'kimi' });

    expect(human.status).toBe('active');
    expect(agent.status).toBe('draft');
    expect(agent.agent).toBe('kimi');
    expect(human.saillance).toBe(50);
    expect(human.fireCount).toBe(0);
    expect(human.pinned).toBe(false);
    expect(human.createdAt.toISOString()).toBe(T0.toISOString());
    store.close();
  });

  test('validation: name and non-empty steps are required', async () => {
    const store = freshStore();
    await expect(store.addScript({ ...DRILL, name: ' ' })).rejects.toThrow('name');
    await expect(store.addScript({ ...DRILL, steps: [] })).rejects.toThrow('step');
    await expect(store.addScript({ ...DRILL, steps: ['ok', '  '] })).rejects.toThrow('step');
    store.close();
  });

  test('addScript arms its cues with targetKind script', async () => {
    const store = freshStore();
    const script = await store.addScript(DRILL, [BRANCH_CUE, CRON_CUE]);

    const cues = await store.listCues({ targetKind: 'script', targetId: script.id });
    expect(cues.length).toBe(2);
    expect(cues.every((c) => c.targetKind === 'script' && c.targetId === script.id)).toBe(true);
    // Compat alias: intentionId mirrors targetId (deprecated, see types.ts).
    expect(cues[0].intentionId).toBe(script.id);
    store.close();
  });

  test('getScriptByName is unique per directory; listScripts filters by status', async () => {
    const store = freshStore();
    await store.addScript({ ...DRILL, name: 'x', directory: '/a', source: 'human' });
    await store.addScript({ ...DRILL, name: 'x', directory: '/b' }); // draft
    await store.addScript({ ...DRILL, name: 'y', directory: '/a' }); // draft

    expect((await store.getScriptByName('x', '/a'))!.status).toBe('active');
    expect((await store.getScriptByName('x', '/b'))!.status).toBe('draft');
    expect((await store.listScripts({ status: 'active' })).length).toBe(1);
    expect((await store.listScripts({ directory: '/a' })).length).toBe(2);
    store.close();
  });
});

describe('Scripts — lifecycle', () => {
  test('activate flips a draft; archive cancels its armed cues', async () => {
    const store = freshStore();
    const script = await store.addScript(DRILL, [BRANCH_CUE]);
    expect(script.status).toBe('draft');

    await store.updateScriptStatus(script.id, 'active');
    expect((await store.getScript(script.id))!.status).toBe('active');
    expect((await store.listCues({ targetId: script.id, status: 'armed' })).length).toBe(1);

    await store.updateScriptStatus(script.id, 'archived');
    expect((await store.listCues({ targetId: script.id, status: 'armed' })).length).toBe(0);
    expect((await store.listCues({ targetId: script.id, status: 'cancelled' })).length).toBe(1);
    store.close();
  });

  test('markScriptFired bumps count and saillance, capped at 100', async () => {
    const store = freshStore();
    const script = await store.addScript({ ...DRILL, source: 'human' }); // saillance 50

    for (let i = 0; i < 3; i++) await store.markScriptFired(script.id);
    let reloaded = (await store.getScript(script.id))!;
    expect(reloaded.fireCount).toBe(3);
    expect(reloaded.saillance).toBe(65);
    expect(reloaded.lastFiredAt!.toISOString()).toBe(T0.toISOString());

    for (let i = 0; i < 10; i++) await store.markScriptFired(script.id);
    reloaded = (await store.getScript(script.id))!;
    expect(reloaded.saillance).toBe(100); // cap
    store.close();
  });

  test('updateScript patches fields, bumps updatedAt, validates steps', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const script = await store.addScript(DRILL);

    clock.advanceHours(1);
    const updated = await store.updateScript(script.id, {
      description: 'new desc',
      steps: ['only one step'],
      pinned: true,
    });
    expect(updated.description).toBe('new desc');
    expect(updated.steps).toEqual(['only one step']);
    expect(updated.pinned).toBe(true);
    expect(updated.name).toBe(DRILL.name); // untouched
    expect(updated.updatedAt.getTime()).toBeGreaterThan(updated.createdAt.getTime());

    await expect(store.updateScript(script.id, { steps: [] })).rejects.toThrow('step');
    store.close();
  });

  test('deleteScript removes the script and its cues', async () => {
    const store = freshStore();
    const script = await store.addScript(DRILL, [BRANCH_CUE]);
    await store.deleteScript(script.id);

    expect(await store.getScript(script.id)).toBeNull();
    expect((await store.listCues({ targetId: script.id })).length).toBe(0);
    store.close();
  });

  test('deleteIntention still removes its own cues (explicit, post-FK world)', async () => {
    const store = freshStore();
    const intention = await store.addIntention(
      { content: 'loop', directory: '/src' },
      [BRANCH_CUE]
    );
    await store.deleteIntention(intention.id);
    expect((await store.listCues({ intentionId: intention.id })).length).toBe(0);
    store.close();
  });
});

describe('Resolver — script fan-out (8.1)', () => {
  test('event cue fires an active script, never a draft', async () => {
    const store = freshStore();
    const active = await store.addScript({ ...DRILL, source: 'human' }, [BRANCH_CUE]);
    const draft = await store.addScript({ ...DRILL, name: 'draft-drill' }, [BRANCH_CUE]);

    const resolver = new SqliteCueResolver(store);
    const matched = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/src',
    } as any);

    expect(matched.length).toBe(1);
    expect(matched[0].targetId).toBe(active.id);
    expect(matched[0].targetId).not.toBe(draft.id);

    const fired = await resolver.fireAny(matched[0].id);
    expect(fired.kind).toBe('script');
    if (fired.kind === 'script') {
      expect(fired.script.fireCount).toBe(1);
      expect(fired.script.saillance).toBe(55);
    }
    store.close();
  });

  test('directory filtering applies to scripts (mental place)', async () => {
    const store = freshStore();
    await store.addScript({ ...DRILL, source: 'human' }, [BRANCH_CUE]); // directory /src

    const resolver = new SqliteCueResolver(store);
    const matched = await resolver.resolveEventCues({
      type: 'branch_switch',
      branch: 'main',
      directory: '/elsewhere/project',
    } as any);
    expect(matched.length).toBe(0);
    store.close();
  });

  test('fire() refuses a script cue and fireScript() refuses an intention cue', async () => {
    const store = freshStore();
    const script = await store.addScript({ ...DRILL, source: 'human' }, [BRANCH_CUE]);
    const intention = await store.addIntention({ content: 'x', directory: '/src' }, [BRANCH_CUE]);

    const [scriptCue] = await store.listCues({ targetKind: 'script', targetId: script.id });
    const [intentionCue] = await store.listCues({ intentionId: intention.id });
    const resolver = new SqliteCueResolver(store);

    await expect(resolver.fire(scriptCue.id)).rejects.toThrow('fireScript');
    await expect(resolver.fireScript(intentionCue.id)).rejects.toThrow('fire');
    store.close();
  });

  test('cron script cue re-arms after firing (recurrence)', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    await store.addScript({ ...DRILL, source: 'human' }, [CRON_CUE]);

    // Monday 2026-01-05 09:05 UTC — the 09:00 occurrence is due.
    clock.set(new Date('2026-01-05T09:05:00.000Z'));
    const resolver = new SqliteCueResolver(store, { clock });
    const due = await resolver.resolveTimeCues();
    expect(due.length).toBe(1);

    await resolver.fireAny(due[0].id);
    const rearmed = await store.getCue(due[0].id);
    expect(rearmed!.status).toBe('armed');
    expect(rearmed!.firedAt).toBeDefined();
    store.close();
  });
});

describe('Cues migration — intention_id → target_kind/target_id (8.1)', () => {
  test('an old-schema cues table is rebuilt without losing rows', async () => {
    const { mkdtempSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { Database } = await import('bun:sqlite');
    const { SQLiteStore } = await import('../src/store/sqlite.js');

    const dir = mkdtempSync(join(tmpdir(), 'humemory-cuemig-'));
    const dbPath = join(dir, 'mig.db');

    try {
      // Seed an OLD-schema cues table (pre-8.1 shape) directly.
      const raw = new Database(dbPath);
      raw.exec(`
        CREATE TABLE cues (
          id TEXT PRIMARY KEY,
          intention_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          trigger_spec TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'armed',
          armed_at INTEGER NOT NULL,
          fired_at INTEGER
        );
        INSERT INTO cues (id, intention_id, kind, trigger_spec, status, armed_at)
          VALUES ('cue-1', 'int-1', 'event', '{"kind":"event","type":"branch_switch","branch":"main"}', 'armed', 1000);
      `);
      raw.close();

      const store = new SQLiteStore(dbPath, { clock: fakeClock() });
      const cue = await store.getCue('cue-1');
      expect(cue).not.toBeNull();
      expect(cue!.targetKind).toBe('intention');
      expect(cue!.targetId).toBe('int-1');
      expect(cue!.intentionId).toBe('int-1'); // compat alias
      expect(cue!.armedAt.getTime()).toBe(1000);

      // The old column is gone; the new schema serves script cues too.
      const script = await store.addScript(DRILL, [BRANCH_CUE]);
      expect((await store.listCues({ targetKind: 'script', targetId: script.id })).length).toBe(1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
