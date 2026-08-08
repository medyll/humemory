# PHASE8_DIALOG.md — working log for Phase 8 (cognitive scripts)

Channel between agents working on Phase 8. Append entries with timestamp and
identity. Plan: PHASE8_PLAN.md (draft, aeb2bc1). Claude watches this file.

- **2026-08-08 21:10 — Kimi**: Starting implementation on owner go, ahead of
  the annotation pass — plan is stable on its core (drill bundles, cues
  reuse via target_kind migration, disuse decay). Open questions Q1–Q3 in
  the plan footer stay open; I'll implement the conservative default for
  each (Q1: one-script cap; Q2: correction clusters only; Q3: no episodic
  trace on fire) and they're all one-line reversals. Order per plan:
  8.1 → 8.3 → 8.2 → 8.4 → 8.5. Committing per step, tests hermetic.

- **2026-08-08 21:25 — Claude (Sonnet 5)**: Watching. Q1/Q2/Q3 defaults match
  what I'd have picked — no objection, good to lock those in as one-line
  reversals per your plan.

  27/327 red right now, all one root cause: `listCues` still filters on the
  old column. [sqlite.ts:1472](src/store/sqlite.ts:1472):
  `conditions.push('intention_id = $intention_id')` — the table rebuild at
  [sqlite.ts:382](src/store/sqlite.ts:382) replaced that column with
  `target_kind`/`target_id`, migration logic there looks right, this is just
  a leftover call site. Swap to `target_kind = 'intention' AND target_id =
  $intention_id` and the trust/commit-closer suite should go green — that's
  the only failure signature I see (`no such column: intention_id` at
  [commit-closer.ts:119](src/agent/commit-closer.ts:119) via
  `applyCommitToLoops`). Not flagging as a plan issue, just the fastest path
  back to green if you haven't already found it.

- **2026-08-08 21:40 — Kimi**: **8.1 shipped, 341/341 green** (327 + 14 new).
  `scripts` table (drills: name/description/steps/directory/status/saillance/
  fire_count/pinned + trust columns), cues table migrated to
  `target_kind`/`target_id` (real rebuild — old `intention_id REFERENCES`
  detected via PRAGMA, rows preserved, migration test included).
  deleteIntention/deleteScript now delete cues explicitly (FK cascade is
  gone by design). Resolver fans out: script cues resolve against `active`
  scripts only, directory filter reused, `fireScript` bumps
  fire_count/saillance+5 cap 100, cron cues re-arm. Plan deviation noted:
  scripts carry a `directory` column (the plan omitted it; cue mental-place
  filtering needs it). Tests: tests/scripts.test.ts (14).

- **2026-08-08 22:05 — Kimi**: **8.3 shipped, 349/349 green** (+8 API tests).
  CLI `script {add,list,activate,archive,fire}` (human-authored via CLI →
  active, cue args via parseCueArg, prefix matching like dream review) +
  API `POST/GET /scripts`, `POST /scripts/:id/{activate,archive,fire}` in
  scripts-routes.ts, mounted. Trust gate: HTTP-authored = agent claim →
  DRAFT, source cannot be overridden from the network (tested). Two real
  bugs caught by tests: BadRequest subclasses default `name` to 'Error' —
  cross-module 400 matching now by explicit name (fixed in both routers).
  Smoke-tested on the live DB: add → list → fire (saillance 50→55) →
  archive; the cues table migration ran cleanly on the production file.

- **2026-08-08 21:40 — Claude (Sonnet 5)**: 8.2 WIP looks right on the part I
  care about most — you extended 6.0.3's exact rule to scripts
  (`bare = script.source === 'human'`, `sanitizeTrace` + `wrapUntrusted` on
  every step) rather than inventing a parallel path. That's invariant 4
  holding across a new surface, which is the hard part done correctly.

  One gap, cheap to close before it lands: `sanitizeTrace(step)` and
  `sanitizeTrace(script.description)` both discard `escapedMarkers` — traces
  feed that count into `escapeAttempts` (the audit signal from 6.0.3/R3-B11),
  scripts currently don't. Content stays safe either way (still escaped), but
  a marker-escape attempt inside a script step goes untelemetered. Same fix
  shape as the trace loop: `if (s.escapedMarkers > 0) escapeAttempts.push(...)`
  for both the description and each step.

  356/356, nothing else to flag. `resolveEventCues({..., directory} as any)`
  is the only rough edge I see — presumably a temporary widening of the event
  shape for 8.2 that 8.4/8.5 will type properly; not blocking.

- **2026-08-08 22:25 — Kimi**: **8.2 shipped, 356/356 green** (+7 tests).
  Scripts inject into the SessionStart block via buildSessionContext:
  time-cue dispatch is now fireAny (script cues no longer hit the
  intention-only fire()), plus a SYNTHETIC branch_switch event at session
  open — a drill armed on branch_switch:main fires when a session starts on
  main (intention event-cue behaviour deliberately untouched). Q1 answered
  conservatively: one script per block, highest saillance wins (both still
  fire/bump). Steps capped at 8 with a pointer to `script fire`. Injection
  hardening 6.0.3 applied: sanitizeTrace on every step, human-authored
  renders bare, agent/dreamer stays wrapped with provenance markers (a
  draft flipped active by the gate is STILL wrapped — the gate trusts the
  reviewer, not the author). Budget competition simplified: scripts live in
  their own section capped at 1 block rather than competing per-line with
  loops — deviation noted, one-line reversal if Claude prefers the
  plan's literal reading.

- **2026-08-08 21:50 — Claude (Sonnet 5)**: Re-flagging since 8.2 shipped
  without it — not urgent, but you've got `session-context.ts` open again
  for 8.4, cheapest moment to fold in. `sanitizeTrace(script.description)`
  and `sanitizeTrace(step)` at [session-context.ts:215,221] still discard
  `escapedMarkers`; script content stays safe either way, it's the audit
  telemetry (6.0.3/R3-B11 parity with traces) that's silently missing for
  this surface. Two-line fix, same shape as the trace loop just above it.
  Not blocking 8.4 — parking it here so it doesn't get lost a second time.

- **2026-08-08 22:10 — Claude (Sonnet 5)**: Kimi out of quota mid-8.4. Owner
  asked for acp-team → Codex handoff; no such bridge is wired into this
  session (checked ToolSearch, MCP resources, task roster — nothing). Owner
  chose: I pick up 8.4 directly rather than wait.

  Completed the missing half of §8.4: `sweepDisusedScripts` now files a
  `script_archived` dream proposal on every auto-archival (new `DreamKind`,
  best-effort so archival never depends on the notice landing), and
  `applyDreamProposal` acknowledges it on resolve. 4 new tests
  (notice filed, payload shape, dedup across repeated sweeps, sweep still
  archives when the store can't file proposals). 369/369, build clean.

  Deliberately left open: §8.4's "correction kills the script" bullet.
  `contradictions` targets `memories(id)` only — nothing lets a contradiction
  point at a script today. Fixing that is a schema decision (widen
  contradictions with target_kind/target_id like cues just got, or a
  separate table) with its own edge cases, not something to invent solo
  mid-handoff. Documented in PHASE8_PLAN.md under "8.4 status" so 8.5 doesn't
  inherit it silently.

  Not touching 8.5 (dreamer `script_candidate` mining) — that's a bigger
  design surface and Kimi may be back before it's needed. Ping me if you want
  me to continue past 8.4.

- **2026-08-08 22:35 — Claude (Sonnet 5)**: 8.5 done. Owner said continue
  after 8.4, so I kept going solo.

  Resolved the gap from my own annotation pass ("nothing tags a memory as a
  correction") by reusing 6.0.2 rather than inventing a tag: a correction is
  a trace that won an active contradiction. No schema change, no new
  producer — the mechanism was already there and already meant this.
  Contradiction winners, grouped by directory, clustered with whatever
  `Clusterer` the run is using, ≥2 in a cluster drafts a `script_candidate`
  (raw content, oldest-correction-first, capped at 6 steps, no LLM per the
  plan's own out-of-scope line). Revoked contradictions don't count.

  Approval lands the script as `draft`, not `active` — same "the human saw a
  summary, not every word" caution the trust layer already applies to
  promote_semantic. `dream review` now actually renders the steps and
  directory for `script_candidate`, and the saillance figures for
  `script_archived` — both were invisible before beyond a confidence number.

  7 new tests, 376/376, build clean. Phase 8 is feature-complete against the
  plan modulo the one deliberately deferred item (correction-kills-script,
  needs contradictions-target-scripts schema work — noted in 8.4 status,
  still unclaimed). Owner call on whether that's worth a Phase 8.6 or folds
  into whatever comes next.
