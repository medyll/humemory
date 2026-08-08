/**
 * Phase 6.0.2 — contradictions: one test per edge case in the plan.
 */
import { describe, test, expect } from 'bun:test';
import { freshStore } from './helpers/store.js';
import { buildSessionContext } from '../src/agent/session-context.js';
import { fakeClock } from './helpers/clock.js';

const base = {
  directory: '/tmp/p', day: '2026-08-08', keywords: [] as string[],
  sessionId: 's1', memoryType: 'semantic' as const,
};

async function two(store: any) {
  const a = await store.add({ ...base, content: 'use WAL for concurrent writes' });
  const b = await store.add({ ...base, content: 'never use WAL, it corrupts' });
  return { a, b };
}

describe('contradictions', () => {
  test('loser collapses ÷4 (floor 5), loses verification, stays searchable', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    await store.verify(b.id, 'corroborated');
    const before = await store.getById(b.id);

    const r = await store.contradict!(a.id, b.id, { reason: 'WAL is the fix, not the bug' });
    expect(r.loser.saillance).toBe(Math.max(5, Math.floor(before!.saillance / 4)));
    expect(r.loser.verified).toBe(false);
    expect(r.loser.refutedCount).toBe(1);

    // still retrievable by search — ghosted, not deleted
    const found = await store.search({ query: 'WAL', directory: '/tmp/p', limit: 10 });
    expect(found.some((f) => f.memory.id === b.id)).toBe(true);
  });

  test('further refutations divide by 2, capped at 3', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    const c = await store.add({ ...base, content: 'third opinion' });
    const d = await store.add({ ...base, content: 'fourth opinion' });
    const e = await store.add({ ...base, content: 'fifth opinion' });

    await store.contradict!(a.id, b.id, {});
    const s1 = (await store.getById(b.id))!.saillance;
    await store.contradict!(c.id, b.id, {});
    const s2 = (await store.getById(b.id))!.saillance;
    expect(s2).toBe(Math.max(5, Math.floor(s1 / 2)));
    await store.contradict!(d.id, b.id, {});
    await store.contradict!(e.id, b.id, {});
    expect((await store.getById(b.id))!.refutedCount).toBe(3); // capped
  });

  test('cycle: last write wins on saillance, no infinite loop', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    await store.contradict!(a.id, b.id, {});
    await store.contradict!(b.id, a.id, {}); // cycle
    const la = (await store.getById(a.id))!;
    const lb = (await store.getById(b.id))!;
    expect(la.saillance).toBeLessThan(100);
    expect(lb.saillance).toBeLessThan(100);
    const all = await store.listContradictions!({ status: 'active' });
    expect(all.length).toBe(2);
  });

  test('non-transitive: A>B and B>C never infers A>C', async () => {
    const store = freshStore();
    const a = await store.add({ ...base, content: 'A' });
    const b = await store.add({ ...base, content: 'B' });
    const c = await store.add({ ...base, content: 'C' });
    await store.contradict!(a.id, b.id, {});
    await store.contradict!(b.id, c.id, {});
    const all = await store.listContradictions!({});
    expect(all.length).toBe(2); // no inferred third row
  });

  test('revocation recomputes saillance (not a literal restore)', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    const before = (await store.getById(b.id))!.saillance;
    const r = await store.contradict!(a.id, b.id, {});
    const collapsed = (await store.getById(b.id))!.saillance;
    expect(collapsed).toBeLessThan(before);

    await store.revokeContradiction!(r.contradiction!.id);
    const after = (await store.getById(b.id))!;
    expect(after.saillance).toBeGreaterThan(collapsed);
    const ct = (await store.listContradictions!({ loserId: b.id }))[0];
    expect(ct.status).toBe('revoked');
  });

  test('asymmetric authority: unverified winner vs human-verified loser files a proposal', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    await store.verify(b.id, 'human');

    const r = await store.contradict!(a.id, b.id, { agent: 'codex' });
    expect(r.proposalFiled).toBe(true);
    expect((await store.getById(b.id))!.verified).toBe(true); // untouched

    // proposals are deduped by payload_hash: filing twice yields one row
    await store.contradict!(a.id, b.id, { agent: 'codex' });
    const n = (store as any).db.query(`SELECT COUNT(*) AS n FROM dream_proposals WHERE kind='contradiction'`).get().n;
    expect(n).toBe(1);
  });

  test('corroborated-verified loser stays directly contradictable', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    await store.verify(b.id, 'corroborated');
    const r = await store.contradict!(a.id, b.id, { agent: 'kimi' });
    expect(r.proposalFiled).toBeUndefined();
    expect(r.contradiction).toBeDefined();
  });

  test('merged loser: the collapse targets the merge target, with a warning', async () => {
    const store = freshStore();
    const { a, b } = await two(store);
    const c = await store.add({ ...base, content: 'absorber' });
    await store.merge(b.id, c.id, {});

    const r = await store.contradict!(a.id, b.id, {});
    expect(r.retargetedTo).toBe(c.id);
    expect((await store.getById(c.id))!.refutedCount).toBe(1);
  });

  test('context block: loser disappears; a cycled trace stays, flagged disputed', async () => {
    const clock = fakeClock('2026-08-08T00:00:00Z');
    const store = freshStore({ clock });
    // L2/L3 + saillance ≥ 60 to surface in the block
    const a = await store.add({ ...base, content: 'trace A', level2Essential: 'gist A', currentLevel: undefined } as any);
    const b = await store.add({ ...base, content: 'trace B' });
    // force level 2 and saillance
    await store.recall(a.id); await store.recall(b.id);
    (store as any).db.query('UPDATE memories SET current_level = 2, saillance = 80 WHERE id IN ($a, $b)').run({ $a: a.id, $b: b.id });

    const ctx1 = await buildSessionContext({ store, directory: '/tmp/p', clock });
    expect(ctx1.markdown).toContain('trace');

    await store.contradict!(a.id, b.id, {});
    const ctx2 = await buildSessionContext({ store, directory: '/tmp/p', clock });
    expect(ctx2.traces.some((m: any) => m.id === b.id)).toBe(false);
    expect(ctx2.traces.some((m: any) => m.id === a.id)).toBe(true);

    // cycle → both stay, both flagged disputed (saillance restored above the
    // threshold so the test isolates the exclusion/flagging logic, not decay)
    await store.contradict!(b.id, a.id, {});
    (store as any).db.query('UPDATE memories SET saillance = 80 WHERE id IN ($a, $b)').run({ $a: a.id, $b: b.id });
    const ctx3 = await buildSessionContext({ store, directory: '/tmp/p', clock });
    expect(ctx3.traces.length).toBe(2);
    expect(ctx3.markdown).toContain('disputed');
  });
});
