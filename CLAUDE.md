# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

For full project vision, concepts, API reference, and roadmap, see **[AGENTS.md](./AGENTS.md)** — that file is the canonical source of truth and is kept current; this file is a quick-start companion for it.

## Commands

```bash
pnpm install
pnpm build          # backend tsc + web typecheck + web bundle
pnpm dev            # watch src/cli/index.ts (bun)
pnpm start:api      # HTTP API + dashboard on :3456
pnpm cli <cmd>      # run CLI directly
pnpm test           # bun test, single pass
pnpm test:watch     # bun test --watch
pnpm consolidate    # manual decay pass (cron-friendly)
pnpm cli doctor     # diagnose an installation (paths, rights, schema, locks, entry points)
pnpm verify:package # pack + install outside the checkout, then drive every entry point
pnpm measure:recall # cognitive-quality report (frozen corpus; gate in tests/relevance.test.ts)
pnpm bench:scale    # cost at scale: cold open, index rebuild, decay sweep vs corpus size
```

Single test file: `bun test tests/humemory.test.ts` (other suites: `tests/agent.test.ts`, `tests/llm-generator.test.ts`)

Runtime is **bun**, not node — `bun:sqlite` is used directly in `src/store/sqlite.ts`, so `pnpm build`'s `tsc` output is not meant to run under plain `node`.

## Architecture

humemory has two halves, **both built** as of Phase 8 (2026-08-08):

1. **Retrospective memory** (✅ shipped) — five states are modeled (L0 detail → L1 summary → L2 essential → L3 keywords → L4 lost/merged), but automatic aging currently stops at L3; explicit merge sets L4. Original content remains stored and searchable. Recall reinforces a trace and slows its decay; `photographic: true` returns L0. Inverse search (`src/core/search.ts`) visits degraded fields first, collects matches across fields and ranks them. See [the architecture guide](docs/architecture/architecture.html).
2. **Prospective memory** (✅ shipped, Phase 5) — intentions live in their own `intentions` table, not as a `MemoryType`. `src/core/cues.ts` resolves time and event cues; `src/agent/session-context.ts` composes the block injected at `SessionStart`. On top of both: a trust layer (Phase 6), vector recall (Phase 7) and cognitive scripts (Phase 8).

AGENTS.md is the canonical roadmap — check it before assuming a phase is unbuilt.

Data flow: `scripts/hook-session.ts` queues the raw Claude Code transcript and exits → maintenance parses it and extracts decisions/bugs/solutions → derived L1/L2/L3 text is generated deterministically (an injected LLM may enhance it) → `src/store/sqlite.ts` persists the traces. A separate decay sweep updates their current level; search retrieves them and explicit recall reinforces them. Worker-side encoding lives in `src/agent/claude-hook.ts`.

`src/api/server.ts` (Hono) exposes this store over HTTP on port 3456 (`PORT` env) and serves the dashboard from `public/`. `src/cli/index.ts` (commander) is a thin CLI over the same store. `src/index.ts` is the library entry point re-exporting the core API.

## API security invariants — do not regress

Fixed in the 2026-08-18 audit pass (see SECURITY_AUDIT.md for the findings and their commits). Each of these is covered by a test; if one starts feeling inconvenient, change the test deliberately rather than the behaviour by accident:

- **Binds `127.0.0.1` by default.** `HUMEMORY_HOST` overrides it, but a non-loopback host without `HUMEMORY_API_TOKEN` makes the server refuse to start. Never pass a hostname-less `serve({ fetch, port })` — Node reads that as "every interface".
- **`HUMEMORY_API_TOKEN`, when set, gates every data route** (constant-time compare). Only `/health` and the static dashboard are public.
- **Context content is fenced by provenance.** Memories and intentions without `verified === true` and `verificationReason === 'human'` render inside `<humemory-untrusted>` after `sanitizeTrace`. Script descriptions and steps use `source === 'human'` for their exception. MCP trace output is sanitized and labeled with provenance; it does not use the SessionStart wrapper. Preserve each output path's boundary and its tests.
- **No `innerHTML` with memory content.** Tooltips and labels are built with `createElement`/`textContent`; `web/viz/river.ts` is the cautionary tale.
- **Input is bounded at the edge** (`src/api/limits.ts`): body size, field lengths, collection sizes, and every numeric parameter through `boundedInt` — never a bare `parseInt`.
- **500s never carry internal detail.** Use `serverErrorBody()` from `src/api/errors.ts`; it logs the real error under a correlation id and returns only that id.
- **CORS compares whole origins** (`new URL().origin`), never substrings, and never answers `*` alongside `credentials: true`.

Field naming uses cognitive-neuroscience terms throughout the codebase (`saillance` = mnemonic strength, `currentLevel` = consolidation stage, `directory` = "lieu mental"/conceptual space, etc.) — see the full glossary table in AGENTS.md before renaming or reasoning about fields, the names are intentional, not legacy cruft.

## Testing constraints — non-negotiable

Full spec: **[docs/TESTING.md](./docs/TESTING.md)**. Every test run must be hermetic, deterministic, network-free:
- Never touch `data/humemory.db` — use an in-memory or temp-file `bun:sqlite` instance, torn down after each suite.
- Decay is time-driven — inject the clock as a parameter rather than calling `Date.now()` directly, so tests can fast-forward through automatic L0→L3; L4 is tested as an explicit merge state.
- `LLMClient` must be stubbed with deterministic fixtures in tests — no live Anthropic calls; CI runs with no `ANTHROPIC_API_KEY`.
- Seed memories from `tests/fixtures/`, not ad hoc literals.

This constraint exists because Phase 5 (prospective/Zeigarnik logic) is clock- and event-driven and cannot be trusted without a hermetic test env underneath it — don't relax it for convenience.

## Known issues

- SQLite multi-process: resolved. WAL + write-queue serialization (Sprint 4) plus a file-based cross-process advisory lock (`AdvisoryLock` in `src/store/sqlite.ts`, Sprint 5 / S5-00a).
- ~~`tests/fixtures/` missing~~ — closed (S5-00b): `tests/fixtures/*.json` + `tests/helpers/fixtures.ts`. Shared corpora belong there; a one-off case a test is specifically *about* stays inline, per [docs/TESTING.md](./docs/TESTING.md).
- ~~`vitest.config.ts` orphaned~~ — closed: the file is gone, the whole suite runs under `bun test`.
- A global `tsc` install can shadow the local one — always run `pnpm build` (which pins `tsc -p tsconfig.json`), not a bare `tsc`.
