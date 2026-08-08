/**
 * Trust score — Phase 6.0.1.
 *
 * Deliberately separate from `saillance`: salience is *how loud* a trace is,
 * trust is *whether to believe it*. Conflating them produces confident
 * nonsense.
 *
 * The weights are calibration outputs (Kimi B7, accepted by Claude R3): they
 * live in TRUST_CONFIG next to DECAY_CONFIG and are frozen against the labeled
 * fixtures in tests/fixtures/trust/ — not guessed inline.
 */

import type { Memory, TraceSource, VerificationReason } from './types.js';

export const TRUST_CONFIG = {
  /** Base trust by provenance. */
  base: {
    human: 60,
    hook: 45,
    agent: 35,
    llm_generated: 25,
    dream_proposal: 20,
  } satisfies Record<TraceSource, number>,

  /**
   * Bonus by verification reason — tiered, not flat (Claude R1). `corroborated`
   * is deliberately weakest: two agents agreeing is the cheapest signal to
   * manufacture and the easiest to obtain by accident.
   */
  bonus: {
    human: 25,
    grounded: 20,
    reused: 15,
    corroborated: 8,
  } satisfies Record<VerificationReason, number>,

  /** Each refutation costs this much, capped at `refutedCap` refutations. */
  refutedPenalty: 15,
  refutedCap: 3,
};

/**
 * Trust of a trace, clamped to 0..100.
 * Pre-Phase-6 rows (no `source`) default to the `agent` base — silence is not
 * endorsement, but it is not suspicion either.
 */
export function trustScore(memory: Memory): number {
  const source = memory.source ?? 'agent';
  let score = TRUST_CONFIG.base[source];

  if (memory.verified && memory.verificationReason) {
    score += TRUST_CONFIG.bonus[memory.verificationReason];
  }

  score -= TRUST_CONFIG.refutedPenalty * Math.min(memory.refutedCount ?? 0, TRUST_CONFIG.refutedCap);

  return Math.max(0, Math.min(100, score));
}

/**
 * Base-only trust, for dreamer clustering (Claude R1 invariant): verification
 * informs recall ordering, recurrence informs clustering — they never feed
 * each other.
 */
export function baseTrust(memory: Memory): number {
  return TRUST_CONFIG.base[memory.source ?? 'agent'];
}
