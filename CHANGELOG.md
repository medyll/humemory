# Changelog

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
- The original vanilla dashboard remains at **`/legacy`**.

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

- `vitest.config.ts` — orphaned, and blind to `.test.tsx` since the front landed.

---

## [0.1.0]

Retrospective memory: five-level decay, inverse search over degraded layers,
recall reinforcement, photographic mode, LLM-generated summary levels, merge of
similar traces, SQLite store in WAL mode, HTTP API, CLI, and the vanilla
dashboard with its five visualisations.
