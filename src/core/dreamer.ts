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
  Memory, Intention, MemoryStore, IntentionStore, ScriptStore,
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
   * FALLBACK cluster threshold, used only for embedders without a calibrated
   * per-model value (HashEmbedder in tests). Production models carry their
   * own in CLUSTER_THRESHOLDS (embeddings.ts, 7.5 rounds 1–4): e5-small
   * 0.855 / e5-base 0.825 / bge-m3 0.740 (best F1 0.89).
   *
   * vectorCorroborateThreshold 0.99 = SENTINEL, auto-corroboration DISABLED.
   * Four calibration rounds (e5-small, e5-base ×2, bge-m3 — 52 labelled pairs
   * incl. same-domain hard negatives) all failed to find a P=1.0 gate
   * (best-case false max 0.908 > true min 0.691 with bge-m3). Re-enabling
   * requires a stronger embedder or an LLM pairwise verifier, not more fixture.
   */
  vectorClusterThreshold: 0.825,
  vectorCorroborateThreshold: 0.99,
  /** Proposal lifetime (owner-approved 14d expiry). */
  proposalTtlDays: 14,
  /** LLM drafting cap per run; skipped entirely without a client. */
  maxDraftsPerRun: 10,
  /** Loops open longer than this are stale-loop candidates. */
  staleLoopDays: 30,
  /** Max traces read per run. */
  collectLimit: 500,
  /**
   * Phase 8.5 — script mining. A "correction" is a trace that WON an active
   * contradiction: 6.0.2 already establishes that mechanism as evidence a
   * prior trace was wrong, so reusing it avoids inventing a new "correction"
   * tag with no producer anywhere in the codebase (Claude's Phase 8
   * annotation flagged the alternative — tagging memoryType — as dead weight
   * without one).
   */
  scriptCandidateMinCluster: 2,
  /** Draft steps are raw trace content, capped — no LLM drafting for this kind (out of scope, PHASE8_PLAN §Out of scope). */
  scriptCandidateMaxSteps: 6,
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
  /** `script_candidate` proposals filed this run (8.5). */
  scriptCandidates: number;
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
  /** Override the 30-day collection window (validation / deep retrospectives). */
  windowDays?: number;
}

export async function runDreamer(options: DreamOptions): Promise<DreamReport> {
  const { store } = options;
  const clock = options.clock ?? systemClock;
  const clusterer = options.clusterer ?? new KeywordClusterer();
  const now = clock.now();
  const windowStart =
    now.getTime() - (options.windowDays ?? DREAM_CONFIG.windowDays) * 24 * 3600_000;

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

  // 6. Script mining (8.5): a cluster of *corrections* — traces that WON an
  // active contradiction — sharing a directory drafts a script. "11 of 15
  // agents fail the same command, then fix it the same way" is a contradiction
  // per winning trace; clustering the winners finds the repeated pattern.
  let scriptCandidates = 0;
  if (store.listContradictions) {
    const activeContradictions = await store.listContradictions({ status: 'active' });
    const inWindow = activeContradictions.filter((c) => c.createdAt.getTime() >= windowStart);
    // A memory can win more than one contradiction; keep its earliest win —
    // that is when it first established itself as the correction.
    const wonAt = new Map<string, Date>();
    for (const c of inWindow) {
      const prior = wonAt.get(c.winnerId);
      if (!prior || c.createdAt < prior) wonAt.set(c.winnerId, c.createdAt);
    }
    const winners = (
      await Promise.all([...wonAt.keys()].map((id) => store.getById(id)))
    ).filter((m): m is Memory => m !== null && m.currentLevel < 4 && !m.mergedIntoId);

    const byDirectory = new Map<string, Memory[]>();
    for (const w of winners) {
      const bucket = byDirectory.get(w.directory) ?? [];
      bucket.push(w);
      byDirectory.set(w.directory, bucket);
    }

    for (const [directory, group] of byDirectory) {
      if (group.length < DREAM_CONFIG.scriptCandidateMinCluster) continue;
      // Cluster within the directory only — a script has one `directory`,
      // mixing corrections from unrelated places would draft a drill nobody
      // asked for. No verification is granted here (unlike step 4's
      // corroboration): this path only ever produces a human-reviewed
      // proposal, so the plain (unscored) grouping is enough.
      const subclusters = await clusterer.cluster(group);
      for (const cluster of subclusters) {
        if (cluster.length < DREAM_CONFIG.scriptCandidateMinCluster) continue;
        const ordered = [...cluster].sort(
          (a, b) => (wonAt.get(a.id)!.getTime() - wonAt.get(b.id)!.getTime())
        );
        const steps = ordered
          .slice(0, DREAM_CONFIG.scriptCandidateMaxSteps)
          .map((m) => (m.level2Essential ?? m.content).slice(0, 200));
        const keywordCounts = new Map<string, number>();
        for (const m of cluster) for (const k of m.keywords) keywordCounts.set(k, (keywordCounts.get(k) ?? 0) + 1);
        const topKeyword = [...keywordCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const ids = cluster.map((m) => m.id);
        const name = topKeyword ? `fix-${topKeyword}` : `correction-${hashOf('script_candidate', ids).slice(0, 6)}`;

        const ok = (await store.fileDreamProposal?.({
          kind: 'script_candidate',
          payload: JSON.stringify({
            directory,
            name,
            description: `Recurring correction across ${cluster.length} traces — steps drafted from what fixed it each time.`,
            steps,
            sourceMemoryIds: ids,
            truncatedSteps: cluster.length > DREAM_CONFIG.scriptCandidateMaxSteps,
          }),
          payloadHash: hashOf('script_candidate', ids),
          confidence: confidenceOf(cluster),
          expiresAt,
        })) ?? false;
        if (ok) { filed++; scriptCandidates++; }
      }
    }
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
    scriptCandidates,
    proposals,
  };
}

/**
 * Applies an approved proposal. Returns a human-readable summary of the effect.
 * `update_agents_md` never writes the file — it returns the suggested line for
 * the human to paste (level-1 memory stays human-owned, permanently).
 */
export async function applyDreamProposal(
  store: MemoryStore & IntentionStore & ScriptStore,
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

    case 'script_candidate': {
      // Lands as 'draft', never 'active' (8.5): the human reviewing the
      // proposal saw a description and a confidence score, not necessarily
      // every drafted step — same reasoning as promote_semantic not landing
      // as `verificationReason: 'human'` (R1 discussion, Claude's reply).
      // A human still runs `script activate` after reading the actual steps.
      const script = await store.addScript({
        name: payload.name,
        description: payload.description,
        steps: payload.steps,
        directory: payload.directory,
        source: 'dream_proposal',
        status: 'draft',
        pinned: false,
      });
      return `drafted script "${script.name}" (${script.id.slice(0, 8)}…) — ` +
        `\`pnpm cli script activate ${script.id.slice(0, 8)}\` after reviewing the steps`;
    }

    case 'script_archived': {
      // Notice, not a request (PHASE8_PLAN.md §8.4): the archival already
      // happened in the disuse sweep. Nothing left to apply — resolving the
      // proposal (approve or reject) only acknowledges the human has seen it.
      return `acknowledged: "${payload.name}" archived by disuse ` +
        `(saillance ${payload.storedSaillance} → effective ${payload.effectiveSaillance})`;
    }
  }
}
