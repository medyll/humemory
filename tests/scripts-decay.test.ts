import { describe, test, expect } from 'bun:test';
import {
  scriptEffectiveSaillance,
  sweepDisusedScripts,
  SCRIPT_DISUSE_GRACE_DAYS,
  SCRIPT_DISUSE_FADE_PER_MONTH,
} from '../src/core/scripts.js';
import { freshStore } from './helpers/store.js';
import { fakeClock, T0 } from './helpers/clock.js';
import type { Script, ScriptStore } from '../src/core/types.js';

/**
 * Phase 8.4 — disuse decay (inverse Zeigarnik). Pure functions + a sweep,
 * driven by the fake clock: fast-forward months, assert archival.
 */

const DRILL = {
  name: 'release-check',
  description: 'desc',
  steps: ['one'],
  directory: '/src',
};

function drillAt(overrides: Partial<Script>): Script {
  return {
    id: 's1',
    ...DRILL,
    status: 'active',
    saillance: 50,
    fireCount: 0,
    pinned: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('scriptEffectiveSaillance', () => {
  const DAY = 86_400_000;

  test('inside the 60-day grace, nothing fades', () => {
    const now = new Date(T0.getTime() + SCRIPT_DISUSE_GRACE_DAYS * DAY);
    expect(scriptEffectiveSaillance(drillAt({}), now)).toBe(50);
  });

  test('past grace: −10 per full month of disuse', () => {
    // 90 days of disuse = grace + 1 month → 50 − 10.
    const now = new Date(T0.getTime() + 90 * DAY);
    expect(scriptEffectiveSaillance(drillAt({}), now)).toBe(50 - SCRIPT_DISUSE_FADE_PER_MONTH);
    // 150 days = grace + 3 months → 50 − 30.
    const later = new Date(T0.getTime() + 150 * DAY);
    expect(scriptEffectiveSaillance(drillAt({}), later)).toBe(50 - 3 * SCRIPT_DISUSE_FADE_PER_MONTH);
  });

  test('disuse is measured from the last firing, not from creation', () => {
    const firedAt = new Date(T0.getTime() + 100 * DAY);
    const now = new Date(firedAt.getTime() + 30 * DAY); // only 30d of disuse
    expect(scriptEffectiveSaillance(drillAt({ lastFiredAt: firedAt }), now)).toBe(50);
  });

  test('pinned scripts never fade (photographic equivalent)', () => {
    const now = new Date(T0.getTime() + 1000 * DAY);
    expect(scriptEffectiveSaillance(drillAt({ pinned: true }), now)).toBe(50);
  });

  test('drafts and archived scripts are out of scope', () => {
    const now = new Date(T0.getTime() + 1000 * DAY);
    expect(scriptEffectiveSaillance(drillAt({ status: 'draft' }), now)).toBe(50);
    expect(scriptEffectiveSaillance(drillAt({ status: 'archived' }), now)).toBe(50);
  });

  test('effective saillance floors at 0', () => {
    const now = new Date(T0.getTime() + 1000 * DAY);
    expect(scriptEffectiveSaillance(drillAt({}), now)).toBe(0);
  });
});

describe('sweepDisusedScripts', () => {
  const DAY = 86_400_000;

  test('a rusted drill archives itself and loses its cues', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const script = await store.addScript({ ...DRILL, source: 'human' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    // 8 months later: 50 − 6×10 = −10 → effective 0 → archived.
    clock.set(new Date(T0.getTime() + 240 * DAY));
    const report = await sweepDisusedScripts(store, { clock });

    expect(report.archived.length).toBe(1);
    expect(report.archived[0].status).toBe('archived');
    expect((await store.listCues({ targetId: script.id, status: 'armed' })).length).toBe(0);
    expect((await store.listCues({ targetId: script.id, status: 'cancelled' })).length).toBe(1);
    store.close();
  });

  test('a decaying-but-alive drill is reported, not archived', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    await store.addScript({ ...DRILL, source: 'human', saillance: 60 });

    clock.set(new Date(T0.getTime() + 120 * DAY)); // 60 − 2×10 = 40 → decaying
    const report = await sweepDisusedScripts(store, { clock });

    expect(report.archived).toEqual([]);
    expect(report.decaying.length).toBe(1);
    expect(report.decaying[0].effective).toBe(40);
    store.close();
  });

  test('a weekly drill never decays — firing resets the disuse clock', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const script = await store.addScript({ ...DRILL, source: 'human' });

    // Fire every week for a year.
    for (let week = 1; week <= 52; week++) {
      clock.set(new Date(T0.getTime() + week * 7 * DAY));
      await store.markScriptFired(script.id);
    }
    const report = await sweepDisusedScripts(store, { clock });
    expect(report.archived).toEqual([]);
    expect(report.decaying).toEqual([]);
    store.close();
  });

  test('pinned drills survive any disuse', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    await store.addScript({ ...DRILL, source: 'human', pinned: true });

    clock.set(new Date(T0.getTime() + 3650 * DAY));
    const report = await sweepDisusedScripts(store, { clock });
    expect(report.archived).toEqual([]);
    store.close();
  });

  test('archival is human-visible: a script_archived dream proposal is filed', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const script = await store.addScript({ ...DRILL, source: 'human' });

    clock.set(new Date(T0.getTime() + 240 * DAY));
    const report = await sweepDisusedScripts(store, { clock });
    expect(report.archived.length).toBe(1);

    const pending = await store.listDreamProposals!({ status: 'pending' });
    const notice = pending.find((p) => p.kind === 'script_archived');
    expect(notice).toBeDefined();
    const payload = JSON.parse(notice!.payload);
    expect(payload.scriptId).toBe(script.id);
    expect(payload.name).toBe('release-check');
    expect(payload.effectiveSaillance).toBeLessThan(20);
    store.close();
  });

  test('the notice is filed once per sweep — re-running does not duplicate it', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    await store.addScript({ ...DRILL, source: 'human' });

    clock.set(new Date(T0.getTime() + 240 * DAY));
    await sweepDisusedScripts(store, { clock });
    await sweepDisusedScripts(store, { clock }); // already archived → not re-swept

    const pending = await store.listDreamProposals!({ status: 'pending' });
    expect(pending.filter((p) => p.kind === 'script_archived').length).toBe(1);
    store.close();
  });

  test('sweep still archives when the store cannot file proposals', async () => {
    const clock = fakeClock();
    const store = freshStore({ clock });
    const bare: ScriptStore = store; // widen away fileDreamProposal
    const script = await store.addScript({ ...DRILL, source: 'human' });

    clock.set(new Date(T0.getTime() + 240 * DAY));
    const report = await sweepDisusedScripts(bare, { clock });
    expect(report.archived.length).toBe(1);
    expect((await store.getScript(script.id))!.status).toBe('archived');
    store.close();
  });
});
