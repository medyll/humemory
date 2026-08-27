import { createHash, randomUUID } from 'crypto';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { LLMClient } from '../core/llm-generator.js';
import { processSession } from './claude-hook.js';
import { parseAgentSession } from './session-parser.js';

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
  /** Set when the job was moved to dead-letter; absent on a live job. */
  deadLetteredAt?: string;
  /** Set when a dead-letter was put back in the queue by hand. */
  requeuedAt?: string;
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
  /**
   * Consecutive job failures that trip the circuit breaker and end the pass.
   * `false` disables the breaker. See `processMaintenanceQueue`.
   */
  failureThreshold?: number | false;
  now?: () => Date;
}

export interface WorkerResult {
  discovered: number;
  processed: number;
  failed: number;
  deadLettered: number;
  memoriesStored: number;
  busy: boolean;
  /** Failures that look like the machine, not the transcript — these cost no retry. */
  infrastructureFailures: number;
  /** Retries handed back because the failure was an outage rather than a bad job. */
  retriesRefunded: number;
  /** True when the circuit breaker cut the pass short instead of working the queue. */
  aborted: boolean;
}

const DEFAULT_LOCK_STALE_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_FAILURE_THRESHOLD = 3;
const DEAD_LETTER_SUFFIX = '.dead.json';
const PROCESSING_SUFFIX = '.processing';
const CHECKPOINT_DIR = 'checkpoints';

/**
 * Why a job failed, as far as the retry budget is concerned.
 *
 * `job` — this transcript is the problem, and every future pass will fail on it
 * the same way. Retrying a few times then dead-lettering is right.
 *
 * `infrastructure` — the machine is the problem (the database will not open,
 * the disk is full, the file is locked). Every job in the queue would fail the
 * same way right now and all of them would succeed once the machine is fixed,
 * so burning a retry punishes the session for an outage it had no part in.
 */
export type FailureKind = 'job' | 'infrastructure';

/** errno values that mean "the machine", never "this transcript". */
const INFRASTRUCTURE_CODES = new Set([
  'EACCES', 'EAGAIN', 'EBUSY', 'EDQUOT', 'EIO', 'EISDIR', 'EMFILE',
  'ENFILE', 'ENOMEM', 'ENOSPC', 'EPERM', 'EROFS', 'ETIMEDOUT',
]);

const INFRASTRUCTURE_PATTERNS = [
  /unable to open database/i,
  /database is locked/i,
  /database disk image is malformed/i,
  /attempt to write a readonly database/i,
  /disk i\/o error/i,
  /no space left/i,
  /out of memory/i,
  /too many open files/i,
  /read-?only file system/i,
];

/**
 * Classify a failure so an outage does not consume the queue's retry budget.
 *
 * Deliberately biased towards `job`: mislabelling a bad transcript as an outage
 * only costs a few wasted passes, while mislabelling an outage as a bad job
 * dead-letters real sessions permanently. Anything not recognisably about the
 * machine is therefore treated as being about the transcript.
 */
export function classifyMaintenanceFailure(error: unknown): FailureKind {
  const err = error as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown } | null;
  if (!err || typeof err !== 'object') return 'job';

  const message = typeof err.message === 'string' ? err.message : String(error);
  if (INFRASTRUCTURE_PATTERNS.some((pattern) => pattern.test(message))) return 'infrastructure';
  if (typeof err.code === 'string') {
    if (INFRASTRUCTURE_CODES.has(err.code)) return 'infrastructure';
    // bun:sqlite reports the extended result code, e.g. SQLITE_CANTOPEN_ISDIR.
    if (err.code.startsWith('SQLITE_') && !err.code.startsWith('SQLITE_CONSTRAINT')) return 'infrastructure';
  }
  // A constraint violation is a schema bug, not an outage — retrying cannot fix
  // it, so it stays on the job's own budget. Every other SQLite error is the
  // storage layer refusing to work at all.
  if (err.name === 'SQLiteError' && !/constraint/i.test(message)) return 'infrastructure';
  if (err.cause !== undefined && err.cause !== err) return classifyMaintenanceFailure(err.cause);
  return 'job';
}

function emptyResult(): WorkerResult {
  return {
    discovered: 0,
    processed: 0,
    failed: 0,
    deadLettered: 0,
    memoriesStored: 0,
    busy: false,
    infrastructureFailures: 0,
    retriesRefunded: 0,
    aborted: false,
  };
}

/** One failed job, held until the end of the pass so the verdict has full context. */
interface PendingFailure {
  path: string;
  claimed: string;
  job: MaintenanceJob;
  lastError: string;
  kind: FailureKind;
}

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
  const parsed = parseAgentSession(rawTranscript, directory);
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
      return { ...emptyResult(), busy: true };
    }
  }

  if (!lock) return { ...emptyResult(), busy: true };

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

    const result: WorkerResult = { ...emptyResult(), discovered: files.length };
    const failureThreshold = options.failureThreshold === false
      ? Number.POSITIVE_INFINITY
      : options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    // Failures are held rather than settled on the spot: whether a retry should
    // be charged depends on how the *pass* ended, which is not known until the
    // loop is over. See the finalisation block below.
    const pending: PendingFailure[] = [];
    let consecutiveFailures = 0;

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
        consecutiveFailures = 0;
      } catch (error) {
        result.failed += 1;
        consecutiveFailures += 1;
        const lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        const kind = classifyMaintenanceFailure(error);
        if (kind === 'infrastructure') result.infrastructureFailures += 1;
        try {
          if (!job) {
            // Unparseable on disk: no attempt counter can live in it, so retrying
            // is pointless. Dead-letter the raw bytes immediately rather than
            // failing this file on every future pass.
            await rename(claimed, join(options.queueDir, `${file.replace(/\.json$/, '')}${DEAD_LETTER_SUFFIX}`));
            result.deadLettered += 1;
          } else {
            pending.push({ path, claimed, job, lastError, kind });
          }
        } catch {
          // Never erase evidence: the claimed file stays for manual inspection
          // and the orphan sweep restores it on the next pass.
        }

        // Circuit breaker. Working through the rest of the queue during an
        // outage is how every queued session used to burn its retries in a
        // single afternoon; a run of failures this long is far more likely to
        // be the machine than a coincidence of bad transcripts, so stop and
        // leave the untouched jobs for the next pass.
        if (consecutiveFailures >= failureThreshold) {
          result.aborted = true;
          break;
        }
      }
    }

    // A pass that aborted without encoding anything is an outage by definition,
    // whatever the individual error messages happened to look like: refund those
    // retries too, so an unrecognised failure mode cannot drain the queue either.
    const wholesaleFailure = result.aborted && result.processed === 0;
    for (const entry of pending) {
      const refund = entry.kind === 'infrastructure' || wholesaleFailure;
      try {
        entry.job.lastError = entry.lastError;
        if (refund) {
          result.retriesRefunded += 1;
        } else {
          entry.job.attempts = (entry.job.attempts ?? 0) + 1;
        }

        if (!refund && entry.job.attempts >= maxAttempts) {
          // Exhausted retries: move out of the active queue so it stops being
          // picked up and stops inflating `failed` on every future pass, but
          // keep the raw transcript on disk for manual inspection.
          entry.job.deadLetteredAt = now().toISOString();
          await atomicWrite(join(options.queueDir, `${entry.job.id}${DEAD_LETTER_SUFFIX}`), JSON.stringify(entry.job));
          await rm(entry.claimed, { force: true });
          result.deadLettered += 1;
        } else {
          // Restore for a later pass — unless a newer transcript already took
          // the slot, which supersedes this one.
          try {
            await stat(entry.path);
            await rm(entry.claimed, { force: true });
          } catch {
            await atomicWrite(entry.path, JSON.stringify(entry.job));
            await rm(entry.claimed, { force: true });
          }
        }
      } catch {
        // Never erase evidence: the claimed file stays for manual inspection
        // and the orphan sweep restores it on the next pass.
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


// === DEAD-LETTER RECOVERY ===

export interface DeadLetter {
  /** Filename in the queue directory, so a caller can name one precisely. */
  file: string;
  id: string;
  /** Absent when the file could not be parsed — the bytes are still there. */
  job?: MaintenanceJob;
  sessionId?: string;
  source?: string;
  attempts?: number;
  lastError?: string;
  deadLetteredAt?: string;
}

export interface RequeueOptions {
  queueDir: string;
  /**
   * Restrict to these dead-letters. Each entry matches a job id, a session id,
   * or a filename. Omitted means every dead-letter in the directory.
   */
  ids?: string[];
  /** Report what would happen and write nothing. */
  dryRun?: boolean;
  limit?: number;
  now?: () => Date;
}

export interface RequeueResult {
  scanned: number;
  requeued: number;
  /** A live job already holds the slot — the newer transcript wins, so the dead-letter is left alone. */
  skippedLive: number;
  /** The file is not a usable job; requeuing it would only dead-letter it again. */
  unreadable: number;
  /** What was (or would be) put back. */
  entries: DeadLetter[];
}

function toDeadLetter(file: string, raw: string): DeadLetter {
  const id = file.slice(0, -DEAD_LETTER_SUFFIX.length);
  try {
    const job = JSON.parse(raw) as MaintenanceJob;
    if (job?.version !== 1 || !job.rawTranscript || typeof job.id !== 'string') return { file, id };
    return {
      file,
      id: job.id,
      job,
      sessionId: job.sessionId,
      source: job.source,
      attempts: job.attempts,
      lastError: job.lastError,
      deadLetteredAt: job.deadLetteredAt,
    };
  } catch {
    return { file, id };
  }
}

/** Everything currently parked in dead-letter, newest failure first. */
export async function listDeadLetters(queueDir: string): Promise<DeadLetter[]> {
  let files: string[];
  try {
    files = (await readdir(queueDir)).filter((file) => file.endsWith(DEAD_LETTER_SUFFIX));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const entries = await Promise.all(
    files.map(async (file) => toDeadLetter(file, await readFile(join(queueDir, file), 'utf8').catch(() => ''))),
  );
  return entries.sort((a, b) => (b.deadLetteredAt ?? '').localeCompare(a.deadLetteredAt ?? ''));
}

/**
 * Put dead-lettered jobs back in the queue with a fresh retry budget.
 *
 * Dead-lettering is not always a verdict on the transcript: before the retry
 * budget learned to tell an outage from a bad job, a single unopenable database
 * could park an entire afternoon of sessions in `.dead.json` files that nothing
 * would ever look at again. This is the way back, and the reason the raw
 * transcript is kept on disk rather than deleted.
 *
 * Restoring resets `attempts` to 0 — the point is a clean chance now that
 * whatever broke has been fixed. A dead-letter whose slot is already held by a
 * live job is left alone: that job carries a newer transcript for the same
 * session and supersedes it.
 */
export async function requeueDeadLetters(options: RequeueOptions): Promise<RequeueResult> {
  const now = options.now ?? (() => new Date());
  const wanted = options.ids?.length ? new Set(options.ids) : undefined;
  const result: RequeueResult = { scanned: 0, requeued: 0, skippedLive: 0, unreadable: 0, entries: [] };

  const all = await listDeadLetters(options.queueDir);
  const selected = wanted
    ? all.filter((entry) => wanted.has(entry.id) || wanted.has(entry.file) || (entry.sessionId !== undefined && wanted.has(entry.sessionId)))
    : all;

  for (const entry of selected) {
    if (options.limit !== undefined && result.requeued >= options.limit) break;
    result.scanned += 1;

    if (!entry.job) {
      result.unreadable += 1;
      continue;
    }

    const live = jobPath(options.queueDir, entry.job.id);
    try {
      await stat(live);
      result.skippedLive += 1;
      continue;
    } catch {
      // Slot is free — the dead-letter is still the best copy of this session.
    }

    result.entries.push(entry);
    result.requeued += 1;
    if (options.dryRun) continue;

    const job: MaintenanceJob = { ...entry.job, attempts: 0, requeuedAt: now().toISOString() };
    delete job.lastError;
    delete job.deadLetteredAt;
    await atomicWrite(live, JSON.stringify(job));
    await rm(join(options.queueDir, entry.file), { force: true });
  }

  return result;
}
