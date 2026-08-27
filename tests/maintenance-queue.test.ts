import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteStore } from '../src/store/sqlite.js';
import {
  classifyMaintenanceFailure,
  enqueueSession,
  listDeadLetters,
  processMaintenanceQueue,
  requeueDeadLetters,
} from '../src/agent/maintenance-queue.js';
import type { LLMClient } from '../src/core/llm-generator.js';

const RAW = JSON.stringify({
  session_id: 'queued-session',
  cwd: '/project',
  transcript: [
    { role: 'user', content: 'Please fix the migration.' },
    { role: 'assistant', content: 'Fixed the migration by making the ALTER TABLE operation idempotent and preserving existing columns.' },
  ],
});

describe('asynchronous maintenance queue', () => {
  let root: string;
  let queueDir: string;
  let dbPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'humemory-maintenance-'));
    queueDir = join(root, 'queue');
    dbPath = join(root, 'memory.db');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /**
   * A job the worker can read but can never run. `version: 2` is refused by the
   * worker itself, which makes it a failure about *this job* rather than about
   * the machine — the only kind that is allowed to spend the retry budget.
   */
  async function writeJobSpecificFailure(id = 'unsupported', queuedAt = '2026-08-15T09:00:00Z'): Promise<string> {
    await mkdir(queueDir, { recursive: true });
    const path = join(queueDir, `${id}.json`);
    await writeFile(path, JSON.stringify({
      version: 2, id, source: 'claude-code', agent: 'claude-code',
      sessionId: id, directory: '/project', rawTranscript: RAW,
      maxLearnings: 5, queuedAt, attempts: 0,
    }), 'utf8');
    return path;
  }

  /** A dead-letter holding a perfectly good session, as an outage would leave it. */
  async function parkDeadLetter(sessionId: string): Promise<string> {
    const raw = JSON.stringify({ session_id: sessionId, cwd: '/project', transcript: JSON.parse(RAW).transcript });
    const queued = await enqueueSession(raw, { queueDir });
    const dead = join(queueDir, `${queued.job.id}.dead.json`);
    await writeFile(dead, JSON.stringify({
      ...queued.job, attempts: 5, lastError: 'unable to open database file',
      deadLetteredAt: '2026-08-15T12:00:00Z',
    }), 'utf8');
    await rm(queued.path, { force: true });
    return dead;
  }

  test('enqueue is durable and idempotent without opening a database or model', async () => {
    const options = { queueDir, now: () => new Date('2026-08-15T12:00:00Z') };
    const first = await enqueueSession(RAW, options);
    const second = await enqueueSession(RAW, options);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(await readdir(queueDir)).toHaveLength(1);
    const saved = JSON.parse(await readFile(first.path, 'utf8'));
    expect(saved).toEqual(expect.objectContaining({ sessionId: 'queued-session', attempts: 0 }));
  });

  test('worker processes a session with the deterministic network-free path', async () => {
    await enqueueSession(RAW, { queueDir });
    const result = await processMaintenanceQueue({ queueDir, dbPath });

    expect(result).toEqual({
      discovered: 1, processed: 1, failed: 0, deadLettered: 0, memoriesStored: 1,
      busy: false, infrastructureFailures: 0, retriesRefunded: 0, aborted: false,
    });
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json'))).toEqual([]);
    const store = new SQLiteStore(dbPath);
    expect((await store.list({ limit: 10 }))[0]).toEqual(expect.objectContaining({
      sessionId: 'queued-session',
      source: 'hook',
    }));
    store.close();
  });

  test('quota failure falls back locally instead of blocking or losing the job', async () => {
    const exhausted: LLMClient = {
      messages: { create: async () => { throw new Error('quota exhausted'); } },
    };
    await enqueueSession(RAW, { queueDir, source: 'codex', agent: 'codex' });
    const result = await processMaintenanceQueue({ queueDir, dbPath, client: exhausted });

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(0);
    const store = new SQLiteStore(dbPath);
    expect((await store.list({ limit: 10 }))[0].agent).toBe('codex');
    store.close();
  });

  test('storage failure retains the job and records the error without spending a retry', async () => {
    // `root` is a directory, so the database cannot be opened. That is the
    // machine failing, not the transcript: the job keeps its full retry budget
    // for when the machine is fixed. See the outage tests below.
    await enqueueSession(RAW, { queueDir });
    const result = await processMaintenanceQueue({ queueDir, dbPath: root });

    expect(result.failed).toBe(1);
    expect(result.infrastructureFailures).toBe(1);
    expect(result.retriesRefunded).toBe(1);
    const files = (await readdir(queueDir)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const retained = JSON.parse(await readFile(join(queueDir, files[0]), 'utf8'));
    expect(retained.attempts).toBe(0);
    expect(retained.lastError).toBeTruthy();
  });

  test('a concurrent worker leaves queued jobs untouched', async () => {
    await enqueueSession(RAW, { queueDir });
    await writeFile(join(queueDir, '.worker.lock'), 'active');

    const result = await processMaintenanceQueue({ queueDir, dbPath });

    expect(result.busy).toBe(true);
    expect((await readdir(queueDir)).filter((file) => file.endsWith('.json'))).toHaveLength(1);
  });

  test('re-enqueuing the same session overwrites the job instead of piling up duplicates', async () => {
    // Stop fires on every turn, so the transcript grows across calls — dedup
    // must key on sessionId, not on the (ever-changing) raw transcript text.
    const grown = JSON.stringify({
      session_id: 'queued-session',
      cwd: '/project',
      transcript: [
        { role: 'user', content: 'Please fix the migration.' },
        { role: 'assistant', content: 'Fixed the migration by making the ALTER TABLE operation idempotent and preserving existing columns.' },
        { role: 'user', content: 'Also add a rollback.' },
        { role: 'assistant', content: 'Added a rollback path that drops the new column when reverting the migration.' },
      ],
    });

    const first = await enqueueSession(RAW, { queueDir });
    const second = await enqueueSession(grown, { queueDir });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.path).toBe(second.path);
    expect(await readdir(queueDir)).toHaveLength(1);
    const saved = JSON.parse(await readFile(second.path, 'utf8'));
    expect(saved.rawTranscript).toBe(grown);
  });

  test('a job past maxAttempts is dead-lettered instead of retried forever', async () => {
    // A job the worker can read but can never run: the transcript is the
    // problem, so this is what the retry budget is actually for. (An
    // unopenable database is deliberately *not* used here any more — that is
    // an outage and no longer consumes attempts.)
    await writeJobSpecificFailure();

    let result = await processMaintenanceQueue({ queueDir, dbPath, maxAttempts: 2 });
    expect(result.failed).toBe(1);
    expect(result.infrastructureFailures).toBe(0);
    expect(result.deadLettered).toBe(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.dead.json'))).toHaveLength(1);

    result = await processMaintenanceQueue({ queueDir, dbPath, maxAttempts: 2 });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.dead.json'))).toHaveLength(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.dead.json'))).toHaveLength(1);

    // Dead-lettered jobs are never picked up again.
    result = await processMaintenanceQueue({ queueDir, dbPath, maxAttempts: 2 });
    expect(result.discovered).toBe(0);
  });

  test('a second pass over a grown transcript encodes only the new messages', async () => {
    // Regression: `Stop` resends the whole transcript every turn. Without a
    // session checkpoint the worker re-encoded the full history on each pass.
    const turnOne = JSON.stringify({
      session_id: 'growing', cwd: '/project',
      transcript: [
        { role: 'user', content: 'Fix the migration.' },
        { role: 'assistant', content: 'Fixed the migration by making the ALTER TABLE operation idempotent and preserving existing columns.' },
      ],
    });
    const turnTwo = JSON.stringify({
      session_id: 'growing', cwd: '/project',
      transcript: [
        { role: 'user', content: 'Fix the migration.' },
        { role: 'assistant', content: 'Fixed the migration by making the ALTER TABLE operation idempotent and preserving existing columns.' },
        { role: 'user', content: 'Also add a rollback.' },
        { role: 'assistant', content: 'Added a rollback path that drops the freshly created column when the migration is reverted.' },
      ],
    });

    await enqueueSession(turnOne, { queueDir });
    const first = await processMaintenanceQueue({ queueDir, dbPath });
    expect(first.memoriesStored).toBe(1);

    await enqueueSession(turnTwo, { queueDir });
    const second = await processMaintenanceQueue({ queueDir, dbPath });
    expect(second.memoriesStored).toBe(1);

    const store = new SQLiteStore(dbPath);
    const all = await store.list({ limit: 50 });
    store.close();

    expect(all).toHaveLength(2);
    expect(all.filter((m) => m.content.includes('ALTER TABLE'))).toHaveLength(1);
    expect(all.filter((m) => m.content.includes('rollback path'))).toHaveLength(1);
  });

  test('a transcript enqueued mid-processing is not deleted by the finishing worker', async () => {
    // Regression: the worker used to `rm` the live job path on success, wiping a
    // newer transcript the hook had written there while the job was running.
    const grown = JSON.stringify({
      session_id: 'queued-session', cwd: '/project',
      transcript: [
        ...JSON.parse(RAW).transcript,
        { role: 'user', content: 'Now document it.' },
        { role: 'assistant', content: 'Documented the migration fix in the changelog and linked the rollback procedure.' },
      ],
    });

    const enqueued = await enqueueSession(RAW, { queueDir });
    // A store that blocks on first write lets the hook enqueue while we work.
    const slowClient: LLMClient = {
      messages: {
        create: async () => {
          await enqueueSession(grown, { queueDir });
          throw new Error('no model'); // falls back to the deterministic path
        },
      },
    };

    const result = await processMaintenanceQueue({ queueDir, dbPath, client: slowClient });
    expect(result.processed).toBe(1);

    // The newer transcript survived and is still queued for the next pass.
    const remaining = (await readdir(queueDir)).filter((f) => f.endsWith('.json'));
    expect(remaining).toEqual([`${enqueued.job.id}.json`]);
    const survivor = JSON.parse(await readFile(enqueued.path, 'utf8'));
    expect(survivor.rawTranscript).toBe(grown);
  });

  test('an unparseable job file is dead-lettered instead of failing on every pass', async () => {
    await writeFile(join(queueDir, 'corrupt.json'), '{ not json', 'utf8').catch(async () => {
      await mkdir(queueDir, { recursive: true });
      await writeFile(join(queueDir, 'corrupt.json'), '{ not json', 'utf8');
    });

    const first = await processMaintenanceQueue({ queueDir, dbPath });
    expect(first.failed).toBe(1);
    expect(first.deadLettered).toBe(1);

    const second = await processMaintenanceQueue({ queueDir, dbPath });
    expect(second.discovered).toBe(0);
    expect(second.failed).toBe(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.dead.json'))).toEqual(['corrupt.dead.json']);
  });

  test('a stale lock is reclaimed without deleting a lock another worker just took', async () => {
    await enqueueSession(RAW, { queueDir });
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, '.worker.lock'), JSON.stringify({ pid: 1, token: 'dead-worker' }));

    const result = await processMaintenanceQueue({ queueDir, dbPath, lockStaleMs: -1 });

    expect(result.busy).toBe(false);
    expect(result.processed).toBe(1);
    // The reclaiming worker released its own lock on the way out.
    expect((await readdir(queueDir)).filter((f) => f.startsWith('.worker.lock'))).toEqual([]);
  });

  test('jobs are processed oldest-first regardless of job id ordering', async () => {
    const older = await enqueueSession(
      JSON.stringify({ session_id: 'older', cwd: '/project', transcript: JSON.parse(RAW).transcript }),
      { queueDir, now: () => new Date('2026-08-15T10:00:00Z') },
    );
    const newer = await enqueueSession(
      JSON.stringify({ session_id: 'newer', cwd: '/project', transcript: JSON.parse(RAW).transcript }),
      { queueDir, now: () => new Date('2026-08-15T11:00:00Z') },
    );

    const result = await processMaintenanceQueue({ queueDir, dbPath, maxJobs: 1 });

    expect(result.processed).toBe(1);
    // The newer job must still be on disk; the older one was picked first and removed.
    expect(await readFile(older.path, 'utf8').catch(() => null)).toBeNull();
    expect(await readFile(newer.path, 'utf8')).toBeTruthy();
  });
  // === OUTAGE RESILIENCE ===
  //
  // The queue isolates jobs so one bad transcript cannot stop the others. That
  // isolation used to make an outage indistinguishable from a batch of bad
  // sessions: every queued job burned its five attempts against an unopenable
  // database and landed in `.dead.json`, where nothing ever looked for it.

  test('an unopenable database is classified as the machine, a bad job as the job', () => {
    const sqlite = Object.assign(new Error('unable to open database file'), {
      name: 'SQLiteError', code: 'SQLITE_CANTOPEN_ISDIR',
    });
    expect(classifyMaintenanceFailure(sqlite)).toBe('infrastructure');
    expect(classifyMaintenanceFailure(Object.assign(new Error('write failed'), { code: 'ENOSPC' }))).toBe('infrastructure');
    expect(classifyMaintenanceFailure(new Error('database is locked'))).toBe('infrastructure');
    expect(classifyMaintenanceFailure(new Error('EROFS: read-only file system'))).toBe('infrastructure');

    // A constraint violation is a schema bug: retrying cannot fix it, so it
    // stays on the job's own budget rather than being excused as an outage.
    expect(classifyMaintenanceFailure(Object.assign(new Error('UNIQUE constraint failed'), {
      name: 'SQLiteError', code: 'SQLITE_CONSTRAINT_UNIQUE',
    }))).toBe('job');
    expect(classifyMaintenanceFailure(new Error('Unsupported maintenance job'))).toBe('job');
    // Biased towards 'job': anything unrecognised is assumed to be about the
    // transcript, because the circuit breaker catches the wholesale case anyway.
    expect(classifyMaintenanceFailure('some string')).toBe('job');
    expect(classifyMaintenanceFailure(undefined)).toBe('job');
    // The cause chain is followed — a wrapper must not hide an outage.
    expect(classifyMaintenanceFailure(new Error('encode failed', { cause: new Error('no space left on device') }))).toBe('infrastructure');
  });

  test('a database outage never dead-letters a session, however long it lasts', async () => {
    await enqueueSession(RAW, { queueDir });

    // Far more passes than maxAttempts: under the old attempt counting this
    // session would have been in `.dead.json` after the second one.
    for (let pass = 0; pass < 6; pass += 1) {
      const result = await processMaintenanceQueue({ queueDir, dbPath: root, maxAttempts: 2 });
      expect(result.failed).toBe(1);
      expect(result.deadLettered).toBe(0);
      expect(result.infrastructureFailures).toBe(1);
    }

    const queued = (await readdir(queueDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.dead.json'));
    expect(queued).toHaveLength(1);
    expect(JSON.parse(await readFile(join(queueDir, queued[0]), 'utf8')).attempts).toBe(0);

    // And once the machine is healthy again, the session is simply encoded.
    const recovered = await processMaintenanceQueue({ queueDir, dbPath, maxAttempts: 2 });
    expect(recovered.processed).toBe(1);
    const store = new SQLiteStore(dbPath);
    expect((await store.list({ limit: 10 }))[0].sessionId).toBe('queued-session');
    store.close();
  });

  test('the circuit breaker ends the pass instead of failing every job in turn', async () => {
    for (let index = 0; index < 5; index += 1) {
      await enqueueSession(
        JSON.stringify({ session_id: 'outage-' + index, cwd: '/project', transcript: JSON.parse(RAW).transcript }),
        { queueDir, now: () => new Date('2026-08-15T1' + index + ':00:00Z') },
      );
    }

    const result = await processMaintenanceQueue({ queueDir, dbPath: root, failureThreshold: 2 });

    expect(result.discovered).toBe(5);
    expect(result.aborted).toBe(true);
    // Only the breaker's worth of jobs was touched; the rest were never claimed.
    expect(result.failed).toBe(2);
    expect(result.deadLettered).toBe(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json'))).toHaveLength(5);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.processing'))).toHaveLength(0);
  });

  test('an aborted pass that encoded nothing refunds even failures it could not classify', async () => {
    // These fail with 'Unsupported maintenance job', which reads as a job-level
    // problem. Three in a row with nothing encoded is still an outage shape, and
    // the refund is what stops an unrecognised failure mode draining the queue.
    await writeJobSpecificFailure('a', '2026-08-15T09:00:00Z');
    await writeJobSpecificFailure('b', '2026-08-15T09:01:00Z');
    await writeJobSpecificFailure('c', '2026-08-15T09:02:00Z');

    const aborted = await processMaintenanceQueue({ queueDir, dbPath, failureThreshold: 3, maxAttempts: 1 });
    expect(aborted.aborted).toBe(true);
    expect(aborted.retriesRefunded).toBe(3);
    expect(aborted.deadLettered).toBe(0);
    for (const id of ['a', 'b', 'c']) {
      expect(JSON.parse(await readFile(join(queueDir, id + '.json'), 'utf8')).attempts).toBe(0);
    }

    // With the breaker disabled the same jobs are judged one by one, which is
    // how a genuinely bad transcript still reaches dead-letter.
    const unguarded = await processMaintenanceQueue({ queueDir, dbPath, failureThreshold: false, maxAttempts: 1 });
    expect(unguarded.aborted).toBe(false);
    expect(unguarded.deadLettered).toBe(3);
  });

  test('a pass that encodes something keeps judging jobs on their own merits', async () => {
    // The breaker must not turn one good session plus a run of bad ones into a
    // blanket amnesty: `processed > 0` proves the machine works.
    await enqueueSession(RAW, { queueDir, now: () => new Date('2026-08-15T08:00:00Z') });
    await writeJobSpecificFailure('bad-1', '2026-08-15T09:00:00Z');
    await writeJobSpecificFailure('bad-2', '2026-08-15T09:01:00Z');

    const result = await processMaintenanceQueue({ queueDir, dbPath, failureThreshold: 2, maxAttempts: 1 });

    expect(result.processed).toBe(1);
    expect(result.aborted).toBe(true);
    expect(result.retriesRefunded).toBe(0);
    expect(result.deadLettered).toBe(2);
  });

  // === DEAD-LETTER RECOVERY ===

  test('dead-letters are listable with the diagnosis that put them there', async () => {
    await parkDeadLetter('parked-session');
    const entries = await listDeadLetters(queueDir);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual(expect.objectContaining({
      sessionId: 'parked-session',
      attempts: 5,
      lastError: 'unable to open database file',
    }));
    expect(await listDeadLetters(join(root, 'no-such-queue'))).toEqual([]);
  });

  test('requeuing restores the retry budget and the session is encoded on the next pass', async () => {
    const dead = await parkDeadLetter('parked-session');

    const dryRun = await requeueDeadLetters({ queueDir, dryRun: true });
    expect(dryRun.requeued).toBe(1);
    expect(await readFile(dead, 'utf8')).toBeTruthy(); // A dry run writes nothing.

    const result = await requeueDeadLetters({ queueDir, now: () => new Date('2026-08-20T08:00:00Z') });
    expect(result).toEqual(expect.objectContaining({ scanned: 1, requeued: 1, skippedLive: 0, unreadable: 0 }));
    expect(await listDeadLetters(queueDir)).toEqual([]);

    const restored = JSON.parse(await readFile(join(queueDir, result.entries[0].id + '.json'), 'utf8'));
    expect(restored.attempts).toBe(0);
    expect(restored.lastError).toBeUndefined();
    expect(restored.requeuedAt).toBe('2026-08-20T08:00:00.000Z');

    const pass = await processMaintenanceQueue({ queueDir, dbPath });
    expect(pass.processed).toBe(1);
  });

  test('requeuing selects by id or session id, and leaves the rest parked', async () => {
    await parkDeadLetter('wanted-session');
    await parkDeadLetter('other-session');

    const result = await requeueDeadLetters({ queueDir, ids: ['wanted-session'] });

    expect(result.requeued).toBe(1);
    expect(result.entries[0].sessionId).toBe('wanted-session');
    expect((await listDeadLetters(queueDir)).map((entry) => entry.sessionId)).toEqual(['other-session']);
  });

  test('a dead-letter superseded by a newer queued transcript is left alone', async () => {
    const dead = await parkDeadLetter('parked-session');
    // The same session came back through the hook while the dead-letter sat there.
    await enqueueSession(
      JSON.stringify({ session_id: 'parked-session', cwd: '/project', transcript: JSON.parse(RAW).transcript }),
      { queueDir },
    );

    const result = await requeueDeadLetters({ queueDir });

    expect(result.requeued).toBe(0);
    expect(result.skippedLive).toBe(1);
    // Never clobber the newer transcript, and never silently delete the old one.
    expect(await readFile(dead, 'utf8')).toBeTruthy();
  });

  test('an unreadable dead-letter is reported rather than requeued into failing again', async () => {
    await mkdir(queueDir, { recursive: true });
    await writeFile(join(queueDir, 'corrupt.dead.json'), '{ not json', 'utf8');

    const result = await requeueDeadLetters({ queueDir });

    expect(result).toEqual(expect.objectContaining({ scanned: 1, requeued: 0, unreadable: 1 }));
    expect(await readFile(join(queueDir, 'corrupt.dead.json'), 'utf8')).toBe('{ not json');
  });
});
