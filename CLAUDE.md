# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For full project vision, concepts, API reference, and roadmap, see **[AGENTS.md](./AGENTS.md)** — that file is the canonical source of truth and is kept current; this file is a quick-start companion for it.

## Commands

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

Single test file: `bun test tests/humemory.test.ts` (other suites: `tests/agent.test.ts`, `tests/llm-generator.test.ts`)

Runtime is **bun**, not node — `bun:sqlite` is used directly in `src/store/sqlite.ts`, so `pnpm build`'s `tsc` output is not meant to run under plain `node`.

## Architecture

humemory has two halves, **both built** as of Phase 8 (2026-08-08):

1. **Retrospective memory** (✅ shipped) — past learnings are encoded then degrade through 5 levels (L0 full detail → L1 summary → L2 essential → L3 keywords → L4 lost/merged) on a human-forgetting curve. Recall reinforces a trace and slows its decay; `photographic: true` disables decay entirely. Inverse search (`src/core/search.ts`) queries degraded layers first (cheap BM25 over L3 keywords) and escalates to full content only on a match.
2. **Prospective memory** (✅ shipped, Phase 5) — intentions live in their own `intentions` table, not as a `MemoryType`. `src/core/cues.ts` resolves time and event cues; `src/agent/session-context.ts` composes the block injected at `SessionStart`. On top of both: a trust layer (Phase 6), vector recall (Phase 7) and cognitive scripts (Phase 8).

AGENTS.md is the canonical roadmap — check it before assuming a phase is unbuilt.

Data flow: `src/agent/session-parser.ts` parses a Claude Code session transcript → `src/agent/learning-extractor.ts` extracts decisions/bugs/solutions → `src/store/sqlite.ts` persists as `Memory` rows → `src/core/decay.ts` degrades them over time → `src/core/search.ts` retrieves them → `src/core/llm-generator.ts` auto-generates the L1/L2/L3 summaries via Claude Haiku (prompt-cached). `src/agent/claude-hook.ts` is wired to Claude Code's `Stop` hook (via `scripts/hook-session.ts`) so every dev session is auto-encoded into memory without manual calls.

`src/api/server.ts` (Hono) exposes this store over HTTP on port 3456 (`PORT` env) and serves the dashboard from `public/`. `src/cli/index.ts` (commander) is a thin CLI over the same store. `src/index.ts` is the library entry point re-exporting the core API.

## API security invariants — do not regress

Fixed in the 2026-08-18 audit pass (see SECURITY_AUDIT.md for the findings and their commits). Each of these is covered by a test; if one starts feeling inconvenient, change the test deliberately rather than the behaviour by accident:

- **Binds `127.0.0.1` by default.** `HUMEMORY_HOST` overrides it, but a non-loopback host without `HUMEMORY_API_TOKEN` makes the server refuse to start. Never pass a hostname-less `serve({ fetch, port })` — Node reads that as "every interface".
- **`HUMEMORY_API_TOKEN`, when set, gates every data route** (constant-time compare). Only `/health` and the static dashboard are public.
- **Untrusted content is fenced, not trusted.** Anything not `verified === true` with `verificationReason === 'human'` renders inside `<humemory-untrusted>` after `sanitizeTrace`. This holds for memories, intentions, script descriptions and steps, dreams and MCP output — the boundary is per-type, so a new content type needs its own wrapping *and* its own test.
- **No `innerHTML` with memory content.** Tooltips and labels are built with `createElement`/`textContent`; `web/viz/river.ts` is the cautionary tale.
- **Input is bounded at the edge** (`src/api/limits.ts`): body size, field lengths, collection sizes, and every numeric parameter through `boundedInt` — never a bare `parseInt`.
- **500s never carry internal detail.** Use `serverErrorBody()` from `src/api/errors.ts`; it logs the real error under a correlation id and returns only that id.
- **CORS compares whole origins** (`new URL().origin`), never substrings, and never answers `*` alongside `credentials: true`.

Field naming uses cognitive-neuroscience terms throughout the codebase (`saillance` = mnemonic strength, `currentLevel` = consolidation stage, `directory` = "lieu mental"/conceptual space, etc.) — see the full glossary table in AGENTS.md before renaming or reasoning about fields, the names are intentional, not legacy cruft.

## Testing constraints — non-negotiable

Full spec: **[docs/TESTING.md](./docs/TESTING.md)**. Every test run must be hermetic, deterministic, network-free:
- Never touch `data/humemory.db` — use an in-memory or temp-file `bun:sqlite` instance, torn down after each suite.
- Decay is time-driven — inject the clock as a parameter rather than calling `Date.now()` directly, so tests can fast-forward through L0→L4 transitions.
- `LLMClient` must be stubbed with deterministic fixtures in tests — no live Anthropic calls; CI runs with no `ANTHROPIC_API_KEY`.
- Seed memories from `tests/fixtures/`, not ad hoc literals.

This constraint exists because Phase 5 (prospective/Zeigarnik logic) is clock- and event-driven and cannot be trusted without a hermetic test env underneath it — don't relax it for convenience.

## Known issues

- SQLite multi-process: resolved. WAL + write-queue serialization (Sprint 4) plus a file-based cross-process advisory lock (`AdvisoryLock` in `src/store/sqlite.ts`, Sprint 5 / S5-00a).
- ~~`tests/fixtures/` missing~~ — closed (S5-00b): `tests/fixtures/*.json` + `tests/helpers/fixtures.ts`. Shared corpora belong there; a one-off case a test is specifically *about* stays inline, per [docs/TESTING.md](./docs/TESTING.md).
- ~~`vitest.config.ts` orphaned~~ — closed: the file is gone, the whole suite runs under `bun test`.
- A global `tsc` install can shadow the local one — always run `pnpm build` (which pins `tsc -p tsconfig.json`), not a bare `tsc`.
