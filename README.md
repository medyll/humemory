# humemory

> **Memory for AI agents that forgets like a human — and resurfaces like one.**

humemory is a memory engine that does not behave like a database. It behaves like
a brain. Traces **decay** through five levels (full detail → summary → essentials →
keywords → lost/merged), recall **reinforces** them, and — this is the part that
matters — the right memory comes back to you **before you ask for it**.

Most "agent memory" is a searchable log. You query it, it returns rows. humemory's
reason to exist is the opposite move: a memory that **surfaces the relevant trace
on a contextual cue**, the way you remember to buy milk when you walk past the shop,
not when you run a full-text search for "milk".

---

## Two halves of a brain

humemory is built in two halves. The first is shipped. The second is its destiny.

### 1. Retrospective memory — *what was learned* ✅ built

Past learnings are **encoded**, then **degraded** over time on a human curve:

| Level | Name | Lifespan | Holds |
|-------|------|----------|-------|
| L0 | full detail | fresh (<24h) | complete content |
| L1 | summary | days | LLM-generated résumé |
| L2 | essential | weeks | the gist |
| L3 | keywords | months | BM25 retrieval tokens |
| L4 | lost / merged | beyond | folded into a sibling trace |

Recall resists decay. Saillance (mnemonic strength, 0–100) and recall count slow
the curve. A **photographic** flag pins critical traces so they never fade.

**Inverse search** queries the *degraded* layers first (cheap, L3 keywords) and
escalates toward full content only on a match — the human recall pattern, fast by
construction.

A Claude Code `Stop` hook already auto-encodes the learnings of each dev session.

### 2. Prospective memory — *what to resurface* 🎯 the destiny

The second half (see `AGENTS.md` → Phase 5) is what gives humemory its life:

- **Prospective memory** — store an *intention* that fires on a **cue** (a time, or
  an event: opening a file, switching branch, hitting an error), not on a search.
- **Zeigarnik effect** — an **open loop** stays salient near consciousness until it
  is closed. A `git commit` is the synaptic release that purges it.
- **Cognitive scripts** — context-triggered routines, pre-loaded, ready to run.

Concretely: on `SessionStart`, humemory reads the open loops and the
decayed-but-relevant traces for the current directory/branch and **injects them as
context** — "yesterday you left *refactor fn X* open" — instead of waiting to be
queried.

---

## Quick start

```bash
pnpm install
pnpm start:api      # API + dashboard → http://localhost:3456
pnpm cli status     # state of the memory palace
pnpm test           # bun test
```

Full command reference, concepts, and roadmap live in **[AGENTS.md](./AGENTS.md)**.
The autonomous test environment spec lives in **[docs/TESTING.md](./docs/TESTING.md)**.

---

## Why it exists

A log remembers everything and reminds you of nothing. A human memory forgets most
of it and hands you the one thing that matters, at the moment it matters. humemory
is an attempt to give an AI agent the second kind.

## Stack

TypeScript · `bun:sqlite` (WAL) · `flexsearch` (BM25) · `hono` (API) ·
`commander` (CLI) · `@anthropic-ai/sdk` (level generation).
