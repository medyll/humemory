import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LLMClient } from '../core/llm-generator.js';
import { processSession } from './claude-hook.js';
import { parseClaudeHookPayload } from './session-parser.js';

export interface MaintenanceJob {
  version: 1;
  id: string;
  source: string;
  agent: string;
  sessionId: string;
  directory: string;
  rawTranscript: string;
  maxLearnings: number;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

export interface EnqueueOptions {
  queueDir: string;
  directory?: string;
  source?: string;
  agent?: string;
  maxLearnings?: number;
  now?: () => Date;
}

export interface QueueResult {
  job: MaintenanceJob;
  created: boolean;
  path: string;
}

export interface WorkerOptions {
  queueDir: string;
  dbPath: string;
  client?: LLMClient;
  llmTimeoutMs?: number;
  maxJobs?: number;
  lockStaleMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export interface WorkerResult {
  discovered: number;
  processed: number;
  failed: number;
  deadLettered: number;
  memoriesStored: number;
  busy: boolean;
}

const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEAD_LETTER_SUFFIX = '.dead.json';
const PROCESSING_SUFFIX = '.processing';
const CHECKPOINT_DIR = 'checkpoints';

interface SessionCheckpoint {
  sessionId: string;
  messagesSeen: number;
  updatedAt: string;
}

function jobPath(queueDir: string, id: string): string {
  return join(queueDir, `${id}.json`);
}

function checkpointPath(queueDir: string, id: string): string {
  return join(queueDir, CHECKPOINT_DIR, `${id}.json`);
}

async function readCheckpoint(queueDir: string, id: string): Promise<SessionCheckpoint | null> {
  try {
    return JSON.parse(await readFile(checkpointPath(queueDir, id), 'utf8')) as SessionCheckpoint;
  } catch {
    return null;
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error: any) {
    if (error?.code !== 'EEXIST' && error?.code !== 'EPERM') throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

export async function enqueueSession(rawTranscript: string, options: EnqueueOptions): Promise<QueueResult> {
  const raw = rawTranscript.trim();
  if (!raw) throw new Error('Cannot queue an empty session');

  const directory = options.directory ?? process.cwd();
  const parsed = parseClaudeHookPayload(rawTranscript, directory);
  const source = options.source ?? 'claude-code';
  // Keyed on session, not transcript content: `Stop` fires once per turn and the
  // transcript grows each time, so hashing the raw text would enqueue one job
  // per turn instead of one per session. Re-enqueuing overwrites with the
  // latest (fuller) transcript and resets attempts — new content, new chance.
  const id = createHash('sha256').update(`${source}\0${parsed.sessionId}`).digest('hex');
  const path = jobPath(options.queueDir, id);
  const now = options.now ?? (() => new Date());
  const job: MaintenanceJob = {
    version: 1,
    id,
    source,
    agent: options.agent ?? source,
    sessionId: parsed.sessionId,
    directory: parsed.directory,
    rawTranscript,
    maxLearnings: options.maxLearnings ?? 5,
    queuedAt: now().toISOString(),
    attempts: 0,
  };

  await mkdir(options.queueDir, { recursive: true });
  let created = true;
  try {
    await readFile(path, 'utf8');
    created = false;
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await atomicWrite(path, JSON.stringify(job));
  return { job, created, path };
}

export async function processMaintenanceQueue(options: WorkerOptions): Promise<WorkerResult> {
  await mkdir(options.queueDir, { recursive: true });
  await mkdir(join(options.queueDir, CHECKPOINT_DIR), { recursive: true });
  const now = options.now ?? (() => new Date());
  const lockPath = join(options.queueDir, '.worker.lock');
  const token = `${process.pid}-${randomUUID()}`;
  let lock;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lock = await open(lockPath, 'wx', 0o600);
      await lock.writeFile(JSON.stringify({ pid: process.pid, token, startedAt: now().toISOString() }));
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const age = now().getTime() - (await stat(lockPath)).mtimeMs;
      if (attempt === 0 && age > (options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS)) {
        // Atomic takeover: renaming the stale lock away can only succeed once,
        // so two workers seeing the same stale lock cannot both reclaim it. A
        // plain unlink would instead delete a lock the winner just acquired.
        try {
          await rename(lockPath, `${lockPath}.stale.${token}`);
          await rm(`${lockPath}.stale.${token}`, { force: true });
        } catch (renameError: any) {
          if (renameError?.code !== 'ENOENT') throw renameError;
          // Another worker won the takeover; the retry below will see its lock.
        }
        continue;
      }
      return { discovered: 0, processed: 0, failed: 0, deadLettered: 0, memoriesStored: 0, busy: true };
    }
  }

  if (!lock) return { discovered: 0, processed: 0, failed: 0, deadLettered: 0, memoriesStored: 0, busy: true };

  try {
    const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

    // We hold the exclusive lock, so any leftover `.processing` file belongs to
    // a worker that died mid-job. Restore it unless a newer session arrived in
    // the meantime, in which case the newer transcript supersedes it.
    for (const orphan of (await readdir(options.queueDir)).filter((file) => file.endsWith(PROCESSING_SUFFIX))) {
      const orphanPath = join(options.queueDir, orphan);
      const restored = join(options.queueDir, orphan.slice(0, -PROCESSING_SUFFIX.length));
      try {
        await stat(restored);
        await rm(orphanPath, { force: true });
      } catch {
        await rename(orphanPath, restored).catch(() => undefined);
      }
    }

    const candidates = (await readdir(options.queueDir)).filter((file) => file.endsWith('.json') && !file.endsWith(DEAD_LETTER_SUFFIX));
    const withMeta = await Promise.all(
      candidates.map(async (file) => {
        const path = join(options.queueDir, file);
        try {
          const job = JSON.parse(await readFile(path, 'utf8')) as MaintenanceJob;
          return { file, path, queuedAt: job.queuedAt ?? '' };
        } catch {
          return { file, path, queuedAt: '' };
        }
      }),
    );
    // Oldest-first: queuedAt is the enqueue timestamp, not the filename (a
    // sha256 id sorts arbitrarily and would starve unlucky hashes forever).
    const files = withMeta
      .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))
      .slice(0, options.maxJobs ?? 20)
      .map((entry) => entry.file);

    const result: WorkerResult = {
      discovered: files.length,
      processed: 0,
      failed: 0,
      deadLettered: 0,
      memoriesStored: 0,
      busy: false,
    };

    for (const file of files) {
      const path = join(options.queueDir, file);
      // Claim the job by moving it aside. The hook may enqueue a newer, longer
      // transcript for the same session while we work; it lands on the now-free
      // job path and survives, instead of being deleted by our own cleanup.
      const claimed = `${path}${PROCESSING_SUFFIX}`;
      try {
        await rename(path, claimed);
      } catch {
        continue; // Vanished between listing and claiming — nothing to do.
      }

      let job: MaintenanceJob | undefined;
      try {
        job = JSON.parse(await readFile(claimed, 'utf8')) as MaintenanceJob;
        if (job.version !== 1 || !job.rawTranscript) throw new Error('Unsupported maintenance job');
        const checkpoint = await readCheckpoint(options.queueDir, job.id);
        const processed = await processSession(job.rawTranscript, {
          dbPath: options.dbPath,
          directory: job.directory,
          maxLearnings: job.maxLearnings,
          client: options.client,
          llmTimeoutMs: options.llmTimeoutMs,
          source: 'hook',
          agent: job.agent,
          sinceMessage: checkpoint?.messagesSeen ?? 0,
        });
        // Record how far this session has been encoded before dropping the job,
        // so a later `Stop` resending the full transcript only adds the delta.
        await atomicWrite(
          checkpointPath(options.queueDir, job.id),
          JSON.stringify({ sessionId: job.sessionId, messagesSeen: processed.messagesSeen, updatedAt: now().toISOString() } satisfies SessionCheckpoint),
        );
        await rm(claimed, { force: true });
        result.processed += 1;
        result.memoriesStored += processed.memoriesStored;
      } catch (error) {
        result.failed += 1;
        const lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        try {
          if (!job) {
            // Unparseable on disk: no attempt counter can live in it, so retrying
            // is pointless. Dead-letter the raw bytes immediately rather than
            // failing this file on every future pass.
            await rename(claimed, join(options.queueDir, `${file.replace(/\.json$/, '')}${DEAD_LETTER_SUFFIX}`));
            result.deadLettered += 1;
            continue;
          }
          job.attempts = (job.attempts ?? 0) + 1;
          job.lastError = lastError;
          if (job.attempts >= maxAttempts) {
            // Exhausted retries: move out of the active queue so it stops being
            // picked up and stops inflating `failed` on every future pass, but
            // keep the raw transcript on disk for manual inspection.
            await atomicWrite(join(options.queueDir, `${job.id}${DEAD_LETTER_SUFFIX}`), JSON.stringify(job));
            await rm(claimed, { force: true });
            result.deadLettered += 1;
          } else {
            // Restore for a later pass — unless a newer transcript already took
            // the slot, which supersedes this one.
            try {
              await stat(path);
              await rm(claimed, { force: true });
            } catch {
              await atomicWrite(path, JSON.stringify(job));
              await rm(claimed, { force: true });
            }
          }
        } catch {
          // Never erase evidence: the claimed file stays for manual inspection
          // and the orphan sweep restores it on the next pass.
        }
      }
    }

    return result;
  } finally {
    await lock.close();
    // Only release a lock still held by this worker: if ours went stale and was
    // reclaimed, the file now belongs to whoever took over.
    try {
      const held = JSON.parse(await readFile(lockPath, 'utf8'));
      if (held?.token === token) await rm(lockPath, { force: true });
    } catch {
      // Already gone or unreadable — nothing of ours left to release.
    }
  }
}
