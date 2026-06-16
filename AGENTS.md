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

The conceptual source for the prospective half is `SCRATCHPAD.md` (mémoire
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
│   └── claude-hook.ts        # Stop-hook → auto-encode session learnings
├── api/server.ts         # Hono HTTP API + serves public/ dashboard
├── cli/index.ts          # commander CLI
└── index.ts              # library exports
scripts/hook-session.ts   # bun script wired to Claude Code Stop hook
tests/                    # bun test (agent / humemory / llm-generator)
data/humemory.db          # shared DB (created on first run)
```

---

## 🧠 Concepts (cognitive-neuroscience naming)

| Field | Human term | Meaning |
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
> Code later. This section is the spec, not yet built.

- [ ] **`intention` memory type** — a trace that holds a *to-do-on-cue*, not a fact.
- [ ] **Cue table** — `{ kind: 'time' | 'event', trigger, intentionId }`. Time cues
      ("Wednesday 9am"), event cues (open file X, branch Y, error pattern Z).
- [ ] **`SessionStart` hook** — on session open, resolve cues for the current
      dir/branch + decayed-but-relevant traces, inject as session context
      ("yesterday you left *refactor fn X* open").
- [ ] **Zeigarnik open loops** — an unclosed loop stays salient (decay paused/boosted)
      until closed; **`git commit` closes linked loops** and purges them.
- [ ] **Cognitive scripts** — context-triggered routine bundles, pre-loaded on cue.

### 🛣️ Beyond
- Shared multi-project DB with concurrency lock (WAL + advisory) — in progress
- OpenCode / other-agent integration; export/import memories between projects

---

## 🐛 Known issues
- SQLite multi-process: WAL + write-queue added (Sprint 4); advisory lock still open.
- `tsc` global can shadow local — `pnpm build` is `tsc -p tsconfig.json`.

## 📝 Notes
- Shared DB: `data/humemory.db` · API port `3456` (`PORT` env)
- Stack: TypeScript · `bun:sqlite` · `flexsearch` · `hono` · `commander` · `@anthropic-ai/sdk`
- `CLAUDE.md` (Claude Code guidance) was removed from the tree; restore from git
  history if needed — this AGENTS.md is now the single source of truth.
