# AGENTS.md — humemory

**Memory for AI agents that forgets like a human — and resurfaces like one.**

Canonical guide for any agent (Claude Code, OpenCode, …) working *on* this repo.
For the project's identity and "why", read [README.md](./README.md) first.

---

## 🎯 Vision — two halves of a brain

humemory has two halves, both built as of Phase 8 (2026-08-08). The direction
was **Direction 1**, chosen 2026-06-17; everything below is the shipped result.

1. **Retrospective** ✅ — past learnings **decay** through 5 levels (detail → summary
   → essential → keywords → lost/merged); recall reinforces; inverse search hits the
   degraded layers first.
2. **Prospective** ✅ — intentions that fire on a **cue** (time/event), **Zeigarnik**
   open loops that stay salient until a `commit` closes them, and context-triggered
   **scripts** that fade on disuse rather than time. A memory that resurfaces
   *before* it is queried. See Phases 5 and 8.

On top of both: a **trust layer** (Phase 6) so several agents can write to one
store without a wrong lesson becoming indestructible, a **dreamer** (6.1) that
proposes cross-session/cross-agent patterns for human review, an **MCP server**
(6.2) so Claude/Codex/Kimi/OpenCode share one memory, and **vector search**
(Phase 7) as an opt-in second retrieval lane alongside BM25.

The conceptual source for the prospective half is `SCRATCHPAD.md` (memoire
prospective, scripts cognitifs, effet Zeigarnik).

---

## ⚙️ Commands

```bash
pnpm install
pnpm build          # tsc -p tsconfig.json → dist/
pnpm dev            # watch src/cli/index.ts (bun)
pnpm start:api      # HTTP API + dashboard on :3456
pnpm cli <cmd>      # run CLI directly
pnpm test           # bun test, single pass
pnpm test:watch     # bun test --watch
pnpm consolidate    # manual decay pass (cron-friendly)
```

Single test file: `bun test tests/humemory.test.ts`

---

## 📦 Structure

```
src/
├── core/
│   ├── types.ts          # Memory, DecayLevel, SearchQuery, MemoryStore iface
│   ├── decay.ts          # degradation curve + thresholds
│   ├── search.ts         # inverse search (BM25, degraded-first)
│   └── llm-generator.ts  # auto-generate L1/L2/L3 via Claude Haiku (prompt cache)
├── store/
│   └── sqlite.ts         # bun:sqlite store (WAL), findSimilar/merge/setPhotographic
├── agent/
│   ├── session-parser.ts     # parse Claude Code session transcripts
│   ├── learning-extractor.ts # extract decisions/bugs/solutions
│   ├── claude-hook.ts        # Stop-hook → auto-encode session learnings
│   └── session-context.ts    # SessionStart → markdown block (open loops + traces)
├── core/
│   ├── clock.ts              # Clock seam (systemClock / FakeClock)
│   ├── event-bus.ts          # AppEvent + InMemoryEventBus
│   ├── cue-arg.ts            # cue syntax, shared by the CLI and the React form
│   └── cues.ts               # cue resolver, cron matcher, loop ids
├── api/server.ts         # Hono HTTP API + serves public/ dashboard
├── cli/index.ts          # commander CLI
└── index.ts              # library exports
web/                      # React front (bun bundler → public/app, served at /app)
scripts/hook-session.ts        # Claude Code Stop hook → encode learnings
scripts/hook-session-start.ts  # Claude Code SessionStart hook → inject context
tests/                    # bun test (hermetic; helpers/ + fixtures/)
data/humemory.db          # shared DB (created on first run)
```

---

## 🧠 Concepts (cognitive-neuroscience naming)

| Field | Cognitive term (French, as in the code) | Meaning |
|-------|-----------|---------|
| `createdAt` | Encodage | trace formation |
| `lastRecalled` | Dernière réactivation | last conscious retrieval |
| `recallCount` | Réactivations | recalls (reinforce) |
| `saillance` | Force mnésique | trace strength 0–100 |
| `decayRate` | Taux d'oubli | degradation speed |
| `sessionId` | Contexte d'encodage | encoding context |
| `directory` | Lieu mental | conceptual space (project) |
| `currentLevel` | État de consolidation | decay stage 0–4 |
| `keywords` | Indices de récupération | retrieval cues |
| `memoryType` | Type | episodic / semantic / procedural |

**Decay thresholds:** L0→L1 ~24h · L1→L2 ~1 week · L2→L3 ~1 month · L3→L4 beyond.
Slowing factors: `recallCount * 0.3`, saillance >70 → 1.5× slower, content >500 chars,
keywords >5. `photographic: true` disables decay entirely.

**Memory types:** `episodic` (events), `semantic` (facts), `procedural` (skills).

---

## 🌐 API (`:3456`, `PORT` env to override)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/memories` | add |
| GET | `/memories` | list (limit, level, type) |
| GET | `/memories/:id` | fetch one |
| POST | `/memories/:id/recall` | bump recall + saillance |
| POST | `/memories/:id/similar` | find similar |
| POST | `/memories/:id/merge` | merge (L4) |
| POST | `/memories/:id/photo` | toggle photographic |
| DELETE | `/memories/:id` | forget |
| GET | `/search?query=X` | inverse search |
| POST | `/decay` | run consolidation |
| GET | `/status` | pool stats |

---

## 🧪 Autonomous test environment — REQUIRED

**Non-negotiable design constraint** (set 2026-06-17). Every test run MUST be
hermetic, deterministic, and network-free. Full spec: **[docs/TESTING.md](./docs/TESTING.md)**.

Core rules:
- **Isolated DB per run** — never touch `data/humemory.db`; use an in-memory or
  temp-file `bun:sqlite` instance, torn down after each suite.
- **Injectable clock** — decay is time-driven, so time must be a parameter, not
  `Date.now()`. Tests fast-forward a fake clock to assert L0→L4 transitions.
- **Mocked LLM** — no calls to Anthropic in tests; `LLMClient` is stubbed with
  deterministic fixtures. CI runs with no `ANTHROPIC_API_KEY`.
- **Fixtures, not live data** — seed memories from `tests/fixtures/`.
- **Deterministic** — same input ⇒ same output; no wall-clock, no randomness, no
  ordering by `Date.now()`.

This environment is the precondition for Phase 5: prospective/Zeigarnik logic is
clock- and event-driven and cannot be trusted without it.

---

## 📊 Roadmap

### ✅ Done — Sprints 1–4
- Core decay + inverse search; `bun:sqlite` store (WAL, write-queue serialization)
- CLI + Hono API + web dashboard ("palais de mémoire")
- Nightly cron consolidation (`0 3 * * *`)
- LLM auto-generation of L1/L2/L3 (Claude Haiku + prompt caching)
- Similar-detection + merge (L4); enriched search (type/period/saillance/recalls)
- Photographic mode; Claude Code `Stop` hook → session learning capture

### 🎯 Phase 5 — Prospective memory (the destiny)
> Detailed corrected plan in **[PHASE5_PLAN.md](./PHASE5_PLAN.md)**. Summary below.

**Preconditions (5.0, blocking):**
- [x] Cross-process SQLite advisory lock (closes Bug #3 below) — shipped, `AdvisoryLock` in `src/store/sqlite.ts`
- [x] Injectable event bus in the test env (Phase 5 is event-driven, not just clock-driven) — shipped as S5-00b, `src/core/event-bus.ts`

**Data model (5.1): ✅ shipped (S5-01).** Dedicated `intentions` table (NOT a new `MemoryType` —
intentions have a future trigger, status, and different decay rules than retrospective
traces) + `cues` table with typed `trigger_spec` (time = ISO/cron, event = file_open /
branch_switch / error_pattern). One intention → N cues.

**Cue resolver (5.2): ✅ shipped (S5-02), `src/core/cues.ts`.** `resolveTimeCues(now)` + `resolveEventCues(event)` + expiry.
Decay × intention rule: `armed` → saillance pinned at 100, no decay (open loop stays
salient); `fired` not `closed` → normal decay (Zeigarnik fades over time); `closed`
→ archived.

**Hooks (5.3): ✅ shipped (S5-03a, S5-03b).**
- `scripts/hook-session-start.ts` — Claude Code `SessionStart` hook resolves cues for
  the current `cwd` + `git branch --show-current`, emits a structured markdown block
  on stdout (configurable budget via `HUMEMORY_SESSION_BUDGET`). Logic lives in
  `src/agent/session-context.ts`.
- `.githooks/post-commit` → `scripts/hook-post-commit.ts` — parses the commit message
  for `Closes loop-<id>` and closes those loops, cancelling their cues. File-overlap
  scoring only ever *suggests*, never closes: logic in `src/agent/commit-closer.ts`.
  Set `HUMEMORY_HOME` when installing the hook into another project — the database is
  shared across projects, the code is not.

**CLI/API (5.4): ✅ shipped (S5-04).** `pnpm cli intent {add,list,close,fire,resolve}`
(cue args like `event:file_open:src/a.ts`, `cron:0 9 * * 1`) + `POST /intentions`,
`GET /intentions`, `POST /intentions/:id/{close,fire}`, `POST /cues`, `POST /events`,
`POST /cues/resolve` — in `src/api/intentions-routes.ts`, mounted by the server.

**Cognitive scripts → Phase 8 ✅ shipped (2026-08-08).** See below.

### 🎯 Phase 6 — Trusted memory & "Dreaming" ✅ shipped (2026-08-08)
> Approved plan in **[PHASE6_PLAN.md](./PHASE6_PLAN.md)**. Summary below.
> Drafted collaboratively by Kimi + Claude; history in PROPOSAL.md (git-ignored).

**Goal:** make the shared store *trustworthy* when several agents write to it,
and make it *learn across sessions* instead of only decaying trace by trace.

**6.0 — Trust layer: ✅ shipped.**
- [x] **6.0.3 first** — SessionStart injection hardening: `<humemory-untrusted>`
  wrapping, marker-escape defence, length caps (`src/core/sanitize.ts`)
- [x] **6.0.1** — Provenance migration: `source` / `agent` / `verified` /
  `verification_reason` / `device` / `refuted_count` on `memories` + `intentions`.
  Verification is **earned by evidence** (cross-agent corroboration via the
  dreamer, grounding in an explicitly-closed loop, cross-agent reuse in
  `recall(id, agent)`); trust score (`src/core/trust.ts`) separate from
  saillance; decay slowdown capped at 2.5× on the *product* of multipliers.
  `device` = `$HUMEMORY_DEVICE` || hostname — localization now, sync later.
- [x] **6.0.4** — `level_revisions` versions derived levels before merge
  overwrites them; `unmerge` reverts. Retention: last 5 per memory.
- [x] **6.0.2** — `contradictions`: loser saillance ÷4 (floor 5), excluded from
  context but searchable; tiered authority keyed on `verification_reason`;
  revocation recomputes saillance; CLI `contradict`, API `/contradicts`.

**6.1 — Dreaming: ✅ shipped** (`pnpm dream`, `src/core/dreamer.ts`). Clusters
recurring traces across sessions/agents (KeywordClusterer behind a `Clusterer`
interface — vectors are Phase 7), scores clusters on `base(source)` only,
writes **idempotent** `dream_proposals` (14-day expiry) reviewed via
`pnpm cli dream review` / `approve` / `reject`; API `GET /dreams`,
`POST /dreams/:id/approve|reject`. Nothing touches `memories` or `AGENTS.md`
without approval. Dream kinds: `promote_semantic`, `merge_cluster`,
`contradiction`, `close_stale_loop`, `update_agents_md` (suggestion only).

**6.2 — MCP server: ✅ shipped** (`pnpm mcp`, `src/mcp/server.ts`, stdio).
Tools `humemory_add / search / recall / intent_add / intent_close / dreams` —
Claude, Codex, Kimi, OpenCode share one store with agent attribution on every
write (`agent` arg or `$HUMEMORY_AGENT`; `HUMEMORY_DB` override for tests).

**Client registration** — the repo ships `.mcp.json` (Claude Code project
scope, `HUMEMORY_AGENT=claude`). For other agents, register the same server
with their own identity:

| Agent | Config | `HUMEMORY_AGENT` |
|-------|--------|------------------|
| Claude Code | `.mcp.json` at repo root (shipped) | `claude` |
| Kimi Code | same shape in the Kimi MCP config | `kimi` |
| Codex | same shape in the Codex MCP config | `codex` |
| OpenCode | `opencode.json` → `mcp` section | `opencode` |

Server entry: `bun run src/mcp/server.ts` (stdio). Every agent MUST set its
own `HUMEMORY_AGENT` — attribution is what powers cross-agent `reused`
verification and the dreamer's cross-agent recurrence signal.

### 🎯 Phase 8 — Cognitive scripts ✅ shipped (2026-08-08)
> Approved plan in **[PHASE8_PLAN.md](./PHASE8_PLAN.md)**. Drafted by Kimi, annotated
> and implemented (8.4/8.5, plus contradictions-target-scripts) by Claude after Kimi
> ran out of quota mid-phase. Dialogue log: [PHASE8_DIALOG.md](./PHASE8_DIALOG.md).

**Goal:** not "remember this fact" but "when this situation occurs, run this
drill" — a named, cue-triggered, versioned bundle of ordered steps, injected as
one block into the session context when its cue fires. Explicitly rejected
shapes: template (steps are data, not text interpolation), chained intentions
(a script has its own lifecycle, not a re-implementation of one on a model that
has none), permanent system prompt (fires on context, not every session), tool
bundle (scripts are markdown any CLI agent reads, humemory stays agent-agnostic).

- **8.1 — data model.** `scripts` table (draft/active/archived, fire-bumped
  saillance, `pinned` = photographic equivalent, same 6.0.1 provenance columns
  as intentions). `cues` rebuilt from `intention_id` to generic
  `target_kind`/`target_id` so one cue mechanism arms intentions or scripts —
  the project's first non-additive migration (SQLite table rebuild:
  create-new/copy/drop/rename, reused twice more below).
- **8.2 — injection.** One drill per context block max (two firing together is
  a smell, not a case to accommodate); tie-break on *effective* saillance
  (disuse included, not the raw value). Same 6.0.3 sandboxing as traces:
  human-authored renders bare, everything else wrapped in
  `<humemory-untrusted>`, escape-attempt telemetry on every render path.
- **8.3 — authoring & trust.** Three paths: human (`script add` → active
  directly), agent (`script propose` → draft, human activates), dreamer-mined
  (→ draft, see 8.5). Draft scripts never fire.
- **8.4 — disuse decay, the inverse Zeigarnik.** Scripts fade on *disuse*, not
  time: active + unfired 60 days → −10 saillance/month past the grace period;
  under 20 → auto-archived (searchable, never injected) with a `script_archived`
  dream-proposal notice so the archival is human-visible; firing resets the
  clock entirely; `pinned` scripts are exempt. **Correction kills the
  script:** `contradictions.loser_id` now targets a script as well as a memory
  (`loser_kind` column, same table-rebuild migration pattern as 8.1's cues) — a
  memory contradicting a script archives it outright (not a saillance
  collapse, that scale already means disuse) rather than proposal-gated
  (scripts carry no `verified` field to be asymmetric about). Revocation
  restores `active` but leaves cues cancelled — re-arming stays a deliberate
  human act.
- **8.5 — dreamer mining.** A `script_candidate` proposal kind: a "correction"
  is redefined as a trace that **won an active contradiction** (reusing 6.0.2
  rather than inventing a new tag) — cluster ≥2 corrections sharing a
  directory, draft steps from the raw content (oldest first, capped, no LLM),
  file as a proposal. Approval lands the script as `draft`, never `active` —
  same "reviewer saw a summary, not every word" caution already applied to
  `promote_semantic`.

CLI: `pnpm cli script {add,list,activate,archive,fire}`, `contradict` now
accepts a script id as the loser. API: `POST/GET /scripts`,
`POST /scripts/:id/{activate,archive,fire}`.

### 🛣️ Beyond
- Shared multi-project DB with concurrency lock (WAL + advisory) — done (Sprint 5 / S5-00a)
- **Phase 7: vector memory** ✅ shipped (2026-08-08) — `Embedder` interface +
  offline ONNX embeddings (bge-m3 q8 default, 1024 dims; e5-base/small via
  `--model`), `VectorClusterer` with per-model calibrated thresholds
  (`CLUSTER_THRESHOLDS`), hybrid RRF search (`search --semantic`),
  `embed backfill`, `dream run --window <days>`.
  **Calibration (7.5, 4 rounds — CLOSED):** no local lightweight embedder
  reaches a P=1.0 corroboration gate on 52 pairs incl. hard negatives
  (bge-m3 false max 0.908 > true min 0.691) → **vector auto-corroboration
  permanently disabled** (0.99 sentinel; keyword path keeps metadata-only
  corroboration). Best clusterer: bge-m3 @ 0.740 (F1 0.89). Default dream
  clusterer stays `keyword`, `vector` opt-in. Details:
  [PHASE7_PLAN.md](./PHASE7_PLAN.md), dialogue log
  [PHASE7_DIALOG.md](./PHASE7_DIALOG.md)
- Multi-device sync of the shared store (the `device` column from 6.0.1 makes
  it migration-free; conflict policy TBD)
- OpenCode / other-agent integration; export/import memories between projects

---

## 🐛 Known issues
- ~~SQLite multi-process: advisory lock~~ — fixed in Sprint 5 (S5-00a): WAL + write-queue (Sprint 4) plus file-based cross-process `AdvisoryLock`.
- ~~`tests/fixtures/` missing~~ — closed: `tests/fixtures/{memories,events,loops}.basic.json` +
  `tests/helpers/fixtures.ts` shipped with S5-00b. New Phase 6/7/8 suites still lean on inline
  literals for scenario-specific content (fine per [docs/TESTING.md](./docs/TESTING.md)'s own
  rule — a fixture is for shared corpora, not a one-off case a test is *about*).
- `vitest.config.ts` orphaned; suite runs under `bun test` (BUG-06).
- `tsc` global can shadow local — `pnpm build` is `tsc -p tsconfig.json`.

## 📝 Notes
- Shared DB: `data/humemory.db` · API port `3456` (`PORT` env)
- Stack: TypeScript · `bun:sqlite` · `flexsearch` · `hono` · `commander` · `@anthropic-ai/sdk`
- `CLAUDE.md` is a thin quick-start companion that points back to this file; this
  AGENTS.md remains the canonical source of truth for project vision and concepts.
