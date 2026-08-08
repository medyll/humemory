/**
 * Phase 8.4 — "correction kills the script": a memory can contradict a
 * script directly. The loser side of a contradiction widens from
 * memory-only to memory-or-script (contradictions.loser_kind), reusing the
 * 6.0.2 mechanism rather than inventing a parallel one.
 */
import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';

const T0 = '2026-08-08T12:00:00Z';
const DRILL = {
  name: 'release-check',
  description: 'desc',
  steps: ['pnpm build', 'bun test'],
  directory: '/tmp/p',
};

describe('contradict() against a script loser', () => {
  test('archives the script outright — not a saillance collapse', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'the test command changed to `bun test:ci`',
      directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    const result = await store.contradict!(winner.id, script.id, { reason: 'test command changed' });

    expect(result.contradiction!.loserKind).toBe('script');
    expect('status' in result.loser).toBe(true);
    expect((result.loser as any).status).toBe('archived');

    const reloaded = await store.getScript(script.id);
    expect(reloaded!.status).toBe('archived');
  });

  test('cancels the script\'s armed cues, same as disuse archival', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'correction', directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);

    await store.contradict!(winner.id, script.id, {});

    expect((await store.listCues({ targetId: script.id, status: 'armed' })).length).toBe(0);
    expect((await store.listCues({ targetId: script.id, status: 'cancelled' })).length).toBe(1);
  });

  test('files a script_archived notice with reason "contradiction"', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'the fix is to use --frozen-lockfile', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' });

    await store.contradict!(winner.id, script.id, {});

    const pending = await store.listDreamProposals!({ status: 'pending' });
    const notice = pending.find((p) => p.kind === 'script_archived')!;
    expect(notice).toBeDefined();
    const payload = JSON.parse(notice.payload);
    expect(payload.reason).toBe('contradiction');
    expect(payload.scriptId).toBe(script.id);
    expect(payload.winnerId).toBe(winner.id);
  });

  test('no asymmetric-authority gate — scripts have no verified field to protect', async () => {
    // A memory-loser contradiction from an unverified winner against a
    // human/grounded-verified loser files a proposal instead of applying
    // (6.0.2). Scripts carry no verified/verificationReason, so nothing
    // gates a script contradiction — it always applies directly.
    const store = freshStore({ clock: fakeClock(T0) });
    const weakWinner = await store.add({
      content: 'unverified correction', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic', source: 'agent',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' }); // human-authored, "trusted" by 8.3's rule

    const result = await store.contradict!(weakWinner.id, script.id, { createdBy: 'agent' });

    expect(result.proposalFiled).toBeUndefined();
    expect((result.loser as any).status).toBe('archived');
  });

  test('contradicting an already-archived script records the contradiction but files no duplicate notice', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winnerA = await store.add({
      content: 'first correction', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const winnerB = await store.add({
      content: 'second correction', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's2', memoryType: 'semantic',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' });

    await store.contradict!(winnerA.id, script.id, {});
    await store.contradict!(winnerB.id, script.id, {}); // already archived

    const contradictions = await store.listContradictions!({ loserId: script.id });
    expect(contradictions.length).toBe(2); // both recorded — audit trail intact

    const notices = (await store.listDreamProposals!({ status: 'pending' })).filter(
      (p) => p.kind === 'script_archived'
    );
    expect(notices.length).toBe(1); // only the first archival produced a notice
  });

  test('revoke restores status to active but leaves cues cancelled', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'correction', directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const script = await store.addScript({ ...DRILL, source: 'human' }, [
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);
    const result = await store.contradict!(winner.id, script.id, {});

    const revoked = await store.revokeContradiction!(result.contradiction!.id);
    expect(revoked.status).toBe('revoked');

    const reloaded = await store.getScript(script.id);
    expect(reloaded!.status).toBe('active');
    // Re-arming is a deliberate separate act — revoke does not do it silently.
    expect((await store.listCues({ targetId: script.id, status: 'armed' })).length).toBe(0);
    expect((await store.listCues({ targetId: script.id, status: 'cancelled' })).length).toBe(1);
  });

  test('memory-loser contradictions are unaffected — loserKind defaults to memory', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'the fix', directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const loser = await store.add({
      content: 'the stale claim', directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's2', memoryType: 'semantic',
    });

    const result = await store.contradict!(winner.id, loser.id, {});
    expect(result.contradiction!.loserKind).toBe('memory');
    expect('status' in result.loser).toBe(false);
  });

  test('a nonexistent loser id (in neither table) throws', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const winner = await store.add({
      content: 'correction', directory: '/tmp/p', day: '2026-08-08', keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    await expect(store.contradict!(winner.id, 'does-not-exist', {})).rejects.toThrow('not found');
  });
});
