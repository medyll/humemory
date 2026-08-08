# AGENTS.md — humemory

**Memory for AI agents that forgets like a human — and resurfaces like one.**

Canonical guide for any agent (Claude Code, OpenCode, …) working *on* this repo.
For the project's identity and "why", read [README.md](./README.md) first.

---

## 🎯 Vision — two halves of a brain

humemory has two halves. The first is built. The second is the direction
(**Direction 1**, chosen 2026-06-17) that gives the project its purpose.

1. **Retrospective** ✅ — past learnings **decay** through 5 levels (detail → summary
   → essential → keywords → lost/merged); recall reinforces; inverse search hits the
   degraded layers first.
2. **Prospective** 🎯 — intentions that fire on a **cue** (time/event), **Zeigarnik**
   open loops that stay salient until a `commit` closes them, and context-triggered
   **scripts**. A memory that resurfaces *before* it is queried. See **Phase 5**.

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

**Cognitive scripts:** still underspecified (template? chained intentions?
system prompt? tool bundle?). Carried through Phase 6's Deferred list — spec
first, then code.

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

### 🛣️ Beyond
- Shared multi-project DB with concurrency lock (WAL + advisory) — done (Sprint 5 / S5-00a)
- Phase 7: vector/embedding clustering for the Dreamer (swap the `Clusterer`)
- Multi-device sync of the shared store (the `device` column from 6.0.1 makes
  it migration-free; conflict policy TBD)
- OpenCode / other-agent integration; export/import memories between projects

---

## 🐛 Known issues
- ~~SQLite multi-process: advisory lock~~ — fixed in Sprint 5 (S5-00a): WAL + write-queue (Sprint 4) plus file-based cross-process `AdvisoryLock`.
- `tests/fixtures/` missing — suites seed ad hoc literals (BUG-05, due with S5-00b).
- `vitest.config.ts` orphaned; suite runs under `bun test` (BUG-06).
- `tsc` global can shadow local — `pnpm build` is `tsc -p tsconfig.json`.

## 📝 Notes
- Shared DB: `data/humemory.db` · API port `3456` (`PORT` env)
- Stack: TypeScript · `bun:sqlite` · `flexsearch` · `hono` · `commander` · `@anthropic-ai/sdk`
- `CLAUDE.md` is a thin quick-start companion that points back to this file; this
  AGENTS.md remains the canonical source of truth for project vision and concepts.
