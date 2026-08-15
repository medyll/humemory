import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { SQLiteStore } from '../src/store/sqlite.js';
import { enqueueSession, processMaintenanceQueue } from '../src/agent/maintenance-queue.js';
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

    expect(result).toEqual({ discovered: 1, processed: 1, failed: 0, deadLettered: 0, memoriesStored: 1, busy: false });
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

  test('storage failure retains the job and records the attempt', async () => {
    await enqueueSession(RAW, { queueDir });
    const result = await processMaintenanceQueue({ queueDir, dbPath: root });

    expect(result.failed).toBe(1);
    const files = (await readdir(queueDir)).filter((f) => f.endsWith('.json'));
    expect(files).toHaveLength(1);
    const retained = JSON.parse(await readFile(join(queueDir, files[0]), 'utf8'));
    expect(retained.attempts).toBe(1);
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
    await enqueueSession(RAW, { queueDir });

    let result = await processMaintenanceQueue({ queueDir, dbPath: root, maxAttempts: 2 });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.dead.json'))).toHaveLength(1);

    result = await processMaintenanceQueue({ queueDir, dbPath: root, maxAttempts: 2 });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(1);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.json') && !f.endsWith('.dead.json'))).toHaveLength(0);
    expect((await readdir(queueDir)).filter((f) => f.endsWith('.dead.json'))).toHaveLength(1);

    // Dead-lettered jobs are never picked up again.
    result = await processMaintenanceQueue({ queueDir, dbPath: root, maxAttempts: 2 });
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
});
