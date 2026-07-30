# Autonomous Test Environment — humemory

**Status:** implemented (2026-07-30, story S5-00b). Spec written 2026-06-17.
This is the *required* foundation for Phase 5 (prospective / Zeigarnik). See
[AGENTS.md](../AGENTS.md) → "Autonomous test environment — REQUIRED".

Seams live in `src/core/clock.ts` and `src/core/event-bus.ts`; test-side helpers
in `tests/helpers/`, data in `tests/fixtures/`. `tests/test-env.test.ts` covers the
four pillars themselves — if it goes red, no time- or event-driven assertion in the
suite can be trusted.

## Why it must be autonomous

humemory's entire behavior is **time-driven** (decay curves) and **event-driven**
(cues, open loops). Logic of that shape is untestable against a wall clock or a live
LLM. Every run must be:

- **Hermetic** — no shared DB, no network, no global state leaking between tests.
- **Deterministic** — same input ⇒ same output. No `Date.now()`, no randomness, no
  ordering that depends on real time.
- **Fast** — fake-clock fast-forward instead of real waiting; in-memory DB.

## Four pillars

### 1. Isolated database — done

Today `tests/humemory.test.ts` uses a temp file `test-humemory.db` with
`beforeEach`/`afterEach` cleanup. Good enough but file-bound and serial.

**Target:** every suite gets its own `bun:sqlite` instance. `SQLiteStore`'s
constructor already accepts a path → pass `':memory:'`.

```ts
import { freshStore } from './helpers/store.js';

const store = freshStore();            // ':memory:', clock frozen at T0
const store2 = freshStore({ clock });  // drive time yourself
```

Rule: **a test must never open `data/humemory.db`.** Enforced, not just asked:
`SQLiteStore`'s constructor throws under `NODE_ENV=test` if the resolved path is the
prod DB (`assertNotProdDbUnderTest`).

Note: a `:memory:` store gets a no-op advisory lock — there is no other process to
synchronise with, and `':memory:' + '.lock'` is not a valid filename on Windows.
Intra-process serialisation still runs through `enqueueWrite`.

### 2. Injectable clock — done

`src/core/clock.ts` exports the seam: `Clock`, `systemClock` (production default,
unchanged behaviour) and `FakeClock` with `advance()` / `advanceHours()` /
`advanceDays()` / `set()`. `FakeClock.now()` returns a defensive copy, so a caller
mutating the returned `Date` cannot shift the clock.

Threaded through `SQLiteStore` (`add`, `recall`, `updateDecay`) and
`InverseSearchEngine` (the recency bonus in `calculateScore`). `decay.ts` already
took `now` as a parameter. Anything still calling `new Date()` in a hot path is a
regression.

Then decay tests assert the full curve without waiting:

```ts
const clock = new FakeClock(new Date('2026-01-01'));
const store = new SQLiteStore(':memory:', { clock });
const m = await store.add({ /* ... */ });
clock.advance(25 * 3600_000);     // +25h
await store.updateDecay();
expect((await store.getById(m.id)).currentLevel).toBe(1); // L0→L1
```

Remaining: `scripts/consolidate.js` and the CLI/API still stamp `day` with
`new Date()` at the edges. Harmless for decay assertions, worth threading when the
prospective hooks land (S5-03a/b).

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

Use `tests/helpers/llm.ts`: `useStubLLM()` installs a deterministic client shaped
like an Anthropic one (`messages.create` returning a JSON text block), records the
calls it received, and can be made to throw via `{ fail: new Error(...) }` to
exercise fallback paths.

### 4. Injectable event bus — done

Phase 5 is **event-driven**, not only clock-driven: a cue can be armed on
`file_open`, `branch_switch`, `error_pattern` or `commit`. Without a seam, testing
"this cue fires when the branch changes" would mean touching the real FS or git.

```ts
import { InMemoryEventBus } from '../src/core/event-bus.js';

const bus = new InMemoryEventBus();
bus.subscribe('branch_switch', (e) => resolver.resolveEventCues(e));
await bus.publish({ type: 'branch_switch', branch: 'feature/x', directory: '/src' });
// handlers are awaited: the effect is observable right after this line
```

`publish()` awaits handlers in subscription order, so **a test never needs a
`setTimeout` to observe an effect**. Handlers are snapshotted before dispatch, so a
handler unsubscribing mid-broadcast cannot corrupt the iteration. `published()` /
`publishedOf(type)` expose the log for assertions without subscribing; `reset()`
clears both handlers and log.

`FileSystemEventBus` (fs.watch / chokidar + git hooks) is deliberately **not**
implemented yet — there is nothing to feed until the `intentions`/`cues` tables and
the resolver exist. It lands with Phase 5.2 (S5-02).

## Fixtures

Seed from `tests/fixtures/` (JSON sets) rather than inline literals, so scenarios are
described as data and replayed against the `FakeClock`.

```
tests/
├── fixtures/
│   ├── memories.basic.json   # traces; dates as offsetHours from T0, never absolute
│   ├── events.basic.json     # AppEvents replayable on the bus
│   ├── loops.open.json       # Zeigarnik open loops   — lands with S5-01
│   └── cues.json             # time/event cues        — lands with S5-01
└── helpers/
    ├── store.ts              # freshStore()
    ├── clock.ts              # fakeClock(), T0, HOURS thresholds
    ├── llm.ts                # useStubLLM(), stubLLMClient()
    └── fixtures.ts           # seedMemories(), eventFixtures()
```

Fixtures carry **no absolute timestamps**: a trace declares `offsetHours` relative to
`T0`, resolved against the injected clock. `seedMemories()` returns the inserted
traces keyed by fixture `key`, so assertions read as
`seeded['auth-bug'].currentLevel` rather than array indices.

`loops.open.json` and `cues.json` are intentionally absent: writing fixtures for
tables that do not exist yet is dead weight. They arrive with the Phase 5.1 schema.

## Checklist before Phase 5 starts

- [x] `Clock` seam added; `new Date()` removed from decay/store hot paths
- [x] `freshStore()` → `:memory:` per test; prod-DB guard under test env
- [x] LLM stub helper in place; CI green with no API key
- [x] injectable event bus (`InMemoryEventBus`) with awaited dispatch
- [x] fixtures dir + helpers in place
- [x] one end-to-end decay test driven purely by `FakeClock.advance()`
      (`tests/test-env.test.ts` → L0→L1→L2→L3 with zero real waiting)

Checklist green as of 2026-07-30 — prospective/Zeigarnik logic can now be built on
top and trusted.

**Still open:** the three legacy suites (`humemory.test.ts`, `agent.test.ts`,
`llm-generator.test.ts`) predate these helpers and still seed ad hoc literals against
temp-file DBs. They pass, but they are not yet hermetic in the sense above.
Migrating them is tracked as BUG-05 and should happen before the suite grows further.
