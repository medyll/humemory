/**
 * Phase 6.1 — dreamer: qualification, baseTrust-only scoring invariant,
 * idempotence, expiry, stale loops, human gate.
 */
import { describe, test, expect } from 'bun:test';
import { runDreamer, applyDreamProposal, KeywordClusterer, DREAM_CONFIG } from '../src/core/dreamer.js';
import { freshStore } from './helpers/store.js';
import { fakeClock } from './helpers/clock.js';

const T0 = '2026-08-08T12:00:00Z';
const base = { day: '2026-08-08', keywords: [] as string[], memoryType: 'semantic' as const, directory: '/tmp/p' };

/** Seeds a cluster of n similar traces across `sessions` sessions / `agents` agents. */
async function seedCluster(store: any, n: number, opts: { sessions?: number; agents?: string[] } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const m = await store.add({
      ...base,
      content: `bun test fails on the shared DB path use hermetic temp database variant ${i}`,
      keywords: ['bun', 'test', 'hermetic', 'database'],
      sessionId: `s${i % (opts.sessions ?? 1)}`,
      agent: opts.agents?.[i % (opts.agents.length || 1)],
    });
    ids.push(m.id);
  }
  return ids;
}

describe('dreamer', () => {
  test('a qualifying cluster (≥3 traces, ≥2 sessions) files exactly one proposal', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 3 });
    await store.add({ ...base, content: 'unrelated cooking recipe tomato basil', keywords: ['cooking'], sessionId: 's9' });

    const report = await runDreamer({ store });
    expect(report.filed).toBe(1);
    const p = report.proposals.find((x) => x.kind === 'promote_semantic')!;
    expect(p).toBeDefined();
    expect(p.confidence).toBeGreaterThan(0);
    expect(p.expiresAt).toBeDefined();
  });

  test('a single-session cluster does not qualify — but 2 agents do', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 1 });
    let report = await runDreamer({ store });
    expect(report.filed).toBe(0);

    const store2 = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store2, 2, { sessions: 1, agents: ['claude', 'codex'] });
    report = await runDreamer({ store: store2 });
    expect(report.filed).toBe(1);
  });

  test('invariant: cluster confidence uses baseTrust only (R1, no feedback loop)', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const ids = await seedCluster(store, 3, { sessions: 3 });
    // Verify all members with the strongest reason — must NOT change confidence
    const r1 = await runDreamer({ store });
    const c1 = r1.proposals.find((x) => x.kind === 'promote_semantic')!.confidence;

    const store2 = freshStore({ clock: fakeClock(T0) });
    const ids2 = await seedCluster(store2, 3, { sessions: 3 });
    for (const id of ids2) await store2.verify(id, 'human');
    const r2 = await runDreamer({ store: store2 });
    const c2 = r2.proposals.find((x) => x.kind === 'promote_semantic')!.confidence;

    expect(c1).toBe(c2);
    void ids;
  });

  test('idempotent: a second run on a frozen store files zero new proposals', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 3 });
    await runDreamer({ store });
    const second = await runDreamer({ store });
    expect(second.filed).toBe(0);
  });

  test('rejected proposals are not resurrected by the next run', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 3 });
    const r = await runDreamer({ store });
    const p = r.proposals.find((x) => x.kind === 'promote_semantic')!;
    await store.resolveDreamProposal(p.id, 'rejected');

    const second = await runDreamer({ store });
    expect(second.filed).toBe(0); // same payload_hash → INSERT OR IGNORE no-op
  });

  test('expiry: pending proposals past TTL become expired', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    await seedCluster(store, 3, { sessions: 3 });
    await runDreamer({ store });

    clock.advance((DREAM_CONFIG.proposalTtlDays + 1) * 24 * 3600_000);
    const second = await runDreamer({ store });
    expect(second.expired).toBe(1);
    const pending = await store.listDreamProposals({ status: 'pending' });
    expect(pending.length).toBe(0);
  });

  test('contradicted losers are excluded from clustering', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const ids = await seedCluster(store, 3, { sessions: 3 });
    const winner = await store.add({ ...base, content: 'winner', sessionId: 'sx' });
    await store.contradict!(winner.id, ids[0], {});
    const report = await runDreamer({ store });
    expect(report.considered).toBe(3); // 4 seeded - 1 contradicted loser
  });

  test('stale loop: open 40d with faded linked trace → close_stale_loop proposal', async () => {
    const clock = fakeClock(T0);
    const store = freshStore({ clock });
    const mem = await store.add({ ...base, content: 'old lesson', sessionId: 's0' });
    const intention = await store.addIntention({ content: 'finish the refactor', directory: '/tmp/p', relatedMemoryId: mem.id });
    // age the loop 40 days and fade the trace to L3
    (store as any).db.query('UPDATE intentions SET created_at = $old WHERE id = $id')
      .run({ $old: Date.parse(T0) - 40 * 24 * 3600_000, $id: intention.id });
    (store as any).db.query('UPDATE memories SET current_level = 3 WHERE id = $id').run({ $id: mem.id });

    const report = await runDreamer({ store });
    expect(report.staleLoopCandidates).toBe(1);
    const p = report.proposals.find((x) => x.kind === 'close_stale_loop')!;
    expect(p).toBeDefined();

    // approve → loop closed
    const effect = await applyDreamProposal(store, p);
    await store.resolveDreamProposal(p.id, 'approved');
    expect(effect).toContain('closed');
    expect((await store.getIntention(intention.id))!.status).toBe('closed');
  });

  test('approve promote_semantic creates a verified dream_proposal memory', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 3 });
    const r = await runDreamer({ store });
    const p = r.proposals.find((x) => x.kind === 'promote_semantic')!;

    const effect = await applyDreamProposal(store, p);
    await store.resolveDreamProposal(p.id, 'approved');
    expect(effect).toContain('promoted to semantic memory');

    const created = (await store.list({ limit: 10 })).find((m) => m.source === 'dream_proposal');
    expect(created).toBeDefined();
    expect(created!.verified).toBe(true);
    // NOT 'human'. That reason is the one that renders a trace bare, outside
    // the untrusted markers — and this content is LLM-drafted or concatenated
    // from agent traces, never read verbatim by the approving human.
    expect(created!.verificationReason).toBe('corroborated');
    expect(created!.verificationReason).not.toBe('human');
  });

  test('resolve twice refuses — a resolved proposal is final', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    await seedCluster(store, 3, { sessions: 3 });
    const r = await runDreamer({ store });
    const p = r.proposals.find((x) => x.kind === 'promote_semantic')!;
    await store.resolveDreamProposal(p.id, 'rejected');
    await expect(store.resolveDreamProposal(p.id, 'approved')).rejects.toThrow('not pending');
  });

  test('cross-agent recurrence across sessions and directories earns `corroborated`', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const m = await store.add({
        ...base,
        directory: `/tmp/p${i}`, // distinct directories — independent looks
        content: `bun test fails on the shared DB path use hermetic temp database variant ${i}`,
        keywords: ['bun', 'test', 'hermetic', 'database'],
        sessionId: `s${i}`,
        agent: ['claude', 'codex'][i],
      });
      ids.push(m.id);
    }

    const report = await runDreamer({ store });
    expect(report.corroborated).toBe(2);
    for (const id of ids) {
      const m = await store.getById(id);
      expect(m!.verified).toBe(true);
      expect(m!.verificationReason).toBe('corroborated');
    }
  });

  test('agreement is not independence: same directory earns nothing (R1 defect 1)', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    // Two agents, two sessions — but both read the same place. One source
    // wearing two names must not verify itself.
    await seedCluster(store, 2, { sessions: 2, agents: ['claude', 'codex'] });

    const report = await runDreamer({ store });
    expect(report.filed).toBe(1);        // still worth proposing
    expect(report.corroborated).toBe(0); // but not evidence
  });

  test('corroboration never downgrades a stronger existing reason', async () => {
    const store = freshStore({ clock: fakeClock(T0) });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const m = await store.add({
        ...base,
        directory: `/tmp/p${i}`,
        content: `bun test fails on the shared DB path use hermetic temp database variant ${i}`,
        keywords: ['bun', 'test', 'hermetic', 'database'],
        sessionId: `s${i}`,
        agent: ['claude', 'codex'][i],
      });
      ids.push(m.id);
    }
    await store.verify(ids[0], 'human');

    await runDreamer({ store });
    expect((await store.getById(ids[0]))!.verificationReason).toBe('human');
    expect((await store.getById(ids[1]))!.verificationReason).toBe('corroborated');
  });

  test('KeywordClusterer is deterministic', () => {
    const mk = (id: string, kw: string[]) =>
      ({ id, keywords: kw, content: kw.join(' '), sessionId: 's', saillance: 50 } as any);
    const input = [
      mk('a', ['bun', 'test', 'db']), mk('b', ['bun', 'test', 'db', 'hermetic']),
      mk('c', ['recipe', 'tomato']), mk('d', ['bun', 'db', 'hermetic', 'temp']),
      mk('e', ['recipe', 'basil', 'tomato']),
    ];
    const c1 = new KeywordClusterer().cluster(input).map((g) => g.map((m) => m.id).sort());
    const c2 = new KeywordClusterer().cluster(input).map((g) => g.map((m) => m.id).sort());
    expect(JSON.stringify(c1)).toBe(JSON.stringify(c2));
    expect(c1.some((g) => g.includes('a') && g.includes('b'))).toBe(true);
    expect(c1.some((g) => g.includes('c') && g.includes('e'))).toBe(true);
  });
});
