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

humemory is built in two halves. The first was shipped first; the second is what it
was always for. Both are built as of Phase 8.

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

A Claude Code `Stop` hook can queue each completed session instantly; maintenance
extracts and stores its learnings afterward, outside the agent's critical path.

### 2. Prospective memory — *what to resurface* ✅ built

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
pnpm build:web      # bundle the React front (bun's own bundler, no extra tooling)
pnpm start:api      # API + dashboards → http://localhost:3456
pnpm cli status     # state of the memory palace
pnpm cli sources discover # discover local AI runtimes; reads no sessions
pnpm test           # bun test — backend and React components, one runner
```

### Local AI sources — a non-exhaustive registry

humemory keeps acquisition outside the cognitive core: the registry discovers
local producers, while humemory decides what becomes a trace, how it decays, and
when it resurfaces. Discovery only checks commands and known data roots; importing
historical sessions remains an explicit, opt-in step.

The non-exhaustive catalog currently recognizes:

| Runtime | Vendor | Discovery hints |
| --- | --- | --- |
| Claude Code | Anthropic | `claude`, `~/.claude` |
| Codex | OpenAI | `codex`, `~/.codex` |
| Kimi Code / Kimi Desktop | Moonshot AI | `kimi`, `~/.kimi-code`, desktop data roots |
| Mistral Vibe | **Mistral AI** | `vibe`, `$VIBE_HOME`, `~/.vibe` |
| OpenCode | SST | `opencode`, `~/.opencode` |
| Qwen Code | Alibaba Cloud | `qwen`, `$QWEN_RUNTIME_DIR`, `$QWEN_HOME`, `~/.qwen` |
| Gemini CLI | Google | `gemini`, `$GEMINI_CLI_HOME`, `~/.gemini` |
| GitHub Copilot CLI | GitHub | `copilot`, `~/.copilot` |
| Aider | Aider-AI | `aider`, `~/.aider.conf.yml` |
| Cursor | Anysphere | `cursor`, desktop data roots |
| Windsurf | Cognition | `windsurf`, desktop data roots |

An entry means **ready to be discovered**, not that its evolving private session
format is already parsed. Run `pnpm cli sources discover --installed-only` for a
local inventory without exposing conversation content.

The React app is served at **`/`** (and `/app`). The original vanilla dashboard
has been removed — the React front reached parity first, and git keeps the old
one if it is ever needed.

The visualisations are **wrapped, not rewritten**: d3 owns its SVG subtree and
three.js its WebGL canvas, so they stay imperative inside a `useEffect`. Only the
parts built from `innerHTML` strings — the trace dashboard, the replay player,
the merge panel — became JSX. Each visualisation is code-split and loaded on
demand; three.js alone is half a megabyte, and nobody who never opens the
promenade should download it.

Run `pnpm build:web` before `pnpm start:api`, or `/` answers 503 telling you so.

### Open loops (prospective memory)

```bash
# arm a loop, with a file cue and a weekly reminder
pnpm cli intent add "refactor token validation" -d ./src/auth \
  -c 'event:file_open:src/auth/service.ts' -c 'cron:0 9 * * 1' -e 2026-12-31

pnpm cli intent list              # armed loops (--all for every status)
pnpm cli intent close loop-a1b2c3d4 --commit deadbee
pnpm cli intent resolve           # expire overdue loops, fire due deadlines
```

Cue formats: `time:<ISO>`, `cron:<5-field expr>`, `event:file_open:<path>`,
`event:branch_switch:<branch>`, `event:error_pattern:<regex>`.

Directories are resolved to absolute paths on write — a loop armed on a relative
path would never match the `SessionStart` hook, which looks the project up by
`process.cwd()`.

Over HTTP: `POST /intentions`, `GET /intentions?status=armed&directory=…`,
`GET /intentions/:id`, `POST /intentions/:id/close`, `POST /intentions/:id/fire`,
`DELETE /intentions/:id`, `POST /cues`, `GET /cues`, `POST /events`,
`POST /cues/resolve`.

### Closing loops from git

```bash
git config core.hooksPath .githooks   # in this repo
```

For another project, copy `.githooks/post-commit` into it and point
`HUMEMORY_HOME` at your humemory checkout — the database is shared across
projects, the code is not:

```bash
export HUMEMORY_HOME=/path/to/humemory
```

Write `Closes loop-a1b2c3d4` in a commit message and that loop is closed, its
SHA recorded, its remaining cues cancelled. Everything else is only **suggested**:
the hook scores the overlap between the files you touched and the loop's text,
and prints candidates. It never closes on a guess — closing the wrong loop costs
more than leaving one open.

```
💡 Loops this commit may have touched:
   loop-e99166cd — Refactor the auth middleware
      overlaps: auth, middleware

   To close: pnpm cli intent close loop-e99166cd
```

### Wiring the Claude Code hooks

Two hooks, both optional and both fail-open. `Stop` only writes the raw session to
a durable local queue; it never waits for a model or a network request:

```jsonc
// ~/.claude/settings.json
{
  "hooks": {
    // start of session: injects open loops + relevant decayed traces as context
    "SessionStart": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "bun /path/to/humemory/scripts/hook-session-start.ts" }
    ]}],
    // end of session: queues the transcript for asynchronous maintenance
    "Stop": [{ "matcher": "", "hooks": [
      { "type": "command", "command": "bun /path/to/humemory/scripts/hook-session.ts" }
    ]}]
  }
}
```

`SessionStart` reads the current directory and git branch, expires stale loops,
fires any due time cues, and writes a markdown block on stdout — which Claude Code
injects into the session. Nothing relevant means nothing written.

Process queued sessions independently from the agent flow:

```bash
pnpm maintenance
```

The default maintenance path is deterministic and network-free. To opt into
Claude as an asynchronous quality enhancement, set
`HUMEMORY_MAINTENANCE_LLM=anthropic` and `ANTHROPIC_API_KEY`; quota errors and
timeouts fall back to the deterministic extractor. A queue item is deleted only
after its extracted memories are committed successfully.

The queue directory is the whole contract, and it is inspectable at any time:

| Entry | Meaning |
| --- | --- |
| `<id>.json` | a session waiting to be encoded, keyed on session — not on transcript content, since `Stop` resends a longer transcript every turn |
| `<id>.json.processing` | claimed by the running worker; a newer transcript may land on the free `<id>.json` slot meanwhile, and survives |
| `checkpoints/<id>.json` | how many messages of that session are already encoded, so a resent transcript only contributes its delta |
| `<id>.dead.json` | gave up after `maxAttempts` (5), or unparseable on disk; never retried, never deleted |
| `.worker.lock` | single-worker token; a lock left by a dead worker is reclaimed atomically after 5 min |

| Env var | Default | Effect |
| --- | --- | --- |
| `HUMEMORY_DB` | `data/humemory.db` | database path |
| `HUMEMORY_QUEUE` | `data/maintenance-queue` | durable raw-session inbox |
| `HUMEMORY_MAINTENANCE_LLM` | `none` | optional enhancement (`anthropic`) |
| `HUMEMORY_MAINTENANCE_TIMEOUT_MS` | `8000` | model timeout; never affects the agent hook |
| `HUMEMORY_DIR` | `cwd` | mental place to scope loops and traces to |
| `HUMEMORY_SESSION_BUDGET` | `10` | max items listed per section |
| `HUMEMORY_SAILLANCE_MIN` | `60` | salience floor for recalling a decayed trace |
| `HUMEMORY_VERBOSE` | unset | `1` logs a one-line summary on stderr |

---

## Serving the API safely

The database holds every learning trace and open loop across all your projects,
and the API can read, alter and delete all of it. Treat the port as sensitive.

| Env var | Default | Effect |
| --- | --- | --- |
| `PORT` | `3456` | API/dashboard port |
| `HUMEMORY_HOST` | `127.0.0.1` | listen address — **loopback only unless you change it** |
| `HUMEMORY_API_TOKEN` | unset | when set, required on every data route (`Authorization: Bearer …` or `X-Humemory-Token`) |
| `CORS_ORIGINS` | `http://localhost:3456` | comma-separated exact origins, honoured when `NODE_ENV=production` |
| `HUMEMORY_VERBOSE_ERRORS` | unset | `1` returns real error messages instead of a correlation id — local debugging only |

**Defaults are private.** The server binds `127.0.0.1`, so nothing on your network
can reach it. Without `HUMEMORY_API_TOKEN` it starts anyway and warns, because on
loopback the OS is the boundary.

**Exposing it is deliberate.** Setting `HUMEMORY_HOST` to anything but loopback
*without* a token makes the server refuse to start rather than quietly publish your
memory to the LAN:

```bash
HUMEMORY_HOST=0.0.0.0 HUMEMORY_API_TOKEN="$(openssl rand -hex 32)" pnpm start:api
```

The dashboard asks for that token behind the 🔑 button in its header and keeps it
in `localStorage`. `/health` and the static assets stay open so a probe and the
page itself still load.

A token is not a substitute for the network layer: over anything but loopback, put
TLS and a firewall in front of it. The token travels in a header, in clear, over
plain HTTP.

---

## Why it exists

A log remembers everything and reminds you of nothing. A human memory forgets most
of it and hands you the one thing that matters, at the moment it matters. humemory
is an attempt to give an AI agent the second kind.

## A memory engine, not an integration bundle

humemory has a narrow job: decide what deserves to become a memory, how that
trace changes with time, and when it should return. Everything that brings data
in sits outside the cognitive core.

- **Connectors live in a registry.** Discovery and future import adapters identify
  Claude Code, Codex, Kimi, Qwen, Mistral and other local producers; they don't
  become memory primitives. Adding a source doesn't change decay, recall, trust
  or cue logic.
- **SQLite owns the truth.** Provenance, decay levels, intentions, scripts and
  review decisions remain queryable and recoverable. Vector embeddings form a
  second, disposable search lane: humemory can rebuild them, change the embedding
  model or disable semantic search without putting the memory store at risk.
- **Several agents can share one brain.** MCP and source attribution let Claude,
  Codex, Kimi, OpenCode and future clients use the same store. Every write keeps
  its agent and device provenance instead of inheriting one vendor's session model.
- **Maintenance stays out of the agent's path.** Hooks queue a raw session locally,
  then exit. A separate worker filters, consolidates and stores it; a slow GPU,
  a network outage or an exhausted quota doesn't make the agent wait.
- **LLMs are optional, not governors.** Decay, salience, recall, cues, scripts,
  trust and deterministic consolidation work without an API key. A configured
  model may improve the generated text, but failure always returns to the local
  deterministic path.
- **Automation stops before judgment.** The dreamer files proposals, agent-authored
  scripts begin as drafts, and contradictions stay inspectable. A model doesn't
  silently turn a guess into permanent memory.

Historical absorption stays opt-in. `sources discover` checks commands and known
paths without reading conversations. Each runtime still needs a parser before
humemory can import its sessions, and discovery never pretends otherwise.

## Stack

TypeScript · `bun:sqlite` (WAL) · `flexsearch` (BM25) · `hono` (API) ·
`commander` (CLI) · `@anthropic-ai/sdk` (optional maintenance adapter).

---

## Usage

### Installation

```bash
pnpm install
```

### CLI Commands

The CLI provides several commands to interact with humemory:

- **Encode a new memory trace**:
  ```bash
  pnpm cli encode "Your memory content here"
  ```
  Options:
  - `-d, --directory <dir>`: Mental space (project)
  - `-s, --session <id>`: Encoding context
  - `-k, --keywords <tags>`: Retrieval cues (comma-separated)
  - `-l1, --level1 <summary>`: Summary for consolidation N1
  - `-l2, --level2 <essential>`: Essential for consolidation N2
  - `-l3, --level3 <keywords>`: Trace for fast search N3
  - `-t, --type <type>`: Memory type (episodic/semantic/procedural)
  - `--auto`: Auto-generate N1/N2/N3 locally; an injected LLM may enhance them
  - `--photographic`: Photographic mode — disable degradation

- **Search for memory traces**:
  ```bash
  pnpm cli search "your query"
  ```
  Options:
  - `-d, --directory <dir>`: Filter by mental space
  - `-s, --session <id>`: Filter by context
  - `-l, --level <max>`: Max consolidation state (0-4)
  - `-n, --limit <n>`: Number of traces
  - `-t, --type <type>`: Filter by type (episodic/semantic/procedural)
  - `--from <date>`: Start date YYYY-MM-DD
  - `--to <date>`: End date YYYY-MM-DD
  - `--min-saillance <n>`: Minimum mnemonic strength (0-100)
  - `--min-recalls <n>`: Minimum reactivations

- **Reactivate a memory trace**:
  ```bash
  pnpm cli recall <id>
  ```

- **List memory traces**:
  ```bash
  pnpm cli list
  ```
  Options:
  - `-n, --limit <n>`: Number of traces
  - `-l, --level <level>`: Filter by state (0-4)
  - `-t, --type <type>`: Filter by type (episodic/semantic/procedural)

- **Update decay**:
  ```bash
  pnpm cli decay
  ```

- **Toggle photographic mode**:
  ```bash
  pnpm cli photo <id>
  ```
  Options:
  - `--off`: Disable photographic mode

- **Find similar traces**:
  ```bash
  pnpm cli similar <id>
  ```
  Options:
  - `-n, --limit <n>`: Number of results
  - `-t, --threshold <n>`: Minimum score (0-100)

- **Merge traces**:
  ```bash
  pnpm cli merge <sourceId> <targetId>
  ```
  Options:
  - `--auto`: Merge content via LLM

- **Delete a memory trace**:
  ```bash
  pnpm cli delete <id>
  ```

- **Show memory palace status**:
  ```bash
  pnpm cli status
  ```

- **Import a Claude Code session**:
  ```bash
  pnpm cli import-session <file>
  ```
  Options:
  - `-d, --directory <dir>`: Project mental space
  - `-n, --max <n>`: Max learnings to extract

### API

Start the API server:

```bash
pnpm start:api
```

The API will be available at `http://localhost:3456`. You can interact with it using the following endpoints:

- `POST /memories`: Add a new memory
- `GET /memories`: List memories
- `GET /memories/:id`: Fetch a specific memory
- `POST /memories/:id/recall`: Bump recall and saillance
- `POST /memories/:id/similar`: Find similar memories
- `POST /memories/:id/merge`: Merge memories
- `POST /memories/:id/photo`: Toggle photographic mode
- `DELETE /memories/:id`: Forget a memory
- `GET /search?query=X`: Inverse search
- `POST /decay`: Run consolidation
- `GET /status`: Pool stats

### Dashboard

The dashboard is available at `http://localhost:3456` when the API server is running. It provides a visual interface to interact with humemory.

---

## Examples

### Encoding a memory

```bash
pnpm cli encode "Fixed the critical bug in the authentication module" \
  -d "my-project" \
  -k "bug,authentication,critical" \
  -t "episodic" \
  --auto
```

### Searching for memories

```bash
pnpm cli search "authentication bug" \
  -d "my-project" \
  --min-saillance 50
```

### Reactivating a memory

```bash
pnpm cli recall "memory-id-here"
```

### Listing memories

```bash
pnpm cli list -l 0 -t "episodic"
```

### Updating decay

```bash
pnpm cli decay
```

### Toggling photographic mode

```bash
pnpm cli photo "memory-id-here" --off
```

### Finding similar traces

```bash
pnpm cli similar "memory-id-here" -n 3 -t 70
```

### Merging traces

```bash
pnpm cli merge "source-memory-id" "target-memory-id" --auto
```

### Deleting a memory

```bash
pnpm cli delete "memory-id-here"
```

### Showing memory palace status

```bash
pnpm cli status
```

### Importing a Claude Code session

```bash
pnpm cli import-session "session-file.txt" -d "my-project" -n 5
```

---

## Development

### Building the project

```bash
pnpm build
```

### Running tests

```bash
pnpm test
```

### Watching tests

```bash
pnpm test:watch
```

### Running the CLI directly

```bash
pnpm cli <command>
```

### Manual consolidation

```bash
pnpm consolidate
```

---

## Concepts

| Field | Cognitive term (French, as in the code) | Meaning |
|-------|-----------|---------|
| `createdAt` | Encodage | trace formation |
| `lastRecalled` | Dernière réactivation | last conscious retrieval |
| `recallCount` | Réactivations | recalls (reinforce) |
| `saillance` | Force mnésique | trace strength 0–100 |
| `decayRate` | Taux d'oubli | degradation speed |
| `sessionId` | Contexte d'encodage | encoding context |
| `directory` | Lieu mental | conceptual space (project) |
| `currentLevel` | État de consolidation | decay stage 0–4 |
| `keywords` | Indices de récupération | retrieval cues |
| `memoryType` | Type | episodic / semantic / procedural |

**Decay thresholds:** L0→L1 ~24h · L1→L2 ~1 week · L2→L3 ~1 month · L3→L4 beyond.
Slowing factors: `recallCount * 0.3`, saillance >70 → 1.5× slower, content >500 chars,
keywords >5. `photographic: true` disables decay entirely.

**Memory types:** `episodic` (events), `semantic` (facts), `procedural` (skills).

---

## Roadmap

### ✅ Done — Sprints 1–4
- Core decay + inverse search; `bun:sqlite` store (WAL, write-queue serialization)
- CLI + Hono API + web dashboard ("palais de mémoire")
- Nightly cron consolidation (`0 3 * * *`)
- Deterministic L1/L2/L3 generation; optional injected LLM enhancement
- Similar-detection + merge (L4); enriched search (type/period/saillance/recalls)
- Photographic mode; Claude Code `Stop` hook → durable async maintenance queue

### 🎯 Phase 5 — Prospective memory (the destiny)
> Corrected plan in **[PHASE5_PLAN.md](./PHASE5_PLAN.md)**. Summary:

- [x] **5.0 Preconditions** — cross-process SQLite advisory lock and injectable
      event bus in the test env, both shipped (S5-00a, S5-00b).
- [x] **5.1 Data model** — dedicated `intentions` table (not a new `MemoryType`,
      intentions don't follow the retrospective decay curve) + `cues` table with
      typed `trigger_spec`. One intention → N cues.
- [x] **5.2 Cue resolver** — time cues (ISO/cron) and event cues (file_open,
      branch_switch, error_pattern). Decay rule: `armed` → saillance pinned at 100;
      `fired` not `closed` → normal decay (Zeigarnik fades); `closed` → archived.
- [x] **5.3 Hooks** — `SessionStart` injects context (`scripts/hook-session-start.ts`,
      budget via `HUMEMORY_SESSION_BUDGET`); git `post-commit` closes loops via the
      explicit `Closes loop-<id>` marker, and only *suggests* on file-overlap.
- [x] **5.4 CLI/API** — `pnpm cli intent {add,list,close,fire,resolve}`,
      `POST /intentions`, `POST /cues`, `POST /events`, `POST /cues/resolve`.

**Deferred to Phase 6** — Cognitive scripts (spec needed before code).

### 🛣️ Beyond
- Shared multi-project DB with concurrency lock (WAL + advisory) — done (Sprint 5 / S5-00a)
- OpenCode / other-agent integration; export/import memories between projects

---

## Known issues
- ~~SQLite multi-process: advisory lock~~ — fixed in Sprint 5 (S5-00a): WAL + write-queue (Sprint 4) plus file-based cross-process `AdvisoryLock`.
- ~~`tests/fixtures/` missing~~ — closed (S5-00b): `tests/fixtures/*.json` + `tests/helpers/fixtures.ts`.
  Shared corpora live there; a one-off case a test is specifically *about* stays inline.
- ~~`vitest.config.ts` orphaned~~ — closed: the file is gone, the suite runs under `bun test`.
- `tsc` global can shadow local — `pnpm build` is `tsc -p tsconfig.json`.

## Notes
- Shared DB: `data/humemory.db` · API port `3456` (`PORT` env)
- Stack: TypeScript · `bun:sqlite` · `flexsearch` · `hono` · `commander` · `@anthropic-ai/sdk`
- `CLAUDE.md` is a thin Claude-Code-specific quick-start that delegates to
  `AGENTS.md`; `AGENTS.md` remains the canonical source of truth.
