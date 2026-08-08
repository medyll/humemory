/**
 * Dreaming — Phase 6.1.
 *
 * A background consolidation pass that detects recurring patterns across
 * sessions *and agents*, then proposes — never silently applies. The human
 * gate is `pnpm cli dream review` / `approve` / `reject`.
 *
 * Invariants (asserted by tests):
 * - The dreamer scores clusters on `base(source)` ONLY — verification informs
 *   recall ordering, recurrence informs clustering, they never feed each
 *   other (Claude R1, self-confirming loop).
 * - The job is idempotent: `payload_hash` dedups proposals, and a rejected
 *   pattern is not resurrected on the next run (re-filing the same hash is an
 *   INSERT OR IGNORE no-op while the rejected row exists).
 * - No network, no embeddings: the `Clusterer` is an interface so Phase 7 can
 *   swap in vectors without touching the pipeline (owner ruling).
 */

import { createHash } from 'crypto';
import type {
  Memory, Intention, MemoryStore, IntentionStore,
  DreamKind, DreamProposal,
} from './types.js';
import { baseTrust } from './trust.js';
import { systemClock, type Clock } from './clock.js';

export const DREAM_CONFIG = {
  /** Traces younger than this are considered. */
  windowDays: 30,
  /** A cluster qualifies at ≥ K traces from ≥ 2 sessions, or ≥ 2 agents. */
  minClusterSize: 3,
  minDistinctSessions: 2,
  minDistinctAgents: 2,
  /** Corroboration also requires distinct directories — agreement ≠ independence. */
  minDistinctDirectories: 2,
  /** Jaccard similarity threshold for the keyword clusterer. */
  similarityThreshold: 0.34,
  /**
   * Vector thresholds (Phase 7.3, A1): grouping is reviewed by a human,
   * corroboration is not — so the verification gate is strictly higher.
   * PROVISIONAL, pending 7.5 calibration: the pre-flight showed e5-small q8
   * cosines are compressed (paraphrase 0.846 / unrelated 0.801), so these
   * start well above the plan's original 0.82/0.90.
   */
  vectorClusterThreshold: 0.87,
  vectorCorroborateThreshold: 0.93,
  /** Proposal lifetime (owner-approved 14d expiry). */
  proposalTtlDays: 14,
  /** LLM drafting cap per run; skipped entirely without a client. */
  maxDraftsPerRun: 10,
  /** Loops open longer than this are stale-loop candidates. */
  staleLoopDays: 30,
  /** Max traces read per run. */
  collectLimit: 500,
};

/** Phase 7 seam: swap this implementation for a vector clusterer. */
export interface Clusterer {
  /** Async since Phase 7.1 — vector clusterers embed before grouping. */
  cluster(memories: Memory[]): Promise<Memory[][]> | Memory[][];
}

/** Tokenize the strongest available retrieval text of a trace. */
function tokens(m: Memory): Set<string> {
  const text = m.level3Keywords || m.keywords.join(' ') || m.level2Essential || m.content;
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9àâäéèêëîïôöùûüç_-]+/i)
      .filter((t) => t.length > 2)
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Keyword clusterer: union-find over pairwise Jaccard similarity. Deterministic
 * (stable iteration order, ties broken by insertion order), local, dependency-free.
 */
export class KeywordClusterer implements Clusterer {
  constructor(private threshold: number = DREAM_CONFIG.similarityThreshold) {}

  cluster(memories: Memory[]): Memory[][] {
    const parent = memories.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const tokenSets = memories.map(tokens);
    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        if (jaccard(tokenSets[i], tokenSets[j]) >= this.threshold) {
          const ri = find(i);
          const rj = find(j);
          if (ri !== rj) parent[rj] = ri;
        }
      }
    }
    const groups = new Map<number, Memory[]>();
    memories.forEach((m, i) => {
      const root = find(i);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(m);
    });
    return [...groups.values()].filter((g) => g.length > 1);
  }
}

export interface DreamReport {
  considered: number;
  clusters: number;
  filed: number;
  expired: number;
  staleLoopCandidates: number;
  draftsWritten: number;
  /** Traces that earned `corroborated` verification during this run (6.0.1). */
  corroborated: number;
  proposals: DreamProposal[];
}

function hashOf(kind: DreamKind, ids: string[]): string {
  return createHash('sha1').update([kind, ...ids.slice().sort()].join('|')).digest('hex');
}

/** Confidence: cluster size saturates at 8, weighted by mean baseTrust. */
function confidenceOf(cluster: Memory[]): number {
  const sizeScore = Math.min(cluster.length, 8) / 8;
  const trustScoreAvg = cluster.reduce((s, m) => s + baseTrust(m), 0) / cluster.length / 100;
  return Math.round(sizeScore * (0.4 + 0.6 * trustScoreAvg) * 100) / 100;
}

function qualifies(cluster: Memory[]): boolean {
  const sessions = new Set(cluster.map((m) => m.sessionId));
  const agents = new Set(cluster.map((m) => m.agent).filter(Boolean));
  return (
    (cluster.length >= DREAM_CONFIG.minClusterSize && sessions.size >= DREAM_CONFIG.minDistinctSessions) ||
    agents.size >= DREAM_CONFIG.minDistinctAgents
  );
}

/**
 * Does this cluster constitute *corroboration* — the first of the three
 * evidence paths of 6.0.1, and the only one the dreamer can observe?
 *
 * Agreement is not independence (Claude R1, defect 1): three agents that read
 * the same stale README are one source wearing three names. So distinct agent
 * labels are necessary but not sufficient — the traces must also come from
 * distinct sessions AND distinct directories, which is the cheapest available
 * proxy for "these agents did not look at the same thing at the same time".
 *
 * Corroboration is deliberately the weakest bonus in TRUST_CONFIG (+8). It
 * cannot feed the dreamer back: clustering scores on `baseTrust` only, so a
 * cluster can never raise the trust that makes it qualify (R1, defect 2).
 */
function corroborates(cluster: Memory[]): boolean {
  const agents = new Set(cluster.map((m) => m.agent).filter(Boolean));
  if (agents.size < DREAM_CONFIG.minDistinctAgents) return false;
  const sessions = new Set(cluster.map((m) => m.sessionId));
  if (sessions.size < DREAM_CONFIG.minDistinctSessions) return false;
  const directories = new Set(cluster.map((m) => m.directory));
  return directories.size >= DREAM_CONFIG.minDistinctDirectories;
}

export interface DreamOptions {
  store: MemoryStore & IntentionStore;
  clusterer?: Clusterer;
  clock?: Clock;
  /**
   * Optional LLM drafting of consolidated wording. Capped and skipped when
   * absent — the job then files proposals with the raw cluster, never fails.
   */
  draft?: (cluster: Memory[]) => Promise<string>;
  /** Human identity for resolvedBy — `git config user.email`, fallback 'cli'. */
  now?: never; // use clock
}

export async function runDreamer(options: DreamOptions): Promise<DreamReport> {
  const { store } = options;
  const clock = options.clock ?? systemClock;
  const clusterer = options.clusterer ?? new KeywordClusterer();
  const now = clock.now();
  const windowStart = now.getTime() - DREAM_CONFIG.windowDays * 24 * 3600_000;

  // 0. Housekeeping: pending proposals past their TTL expire first.
  const expired = (await store.expireDreamProposals?.()) ?? 0;

  // 1. Collect — exclude contradicted losers and level-4/merged rows.
  const contradicted = new Set(
    ((await store.listContradictions?.({ status: 'active' })) ?? []).map((ct) => ct.loserId)
  );
  const traces = (await store.list({ limit: DREAM_CONFIG.collectLimit })).filter(
    (m) =>
      m.createdAt.getTime() >= windowStart &&
      m.currentLevel < 4 &&
      !m.mergedIntoId &&
      !contradicted.has(m.id)
  );

  // 2. Cluster. ScoredClusterer (Phase 7.3) also yields each cluster's
  // weakest link — needed for the two-threshold rule (A1).
  const { hasScores } = await import('./vector-clusterer.js');
  const scored = hasScores(clusterer) ? await clusterer.clusterWithScores(traces) : null;
  const clusters: { members: Memory[]; minPairwiseSimilarity: number | null }[] = scored
    ? scored.map((c) => ({ members: c.members, minPairwiseSimilarity: c.minPairwiseSimilarity }))
    : (await clusterer.cluster(traces)).map((members) => ({ members, minPairwiseSimilarity: null }));

  // 3-4. Qualify, then propose (idempotent via payload_hash).
  let filed = 0;
  let drafts = 0;
  const proposals: DreamProposal[] = [];
  const expiresAt = new Date(now.getTime() + DREAM_CONFIG.proposalTtlDays * 24 * 3600_000);

  let corroborated = 0;

  for (const cluster of clusters) {
    if (!qualifies(cluster.members)) continue;

    // Corroboration is evidence, not a proposal: 6.0.1 lists it as an
    // automatic verification path, so it applies without the human gate.
    // It touches no content — only the `verified` flag and its reason.
    //
    // A1 (two thresholds): when the clusterer scores its clusters, the weakest
    // link must also clear the STRICTER corroborate threshold — grouping
    // tolerates noise because a human reviews proposals; verification does
    // not, because nobody reviews it. Clusterers without scores (keyword)
    // keep the metadata-only rule.
    const similarityOk =
      cluster.minPairwiseSimilarity === null ||
      cluster.minPairwiseSimilarity >= DREAM_CONFIG.vectorCorroborateThreshold;
    if (similarityOk && corroborates(cluster.members) && store.verify) {
      for (const m of cluster.members) {
        if (m.verified) continue; // never downgrade an existing, stronger reason
        await store.verify(m.id, 'corroborated');
        corroborated++;
      }
    }

    let drafted: string | undefined;
    if (options.draft && drafts < DREAM_CONFIG.maxDraftsPerRun) {
      drafted = await options.draft(cluster.members);
      drafts++;
    }

    const ids = cluster.members.map((m) => m.id);
    const payload = JSON.stringify({
      clusterIds: ids,
      agents: [...new Set(cluster.members.map((m) => m.agent).filter(Boolean))],
      sessions: new Set(cluster.members.map((m) => m.sessionId)).size,
      samples: cluster.members.slice(0, 3).map((m) => (m.level2Essential ?? m.content).slice(0, 140)),
      drafted,
    });

    const ok = (await store.fileDreamProposal?.({
      kind: 'promote_semantic',
      payload,
      payloadHash: hashOf('promote_semantic', ids),
      confidence: confidenceOf(cluster.members),
      expiresAt,
    })) ?? false;
    if (ok) filed++;
  }

  // 5. Stale loops (intentions read-only): open past staleLoopDays whose linked
  // trace has faded to L3+ — propose closing them.
  let staleLoopCandidates = 0;
  const armed = await store.listIntentions({ status: ['armed', 'fired'], limit: 500 });
  for (const intention of armed) {
    const ageMs = now.getTime() - intention.createdAt.getTime();
    if (ageMs < DREAM_CONFIG.staleLoopDays * 24 * 3600_000) continue;
    if (intention.relatedMemoryId) {
      const linked = await store.getById(intention.relatedMemoryId);
      if (linked && linked.currentLevel < 3) continue; // trace still alive → not stale
    }
    staleLoopCandidates++;
    const ok = (await store.fileDreamProposal?.({
      kind: 'close_stale_loop',
      payload: JSON.stringify({ intentionId: intention.id, content: intention.content, ageDays: Math.floor(ageMs / 24 / 3600_000) }),
      payloadHash: hashOf('close_stale_loop', [intention.id]),
      confidence: 0.3,
      expiresAt,
    })) ?? false;
    if (ok) filed++;
  }

  const pending = (await store.listDreamProposals?.({ status: 'pending' })) ?? [];
  proposals.push(...pending);

  return {
    considered: traces.length,
    clusters: clusters.length,
    filed,
    expired,
    staleLoopCandidates,
    draftsWritten: drafts,
    corroborated,
    proposals,
  };
}

/**
 * Applies an approved proposal. Returns a human-readable summary of the effect.
 * `update_agents_md` never writes the file — it returns the suggested line for
 * the human to paste (level-1 memory stays human-owned, permanently).
 */
export async function applyDreamProposal(
  store: MemoryStore & IntentionStore,
  proposal: DreamProposal,
  options?: { clock?: Clock }
): Promise<string> {
  const payload = JSON.parse(proposal.payload);

  switch (proposal.kind) {
    case 'promote_semantic': {
      const ids: string[] = payload.clusterIds;
      const members = (await Promise.all(ids.map((id) => store.getById(id)))).filter(Boolean) as Memory[];
      if (!members.length) return 'cluster vanished — nothing to promote';
      const content = payload.drafted ??
        `Recurring pattern across ${members.length} traces (${payload.sessions} sessions, agents: ${payload.agents.join(', ') || 'n/a'}):\n` +
        members.map((m) => `- ${(m.level2Essential ?? m.content).slice(0, 200)}`).join('\n');
      const created = await store.add({
        content,
        directory: members[0].directory,
        day: (options?.clock ?? systemClock).now().toISOString().split('T')[0],
        keywords: [...new Set(members.flatMap((m) => m.keywords))].slice(0, 8),
        sessionId: 'dream',
        memoryType: 'semantic',
        source: 'dream_proposal',
        verified: true,
        // NOT 'human': `human` is the only reason that renders a trace *bare*,
        // outside the untrusted markers, in the next session's context block
        // (session-context.ts). This content is LLM-drafted or concatenated
        // from agent traces — the human approved a proposal showing three
        // 140-char samples, they did not read this text. `corroborated` is
        // what the evidence actually supports, and it keeps the trace wrapped.
        verificationReason: 'corroborated',
      });
      return `promoted to semantic memory ${created.id.slice(0, 8)}…`;
    }

    case 'merge_cluster': {
      const ids: string[] = payload.clusterIds;
      if (ids.length < 2) return 'cluster too small to merge';
      const [target, ...sources] = ids;
      for (const src of sources) await store.merge(src, target, {});
      return `merged ${sources.length} trace(s) into ${target.slice(0, 8)}…`;
    }

    case 'contradiction': {
      const r = await store.contradict!(payload.winnerId, payload.loserId, {
        reason: payload.reason,
        createdBy: 'human', // approved by the human gate
      });
      return r.contradiction
        ? `contradiction applied — loser at ${r.loser.saillance}/100`
        : 'contradiction filed again as proposal';
    }

    case 'close_stale_loop': {
      await store.updateIntentionStatus(payload.intentionId, 'closed', {});
      return `stale loop ${payload.intentionId.slice(0, 8)}… closed`;
    }

    case 'update_agents_md': {
      return `suggested AGENTS.md addition (paste it yourself):\n${payload.drafted ?? payload.suggestion ?? ''}`;
    }
  }
}
