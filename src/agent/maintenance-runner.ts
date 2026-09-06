/**
 * One maintenance pass: pull in what the local agents wrote since last time,
 * then drain the queue into memory.
 *
 * The pass has exactly one definition here, callable from two places:
 * `scripts/maintenance-worker.ts` (a one-shot CLI run) and the long-lived API
 * process (`startMaintenanceLoop`). It used to live only in the script, driven
 * by a Windows scheduled task whose `cmd` action flashed a console window every
 * 15 minutes; hosting it in the already-resident, windowless API process is what
 * removed the flash.
 *
 * Every pass writes to the state file (src/agent/maintenance-state.ts) whether
 * it succeeds or fails, so a loop that has silently stopped is detectable from
 * the CLI and the API instead of being noticed weeks later.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LLMClient } from '../core/llm-generator.js';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';
import { databasePath, queueDirectory } from '../core/paths.js';
import { createCodexClient } from '../core/llm-cli-client.js';
import { processMaintenanceQueue, type WorkerResult } from './maintenance-queue.js';
import { importCodexRollouts, defaultCodexSessionsDir, type CodexImportResult } from './codex-import.js';
import { importKimiSessions, defaultKimiHome, type KimiImportResult } from './kimi-import.js';
import {
  importOpenCodeSessions,
  type OpenCodeCommandRunner,
  type OpenCodeImportResult,
} from './opencode-import.js';
import { defaultStatePath, recordMaintenanceRun } from './maintenance-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

export interface MaintenancePassOptions {
  queueDir?: string;
  dbPath?: string;
  statePath?: string;
  /** Days of codex rollouts to sweep in. `false` skips the codex import entirely. */
  codexSinceDays?: number | false;
  /** Overrides `$CODEX_HOME/sessions`; mainly a test seam. */
  codexSessionsDir?: string;
  /** Days of Kimi Code sessions to sweep in. `false` skips Kimi. */
  kimiSinceDays?: number | false;
  /** Overrides `$KIMI_CODE_HOME`; mainly a test seam. */
  kimiHome?: string;
  /** Days of OpenCode sessions to sweep in. `false` skips OpenCode. */
  opencodeSinceDays?: number | false;
  /** Test seam for the otherwise local, logged-in OpenCode CLI. */
  opencodeRun?: OpenCodeCommandRunner;
  opencodeCommand?: string;
  client?: LLMClient;
  llmTimeoutMs?: number;
  maxJobs?: number;
  clock?: Clock;
  /** Recorded in the state file so two competing schedulers are visible. */
  runner?: string;
}

export interface MaintenancePassResult {
  codex?: CodexImportResult;
  codexError?: string;
  kimi?: KimiImportResult;
  kimiError?: string;
  opencode?: OpenCodeImportResult;
  opencodeError?: string;
  worker: WorkerResult;
}

export function defaultQueueDir(): string {
  return queueDirectory();
}

export function defaultDbPath(): string {
  return databasePath();
}

export function defaultLlmTimeoutMs(): number {
  return Number(process.env.HUMEMORY_MAINTENANCE_TIMEOUT_MS ?? 8_000);
}

export function configuredIntervalMs(): number {
  const raw = Number(process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
}

/**
 * The LLM the pass consolidates with. 'none' (the default) keeps consolidation
 * deterministic and network-free; there is no API key on the production machine
 * and none wanted, so 'codex' shells out to the logged-in CLI instead.
 */
export async function resolveMaintenanceClient(
  timeoutMs = defaultLlmTimeoutMs()
): Promise<LLMClient | undefined> {
  const provider = process.env.HUMEMORY_MAINTENANCE_LLM ?? 'none';

  if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    return new Anthropic() as unknown as LLMClient;
  }
  if (provider === 'codex') {
    // No API key needed: the logged-in `codex` CLI answers instead. Slower than
    // an SDK call (agent start-up), so it gets its own, larger budget.
    return createCodexClient({ timeoutMs });
  }
  return undefined;
}

/**
 * Import, then drain, then record. Every producer is isolated: a missing or
 * unreadable runtime must never stall the queue or another producer.
 *
 * Throws only if the queue itself could not be drained — the caller records
 * that failure and stays alive.
 */
export async function runMaintenancePass(
  options: MaintenancePassOptions = {}
): Promise<MaintenancePassResult> {
  const clock = options.clock ?? systemClock;
  const queueDir = options.queueDir ?? defaultQueueDir();
  const dbPath = options.dbPath ?? defaultDbPath();
  const statePath = options.statePath ?? defaultStatePath(queueDir);
  const llmTimeoutMs = options.llmTimeoutMs ?? defaultLlmTimeoutMs();
  const codexSinceDays = options.codexSinceDays ?? 1;
  const kimiSinceDays = options.kimiSinceDays ?? 1;
  const opencodeSinceDays = options.opencodeSinceDays ?? 1;
  const startedAt = clock.now();

  let codex: CodexImportResult | undefined;
  let codexError: string | undefined;
  if (codexSinceDays !== false) {
    try {
      codex = await importCodexRollouts({
        queueDir,
        sessionsDir: options.codexSessionsDir ?? defaultCodexSessionsDir(),
        since: new Date(startedAt.getTime() - codexSinceDays * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      codexError = (error as Error).message;
      console.error('[humemory] maintenance: codex import failed —', codexError);
    }
  }

  let kimi: KimiImportResult | undefined;
  let kimiError: string | undefined;
  if (kimiSinceDays !== false) {
    try {
      kimi = await importKimiSessions({
        queueDir,
        kimiHome: options.kimiHome ?? defaultKimiHome(),
        since: new Date(startedAt.getTime() - kimiSinceDays * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      kimiError = (error as Error).message;
      console.error('[humemory] maintenance: Kimi import failed —', kimiError);
    }
  }

  let opencode: OpenCodeImportResult | undefined;
  let opencodeError: string | undefined;
  if (opencodeSinceDays !== false) {
    try {
      opencode = await importOpenCodeSessions({
        queueDir,
        since: new Date(startedAt.getTime() - opencodeSinceDays * 24 * 60 * 60 * 1000),
        run: options.opencodeRun,
        command: options.opencodeCommand,
      });
    } catch (error) {
      opencodeError = (error as Error).message;
      console.error('[humemory] maintenance: OpenCode import failed —', opencodeError);
    }
  }

  try {
    const worker = await processMaintenanceQueue({
      queueDir,
      dbPath,
      client: options.client,
      llmTimeoutMs,
      maxJobs: options.maxJobs ?? Number(process.env.HUMEMORY_MAINTENANCE_BATCH ?? 20),
      now: () => clock.now(),
    });

    // A pass where every job failed is not a healthy pass. The queue isolates
    // jobs on purpose — a bad transcript must not stop the others — but that
    // isolation also makes an infrastructure failure (unopenable database, full
    // disk) look exactly like a batch of bad sessions. The queue no longer
    // dead-letters its way through an outage (retries are refunded and the
    // circuit breaker cuts the pass short), but silence would still leave the
    // machine broken and nothing consolidated, so the pass is recorded as a
    // failure and `maintenance status` says so.
    const wholesaleFailure = worker.discovered > 0 && worker.processed === 0 && worker.failed > 0;

    await recordMaintenanceRun({
      path: statePath,
      startedAt,
      clock,
      runner: options.runner,
      error: wholesaleFailure ? new Error(wholesaleFailureMessage(worker)) : undefined,
      result: {
        discovered: worker.discovered,
        processed: worker.processed,
        failed: worker.failed,
        deadLettered: worker.deadLettered,
        memoriesStored: worker.memoriesStored,
        busy: worker.busy,
        retriesRefunded: worker.retriesRefunded,
        aborted: worker.aborted,
      },
    });

    return { codex, codexError, kimi, kimiError, opencode, opencodeError, worker };
  } catch (error) {
    await recordMaintenanceRun({ path: statePath, startedAt, clock, runner: options.runner, error });
    throw error;
  }
}

/**
 * One line naming what the pass looked like, so `maintenance status` can be
 * read without opening the queue directory.
 */
function wholesaleFailureMessage(worker: WorkerResult): string {
  const scope = worker.aborted
    ? `pass aborted after ${worker.failed} consecutive failures`
    : `every job failed this pass (${worker.failed}/${worker.discovered})`;
  const budget = worker.retriesRefunded > 0
    ? `; ${worker.retriesRefunded} retry(ies) refunded, nothing dead-lettered`
    : '';
  return `${scope} — suspect the database or the disk, not the sessions${budget}`;
}

/** Minimal timer seam, so the loop is testable without waiting on wall time. */
export interface TimerLike {
  setInterval(handler: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const REAL_TIMERS: TimerLike = {
  setInterval: (handler, ms) => {
    const handle = setInterval(handler, ms);
    // Maintenance alone is no reason to hold the process alive.
    if (typeof (handle as { unref?: () => void }).unref === 'function') {
      (handle as unknown as { unref: () => void }).unref();
    }
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export interface MaintenanceLoop {
  /** Runs a pass now, outside the schedule. Resolves once it has finished. */
  runNow(): Promise<void>;
  stop(): void;
  /** True while a pass is in flight — the next tick is suppressed until it clears. */
  readonly busy: boolean;
}

export interface MaintenanceLoopOptions extends MaintenancePassOptions {
  intervalMs?: number;
  /** Run one pass immediately instead of waiting a full interval. */
  runAtStart?: boolean;
  timers?: TimerLike;
}

/**
 * Run a pass every `intervalMs` inside the calling process. The API process is
 * already resident and windowless, so hosting the loop there spawns nothing —
 * which is the whole point of moving it off the Windows scheduler.
 *
 * Three properties this guarantees, each covered by a test:
 *  - passes never overlap, on top of the queue's own cross-process lock;
 *  - a throwing pass is contained and the loop keeps ticking, because the API
 *    must not die of a bad session transcript;
 *  - every pass, good or bad, lands in the state file.
 */
export function startMaintenanceLoop(options: MaintenanceLoopOptions = {}): MaintenanceLoop {
  const intervalMs = options.intervalMs ?? configuredIntervalMs();
  const timers = options.timers ?? REAL_TIMERS;
  let running = false;
  let stopped = false;

  const pass = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const client = options.client ?? await resolveMaintenanceClient(options.llmTimeoutMs);
      const { worker } = await runMaintenancePass({ ...options, client, runner: options.runner ?? 'api-loop' });
      if (process.env.HUMEMORY_VERBOSE === '1' || worker.failed > 0) {
        console.error(
          `[humemory] maintenance: ${worker.processed}/${worker.discovered} jobs, ` +
          `${worker.memoriesStored} memories, ${worker.failed} failed, ${worker.deadLettered} dead-lettered` +
          (worker.aborted ? ' (pass aborted — suspected outage)' : '')
        );
      }
    } catch (error) {
      // Contained on purpose: a crashing pass must never take the API down.
      // The failure is already in the state file, so it stays visible.
      console.error('[humemory] maintenance pass failed —', (error as Error).message);
    } finally {
      running = false;
    }
  };

  const handle = timers.setInterval(() => void pass(), intervalMs);
  if (options.runAtStart) void pass();

  return {
    runNow: pass,
    get busy() {
      return running;
    },
    stop() {
      stopped = true;
      timers.clearInterval(handle);
    },
  };
}
