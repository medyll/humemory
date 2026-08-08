/**
 * Phase 6.0.1 — provenance, trust score, evidence-earned verification.
 */
import { describe, test, expect } from 'bun:test';
import { trustScore, baseTrust, TRUST_CONFIG } from '../src/core/trust.js';
import { calculateDecayLevel, DECAY_CONFIG } from '../src/core/decay.js';
import { freshStore } from './helpers/store.js';
import type { Memory } from '../src/core/types.js';

function mem(partial: Partial<Memory>): Memory {
  return {
    id: 'm1',
    content: 'test trace',
    directory: '/tmp/p',
    day: '2026-08-08',
    keywords: [],
    sessionId: 's1',
    memoryType: 'semantic',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    recallCount: 0,
    decayRate: 0.5,
    currentLevel: 0,
    saillance: 50,
    ...partial,
  };
}

describe('trustScore — table-driven, pure', () => {
  test('base by source', () => {
    expect(baseTrust(mem({ source: 'human' }))).toBe(TRUST_CONFIG.base.human);
    expect(baseTrust(mem({ source: 'dream_proposal' }))).toBe(20);
    expect(baseTrust(mem({}))).toBe(TRUST_CONFIG.base.agent); // pre-Phase-6 row
  });

  test('tiered verification bonus', () => {
    const base = TRUST_CONFIG.base.agent;
    expect(trustScore(mem({ source: 'agent', verified: true, verificationReason: 'human' }))).toBe(base + 25);
    expect(trustScore(mem({ source: 'agent', verified: true, verificationReason: 'corroborated' }))).toBe(base + 8);
    // verified flag without a reason earns nothing
    expect(trustScore(mem({ source: 'agent', verified: true }))).toBe(base);
  });

  test('refutation penalty, capped at 3', () => {
    const base = TRUST_CONFIG.base.agent;
    expect(trustScore(mem({ source: 'agent', refutedCount: 1 }))).toBe(base - 15);
    expect(trustScore(mem({ source: 'agent', refutedCount: 99 }))).toBe(0); // 35−45, clamped
  });

  test('clamped to 0..100', () => {
    expect(trustScore(mem({ source: 'human', verified: true, verificationReason: 'human' }))).toBe(85);
    expect(trustScore(mem({ source: 'dream_proposal', refutedCount: 3 }))).toBe(0);
  });
});

describe('decay × verified — the 2.5× product cap (R3/B8)', () => {
  const now = new Date('2026-09-01T00:00:00Z');
  const created = new Date('2026-08-01T00:00:00Z'); // 744h ago → L3 (720h) unmodified

  test('an ordinary trace reaches L3 on schedule', () => {
    expect(calculateDecayLevel(mem({ createdAt: created }), now)).toBe(3);
  });

  test('verified + salient + 5 recalls cannot beat the cap', () => {
    // Product would be (1+5×0.3) × 1.5 × 1.5 = 5.625× → capped at 2.5×
    const m = mem({ createdAt: created, recallCount: 5, saillance: 80, verified: true, verificationReason: 'human' });
    const capped = calculateDecayLevel(m, now);
    // 744h / 2.5 = 297.6h → L2 (168h..720h). Uncapped would be L0.
    expect(capped).toBe(2);
  });

  test('verified alone gives the 1.5× slowdown', () => {
    // 744h / 1.5 = 496h → L2; without verification it was L3
    const m = mem({ createdAt: created, verified: true, verificationReason: 'reused' });
    expect(calculateDecayLevel(m, now)).toBe(2);
  });
});

describe('store provenance (freshStore)', () => {
  test('add stamps source/agent/device defaults', async () => {
    const store = freshStore();
    const m = await store.add({
      content: 'trace', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    expect(m.source).toBe('agent');
    expect(m.verified).toBe(false);
    expect(m.refutedCount).toBe(0);
    expect(typeof m.device).toBe('string');
    expect(m.device!.length).toBeGreaterThan(0);
  });

  test('verify then refute revokes the verification', async () => {
    const store = freshStore();
    const m = await store.add({
      content: 'trace', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const v = await store.verify(m.id, 'human');
    expect(v.verified).toBe(true);
    expect(v.verificationReason).toBe('human');

    const r = await store.refute(m.id, 'no longer true');
    expect(r.verified).toBe(false);
    expect(r.verificationReason).toBeUndefined();
    expect(r.refutedCount).toBe(1);
  });

  test('cross-agent recall earns `reused`; same-agent recall does not', async () => {
    const store = freshStore();
    const m = await store.add({
      content: 'trace', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic', agent: 'claude',
    });

    const same = await store.recall(m.id, 'claude');
    expect(same.verified).toBe(false);

    const other = await store.recall(m.id, 'codex');
    expect(other.verified).toBe(true);
    expect(other.verificationReason).toBe('reused');
  });

  test('grounded verification through an explicitly-closed loop', async () => {
    const { applyCommitToLoops } = await import('../src/agent/commit-closer.js');
    const store = freshStore();
    const m = await store.add({
      content: 'WAL locking lesson', directory: '/tmp/p', day: '2026-08-08',
      keywords: [], sessionId: 's1', memoryType: 'semantic',
    });
    const intention = await store.addIntention({
      content: 'fix the lock', directory: '/tmp/p', relatedMemoryId: m.id,
    });

    const { extractLoopIds } = await import('../src/core/cues.js');
    void extractLoopIds;
    const { loopId } = await import('../src/core/cues.js');
    await applyCommitToLoops(store, {
      sha: 'abc123',
      message: `fix: lock contention\n\nCloses ${loopId(intention.id)}`,
      files: [],
      directory: '/tmp/p',
    }, store);

    const after = await store.getById(m.id);
    expect(after!.verified).toBe(true);
    expect(after!.verificationReason).toBe('grounded');
  });
});
