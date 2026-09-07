# Portability and recovery guarantees

## Installation and data

Humemory requires Bun 1.3.14 or newer. The archive deliberately includes `src`
alongside `dist`: hooks and MCP use those shipped sources, while the executable
uses the compiled CLI. A checkout is not required at runtime.

`HUMEMORY_DATA_DIR` takes precedence over the default data root. Without it, an
existing installation containing `data/humemory.db` keeps that location. New
installations use `%LOCALAPPDATA%/humemory` on Windows,
`~/Library/Application Support/humemory` on macOS, and
`$XDG_DATA_HOME/humemory` (or `~/.local/share/humemory`) on Linux.
No existing database is copied, migrated or overwritten implicitly.

`HUMEMORY_DB`, `HUMEMORY_QUEUE` and `HUMEMORY_MODEL_CACHE` select individual
locations. Restart every resident API/MCP/worker process with the same overrides
when moving shared state. Updating one process does not reconfigure the others.

`remap-project <from> <to>` previews directory changes. Applying requires
`--apply --backup <new-file>` and uses a SQLite snapshot followed by a
transaction. It covers trace, intention and script directories, plus absolute
file-open cue paths. It does not rewrite prose, MCP installation paths or queued
transcripts. Drain or preserve the queue separately before relocating projects.
The backup contains the database, not model files or pending transcripts.

## Discovery, configuration and encoding

Discovery reports local runtime evidence without importing conversations.
An available import adapter, an installed MCP configuration and a successfully
encoded trace are distinct states. Use source discovery, configuration reports,
maintenance status and memory search respectively to check them.

To process only already queued transcripts without scanning local agent history:

```bash
pnpm maintenance --skip-imports
```

Maintenance uses deterministic extraction by default. Models used by vector
search require a separate initial download or a populated model cache. An empty
cache is not proof of an offline-ready vector installation; `humemory doctor`
reports cache presence, not ONNX execution compatibility.

## Timing, concurrency and recovery

Cron expressions are evaluated in UTC. Time cues should use an ISO timestamp
with an explicit offset. Cron catch-up examines the most recent seven days;
it does not replay every missed occurrence after a long shutdown. A recurring
intention remains eligible after firing until it is closed or expires.

SQLite advisory locks have no age-based expiry. A live worker retains its lock,
and the operating system releases it when the process dies. Persistent
`.sqlite` coordination files are normal and must not be deleted to unlock a
running process. Stop all old-version workers when upgrading from file locks;
old and new lock mechanisms do not coordinate with each other.

Queue replacements use unique temporary files. If replacement fails, the
previous destination and the complete temporary remain available for recovery.
The worker restores abandoned `.processing` files on a later pass. Checkpoints
avoid ordinary repeated imports, but a crash between memory storage and the
checkpoint can replay work: this is not a claim of exactly-once encoding.
Rename-based replacement is not a guarantee against power loss without an
explicit persistence protocol.

MCP setup preserves a backup of the original, checks for changes before the
rename, and serializes cooperating setup processes. It cannot lock an unrelated
editor that ignores that protocol; a change in the final check-to-rename window
remains possible. Keep the `.bak` files until the resulting configuration has
been checked.

## What the checks establish

`pnpm test` is the isolated, deterministic suite with mocked external services.
`pnpm verify:package` is a separate installation check: dependency installation
requires network access, while its runtime inputs are synthetic and its HTTP
requests target the test server on loopback. It verifies the shipped CLI, hooks,
queue processing, consolidation, MCP and API from a temporary location outside
the checkout, with spaces and accents in the path and a fresh data profile.

The CI defines this sequence for Windows, Linux and macOS. A configured job is
not evidence that a particular run passed. Real ONNX inference per OS and
architecture, enforced read-only installation permissions, power-loss recovery,
and complete database-plus-queue restoration need separate validation.
