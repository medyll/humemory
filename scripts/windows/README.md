# Windows production wiring

How humemory stays alive on a Windows machine, and why it is shaped this way.

```powershell
pwsh -File scripts\windows\install.ps1          # install or repair
pwsh -File scripts\windows\install.ps1 -Uninstall
```

## The constraint

No elevation. `schtasks /sc onlogon` is refused without admin rights, so logon
start goes through the Startup folder instead of a scheduled task.

And the one that shaped everything else: **a scheduled task whose action is
`cmd` flashes a console window at every single run.** Task Scheduler's `Hidden`
flag hides the *task* in the UI, not the window. The only setting that truly
suppresses it — "run whether the user is logged on or not", which puts the task
in session 0 — needs elevation.

`wscript.exe` is a windowless script host, and `WScript.Shell.Run` with window
style `0` hides whatever it launches. Every piece here goes through one of those
two, which is why nothing flashes.

## The pieces

| Piece | What it does | Where |
|---|---|---|
| Startup launcher | Starts the API at logon, hidden, logging to `data\logs\api.log` | `%APPDATA%\...\Startup\humemory-api.vbs` → `humemory-api.vbs` |
| API process | Serves the dashboard **and hosts the maintenance loop** (every 15 min) | `src/api/server.ts` |
| Watchdog task | Every 5 min: restarts the API if `/health` stops answering | `humemory-watchdog.vbs` |

The Startup entry is a generated two-line shim that defers to the versioned
script, so the real logic stays in git and a repo move only requires re-running
the installer.

## Why maintenance lives in the API process

It used to be its own scheduled task running `cmd /c ... bun ...` every 15
minutes — the flash. The API process is already resident and windowless, so the
loop costs nothing there and spawns nothing.

The trade-off is real and deliberate: **the API is now a single point of
failure.** If it dies, consolidation stops. Two things answer that:

- the **watchdog** brings the process back without anyone noticing;
- the **state file** (`data/maintenance-state.json`) makes a stopped loop
  *visible* rather than silent.

```bash
bun run src/cli/index.ts maintenance status   # exit code 1 when overdue
bun run src/cli/index.ts maintenance run      # force a pass here and now
```

The same answer is on `GET /maintenance/status` (behind the API token, because
`lastError` is internal detail). `/health` stays public and coarse — the
watchdog needs liveness, nothing more.

## Escape hatch

`HUMEMORY_MAINTENANCE_INTERVAL_MS=0` disables the in-process loop and hands the
job back to an external scheduler running `scripts/maintenance-worker.ts`. The
state file and the status command keep working either way.

If you do that on Windows, make the task's action `wscript.exe` wrapping a
launcher, not `cmd` — or the flash comes back.
