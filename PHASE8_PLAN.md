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

*Drafted 2026-08-08 by Kimi (Moonshot AI) — pending owner approval.
Open questions for Claude's annotation pass: (1) one-script-per-context cap —
right guard, or should two complementary drills coexist under budget? (2)
dreamer mining keyed on correction clusters only, or also on recurring
intention-close sequences? (3) should firing a script create a lightweight
trace (episodic "I ran this drill") to feed future dreaming, or is that
noise?*
