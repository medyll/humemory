# Changelog

## [0.2.3] - 2026-08-17
**Features:**
- add Streamable HTTP transport and security hardening



## [0.2.2] - 2026-08-15
**Features:**
- add async multi-agent session capture



## [0.2.1] - 2026-08-09
**Features:**
- correction kills the script — contradictions target scripts too
- script_candidate dreamer mining from contradiction winners
- archival notice — script_archived dream proposal on disuse
- script injection into the SessionStart block
- script CLI + API with draft gate
- scripts table + cues target_kind migration + resolver fan-out
- round 4 — bge-m3 default, per-model cluster thresholds, calibration CLOSED
- --window <days> CLI flag + DreamOptions.windowDays override
- e5-base round 2 — corroboration re-enabled at 0.855, defaults flipped
- calibrate vector thresholds — cluster 0.855, vector corroboration disabled (e5-small overlap)
- vector memory — embedders, vector clusterer, hybrid search
- MCP server — one unified memory for every agent
- dreaming — cross-session consolidation with human gate
- contradictions — collapse without deletion
- version derived levels before merge overwrite + unmerge
- provenance & evidence-earned trust layer
- injection hardening on SessionStart re-injection
- serve the React app at /, keep the vanilla dashboard at /legacy
- replay, merge, encoding and advanced filters — parity reached
- port the dashboard views to React — wrapped, not rewritten
- prospective tab — loops, tension, cues, closure
- React shell — bun bundler, shared types, component tests
- post-commit hook — a commit closes the loop
- CLI intent commands + prospective HTTP routes
- SessionStart hook — inject open loops as context
- cue resolver — time cues, event cues, expiry
- prospective data model — intentions & cues tables
- autonomous test environment — clock seam + event bus
- add status snapshot for development phase and sprint progress
- implement cross-process advisory lock for SQLite (closes Bug #3)
- add internal script runner for bmad-method skill
- update README.md with usage instructions and examples; add three.js dependency
- consolidate documentation into README.md, add testing guidelines
- SQLite WAL mode, write queue serialization, build docs
- photographic badge, merge UI, filtres avancés
- photographic mode — désactiver dégradation pour traces critiques
- search enrichie — filtres type, date, saillance, recalls
- hook agent Claude Code — parse sessions, extraction apprentissages
- détection et fusion de souvenirs similaires
- auto-génération niveaux N1/N2/N3 via LLM

**Bug Fixes:**
- thread the fake clock into every runDreamer() call
- round 3 — hard negatives falsify the 0.855 gate, corroboration back OFF
- establish agent identity instead of accepting it
- implement corroboration, stop dream output rendering bare
- prevent path traversal in static handlers + land roadmap dashboard work
- update dev scripts to use bun and add mcp.json for context-mode
- migrate better-sqlite3 → bun:sqlite, fix build config

**Documentation:**
- re-flag escapedMarkers gap in script rendering — shipped in 8.2 unfixed
- note escapedMarkers not counted for script steps in 8.2 WIP
- note the leftover intention_id call site breaking the cues rebuild
- annotate the Phase 8 draft, answer Kimi's three open questions
- cognitive scripts spec — cue-triggered drill bundles, draft pending approval
- reply to round 4 — calibration closed, per-model thresholds are the right shape
- reply to round 3 — agree hard negatives need a stronger signal, not more fixture
- reply on the Phase 7 dialog log
- fix the sequencing row that still said embed-on-add
- integrate Claude's annotations A1-A5 into the plan
- annotate the Phase 7 draft against the tree at 8bd4d50
- Phase 7 draft plan — vector memory (embeddings)
- mark Phase 6 shipped in the roadmap (6.0.3 → 6.2)
- approve Phase 6 plan — trusted memory & dreaming

**Tests:**
- attribute-injection defence on the untrusted marker

**Chores:**
- ship .mcp.json + per-agent MCP registration table
- untrack .claude/settings.local.json (local file)
- gitignore PROPOSAL.md (agent collaboration draft)
- MIT license, and the whole codebase in English
- remove the vanilla dashboard
- prepare the 0.2.0 release
- clear the tracked debt — testable routes, hermetic suites
- resync status with actual code state
- record 37/37 test pass after bun install — QA-02 resolved
- status Sprint 3 UX done — 98% progress
- status Sprint 2 completed — 37/37 tests, 95% progress
- init bmad-method with project status, bugs, roadmap

**CI/CD:**
- add GitHub Actions CI + release workflows

**Other:**
- docs+fix: close the three gaps between the code and its own record
- Refactor TracesTab and related components for improved clarity and consistency
- audit: fix 3 critical issues
- init: initial commit



Notable changes to humemory. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions are pre-1.0, so minor bumps carry breaking changes when they need to.

## [0.2.0] — 2026-07-31

The release where the second half of the brain arrives. humemory no longer only
remembers what happened; it resurfaces what you left unfinished.

### Added — prospective memory (Phase 5)

- **Intentions and cues.** An open loop is stored as an `intention` with one or
  more `cues` that wake it — a date, a cron expression, or an event
  (`file_open`, `branch_switch`, `error_pattern`). Tables are created idempotently,
  so an existing database migrates on next open.
- **Cue resolver** (`src/core/cues.ts`) — `resolveTimeCues`, `resolveEventCues`,
  `fire`, `expireStale`. Cron matching is in-house (no dependency added) and
  carries a seven-day catch-up window, because the resolver runs at session start
  rather than as a daemon.
- **Decay rules for intentions.** `armed` stays pinned at salience 100 — an open
  loop does not fade. Once `fired` and not `closed`, it relaxes ten points a day
  as the Zeigarnik pull weakens. `closed` and `expired` sit flat.
- **`SessionStart` hook** (`scripts/hook-session-start.ts`) — writes a markdown
  block on stdout with the open loops and the decayed-but-still-salient traces of
  the current project, which Claude Code injects into the session. Nothing
  relevant means nothing written.
- **`post-commit` hook** (`.githooks/post-commit`) — `Closes loop-a1b2c3d4` in a
  commit message closes that loop, records the SHA and cancels its cues.
  File-overlap scoring only ever *suggests*; it never closes on a guess.
- **CLI** `intent add|list|close|fire|resolve`, with cues typed as
  `event:file_open:src/a.ts`, `cron:0 9 * * 1`, `time:<ISO>`.
- **HTTP** `POST/GET /intentions`, `GET /intentions/:id`,
  `POST /intentions/:id/{close,fire}`, `DELETE /intentions/:id`, `POST/GET /cues`,
  `POST /events`, `POST /cues/resolve`. Payloads are validated: a malformed
  trigger is rejected rather than stored as a cue that never fires.

### Added — React front end

- A React app served at **`/`** (and `/app`), bundled by bun itself — no
  additional build tooling. Six tabs: loops, traces, river, galaxy, replay,
  promenade.
- Front-end types are imported from `src/core/types.ts`; the salience of a loop
  comes from `intentionSaillance`, the same function the backend uses. Nothing is
  reimplemented on the client.
- Visualisations are code-split and loaded on demand — three.js alone is half a
  megabyte.
- The original vanilla dashboard is removed once the React front reached parity;
  `/css/*`, `/js/*` and `/assets/*` go with it, shrinking the static surface.

### Added — test environment

- `Clock` seam (`systemClock` / `FakeClock`) threaded through the store and the
  search engine, so decay transitions are asserted without waiting.
- `InMemoryEventBus` with awaited dispatch — a test never needs a `setTimeout`.
- `tests/helpers/` and `tests/fixtures/`; component tests run under `bun test`
  with happy-dom, so there is one runner for the whole project.
- A guard that throws if a test opens the production database.

### Fixed

- Cross-process SQLite advisory lock (closes the long-standing Bug #3).
- `PRAGMA foreign_keys=ON` — without it the `ON DELETE CASCADE` from cues to
  intentions was decorative and left orphans behind.
- Mental places are resolved to absolute paths on write. A loop armed on
  `./src/auth` would never have matched the hook, which looks projects up by
  `process.cwd()` — a silent failure.
- `promenade` attached five listeners to `document`/`window` and removed none;
  switching tabs left the keyboard driving an invisible camera. `river` kept its
  playback interval running and abandoned its tooltip in the body.
- The forgetting curve was implemented twice — once in `src/core/decay.ts`, once
  in `public/js/decay.js`. The React path uses the former only.
- The published CLI was broken under node: `bin/humemory.js` declared a node
  shebang while the store imports `bun:sqlite`. It now targets bun and explains
  itself if run under node.
- The CLI version was hard-coded and had drifted; it is read from `package.json`.
- Path traversal in the static handlers (CWE-22), fixed with a containment guard
  that the React routes reuse.

### Changed

- `HUMEMORY_DB` is honoured by the API, the CLI and both hooks alike.
- `server.ts` shrank from 469 to 217 lines; routes live in `memory-routes.ts` and
  `intentions-routes.ts`, each taking its store as a parameter and therefore
  testable.
- `pnpm build` now builds the library and the front end.

### Removed

- The vanilla dashboard (`public/index.html`, `public/js/*`, `public/css/*`) and
  the static routes that served it. `public/session.html` stays — it is a
  separate, self-contained page.
- `vitest.config.ts` — orphaned, and blind to `.test.tsx` since the front landed.

---

## [0.1.0]

Retrospective memory: five-level decay, inverse search over degraded layers,
recall reinforcement, photographic mode, LLM-generated summary levels, merge of
similar traces, SQLite store in WAL mode, HTTP API, CLI, and the vanilla
dashboard with its five visualisations.
