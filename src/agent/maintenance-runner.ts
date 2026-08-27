/**
 * One maintenance pass: pull in what the local agents wrote since last time,
 * then drain the queue into memory.
 *
 * This exists so the pass has exactly one definition, callable from two places:
 * `scripts/maintenance-worker.ts` (a one-shot CLI run) and the long-lived API
 * process (`startMaintenanceLoop`). It used to live only in the script, driven
 * by a Windows scheduled task whose `cmd` action flashed a console window every
 * 15 minutes.
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LLMClient } from '../core/llm-generator.js';
import { createCodexClient } from '../core/llm-cli-client.js';
import { processMaintenanceQueue, type WorkerResult } from './maintenance-queue.js';
import { importCodexRollouts, defaultCodexSessionsDir, type CodexImportResult } from './codex-import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface MaintenancePassOptions {
  queueDir?: string;
  dbPath?: string;
  /** Days of codex rollouts to sweep in. `false` skips the codex import entirely. */
  codexSinceDays?: number | false;
  client?: LLMClient;
  llmTimeoutMs?: number;
  maxJobs?: number;
}

export interface MaintenancePassResult {
  codex?: CodexImportResult;
  worker: WorkerResult;
}

export function defaultQueueDir(): string {
  return process.env.HUMEMORY_QUEUE ?? join(__dirname, '../../data/maintenance-queue');
}

export function defaultDbPath(): string {
  return process.env.HUMEMORY_DB ?? join(__dirname, '../../data/humemory.db');
}

export function defaultLlmTimeoutMs(): number {
  return Number(process.env.HUMEMORY_MAINTENANCE_TIMEOUT_MS ?? 8_000);
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

/** Import, then drain. Never throws on the import half — a missing codex must not stall the queue. */
export async function runMaintenancePass(
  options: MaintenancePassOptions = {}
): Promise<MaintenancePassResult> {
  const queueDir = options.queueDir ?? defaultQueueDir();
  const dbPath = options.dbPath ?? defaultDbPath();
  const llmTimeoutMs = options.llmTimeoutMs ?? defaultLlmTimeoutMs();
  const sinceDays = options.codexSinceDays ?? 1;

  let codex: CodexImportResult | undefined;
  if (sinceDays !== false) {
    try {
      codex = await importCodexRollouts({
        queueDir,
        sessionsDir: defaultCodexSessionsDir(),
        since: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000),
      });
    } catch (error) {
      console.error('[humemory] maintenance: codex import failed —', (error as Error).message);
    }
  }

  const worker = await processMaintenanceQueue({
    queueDir,
    dbPath,
    client: options.client,
    llmTimeoutMs,
    maxJobs: options.maxJobs ?? Number(process.env.HUMEMORY_MAINTENANCE_BATCH ?? 20),
  });

  return { codex, worker };
}

export interface MaintenanceLoop {
  stop(): void;
}

/**
 * Run a pass every `intervalMs` inside the calling process. The API process is
 * already resident and windowless, so hosting the loop there costs nothing and
 * spawns nothing — which is the entire point of moving it off the scheduler.
 *
 * Passes never overlap: a run still in flight suppresses the next tick, on top
 * of the queue's own cross-process lock.
 */
export function startMaintenanceLoop(options: MaintenancePassOptions & {
  intervalMs?: number;
  /** Wait one interval before the first pass (default) or run one at start-up. */
  runAtStart?: boolean;
} = {}): MaintenanceLoop {
  const intervalMs = options.intervalMs ?? Number(process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS ?? 15 * 60 * 1000);
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const client = options.client ?? await resolveMaintenanceClient(options.llmTimeoutMs);
      const { worker } = await runMaintenancePass({ ...options, client });
      if (process.env.HUMEMORY_VERBOSE === '1' || worker.failed > 0) {
        console.error(
          `[humemory] maintenance: ${worker.processed}/${worker.discovered} jobs, ` +
          `${worker.memoriesStored} memories, ${worker.failed} failed, ${worker.deadLettered} dead-lettered`
        );
      }
    } catch (error) {
      // A crashing pass must never take the API down with it.
      console.error('[humemory] maintenance pass failed —', (error as Error).message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Maintenance alone is no reason to hold the process alive.
  if (typeof timer.unref === 'function') timer.unref();
  if (options.runAtStart) void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
