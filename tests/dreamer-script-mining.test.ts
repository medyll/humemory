/**
 * Phase 8.5 — dreamer script mining: a cluster of *corrections* (traces that
 * won an active contradiction) sharing a directory drafts a `script_candidate`
 * dream proposal. Reuses the 6.0.2 contradiction mechanism as the "correction"
 * signal rather than inventing a new tag — see PHASE8_PLAN.md §8.4 status.
 */
import { describe, test, expect } from 'bun:test';
import { runDreamer, applyDreamProposal } from '../src/core/dreamer.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';

const T0 = '2026-08-08T12:00:00Z';
const base = { day: '2026-08-08', keywords: [] as string[], memoryType: 'semantic' as const, directory: '/tmp/p' };

/** Seeds `n` correction pairs: a stale loser and a winner that beat it via an active contradiction. */
async function seedCorrections(store: any, n: number, opts: { directory?: string } = {}) {
  const winnerIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const loser = await store.add({
      ...base,
      directory: opts.directory ?? base.directory,
      content: `use the global sqlite path for tests variant ${i}`,
      keywords: ['sqlite', 'test', 'path'],
      sessionId: `loser-s${i}`,
    });
    const winner = await store.add({
      ...base,
      directory: opts.directory ?? base.directory,
      content: `always use a hermetic temp sqlite path for tests, never the shared one, variant ${i}`,
      keywords: ['sqlite', 'test', 'path', 'hermetic'],
      sessionId: `winner-s${i}`,
    });
    await store.contradict!(winner.id, loser.id, { reason: 'the shared path breaks parallel runs' });
    winnerIds.push(winner.id);
  }
  return winnerIds;
}

describe('dreamer script mining (8.5)', () => {
  test('a directory with ≥2 clustered corrections files a script_candidate proposal', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 2);

    const report = await runDreamer({ store, clock });
    expect(report.scriptCandidates).toBe(1);
    const p = report.proposals.find((x) => x.kind === 'script_candidate')!;
    expect(p).toBeDefined();
    const payload = JSON.parse(p.payload);
    expect(payload.directory).toBe('/tmp/p');
    expect(payload.steps.length).toBe(2);
    expect(payload.sourceMemoryIds.length).toBe(2);
  });

  test('a single correction does not qualify — one is not a pattern', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 1);

    const report = await runDreamer({ store, clock });
    expect(report.scriptCandidates).toBe(0);
    expect(report.proposals.some((p) => p.kind === 'script_candidate')).toBe(false);
  });

  test('corrections in different directories do not combine into one script', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 1, { directory: '/tmp/a' });
    await seedCorrections(store, 1, { directory: '/tmp/b' });

    const report = await runDreamer({ store, clock });
    // Each directory has only 1 correction — below the min cluster size on its own.
    expect(report.scriptCandidates).toBe(0);
  });

  test('idempotent: a second run does not refile the same candidate', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 2);

    const first = await runDreamer({ store, clock });
    expect(first.scriptCandidates).toBe(1);
    const second = await runDreamer({ store, clock });
    expect(second.scriptCandidates).toBe(0); // already pending, dedup by payload_hash
  });

  test('a revoked contradiction does not count as a correction', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    const winnerIds = await seedCorrections(store, 2);
    const contradictions = await store.listContradictions!({ status: 'active' });
    // Revoke every contradiction won by the first winner.
    for (const c of contradictions.filter((c: any) => c.winnerId === winnerIds[0])) {
      await store.revokeContradiction!(c.id);
    }

    const report = await runDreamer({ store, clock });
    // Only one correction left (winnerIds[1]) — below the min cluster size.
    expect(report.scriptCandidates).toBe(0);
  });

  test('approving a script_candidate drafts a script, never active', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 2);

    const report = await runDreamer({ store, clock });
    const p = report.proposals.find((x) => x.kind === 'script_candidate')!;

    const effect = await applyDreamProposal(store, p);
    expect(effect).toContain('drafted script');

    const scripts = await store.listScripts({ status: 'draft' });
    expect(scripts.length).toBe(1);
    expect(scripts[0].status).toBe('draft');
    expect(scripts[0].source).toBe('dream_proposal');
    expect(scripts[0].directory).toBe('/tmp/p');
  });

  test('mining only ever creates proposals — never touches memories or scripts directly', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCorrections(store, 3);

    await runDreamer({ store, clock });
    // No script exists until a human approves the proposal.
    expect((await store.listScripts({ status: 'draft' })).length).toBe(0);
    expect((await store.listScripts({ status: 'active' })).length).toBe(0);
  });
});
