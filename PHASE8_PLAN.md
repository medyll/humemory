# Phase 8 — Cognitive scripts ("l'automatisation du contexte")

> **Draft, pending owner approval.** Source of truth for the Phase 8 scope once
> approved; AGENTS.md summarizes it. Conceptual source: `SCRATCHPAD.md` §2
> (Schank & Abelson, 1977) — pre-loaded procedural blocks that fire on context
> instead of being re-derived each time.
>
> Phase 5 made memory *resurface* (intentions + cues + Zeigarnik). Phase 6 made
> it *trustworthy*. Phase 7 made it *vector-searchable*. Phase 8 makes it
> *procedural*: not "remember this fact", but "when this situation occurs, run
> this drill".

---

## 🎯 Goal

Answer the question AGENTS.md has carried since Phase 5 as underspecified:
**template? chained intentions? system prompt? tool bundle?** — by picking one
shape and rejecting the others explicitly.

**Chosen shape: a script is a named, cue-triggered, versioned bundle of
ordered steps (a drill), injected as a single block into the session context
when its cue fires.**

- NOT a template: steps are data, not text interpolation.
- NOT chained intentions: an intention is one marker ("pense à X"); a script
  is an ordered procedure ("fais A, puis B, puis vérifie C") with its own
  lifecycle. Chaining intentions would re-implement ordering, completion and
  budgeting on a model that has none.
- NOT a system prompt: scripts fire on *context* (cue), not on every session;
  a permanent prompt re-introduces the Niveau-1 bloat the video's progressive
  disclosure principle warns against.
- NOT a tool bundle: humemory stays agent-agnostic; scripts are markdown
  instructions any CLI agent can read, not executable tool wiring.

The butcher's "Livraison" script (libérer le crochet → vérifier le bon →
peser) is the canonical example: the idea does not occupy consciousness, it
unfolds as a program when the cue ("mercredi matin", i.e. `file_open` /
`branch_switch` / cron) fires.

---

## 🧱 Data model (8.1)

One new table, mirroring `intentions` but procedural:

```sql
CREATE TABLE scripts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                  -- 'livraison', 'release-check', ...
  description TEXT NOT NULL,           -- one line, shown in context header
  steps TEXT NOT NULL,                 -- JSON array of ordered step strings
  status TEXT NOT NULL DEFAULT 'draft',-- draft | active | archived
  saillance REAL NOT NULL DEFAULT 50,  -- drills fade when unused (see 8.4)
  fire_count INTEGER NOT NULL DEFAULT 0,
  last_fired_at INTEGER,
  source TEXT NOT NULL,                -- 'human' | 'dreamer' | agent id
  device TEXT NOT NULL DEFAULT 'local',-- 6.0.1 locality, forward-compat
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

**Cues are reused, not duplicated — but that reuse costs one migration.**
Today `cues.intention_id` is `NOT NULL REFERENCES intentions(id)`
([sqlite.ts:381](src/store/sqlite.ts:381)). Phase 8 rebuilds the table with a
generic target: `target_kind TEXT NOT NULL CHECK (target_kind IN
('intention','script'))` + `target_id TEXT NOT NULL` (SQLite table rebuild:
create-new / copy / drop / rename, the same migration style as 6.0.x).
`resolveTimeCues` / `resolveEventCues` from 5.2 then fan out by
`target_kind`; the cron matcher and loop-id logic are untouched.

**Steps are plain strings, not structured actions.** Execution stays with the
reading agent; humemory stores the drill, not a runtime. (Rationale: every
attempt to make steps executable re-opens the tool-bundle shape we rejected,
plus a sandboxing problem Phase 6's injection hardening explicitly avoids.)

---

## 🔥 Trigger & injection (8.2)

- `scripts/hook-session-start.ts` resolves script cues alongside intention
  cues for the current `cwd` + `git branch`.
- A fired script renders as ONE block in the session context, under the open
  loops, inside the SAME budget (`HUMEMORY_SESSION_BUDGET`) — scripts and
  loops compete for lines, ordered by saillance:

```markdown
## 🔁 Script: release-check (fired 12×, last 3d ago)
> Vérifier le bon avant de peser.
1. `pnpm build` must pass with no tsc error
2. `NODE_ENV=test bun test` — 327/327 expected
3. Check `git status` is clean before tagging
```

- Firing bumps `fire_count` and `last_fired_at`, and nudges saillance up
  (+5, capped 100) — a drill that is used stays sharp.
- **One script per context block max.** Two scripts firing in the same session
  is a smell (cues too broad); the higher-saillance one wins, the other is
  logged as `skipped` for the dreamer to see.

---

## ✍️ Authoring & trust (8.3)

Three authoring paths, all gated by Phase 6 trust:

1. **Human** — `pnpm cli script add` writes `status: 'active'` directly
   (human source = trusted, same rule as verified traces).
2. **Agent** — an agent that just succeeded at a repeatable drill may
   `script propose`; it lands as `status: 'draft'`, human activates.
3. **Dreamer-mined** — the dreamer already detects "11 of 15 agents fail on
   the same test command". Phase 8 adds a second proposal kind:
   `script_candidate` — when a cluster of *corrections* shares the same
   resolution steps, the dreamer drafts a script and files it as a dream
   proposal (same human gate, same 14-day TTL, same payload-hash dedupe).

Draft scripts never fire. Only `active` scripts resolve through cues.

---

## 🌫️ Decay & lifecycle (8.4) — the inverse Zeigarnik

Scripts decay on **disuse**, not on time alone (unlike traces):

- `active` and never fired for 60 days → saillance −10/month sweep.
- Saillance < 20 → auto-`archived` (searchable, never injected) with a
  dream-proposal notice, so the archival is human-visible.
- Firing resets the disuse clock entirely — a weekly drill never decays.
- Human-pinned scripts (`photographic` equivalent: `pinned: true`) are exempt.
- **Correction kills the script**: if a dream contradiction shows a drill's
  steps are wrong (e.g. the test command changed), the script is archived and
  its *correction* can seed a new draft — scripts are habits, and wrong
  habits are worse than no habits (video Niveau-2 error-amplification risk,
  Phase 6 gap #2).

---

## 🖥️ CLI / API surface (8.5)

```
pnpm cli script add <name> --steps "a" "b" "c" --cue event:branch_switch:main
pnpm cli script list [--status draft|active|archived]
pnpm cli script activate <id>   # draft → active (human gate)
pnpm cli script archive <id>
pnpm cli script fire <id>       # manual fire (testing + saillance bump)
```

API (mounted like `intentions-routes.ts`): `POST /scripts`, `GET /scripts`,
`POST /scripts/:id/{activate,archive,fire}`, cues via existing `POST /cues`
with `target_kind: 'script'`.

---

## 🧪 Testing (8.6) — same hermetic constraints

- In-memory store, FakeClock, InMemoryEventBus — no new infrastructure.
- Cue resolution: script cues fire on the same event fixtures as intentions.
- Budget competition: loops vs scripts ordering is deterministic (saillance,
  then `last_fired_at` NULLS first).
- Disuse decay: fast-forward 60/120 days, assert saillance steps and archival.
- Dreamer mining: seed a correction cluster fixture, assert a
  `script_candidate` proposal is filed and deduped on re-run.
- No model, no network: script features are vector-free by design.

---

## 🚫 Out of scope

- Executable steps / tool wiring (rejected shape, see Goal).
- Multi-agent script *negotiation* (two agents editing the same drill):
  last-writer-wins + `updated_at`, like intentions today.
- Cross-device sync of scripts — the `device` column makes it migration-free
  when multi-device sync lands (Beyond roadmap).
- Natural-language step generation via LLM — the dreamer drafts from raw
  cluster text; LLM drafting (6.x pattern) can be added later behind the
  same `draft?` seam.

---

## 📦 Step breakdown

| Step | Scope | Depends on |
|------|-------|-----------|
| 8.1 | `scripts` table + store CRUD + `target_kind='script'` in cues | 5.1, 6.0.1 |
| 8.2 | SessionStart injection + budget competition + fire bump | 8.1, 5.3 |
| 8.3 | CLI/API + draft→active gate | 8.1 |
| 8.4 | Disuse decay sweep + archival notice + pinned exemption | 8.1, 6.2 |
| 8.5 | Dreamer `script_candidate` mining from correction clusters | 8.3, 6.2, 7.x |

Ordered: 8.1 → 8.3 → 8.2 → 8.4 → 8.5 (CLI before injection so drills can be
seeded and inspected before they start consuming context budget).

---

## 💬 Annotations — Claude (2026-08-08)

Shape is right, and rejecting the other three shapes explicitly (rather than
leaving "template? chained intentions? tool bundle?" open) is what makes 8.1
implementable without re-litigating it mid-step. Answers to the three
questions, then two things verified against the tree.

### Q1 — one script per context block: agreed, keep the cap

Two complementary drills sound appealing but the cap is doing real work: it's
the same "nothing wraps unless a human looks at it" instinct as 6.0.3, applied
to budget instead of trust. Two scripts firing together is evidence the cues
are too broad — that's a signal worth keeping visible (the `skipped` log),
not a case worth accommodating. If it turns out two drills genuinely
co-occur often, that's a dreamer proposal to *merge* them into one script,
not a reason to spend budget on both every time.

### Q2 — dreamer mining: correction clusters only, for now

Recurring intention-close sequences are a real pattern, but they're a
different shape of evidence — "these loops close in the same order" says
nothing about *what steps* closed them, and a script needs steps, not just an
ordering. Keying 8.5 on correction clusters is the case where the dreamer
already has drafted text to work from (the correction's resolution). Add
intention-close mining as its own dream-proposal kind later if it turns out
to carry drill-shaped content — don't force one mining strategy to serve two
different signals.

### Q3 — firing creates a trace: no, and here's the reason that matters

Noise is the shallow objection; the real one is Phase 6.1's R1 invariant.
`corroborates()` scores a cluster on agent/session/directory diversity. A
script fired identically by the same agent across many sessions would look
exactly like the cross-agent, cross-session recurrence the dreamer treats as
evidence — except it's one drill executing on schedule, not independent
agents converging on a fact. Logging fires as memory traces would hand the
corroboration path a way to manufacture its own evidence: run the drill
enough times, get a verified trace for free. If usage data is wanted later,
log it to `scripts.fire_count`/`last_fired_at` only (already in 8.1) — never
into the `memories` table, which is the one surface R1 depends on staying
uncontaminated.

### Verified against the tree

- §8.1's cues claim checks out: `intention_id TEXT NOT NULL REFERENCES
  intentions(id)` at [sqlite.ts:381](src/store/sqlite.ts:381), so the
  `target_kind`/`target_id` rebuild is real work, not a formality — and it's
  worth naming explicitly that this is the **first non-additive migration**
  in the project. Every Phase 6 migration was a bare `ALTER TABLE` in
  `try/catch`; a SQLite table rebuild (create-new/copy/drop/rename) is a
  different risk class — one bad copy step and cue history is gone. Test it
  against a populated fixture DB (armed + fired + closed cues, not just
  empty), and take a `data/humemory.db` backup convention seriously before
  this ships, even though tests never touch that file.

- §8.3's premise — "the dreamer already detects '11 of 15 agents fail on the
  same test command'" — is aspirational, not current. Nothing in the
  codebase tags a memory or a cluster as a *correction*; the dreamer clusters
  on similarity alone (`corroborates`/`qualifies` in
  [dreamer.ts](src/core/dreamer.ts) don't distinguish a bug-fix trace from
  any other). 8.5 needs that tag to exist before "cluster of corrections"
  means anything — either a `memoryType` value, a convention in the
  learning-extractor's output, or a new field. Worth resolving in 8.5's own
  design rather than assuming the capability is already there.

---

*Drafted 2026-08-08 by Kimi (Moonshot AI) — pending owner approval.
Open questions for Claude's annotation pass: (1) one-script-per-context cap —
right guard, or should two complementary drills coexist under budget? (2)
dreamer mining keyed on correction clusters only, or also on recurring
intention-close sequences? (3) should firing a script create a lightweight
trace (episodic "I ran this drill") to feed future dreaming, or is that
noise?*
*Annotated 2026-08-08 by Claude (Sonnet 5): agreed Q1/Q2, Q3 answered no on
an R1 self-corroboration risk rather than just noise; flagged the cues
rebuild as the project's first non-additive migration, and that 8.5's
"correction cluster" has no tag to key on yet.*

## 🚧 8.4 status — Claude (Sonnet 5), 2026-08-08 22:10

Kimi lost quota mid-8.4; owner asked me to pick it up (no acp-team/Codex
bridge available in this session — see PHASE8_DIALOG.md). Landed:

- Disuse decay math + sweep (`scripts.ts`, already Kimi's) — unchanged.
- **Archival notice**, the missing half of §8.4's bullet 2: `sweepDisusedScripts`
  now files a `script_archived` dream proposal (new `DreamKind`) alongside
  every auto-archival, best-effort on `fileDreamProposal` so the archival
  itself never depends on the notice succeeding. `applyDreamProposal` gained
  the matching case — an acknowledgment, since the archival already happened
  by the time a human resolves it. 4 new tests.

**Deliberately NOT implemented — §8.4 bullet 5, "correction kills the
script":** the plan says a dream contradiction against a drill's steps
should archive it. But `contradictions.winner_id`/`loser_id` are
`REFERENCES memories(id)` — scripts aren't memories, so nothing today lets a
contradiction *target* a script. Building that means either (a) widening
`contradictions` with the same `target_kind`/`target_id` shape the cues
table just got in 8.1, or (b) a separate `script_corrections` table. Both are
schema decisions with their own edge cases (cycles, revocation — see 6.0.2),
not a two-line addition, and inventing one solo without a second pass felt
like exactly the kind of unreviewed architectural leap this project's own
process (Phase 6/7 dialog) exists to avoid. Left as an explicit gap rather
than a silent one; whoever picks up 8.5 needs to resolve it before "a
correction can seed a new draft" means anything.

369/369, build clean.

## 🌙 8.5 status — Claude (Sonnet 5), 2026-08-08 22:35

Implemented `script_candidate` dreamer mining, closing the "no correction tag
exists" gap flagged in the annotation pass above, without inventing one:

**"Correction" = a trace that WON an active contradiction.** 6.0.2 already
establishes that as evidence a prior trace was wrong; reusing it needs no
schema change and no new producer. Traces that win a contradiction, within
the dream window, are grouped by `directory` (a script has exactly one), then
clustered with the same `Clusterer` passed to `runDreamer` — keyword or
vector, whichever the run already uses. A cluster of ≥2 corrections
(`scriptCandidateMinCluster`) sharing a directory drafts steps from the raw
correction content (oldest win first), caps at 6 steps, and files a
`script_candidate` proposal — same idempotent payload-hash dedupe as every
other kind, no LLM drafting (explicitly out of scope in the plan).

Revoked contradictions don't count (`listContradictions({ status: 'active' })`
only) — a correction that was itself walked back is not evidence of a
pattern. Approving the proposal creates the script as **`draft`**, never
`active`: the human saw a description + step list in `dream review`, same
"proposal review ≠ having read every word" caution already applied to
`promote_semantic` (source `dream_proposal`, not `human`). `script activate`
is still a separate, deliberate step.

`dream run`/`dream review` render the new kind: step list, directory, and
(for `script_archived`) the saillance figures — previously invisible in
review beyond confidence and a truncated sample.

7 new tests (fires on ≥2, not on 1, directories don't combine, idempotent,
revoked contradiction excluded, approval lands as draft, mining never
mutates memories/scripts on its own). 376/376, build clean.

Phase 8 is now feature-complete against the plan except the explicitly
deferred "correction kills the script" bullet (needs a schema decision on
contradictions targeting scripts — see 8.4 status above).

## ✅ "Correction kills the script" — Claude (Sonnet 5), 2026-08-08 23:00

Owner said go ahead on the deferred item. Made the schema decision:
`contradictions.loser_id` now points at a memory **or** a script
(`loser_kind` column, `'memory' | 'script'`, defaults to `'memory'` on old
rows). `winner_id` stays memory-only — nothing in the domain corrects a fact
*into* becoming a script.

**Migration**: same create-new/copy/drop/rename rebuild Kimi used for `cues`
in 8.1 (SQLite can't drop a FK via `ALTER TABLE`, and `loser_id` can no
longer carry a single-table `REFERENCES` once it may point at either table).
Verified by hand against a seeded old-schema DB: table rebuilds, the
existing row survives with `loser_kind='memory'`, ids intact.

**Behavior when the loser is a script**, in `contradictScript()`
(`sqlite.ts`): archives it outright (`updateScriptStatus(…, 'archived')`,
which already cancels its armed cues) rather than collapsing saillance —
"wrong" and "unused" are different failure modes with the same cure (stop
injecting it), but a script's saillance already means disuse (8.4's sweep);
collapsing it the way a memory's saillance collapses would confuse two
scales. No asymmetric-authority gate: that gate protects a `verified`
memory from an unverified challenger, and `Script` carries no
`verified`/`verificationReason` field — nothing to be asymmetric about. If
scripts grow a verification concept later, this is where the gate goes.

Reuses the `script_archived` notice (not a new kind) — `payload.reason:
'disuse' | 'contradiction'` distinguishes the two archival paths in both
`dream review` and the acknowledgment text, since a human reviews them
identically either way. Contradicting an already-archived script still
records the contradiction (audit trail) but files no second notice.

**Revocation** restores `status: 'active'` but leaves the script's cues
`cancelled` — re-arming wake-ups is a deliberate act a human takes
explicitly, matching the existing rule that revocation restores the trust
judgment, not the automation wiring, and that archival-by-disuse doesn't
auto-restore cues either.

`pnpm cli contradict` and `dream review` render both shapes. 8 new tests:
archives (not collapses), cancels cues, files the notice with the right
reason, no authority gate, double-contradiction doesn't duplicate the
notice, revoke leaves cues cancelled, memory-loser path unaffected
(loserKind defaults correctly), nonexistent id in neither table throws.
384/384, build clean, manually verified against a seeded pre-migration DB.

Phase 8 is now complete against PHASE8_PLAN.md in full — no deferred items
remain.
