# ROADMAP.md — humemory demo / visualization

Goal: make humemory **demonstrable**. Today's dashboard (`public/index.html`) is a
filterable card list with zone counters and a detail modal — functional, but it
shows *state*, not *behavior*. A case study about a memory that decays, gets
reinforced, and resurfaces itself needs a viz that shows **time and motion**, not
a table. This file lists every option, so a choice can be made deliberately.

---

## Why the current dashboard undersells the project

- Decay (L0→L4) is the entire thesis, but it only appears as a static colored dot
  and a 5-segment bar — no sense of *movement* through time.
- Inverse search (degraded-first BM25) is invisible: a search box returns results,
  no view of "found via L3 keywords, escalated to L0" path.
- Recall reinforcement (saillance + decayRate slowing) has no before/after visual.
- Prospective memory / Zeigarnik loops (the actual differentiator, Phase 5) has
  zero visual vocabulary yet — nothing to extend toward.

A demo needs one screen that makes the **decay curve visible and alive**, ideally
animated or scrubbable, plus a "walk" interaction that mimics how the right memory
surfaces unprompted.

---

## Option A — Memory Galaxy (force-directed graph, 2D)

Each memory = a node. Position by `directory` (cluster), size by `saillance`,
color by `currentLevel` (L0 bright → L4 dim/grey). Node pulses on recall. Edges
between merged/similar memories. Idle nodes drift toward "dormant" outer ring —
literal spatial decay.

- **Stack**: `d3-force` (SVG/Canvas) or `react-force-graph` (WebGL via three.js
  under the hood) — vanilla JS fits the current no-framework `public/` setup.
- **Demo moment**: hit `/decay` live, watch nodes visibly dim and drift outward.
- **Effort**: medium (1–2 days). Biggest bang for a "wow" given existing data
  already has all needed fields (`saillance`, `currentLevel`, `directory`).
- **Risk**: force graphs get messy past ~200 nodes; fine for a demo dataset,
  needs clustering/pagination for real usage later.

## Option B — Memory River / Timeline (horizontal decay lanes)

Five horizontal lanes (L0…L4), memories flow left→right as time passes, each as a
small pill that visually fades (opacity/saturation) as it crosses lanes. Scrub a
time slider to fast-forward and watch the whole population decay in real time —
literally the "human forgetting curve" rendered as a chart.

- **Stack**: SVG/Canvas + `d3-scale`/`d3-axis` for the time axis; or pure CSS
  animation driven by `requestAnimationFrame`, no extra dependency.
- **Demo moment**: drag time slider from "today" to "+90 days", entire river
  visibly drains into the dormant lane unless a memory was recalled or is
  photographic (those visibly resist the current).
- **Effort**: medium. Reuses existing `/memories` + decay math already in
  `src/core/decay.ts` — can run decay projection client-side without hitting the
  API repeatedly.
- **Best fit for**: explaining the core thesis to someone in 30 seconds.

## Option C — "Promenade" mode (literal walk-through, first-person)

A spatial "memory palace" you walk through (canvas/WebGL room or simple isometric
grid), memories appear as objects placed by recency/context; as you "walk" near a
dormant memory it sharpens (decay reverses visually = recall). Mouse/keyboard
movement, or auto-guided camera path for a recorded demo.

- **Stack**: this is the only option that benefits from a real engine —
  `three.js` (lightweight scene, no physics needed) or `pixi.js` for 2D
  isometric. Bigger lift than A/B.
- **Demo moment**: literally matches the README pitch ("a memory that surfaces
  ... not on a search, but on a contextual cue") — walking past a "room" (= a
  `directory`) resurfaces its memories unprompted, the way walking past a shop
  reminds you to buy milk.
- **Effort**: high (3–5 days) for something demo-polished. Highest narrative
  payoff if Phase 5 (prospective/cue-based resurfacing) is the part being pitched.
- **Risk**: scope creep — a 3D "palace" can swallow a week if not timeboxed to a
  fixed demo script (3–4 scripted memories, not a generic explorer).

## Option D — Live "Session Replay" (already-started seed: `public/session.html`)

Replay an actual Claude Code session transcript: left pane = chat-like transcript
scrubber, right pane = memories being encoded/decayed/recalled in real time as the
scrubber moves, tied 1:1 to actual `learning-extractor.ts` output. This is the
most *credible* demo because it's not synthetic data — it's the tool eating its
own dogfood (the Stop-hook auto-encoding).

- **Stack**: extend the existing `public/session.html` (already exists, check
  its current state before rebuilding) + a scrubber timeline component.
- **Demo moment**: "here's me coding yesterday, here's what humemory remembered
  about it, watch it decay in fast-forward" — strongest pitch for *this specific
  audience* (other devs/agents), weaker as a generic flashy visual.
- **Effort**: low–medium if `session.html` already has the data wiring; mostly a
  timeline-scrub UI on top.

## Option E — Decay curve chart, Recharts/D3 line chart per memory

Smallest scope: a real-time line chart per memory showing saillance over time
(actual + projected decay curve), recall events as markers that kick the curve
back up. Drop into the existing detail modal instead of the static 5-segment bar.

- **Stack**: `recharts` (React) doesn't fit the current vanilla dashboard without
  a framework migration — prefer plain `<canvas>` + a ~50-line curve renderer, or
  `chart.js` via CDN script tag (zero build step, fits `public/` as-is).
- **Demo moment**: smaller, but cheap and immediately legible — "this is the
  forgetting curve, this spike is a recall." Good as a *minimum viable* upgrade
  if A/B/C/D are too much scope before a demo date.
- **Effort**: low (half a day). Best ROI-per-hour, but least impressive alone.

---

## Recommendation if forced to pick one

**B (Memory River) first, A (Galaxy) second.** Both reuse data/decay math already
shipped, no engine dependency, and B in particular states the thesis ("forgetting
is a curve, not a flag") better than any list/card view ever could in one glance.
D is the most *credible* but is a slower story to tell live; C is the most
*ambitious* and matches the long-term Phase 5 pitch but should wait until
Phase 5's cue/intention model actually exists in `src/` — building the walk before
the cue logic it's supposed to dramatize is building scenery for a play with no
script yet.

## Sequencing suggestion

1. Ship **E** (decay curve in the modal) as a quick win — touches one file.
2. Ship **B** (river/timeline) as the headline demo screen — new `public/river.html`
   or a tab in `index.html`, reuses `/memories` + decay.ts.
3. Defer **A**, **C**, **D** until after Phase 5's cue table exists — the
   "promenade" pitch (C) is strongest once there's an actual cue firing to show,
   not just decay.

No code written yet — this is the option menu, pick a lane before any of A–E
gets built.
