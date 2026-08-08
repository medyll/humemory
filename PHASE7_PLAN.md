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
| Trust invariants (R1) | Cluster scoring stays on `base(source)` only; vectors change *grouping*, never *trust* |

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

- Written on `add()` **asynchronously and best-effort**: a failed/absent model
  never blocks encoding (the trace is the memory; the vector is an index).
- `merge` / `unmerge` / `delete` keep it consistent (CASCADE on delete;
  merge recomputes the target's embedding from its new levels).
- Backfill: `pnpm cli embed backfill` — batches over existing traces, idempotent
  (`INSERT OR REPLACE` where model_id differs).

### 7.3 — `VectorClusterer` (dreamer swap)

```ts
export class VectorClusterer implements Clusterer {
  constructor(embedder: Embedder, store: SQLiteStore, opts?: { threshold?: number }) {}
  async cluster(memories: Memory[]): Promise<Memory[][]>
}
```

- Cosine similarity on stored embeddings (embedding missing → fall back to the
  trace's keyword tokens via HashEmbedder? **No** — missing embeddings are
  embedded on the spot; keyword fallback would mix two geometries).
- Same union-find as `KeywordClusterer`, threshold ~0.82 (calibrated — §7.5),
  so the swap is a one-line change in `runDreamer` wiring + CLI flag
  `--clusterer vector|keyword` (default vector once calibrated, keyword until then).
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
- A calibration script (not a test — needs the model) sweeps the cosine
  threshold, reports precision/recall, and writes the chosen value into
  `DREAM_CONFIG.vectorSimilarityThreshold`.
- Tests assert only with `HashEmbedder`: pipeline shape, threshold plumbing,
  missing-embedding behavior, determinism.

---

## 🥾 Sequencing

| Step | Scope | Notes |
|------|-------|-------|
| 7.1 | `Embedder` interface + `HashEmbedder` + async `Clusterer` | no behavior change; full suite stays green |
| 7.2 | `memory_embeddings` table + async embed-on-add + backfill CLI | works with HashEmbedder already |
| 7.3 | `OnnxEmbedder` + model cache + `VectorClusterer` | behind `--clusterer` flag |
| 7.4 | Hybrid RRF search lane | additive, flag-gated |
| 7.5 | Labeled fixtures + threshold calibration + flip the default | the step that makes it real |

Dependencies to add: `@huggingface/transformers` (pulls `onnxruntime-node`).
~150MB install + ~120MB model on first run — document in README setup.

---

## ⚠️ Risks

| Risk | Mitigation |
|------|-----------|
| onnxruntime-node breaks under bun on win32 | 7.3 is flag-gated; keyword clusterer stays the default until 7.5 proves the model runs; fall back to node (not bun) for the MCP/consolidate entry if needed |
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
   would actually see)? → Proposed: L0 + L3 keywords concatenated — the trace
   stays findable by detail *and* by gist as it decays.
3. Should `findSimilar` (merge detection) also use vectors? → Proposed: yes
   as a lane, but merge stays L4-triggered; no auto-merge on vector score alone.

---

*Drafted 2026-08-08 by Kimi (Moonshot AI) — pending owner approval.*
