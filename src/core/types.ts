/**
 * Memory decay levels.
 * 0 = full detail (fresh)
 * 1 = summary (days)
 * 2 = gist (weeks)
 * 3 = keywords (months)
 * 4 = lost / merged
 */
export type DecayLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Memory types (cognitive neuroscience).
 * - Episodic: lived events, with their temporal and spatial context
 * - Semantic: facts and concepts
 * - Procedural: know-how, gestures, routines
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export interface Memory {
  id: string;
  content: string;           // Level 0 (full detail)
  level1Summary?: string;    // Level 1 (summary)
  level2Essential?: string;  // Level 2 (gist)
  level3Keywords?: string;   // Level 3 (keywords for BM25)
  
  // Lightweight metadata
  directory: string;         // Project / source
  day: string;               // YYYY-MM-DD
  keywords: string[];        // Tagged keywords
  sessionId: string;         // Working session
  memoryType: MemoryType;    // Memory type
  
  // Lifecycle
  createdAt: Date;
  lastRecalled?: Date;
  recallCount: number;       // How many times it was recalled
  
  // Decay
  decayRate: number;         // 0.0 (slow) to 1.0 (fast)
  currentLevel: DecayLevel;  // Current decay level
  saillance: number;         // Score 0-100
  
  // Merging
  mergedIntoId?: string;     // Id of the trace it was merged into (level 4)

  // Photographic mode — disables decay
  photographic?: boolean;

  // ── Phase 6 trust layer (populated from 6.0.1 onward) ──
  source?: TraceSource;      // who wrote it; undefined on pre-Phase-6 rows
  agent?: string;            // claude | codex | kimi | opencode | unknown
  verified?: boolean;
  verificationReason?: VerificationReason;
  device?: string;           // encoding device (localization now, sync later)
  refutedCount?: number;
}

export type TraceSource = 'human' | 'agent' | 'hook' | 'llm_generated' | 'dream_proposal';

export type VerificationReason = 'corroborated' | 'grounded' | 'reused' | 'human';

export interface SearchQuery {
  query: string;
  directory?: string;
  sessionId?: string;
  maxLevel?: DecayLevel;     // Highest decay level to include
  limit?: number;
  // Enriched filters
  memoryType?: MemoryType;
  dateFrom?: Date;           // Filter: createdAt >= dateFrom
  dateTo?: Date;             // Filter: createdAt <= dateTo
  minSaillance?: number;     // Filter: saillance >= minSaillance
  minRecalls?: number;       // Filter: recallCount >= minRecalls
}

export interface SearchResult {
  memory: Memory;
  matchLevel: DecayLevel;    // Level at which the match was found
  score: number;             // Relevance score
}

export interface MergeResult {
  source: Memory;
  target: Memory;
  mergedContent?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Trust layer (Phase 6.0.2) — contradictions
//
// A contradiction collapses the loser's saillance and excludes it from the
// SessionStart block, but never deletes it: human forgetting keeps the
// "ghosted" memory; humemory should too.
// ─────────────────────────────────────────────────────────────────────────────

export interface Contradiction {
  id: string;
  winnerId: string;
  loserId: string;
  reason?: string;
  createdAt: Date;
  createdBy: 'agent' | 'human' | 'dreamer';
  agent?: string;
  status: 'active' | 'revoked';
}

export interface ContradictResult {
  contradiction?: Contradiction;
  /** Set when authority was asymmetric: a proposal was filed instead. */
  proposalFiled?: boolean;
  /** Set when the loser was already merged — the collapse hit the merge target. */
  retargetedTo?: string;
  loser: Memory;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dreaming (Phase 6.1) — cross-session consolidation
//
// The dreamer detects recurring patterns across sessions and agents, then
// *proposes*. Nothing touches `memories` or AGENTS.md without explicit human
// approval.
// ─────────────────────────────────────────────────────────────────────────────

export type DreamKind =
  | 'promote_semantic'
  | 'merge_cluster'
  | 'update_agents_md'
  | 'contradiction'
  | 'close_stale_loop';

export type DreamStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface DreamProposal {
  id: string;
  kind: DreamKind;
  payload: string;          // JSON: cluster ids, drafted consolidated content
  payloadHash: string;      // stable hash of sorted cluster ids + kind → idempotent
  status: DreamStatus;
  confidence: number;       // 0..1, cluster size × mean baseTrust
  createdAt: Date;
  expiresAt?: Date;
  resolvedAt?: Date;
  resolvedBy?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prospective memory (Phase 5) — intentions and cues
//
// An `Intention` is an open loop: "tomorrow, refactor fn X". You do not search
// for it, it comes back — carried by one or more `Cue`s armed on time or on an
// event. Zeigarnik effect: while `armed` its salience stays pinned at 100; once
// `fired` and not `closed`, it starts declining like an ordinary trace.
// See PHASE5_PLAN.md § 5.1.
// ─────────────────────────────────────────────────────────────────────────────

/** armed = waiting · fired = surfaced to the agent · closed = done · expired = past its deadline. */
export type IntentionStatus = 'armed' | 'fired' | 'closed' | 'expired';

export type CueStatus = 'armed' | 'fired' | 'cancelled';

export type CueKind = 'time' | 'event';

/** Time trigger: either a one-shot date (`at`) or a recurrence (`cron`). */
export interface TimeTriggerSpec {
  kind: 'time';
  at?: string; // ISO datetime
  cron?: string; // expression cron 5 champs
}

/**
 * Event trigger. No `commit` variant here, on purpose: a commit does not wake an
 * intention, it *closes* one — that is the post-commit hook's job (S5-03b), not
 * the cue resolver's.
 */
export type EventTriggerSpec =
  | { kind: 'event'; type: 'file_open'; path: string }
  | { kind: 'event'; type: 'branch_switch'; branch: string }
  | { kind: 'event'; type: 'error_pattern'; pattern: string };

export type TriggerSpec = TimeTriggerSpec | EventTriggerSpec;

export interface Intention {
  id: string;
  content: string;
  directory: string; // mental place
  createdAt: Date;
  expiresAt?: Date; // an intention without a deadline is undefined
  status: IntentionStatus;
  firedAt?: Date;
  closedAt?: Date;
  closedByCommit?: string; // SHA of the commit that closed the loop
  saillance: number; // pinned at 100 while armed
  relatedMemoryId?: string; // optional link to a retrospective trace

  // ── Phase 6 trust layer (gap 8: loops carry provenance too) ──
  source?: TraceSource;
  agent?: string;
  verified?: boolean;
  verificationReason?: VerificationReason;
  device?: string;
}

export interface Cue {
  id: string;
  intentionId: string;
  kind: CueKind;
  triggerSpec: TriggerSpec;
  status: CueStatus;
  armedAt: Date;
  firedAt?: Date;
}

/** Write shape for an intention: the store sets id/createdAt/status/saillance. */
export type NewIntention = Omit<
  Intention,
  'id' | 'createdAt' | 'status' | 'saillance' | 'firedAt' | 'closedAt' | 'closedByCommit'
> & {
  status?: IntentionStatus;
  saillance?: number;
};

/** Write shape for a cue: the store sets id/armedAt/status and derives `kind` from the spec. */
export type NewCue = {
  intentionId: string;
  triggerSpec: TriggerSpec;
  status?: CueStatus;
};

export interface IntentionStore {
  addIntention(intention: NewIntention, cues?: TriggerSpec[]): Promise<Intention>;
  getIntention(id: string): Promise<Intention | null>;
  listIntentions(options?: {
    status?: IntentionStatus | IntentionStatus[];
    directory?: string;
    limit?: number;
  }): Promise<Intention[]>;
  updateIntentionStatus(
    id: string,
    status: IntentionStatus,
    options?: { closedByCommit?: string }
  ): Promise<Intention>;
  deleteIntention(id: string): Promise<void>;

  addCue(cue: NewCue): Promise<Cue>;
  getCue(id: string): Promise<Cue | null>;
  listCues(options?: {
    intentionId?: string;
    status?: CueStatus | CueStatus[];
    kind?: CueKind;
    limit?: number;
  }): Promise<Cue[]>;
  updateCueStatus(id: string, status: CueStatus): Promise<Cue>;
  /** Records a firing. `rearm` keeps the cue `armed` (recurring cues). */
  markCueFired(id: string, options?: { rearm?: boolean }): Promise<Cue>;
}

export interface MemoryStore {
  add(memory: Omit<Memory, 'id' | 'createdAt' | 'recallCount' | 'decayRate' | 'currentLevel' | 'saillance'>, options?: { autoGenerate?: boolean }): Promise<Memory>;
  getById(id: string): Promise<Memory | null>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  /**
   * `agent` (Phase 6.0.1): who is recalling. A recall by a *different* agent
   * than the writer earns the trace the `reused` verification.
   */
  recall(id: string, agent?: string): Promise<Memory>;
  updateDecay(): Promise<void>;
  delete(id: string): Promise<void>;
  list(options?: {
    limit?: number;
    level?: DecayLevel;
    levels?: DecayLevel[];
    type?: MemoryType;
    directory?: string;
    minSaillance?: number;
  }): Promise<Memory[]>;
  findSimilar(id: string, options?: { limit?: number; threshold?: number }): Promise<SearchResult[]>;
  merge(sourceId: string, targetId: string, options?: { autoMergeContent?: boolean; client?: import('./llm-generator.js').LLMClient }): Promise<MergeResult>;
  setPhotographic(id: string, value: boolean): Promise<Memory>;
  /** Phase 6.0.1 — human override verification; automatic paths set the flag directly. */
  verify?(id: string, by?: string): Promise<Memory>;
  /** Phase 6.0.1 — negative signal: refuted_count +1 and verification revoked. */
  refute?(id: string, reason?: string): Promise<Memory>;
  /** Phase 6.0.4 — revert a merge: resurrect the source, restore the target's revised levels. */
  unmerge?(sourceId: string): Promise<{ source: Memory; target: Memory }>;
  /** Phase 6.0.2 — `id` contradicts `otherId`. Tiered authority keyed on verification_reason. */
  contradict?(winnerId: string, loserId: string, options?: { reason?: string; createdBy?: 'agent' | 'human' | 'dreamer'; agent?: string }): Promise<ContradictResult>;
  /** Phase 6.0.2 — revoke: the loser's saillance is recomputed, not literally restored. */
  revokeContradiction?(id: string): Promise<Contradiction>;
  /** Phase 6.0.2 — active (or all) contradictions, for the context block and audits. */
  listContradictions?(options?: { loserId?: string; status?: 'active' | 'revoked' }): Promise<Contradiction[]>;
  /** Phase 6.1 — dream proposals: list (default pending, non-expired) and resolve. */
  listDreamProposals?(options?: { status?: DreamStatus; includeExpired?: boolean }): Promise<DreamProposal[]>;
  resolveDreamProposal?(id: string, status: 'approved' | 'rejected', resolvedBy?: string): Promise<DreamProposal>;
  /** Phase 6.1 — insert a proposal, deduped by (kind, payload_hash). Returns false if it already existed. */
  fileDreamProposal?(p: { kind: DreamKind; payload: string; payloadHash: string; confidence?: number; expiresAt?: Date }): Promise<boolean>;
  /** Phase 6.1 — mark pending proposals past their expires_at as expired. Returns the count. */
  expireDreamProposals?(): Promise<number>;
}
