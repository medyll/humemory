/**
 * Durable record of how maintenance is actually going.
 *
 * Without this, a stopped maintenance loop is invisible: the queue simply stops
 * draining and nothing says so until someone notices memories are missing. The
 * state file is the answer to "is consolidation still alive, and since when".
 *
 * It is a plain JSON file rather than a table on purpose. This is the health
 * signal *about* the system, so it must not depend on the part of the system
 * most likely to be broken — a locked or corrupt database still leaves a
 * readable answer here. Writes are atomic (temp file + rename) so a crash
 * mid-write cannot leave a truncated state behind.
 */

import { readFile, rename, writeFile, mkdir } from 'fs/promises';
import { dirname, join } from 'path';
import type { Clock } from '../core/clock.js';
import { systemClock } from '../core/clock.js';

/** A pass is considered overdue at four intervals without a success. */
export const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000;

export interface MaintenanceState {
  /** Start of the most recent pass, successful or not. */
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastDurationMs?: number;
  /** Reset to 0 by any success — a non-zero value means the loop is degraded, not dead. */
  consecutiveFailures: number;
  /** Message only, never a stack: this is read back over the API. */
  lastError?: string;
  lastResult?: {
    discovered: number;
    processed: number;
    failed: number;
    deadLettered: number;
    memoriesStored: number;
    /** True when another worker held the lock — not a failure. */
    busy: boolean;
  };
  /** Which process last wrote here, so two schedulers fighting is visible. */
  lastRunner?: string;
}

const EMPTY: MaintenanceState = { consecutiveFailures: 0 };

export function defaultStatePath(queueDir: string): string {
  return join(dirname(queueDir), 'maintenance-state.json');
}

/**
 * Never throws: an absent file is a fresh install, and a corrupt one must not
 * take down the caller that is merely asking for a status.
 */
export async function readMaintenanceState(path: string): Promise<MaintenanceState> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as MaintenanceState;
    if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
    return { ...EMPTY, ...parsed };
  } catch {
    return { ...EMPTY };
  }
}

async function writeAtomic(path: string, state: MaintenanceState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, path);
}

export interface RecordRunOptions {
  path: string;
  startedAt: Date;
  clock?: Clock;
  runner?: string;
  result?: MaintenanceState['lastResult'];
  error?: unknown;
}

/**
 * Fold one pass into the state file. Recording is best-effort by design: a
 * read-only disk must degrade observability, never stop consolidation.
 */
export async function recordMaintenanceRun(options: RecordRunOptions): Promise<MaintenanceState> {
  const clock = options.clock ?? systemClock;
  const previous = await readMaintenanceState(options.path);
  const finishedAt = clock.now();
  const succeeded = options.error === undefined;

  const next: MaintenanceState = {
    ...previous,
    lastRunAt: options.startedAt.toISOString(),
    lastDurationMs: Math.max(0, finishedAt.getTime() - options.startedAt.getTime()),
    consecutiveFailures: succeeded ? 0 : previous.consecutiveFailures + 1,
    lastRunner: options.runner ?? previous.lastRunner,
  };

  // Counts are recorded either way: a pass that failed wholesale still says how
  // many jobs it saw, which is the first thing to look at when diagnosing it.
  if (options.result) next.lastResult = options.result;

  if (succeeded) {
    next.lastSuccessAt = finishedAt.toISOString();
    delete next.lastError;
  } else {
    next.lastError = options.error instanceof Error ? options.error.message : String(options.error);
  }

  try {
    await writeAtomic(options.path, next);
  } catch (error) {
    console.error('[humemory] maintenance: could not record state —', (error as Error).message);
  }
  return next;
}

export interface MaintenanceHealth {
  /** No success ever, or the last one is older than the staleness budget. */
  stale: boolean;
  /** Milliseconds since the last success; undefined when there has never been one. */
  ageMs?: number;
  consecutiveFailures: number;
  lastSuccessAt?: string;
  lastRunAt?: string;
  lastError?: string;
  lastResult?: MaintenanceState['lastResult'];
  /** One line a human can act on. */
  summary: string;
}

export function assessMaintenance(
  state: MaintenanceState,
  options: { staleAfterMs?: number; clock?: Clock } = {}
): MaintenanceHealth {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = (options.clock ?? systemClock).now().getTime();
  const lastSuccess = state.lastSuccessAt ? Date.parse(state.lastSuccessAt) : undefined;
  const ageMs = lastSuccess !== undefined && Number.isFinite(lastSuccess) ? now - lastSuccess : undefined;
  const stale = ageMs === undefined || ageMs > staleAfterMs;

  let summary: string;
  if (ageMs === undefined) {
    summary = 'no maintenance pass has ever succeeded';
  } else if (stale) {
    summary = `last success ${Math.round(ageMs / 60_000)} min ago — over the ${Math.round(staleAfterMs / 60_000)} min budget`;
  } else {
    summary = `healthy — last success ${Math.round(ageMs / 60_000)} min ago`;
  }
  if (state.consecutiveFailures > 0) {
    summary += `, ${state.consecutiveFailures} consecutive failure(s)`;
  }

  return {
    stale,
    ageMs,
    consecutiveFailures: state.consecutiveFailures,
    lastSuccessAt: state.lastSuccessAt,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastResult: state.lastResult,
    summary,
  };
}
