# Autonomous Test Environment — humemory

**Status:** spec (2026-06-17). Code later. This is the *required* foundation for
Phase 5 (prospective / Zeigarnik). See [AGENTS.md](../AGENTS.md) → "Autonomous test
environment — REQUIRED".

## Why it must be autonomous

humemory's entire behavior is **time-driven** (decay curves) and **event-driven**
(cues, open loops). Logic of that shape is untestable against a wall clock or a live
LLM. Every run must be:

- **Hermetic** — no shared DB, no network, no global state leaking between tests.
- **Deterministic** — same input ⇒ same output. No `Date.now()`, no randomness, no
  ordering that depends on real time.
- **Fast** — fake-clock fast-forward instead of real waiting; in-memory DB.

## Three pillars

### 1. Isolated database — partly done, finish it

Today `tests/humemory.test.ts` uses a temp file `test-humemory.db` with
`beforeEach`/`afterEach` cleanup. Good enough but file-bound and serial.

**Target:** every suite gets its own `bun:sqlite` instance. `SQLiteStore`'s
constructor already accepts a path → pass `':memory:'`.

```ts
// helper: tests/helpers/store.ts
export function freshStore() {
  return new SQLiteStore(':memory:'); // no disk, no cross-test bleed
}
```

Rule: **a test must never open `data/humemory.db`.** Add a guard that throws if the
prod DB path is opened under `NODE_ENV=test`.

### 2. Injectable clock — THE missing piece

`src/store/sqlite.ts` and `src/core/decay.ts` call `new Date()` / `Date.now()`
directly (see `sqlite.ts:136,185`). That makes decay transitions impossible to test
deterministically. **This is the one real gap to close before Phase 5.**

**Target:** a `Clock` seam injected into the store and decay functions.

```ts
// src/core/clock.ts
export interface Clock { now(): Date; }
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  constructor(private t: Date) {}
  now() { return this.t; }
  advance(ms: number) { this.t = new Date(this.t.getTime() + ms); }
}
```

Then decay tests assert the full curve without waiting:

```ts
const clock = new FakeClock(new Date('2026-01-01'));
const store = new SQLiteStore(':memory:', { clock });
const m = await store.add({ /* ... */ });
clock.advance(25 * 3600_000);     // +25h
await store.updateDecay();
expect((await store.getById(m.id)).currentLevel).toBe(1); // L0→L1
```

Migration: thread `clock` through `SQLiteStore`, `decay.ts`, and the consolidation
script; default to `systemClock` so production is unchanged.

### 3. Mocked LLM — seam already exists

`src/core/llm-generator.ts` exports `setLLMClient(client: LLMClient)` and the
`LLMClient` interface. Tests must use it; **no test may instantiate a real
`Anthropic` client.**

```ts
import { setLLMClient } from '../src/core/llm-generator.js';

setLLMClient({
  async generate() {
    return { level1: 'fixed summary', level2: 'fixed gist', level3: 'k1 k2 k3' };
  },
});
```

CI runs with **no `ANTHROPIC_API_KEY`**. A test hitting the network is a bug.

## Fixtures

Seed from `tests/fixtures/` (JSON memory sets) rather than inline literals, so
prospective-memory scenarios (open loops, cues firing at given times) are described
as data and replayed against the `FakeClock`.

```
tests/
├── fixtures/
│   ├── memories.basic.json
│   ├── loops.open.json        # Zeigarnik open loops for Phase 5
│   └── cues.json             # time/event cues
└── helpers/
    ├── store.ts              # freshStore()
    └── clock.ts              # FakeClock factory
```

## Checklist before Phase 5 starts

- [ ] `Clock` seam added; `new Date()` removed from decay/store hot paths
- [ ] `freshStore()` → `:memory:` per test; prod-DB guard under test env
- [ ] all suites use `setLLMClient` stub; CI green with no API key
- [ ] fixtures dir + helpers in place
- [ ] one end-to-end decay test driven purely by `FakeClock.advance()`

When this checklist is green, prospective/Zeigarnik logic can be built and trusted.
