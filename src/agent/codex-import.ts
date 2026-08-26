/**
 * Imports Codex CLI rollouts into the maintenance queue.
 *
 * Acquisition stays outside the cognitive core: this only decides *which files
 * are candidate sessions* and hands their raw bytes to `enqueueSession`. What
 * becomes a trace, how it decays and when it resurfaces is still the store's
 * business, decided later by the worker — the same path a Claude `Stop` hook
 * feeds.
 *
 * Re-importing is safe: a queue job is keyed on `source + sessionId`, and the
 * worker keeps a per-session checkpoint, so a rollout that grew since the last
 * pass contributes only its new messages.
 */

import { readdir, readFile, stat } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { enqueueSession } from './maintenance-queue.js';
import { isSubagentThread, parseCodexRollout, readCodexRolloutMeta } from './codex-rollout-parser.js';

/** Marks these jobs as coming from a rollout sweep rather than a live hook. */
export const CODEX_SOURCE = 'codex-rollout';

export interface CodexImportOptions {
  queueDir: string;
  /** Defaults to `$CODEX_HOME/sessions`, else `~/.codex/sessions`. */
  sessionsDir?: string;
  /** Only rollouts modified at or after this instant. */
  since?: Date;
  /** Stop after this many *queued* sessions. */
  limit?: number;
  /** Threads Codex spawned for itself (judges, reviews) are excluded by default. */
  includeSubagents?: boolean;
  /** Scan and report without writing to the queue. */
  dryRun?: boolean;
  maxLearnings?: number;
}

export interface CodexImportResult {
  scanned: number;
  queued: number;
  created: number;
  skippedSubagent: number;
  skippedEmpty: number;
  skippedOld: number;
  unreadable: number;
}

export function defaultCodexSessionsDir(): string {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(home, 'sessions');
}

/** Rollout files, depth-first through the YYYY/MM/DD tree. */
async function findRollouts(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // No codex on this machine, or no session ever recorded.
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findRollouts(path)));
    else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) found.push(path);
  }
  return found;
}

export async function importCodexRollouts(options: CodexImportOptions): Promise<CodexImportResult> {
  const sessionsDir = options.sessionsDir ?? defaultCodexSessionsDir();
  const result: CodexImportResult = {
    scanned: 0, queued: 0, created: 0,
    skippedSubagent: 0, skippedEmpty: 0, skippedOld: 0, unreadable: 0,
  };

  const files = (await findRollouts(sessionsDir)).sort();

  for (const file of files) {
    if (options.limit !== undefined && result.queued >= options.limit) break;
    result.scanned += 1;

    try {
      if (options.since) {
        const { mtime } = await stat(file);
        if (mtime < options.since) {
          result.skippedOld += 1;
          continue;
        }
      }

      const raw = await readFile(file, 'utf-8');
      const meta = readCodexRolloutMeta(raw);
      if (!options.includeSubagents && isSubagentThread(meta)) {
        result.skippedSubagent += 1;
        continue;
      }

      // A rollout with no human turn and no answer holds nothing to learn from:
      // an aborted start, or a thread that only ran tools.
      const parsed = parseCodexRollout(raw, meta?.directory ?? sessionsDir);
      if (parsed.messages.length === 0) {
        result.skippedEmpty += 1;
        continue;
      }

      if (options.dryRun) {
        result.queued += 1;
        continue;
      }

      const { created } = await enqueueSession(raw, {
        queueDir: options.queueDir,
        directory: parsed.directory,
        source: CODEX_SOURCE,
        agent: 'codex',
        maxLearnings: options.maxLearnings,
      });
      result.queued += 1;
      if (created) result.created += 1;
    } catch {
      // A rollout being written to, or one this user cannot read: never fatal.
      result.unreadable += 1;
    }
  }

  return result;
}
