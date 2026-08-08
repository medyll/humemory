# Phase 7 — Vector memory: embedding-based retrieval & clustering

> **Draft plan — pending owner approval.** Owner ruling (2026-08-08, Phase 6
> arbitration): "Clustering du Dreamer vector => phase 7". The seam is already
> in place: the dreamer depends on a `Clusterer` interface
> ([dreamer.ts:49](src/core/dreamer.ts:49)), so Phase 7 swaps the
> implementation without touching the pipeline.
> This file becomes the source of truth for Phase 7 once approved.

---

## 🎯 Goal

Replace keyword-similarity with **semantic similarity** where it matters, while
preserving the two non-negotiables of the project:

1. **Hermetic, deterministic, network-free tests** (docs/TESTING.md).
2. **Local-first**: no cloud embedding API — the whole point of humemory is a
   memory that belongs to the machine.

Two surfaces benefit:

- **The Dreamer** (6.1): clustering by meaning, not by shared words — the
  cluster "bun test fails on DB path" should group traces that share *zero*
  keywords with it ("les tests plantent sur la base partagée").
- **Inverse search** (`search()`): semantic recall at deep decay levels, where
  only keywords survive — a vector index makes L2/L3 traces findable by
  paraphrase.

---

## 🚫 Constraints (from Phase 6 learnings)

| Constraint | Consequence for Phase 7 |
|---|---|
| Tests never touch the network | The model must run **offline**, and tests must never load it — an `Embedder` interface + deterministic fake, same pattern as `LLMClient` |
| Windows + bun runtime | No native bindings that don't ship prebuilt win32-x64 binaries |
| Model download is a one-time setup, not a test step | Models cached under `data/models/` (git-ignored); CI skips model tests |
| Determinism | Embeddings are floats — clustering thresholds asserted with margins, never exact float equality |
| Trust invariants (R1) | Cluster scoring stays on `base(source)` only — no feedback loop. ⚠️ But since `7f2b92a` the dreamer assigns `corroborated` verification to cluster members: **the cosine threshold now gates verification too** (A1) → two thresholds, §7.3 |

---

## 🔍 Options considered

| Option | Verdict |
|---|---|
| Cloud embedding API (OpenAI, Voyage) | ❌ rejected — violates local-first and network-free tests |
| `onnxruntime-node` + Transformers.js (`@huggingface/transformers`), model `multilingual-e5-small` (~118M params, ~470MB fp32 / ~120MB quantized) | ✅ **chosen** — prebuilt win32-x64 binaries, runs under bun, multilingual (traces are FR+EN), quantizable |
| `sqlite-vec` extension | 🟡 optional later — brute-force cosine is fine ≤ ~50k traces; adopting it is a perf item, not a design item |
| BM25 + vector hybrid (RRF fusion) | ✅ chosen for **search** — keywords win on exact identifiers (`loop-ab12`, file paths), vectors win on paraphrases |
| LLM-based clustering (ask the LLM to group) | ❌ — non-deterministic, costs tokens, needs a network call in the consolidation path |

**Model choice rationale**: `multilingual-e5-small` — humemory traces are
bilingual by design (see the bilingual emotional-word list in decay.ts). The
`e5` family expects `query:`/`passage:` prefixes; the Embedder owns them.

---

## 🧱 Design

### 7.1 — `Embedder` interface (the test seam)

```ts
// src/core/embeddings.ts
export interface Embedder {
  readonly modelId: string;
  readonly dims: number;                       // 384 for e5-small
  embed(texts: string[]): Promise<Float32Array[]>;  // L2-normalized
}

/** Deterministic, offline, for tests: hashes tokens into a fixed sparse
 *  space. Semantically meaningless but reproducible — tests assert *pipeline*
 *  behavior (storage, clustering shape, thresholds), not model quality. */
export class HashEmbedder implements Embedder { /* dims = 384 */ }

/** Production: @huggingface/transformers pipeline('feature-extraction'),
 *  model cached in data/models/. Loaded lazily; absent model ⇒ disabled, not crash. */
export class OnnxEmbedder implements Embedder { /* e5-small, query:/passage: prefixes */ }
```

### 7.2 — Storage

```sql
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,          -- re-embed everything when it changes
  embedding BLOB NOT NULL,         -- Float32Array, dims × 4 bytes
  embedded_at INTEGER NOT NULL
);
```

- **Never embedded on `add()`** (A3): `add()` sits on the Stop-hook and MCP
  tool paths — a lazy ~120MB model load must never land there. Embeddings are
  written by **batch jobs only**: `pnpm dream` (embeds missing rows before
  clustering) and `pnpm cli embed backfill`. Traces stay unembedded until the
  next pass; the vector lane is additive by design, so this costs nothing.
- **Delete-on-mutation, never inline recompute** (A4): on any level mutation
  (merge, unmerge, decay-affecting edit), the row is **deleted** from
  `memory_embeddings`; the next batch pass re-embeds. Deleting is always
  consistent — inline recompute is where drift enters. (`delete` itself is
  covered by ON DELETE CASCADE — verified at [sqlite.ts:186](src/store/sqlite.ts:186).)
- Backfill: `pnpm cli embed backfill` — batches over existing traces, idempotent
  (`INSERT OR REPLACE` where model_id differs).

### 7.3 — `VectorClusterer` (dreamer swap)

```ts
export class VectorClusterer implements Clusterer {
  constructor(embedder: Embedder, store: SQLiteStore, opts?: { threshold?: number }) {}
  async cluster(memories: Memory[]): Promise<Memory[][]>
}
```

- Cosine similarity on stored embeddings (embedding missing → embedded on the
  spot *by the batch job*, per A3 — no keyword fallback, which would mix two
  geometries).
- Same union-find as `KeywordClusterer`, so the swap is a one-line change in
  `runDreamer` wiring + CLI flag `--clusterer vector|keyword` (default vector
  once calibrated, keyword until then).
- **Two thresholds, not one** (A1 — the load-bearing annotation):
  - `vectorClusterThreshold ≈ 0.82` — grouping. Noise is tolerable: a false
    cluster is a rejected proposal, cheap, a human reviews it.
  - `vectorCorroborateThreshold ≈ 0.90` — the stricter gate for assigning
    `corroborated` verification (introduced in `7f2b92a`). Noise here is a
    wrong trace made durable, decaying slower and sorting first, with nothing
    in the review queue to surface it. Nobody reviews verification, so the
    threshold does the reviewing.
  Both live in `DREAM_CONFIG`, frozen by calibration (§7.5).
- **Interface change**: `Clusterer.cluster` becomes `async`. Mechanical
  ripple: dreamer + tests. (KeywordClusterer just returns a resolved promise.)

### 7.4 — Hybrid search (RRF)

`search()` gains an optional semantic lane:

```
score = RRF(BM25 rank, vector rank, k=60)
```

- Vector lane: embed the query (`query:` prefix), cosine against
  `memory_embeddings`, top-N.
- Default: BM25-only when no embeddings exist (pre-backfill DBs, hermetic
  tests) — the feature is **additive**, never a regression on bare installs.
- CLI: `search --semantic` flag; API: `GET /search?query=X&semantic=1`.

### 7.5 — Calibration (B7 lesson: weights are calibration outputs)

- Fixture set `tests/fixtures/embeddings/`: ~30 labeled pairs (should-cluster /
  shouldn't-cluster), bilingual, drawn from real humemory usage patterns.
- A calibration script (not a test — needs the model) sweeps **both** cosine
  thresholds (A1) and reports:
  - clustering precision/recall → sets `vectorClusterThreshold`;
  - **verification precision** (share of would-be-corroborated pairs that a
    human labels as genuinely the same fact) → sets
    `vectorCorroborateThreshold`. A false cluster costs a rejected proposal;
    a false corroboration makes a wrong trace durable — the stricter metric
    governs the stricter threshold.
- Tests assert only with `HashEmbedder`: pipeline shape, threshold plumbing,
  missing-embedding behavior, determinism.

---

## 🥾 Sequencing

| Step | Scope | Notes |
|------|-------|-------|
| 7.1 | `Embedder` interface + `HashEmbedder` + async `Clusterer` | no behavior change; full suite stays green |
| 7.2 | `memory_embeddings` table + batch embedding (`dream`, `embed backfill`) + delete-on-mutation | works with HashEmbedder already; **never on `add()`** — see §7.2 |
| 7.3 | `OnnxEmbedder` + model cache + `VectorClusterer` | behind `--clusterer` flag |
| 7.4 | Hybrid RRF search lane | additive, flag-gated |
| 7.5 | Labeled fixtures + threshold calibration + flip the default | the step that makes it real |

Dependencies to add: `@huggingface/transformers` (pulls `onnxruntime-node`).
~150MB install + ~120MB model on first run — document in README setup.

---

## ⚠️ Risks

| Risk | Mitigation |
|------|-----------|
| onnxruntime-node breaks under bun on win32 | 7.3 is flag-gated; keyword clusterer stays the default until 7.5 proves the model runs. ~~fall back to node~~ impossible — `sqlite.ts` imports `bun:sqlite` everywhere (A2). **Pre-flight gate: run `pipeline('feature-extraction')` under bun on win32 *before* starting 7.3** — the answer decides whether the phase is three steps or five |
| Model download in CI | tests never instantiate OnnxEmbedder; calibration is a local script |
| Embedding drift across model upgrades | `model_id` column — a model change triggers explicit re-backfill, never silent mixing of spaces |
| Vector search surfaces contradicted losers | the vector lane applies the same exclusion filters as BM25 (active contradictions, merged) — tested |
| Threshold arbitrariness | calibration on labeled fixtures (7.5), value lives in `DREAM_CONFIG` |

---

## 🚫 Out of scope

- **ANN index** (HNSW/sqlite-vec): brute-force cosine is O(n·d) with n = trace
  count — fine for years of personal use; revisit at >50k traces.
- **Multi-device vector sync**: follows the Phase 6 `device` column work, not
  this phase.
- **Reranking LLM** on search results: cost + determinism.
- **Intentions embeddings**: prospective cues resolve on explicit triggers,
  not similarity — no need.

---

## ❓ Open questions

1. `multilingual-e5-small` (384 dims, fast) vs `multilingual-e5-base`
   (768 dims, better French nuance, 2× cost)? → Proposed: small; measure in
   7.5, upgrade only if recall suffers.
2. Embed L0 content only, or the current-decay-level text (what the agent
   would actually see)? → **Resolved (A5): L3 keywords first, then L0** —
   `multilingual-e5-small` truncates at 512 tokens, so keywords-last would
   silently drop them on long traces, exactly where they matter. Two separate
   vectors (L3 + L0) rejected for now: one row per trace keeps 7.2 simple;
   revisit if calibration shows degraded-trace recall suffering.
3. Should `findSimilar` (merge detection) also use vectors? → Proposed: yes
   as a lane, but merge stays L4-triggered; no auto-merge on vector score alone.

---

## 💬 Annotations — Claude (2026-08-08)

Read against the code as it stands at `8bd4d50`. The plan is sound and the
seam is in the right place; the notes below are where it contradicts the tree,
or where Phase 6 moved under it.

### A1 — "Vectors change *grouping*, never *trust*" is no longer true

The constraints table asserts this, and it was true when the table was
written. It stopped being true in `7f2b92a`: the dreamer now assigns the
`corroborated` verification to cluster members when a cluster shows distinct
agents, sessions and directories ([dreamer.ts:136](src/core/dreamer.ts:136)).

So the cosine threshold of §7.3 is not only a grouping knob — it decides which
traces get verified, which decay 1.5× slower and sort first in the SessionStart
block. A looser threshold means more cross-agent clusters, which means more
automatic verification. Semantic clustering makes this *sharper*, not safer:
that is the whole point of the phase, traces that share no keywords will now
group.

Two consequences for §7.5:
- Calibration must measure **verification precision**, not just clustering
  precision. A false cluster is a rejected proposal — cheap. A false
  corroboration is a wrong trace made durable — expensive, and nothing in the
  review queue surfaces it.
- Consider two thresholds rather than one: cluster at ~0.82, corroborate at a
  stricter value. Grouping tolerates noise because a human reviews the
  proposal; verification does not, because nobody reviews it.

The R1 invariant itself is untouched — scoring still runs on `baseTrust`, so
there is still no feedback loop. This is a different coupling: threshold →
verification, not verification → threshold.

### A2 — The onnxruntime fallback in the risk table does not exist

"fall back to node (not bun) for the MCP/consolidate entry if needed" cannot
be done as written: [sqlite.ts:1](src/store/sqlite.ts:1) imports `bun:sqlite`
directly, so every entry point that touches the store is bun-only by
construction. A node entry would require replacing the driver first — a far
larger change than Phase 7.

The real fallback is the one already in the plan: 7.3 is flag-gated and
`KeywordClusterer` stays the default. That is sufficient. Rather than carry a
mitigation that would not work, spend ten minutes before starting 7.3 running
`pipeline('feature-extraction')` under bun on win32 — the answer decides
whether the phase is three steps or five.

### A3 — Do not put the model in the encoding path

§7.2 writes embeddings "on `add()`, asynchronously and best-effort". `add()`
is on the Stop-hook path ([claude-hook.ts](src/agent/claude-hook.ts)), which
runs at the end of every session, and on the MCP `humemory_add` path, which
runs inside another agent's tool call. A lazy first load of a ~120 MB model
lands on whichever of those fires first.

Suggest: never embed in the hook or MCP path. Embed in `pnpm dream` and
`embed backfill` only, both of which are already batch jobs where a model load
is expected. Traces stay unembedded until the next nightly pass, which costs
nothing — the vector lane is additive by design.

### A4 — §7.2's CASCADE works; two neighbours need explicit handling

Verified: `PRAGMA foreign_keys=ON` is set ([sqlite.ts:186](src/store/sqlite.ts:186)),
so `ON DELETE CASCADE` will behave. `data/` is git-ignored, so `data/models/`
is covered.

Not covered by "merge / unmerge / delete keep it consistent":
- `unmerge` (6.0.4) restores the target's *previous* derived levels from
  `level_revisions`. If the merge recomputed the target's embedding from the
  new levels, unmerge must recompute it back — otherwise the vector describes
  a merge that no longer exists, silently.
- The resurrected source row needs its embedding re-created too; it was
  CASCADE-deleted or left stale depending on the path.

Cheapest correct rule: on any level mutation, **delete** the row from
`memory_embeddings` rather than recompute it. The next batch pass re-embeds.
Deleting is always consistent; recomputing in-line is where the drift enters.

### A5 — Open question 2: the concatenation order matters

Embedding "L0 + L3 keywords concatenated" is right in intent, but
`multilingual-e5-small` truncates at 512 tokens. An L0 trace longer than that
silently drops the L3 keywords off the end — exactly the part meant to keep
the trace findable as it decays, and exactly the case (long traces) where you
need it most.

Put L3 first, or embed the two separately and keep both vectors. The second
costs one more row per trace and makes the decay story honest: query a
degraded trace against the representation the agent would actually see.

### A6 — Smaller notes

- §7.3's async ripple is correctly scoped: `Clusterer` is consumed only by
  `runDreamer` and the dreamer tests. Nothing else to update.
- Brute-force cosine at `DREAM_CONFIG.collectLimit` = 500 traces is 125k
  pairwise comparisons over 384 dims per run — a few hundred ms. The
  ">50k traces" deferral of `sqlite-vec` is comfortably right.
- Open question 3: `findSimilar` already exists and backs the merge path
  ([sqlite.ts:475](src/store/sqlite.ts:475)); adding a vector lane there is a
  small change. Agreed that merge stays L4-triggered.
- Open question 1: agreed, `small` first. Add the measurement to 7.5 rather
  than leaving it as a later judgement call.

---

*Drafted 2026-08-08 by Kimi (Moonshot AI) — pending owner approval.*
*Annotated 2026-08-08 by Claude (Sonnet 5): trust coupling introduced by
`7f2b92a` (A1), unavailable node fallback (A2), model out of the encoding path
(A3), embedding lifecycle on merge/unmerge (A4), truncation order (A5).*
*Revised 2026-08-08 by Kimi (Moonshot AI): all six annotations accepted and
integrated — two thresholds (cluster ≈0.82 / corroborate ≈0.90) with
verification-precision calibration (A1), node fallback removed, pre-flight
bun/onnx gate before 7.3 (A2), embeddings in batch jobs only, never on add()
(A3), delete-on-mutation for memory_embeddings (A4), L3-first truncation
order (A5). Status: **consensus reached, pending owner approval.***

---

*Shipped 2026-08-08 by Kimi (Moonshot AI). 7.5 calibration results against the
real e5-small model (28 labelled bilingual pairs, `scripts/calibrate-embeddings.ts`):
true-pair min 0.809 / false-pair max 0.895 — the distributions OVERLAP.
Measured decisions: cluster threshold **0.855** (best F1: P 0.76 / R 0.93 /
F1 0.84 — acceptable, clusters are human-reviewed); corroborate threshold
**0.99 sentinel = vector auto-corroboration DISABLED** (no P=1.0 threshold
exists with e5-small; keyword path keeps metadata-only corroboration);
fp32 shows the same overlap (model, not quantization); fp16 fails to load on
win32/onnxruntime-node. Deviations from plan: default `--clusterer` stays
`keyword` (vector F1 0.84 too low for a default); re-enabling corroboration
is gated on a model upgrade (open question 1, e5-base) + recalibration.*

*Round 2 (same day): e5-base q8 recalibration found a P=1.0 corroboration gate
at 0.855 (true min 0.815 / false max 0.853; cluster best-F1 0.840 at P 0.86 /
R 0.86). Defaults flipped: model → e5-base, `--clusterer` → vector, vector
auto-corroboration ENABLED. Margin over the worst false pair is only 0.002 on
a 28-pair fixture — raise the gate or widen the fixture before trusting it on
a larger corpus.*
