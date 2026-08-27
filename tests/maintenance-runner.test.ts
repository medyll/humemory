/**
 * The maintenance loop is the thing that keeps consolidation alive on a machine
 * nobody is watching, so its failure modes are the ones worth pinning down:
 * overlapping passes, a pass that throws, and a loop that has silently stopped.
 *
 * Hermetic per docs/TESTING.md: temp dirs, an injected clock, injected timers,
 * no network, no production database.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { enqueueSession } from '../src/agent/maintenance-queue.js';
import {
  runMaintenancePass,
  startMaintenanceLoop,
  configuredIntervalMs,
  DEFAULT_INTERVAL_MS,
  type TimerLike,
} from '../src/agent/maintenance-runner.js';
import {
  assessMaintenance,
  readMaintenanceState,
  recordMaintenanceRun,
  DEFAULT_STALE_AFTER_MS,
} from '../src/agent/maintenance-state.js';
import { fakeClock, T0 } from './helpers/clock.js';

const RAW = JSON.stringify({
  session_id: 'loop-session',
  cwd: '/project',
  transcript: [
    { role: 'user', content: 'Please fix the migration.' },
    {
      role: 'assistant',
      content:
        'Fixed the migration by making the ALTER TABLE operation idempotent and preserving existing columns.',
    },
  ],
});

/** Timer seam that fires only when the test says so. */
function manualTimers() {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  const timers: TimerLike = {
    setInterval(handler) {
      const id = nextId++;
      handlers.set(id, handler);
      return id;
    },
    clearInterval(handle) {
      handlers.delete(handle as number);
    },
  };
  return {
    timers,
    get armed() {
      return handlers.size;
    },
    /** Fires every live interval once, the way wall-clock time would. */
    tick() {
      for (const handler of [...handlers.values()]) handler();
    },
  };
}

describe('maintenance state file', () => {
  let root: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'humemory-mstate-'));
    statePath = join(root, 'maintenance-state.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a missing state file reads as "never succeeded" rather than throwing', async () => {
    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toBeUndefined();

    const health = assessMaintenance(state, { clock: fakeClock() });
    expect(health.stale).toBe(true);
    expect(health.summary).toContain('has ever succeeded');
  });

  test('a corrupt state file degrades to empty instead of taking the caller down', async () => {
    await writeFile(statePath, '{ this is not json', 'utf-8');
    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(0);
  });

  test('a success records a timestamp, a duration and clears the previous error', async () => {
    const clock = fakeClock();
    await recordMaintenanceRun({ path: statePath, startedAt: clock.now(), clock, error: new Error('codex exploded') });
    expect((await readMaintenanceState(statePath)).lastError).toBe('codex exploded');

    const startedAt = clock.now();
    clock.advance(1_500);
    await recordMaintenanceRun({
      path: statePath,
      startedAt,
      clock,
      result: { discovered: 2, processed: 2, failed: 0, deadLettered: 0, memoriesStored: 2, busy: false },
    });

    const state = await readMaintenanceState(statePath);
    expect(state.lastError).toBeUndefined();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastDurationMs).toBe(1_500);
    expect(state.lastResult?.memoriesStored).toBe(2);
    expect(state.lastSuccessAt).toBe(new Date(T0.getTime() + 1_500).toISOString());
  });

  test('consecutive failures accumulate, so a degraded loop is distinguishable from a dead one', async () => {
    const clock = fakeClock();
    for (let i = 0; i < 3; i++) {
      await recordMaintenanceRun({ path: statePath, startedAt: clock.now(), clock, error: new Error('nope') });
      clock.advance(60_000);
    }
    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(3);
    expect(assessMaintenance(state, { clock }).summary).toContain('3 consecutive failure(s)');
  });

  test('staleness is measured against the last success, not the last attempt', async () => {
    const clock = fakeClock();
    await recordMaintenanceRun({
      path: statePath,
      startedAt: clock.now(),
      clock,
      result: { discovered: 0, processed: 0, failed: 0, deadLettered: 0, memoriesStored: 0, busy: false },
    });

    clock.advance(DEFAULT_STALE_AFTER_MS - 1);
    expect(assessMaintenance(await readMaintenanceState(statePath), { clock }).stale).toBe(false);

    // Attempts keep happening and keep failing: the success age is what matters.
    await recordMaintenanceRun({ path: statePath, startedAt: clock.now(), clock, error: new Error('still broken') });
    clock.advance(2);

    const health = assessMaintenance(await readMaintenanceState(statePath), { clock });
    expect(health.stale).toBe(true);
    expect(health.lastError).toBe('still broken');
  });
});

describe('maintenance pass', () => {
  let root: string;
  let queueDir: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'humemory-mrun-'));
    queueDir = join(root, 'queue');
    dbPath = join(root, 'memory.db');
    statePath = join(root, 'maintenance-state.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a pass drains the queue and leaves a success in the state file', async () => {
    await enqueueSession(RAW, { queueDir });
    const clock = fakeClock();

    const { worker } = await runMaintenancePass({
      queueDir,
      dbPath,
      statePath,
      clock,
      codexSinceDays: false,
      runner: 'test',
    });

    expect(worker.discovered).toBe(1);
    expect(worker.processed).toBe(1);

    const state = await readMaintenanceState(statePath);
    expect(state.lastSuccessAt).toBeDefined();
    expect(state.lastRunner).toBe('test');
    expect(state.consecutiveFailures).toBe(0);
  });

  test('an unreadable codex directory is contained — the queue still drains', async () => {
    await enqueueSession(RAW, { queueDir });

    const { worker, codexError } = await runMaintenancePass({
      queueDir,
      dbPath,
      statePath,
      clock: fakeClock(),
      codexSinceDays: 1,
      codexSessionsDir: join(root, 'no-such-codex-dir'),
    });

    // A missing codex is the normal case on a machine without it: not an error,
    // and above all not a reason to leave every other source unconsolidated.
    expect(codexError).toBeUndefined();
    expect(worker.processed).toBe(1);
    expect((await readMaintenanceState(statePath)).lastSuccessAt).toBeDefined();
  });

  test('an infrastructure failure is recorded as a failure, not as a quiet success', async () => {
    const clock = fakeClock();
    // A directory sitting where the database file belongs. The queue isolates
    // jobs, so this does not throw — every job simply fails. Left unflagged it
    // would read as an ordinary pass while the queue dead-letters itself.
    const unopenable = join(root, 'db-as-directory');
    await mkdir(unopenable, { recursive: true });
    await enqueueSession(RAW, { queueDir });

    const { worker } = await runMaintenancePass({
      queueDir,
      dbPath: unopenable,
      statePath,
      clock,
      codexSinceDays: false,
    });

    expect(worker.discovered).toBe(1);
    expect(worker.processed).toBe(0);
    expect(worker.failed).toBe(1);

    // The retry was refunded rather than spent: visibility is not enough on its
    // own, the session also has to still be there when the machine is fixed.
    expect(worker.deadLettered).toBe(0);
    expect(worker.retriesRefunded).toBe(1);

    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).toContain('suspect the database or the disk');
    expect(state.lastError).toContain('refunded');
    expect(state.lastSuccessAt).toBeUndefined();
    // The counts survive the failure — they are the diagnosis.
    expect(state.lastResult?.discovered).toBe(1);
    expect(state.lastResult?.retriesRefunded).toBe(1);
    expect(assessMaintenance(state, { clock }).stale).toBe(true);
  });

  test('an outage the pass sits through leaves every session recoverable', async () => {
    // The end-to-end shape of the bug this guards: a database that will not
    // open, several queued sessions, and pass after pass going nowhere. What
    // must never happen is the queue quietly draining itself into `.dead.json`.
    const clock = fakeClock();
    const unopenable = join(root, 'db-as-directory');
    await mkdir(unopenable, { recursive: true });
    for (const sessionId of ['one', 'two', 'three']) {
      await enqueueSession(
        JSON.stringify({ session_id: sessionId, cwd: '/project', transcript: JSON.parse(RAW).transcript }),
        { queueDir, now: () => clock.now() },
      );
    }

    for (let pass = 0; pass < 8; pass += 1) {
      const { worker } = await runMaintenancePass({
        queueDir, dbPath: unopenable, statePath, clock, codexSinceDays: false,
      });
      expect(worker.deadLettered).toBe(0);
      clock.advance(15 * 60_000);
    }

    // Nothing was lost, and the outage is loud in the state file.
    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(8);
    expect(state.lastSuccessAt).toBeUndefined();

    // Fix the machine: the same sessions consolidate on the very next pass.
    const { worker } = await runMaintenancePass({
      queueDir, dbPath, statePath, clock, codexSinceDays: false,
    });
    expect(worker.processed).toBe(3);
    expect((await readMaintenanceState(statePath)).consecutiveFailures).toBe(0);
  });

  test('a partial failure still counts as a successful pass', async () => {
    const clock = fakeClock();
    await enqueueSession(RAW, { queueDir });
    await enqueueSession(JSON.stringify({ ...JSON.parse(RAW), session_id: 'other-session' }), { queueDir });
    await writeFile(join(queueDir, 'broken.json'), 'not a job at all', 'utf-8');

    const { worker } = await runMaintenancePass({
      queueDir,
      dbPath,
      statePath,
      clock,
      codexSinceDays: false,
    });

    expect(worker.processed).toBeGreaterThan(0);
    expect(worker.deadLettered + worker.failed).toBeGreaterThan(0);

    // Some jobs are simply bad; that is the queue working, not the system failing.
    const state = await readMaintenanceState(statePath);
    expect(state.lastSuccessAt).toBeDefined();
    expect(state.consecutiveFailures).toBe(0);
  });

  test('a pass that cannot even reach the queue fails loudly and is rethrown', async () => {
    const clock = fakeClock();
    // A regular file where the queue directory belongs: the pass cannot start.
    const queueAsFile = join(root, 'queue-as-file');
    await writeFile(queueAsFile, 'not a directory', 'utf-8');

    await expect(
      runMaintenancePass({
        queueDir: queueAsFile,
        dbPath,
        statePath,
        clock,
        codexSinceDays: false,
      })
    ).rejects.toThrow();

    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.lastError).toBeTruthy();
    expect(state.lastSuccessAt).toBeUndefined();
  });
});

describe('maintenance loop', () => {
  let root: string;
  let queueDir: string;
  let dbPath: string;
  let statePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'humemory-mloop-'));
    queueDir = join(root, 'queue');
    dbPath = join(root, 'memory.db');
    statePath = join(root, 'maintenance-state.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('a tick runs a pass, and stop() disarms the timer', async () => {
    await enqueueSession(RAW, { queueDir });
    const timers = manualTimers();

    const loop = startMaintenanceLoop({
      queueDir,
      dbPath,
      statePath,
      clock: fakeClock(),
      codexSinceDays: false,
      timers: timers.timers,
    });

    expect(timers.armed).toBe(1);
    await loop.runNow();
    expect((await readMaintenanceState(statePath)).lastSuccessAt).toBeDefined();

    loop.stop();
    expect(timers.armed).toBe(0);
  });

  test('passes never overlap: a tick during an in-flight pass is dropped', async () => {
    const timers = manualTimers();
    let started = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Stand in for the pass itself: the loop's guard is what is under test, so
    // the work is replaced by something the test can hold open.
    const loop = startMaintenanceLoop({
      queueDir,
      dbPath,
      statePath,
      clock: fakeClock(),
      codexSinceDays: false,
      timers: timers.timers,
      client: {
        messages: {
          create: async () => {
            started += 1;
            await gate;
            return { content: [{ type: 'text', text: '{}' }] };
          },
        },
      } as never,
    });

    const first = loop.runNow();
    expect(loop.busy).toBe(true);

    // Every tick that lands while the first pass is still running is a no-op.
    timers.tick();
    timers.tick();
    await loop.runNow();
    expect(loop.busy).toBe(true);

    release?.();
    await first;
    expect(loop.busy).toBe(false);
    expect(started).toBeLessThanOrEqual(1);

    loop.stop();
  });

  test('a throwing pass is contained: the loop survives and keeps its timer armed', async () => {
    const timers = manualTimers();
    // A regular file where the queue directory belongs: every pass throws.
    const queueAsFile = join(root, 'queue-as-file');
    await writeFile(queueAsFile, 'not a directory', 'utf-8');
    const loop = startMaintenanceLoop({
      queueDir: queueAsFile,
      dbPath,
      statePath,
      clock: fakeClock(),
      codexSinceDays: false,
      timers: timers.timers,
    });

    // Would reject if the loop let the failure escape.
    await loop.runNow();
    await loop.runNow();

    expect(timers.armed).toBe(1);
    expect(loop.busy).toBe(false);

    // Contained, but not hidden — the failures are on record.
    const state = await readMaintenanceState(statePath);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.lastError).toBeTruthy();

    loop.stop();
  });

  test('a stopped loop refuses to run again, so shutdown cannot race a tick', async () => {
    await enqueueSession(RAW, { queueDir });
    const timers = manualTimers();
    const loop = startMaintenanceLoop({
      queueDir,
      dbPath,
      statePath,
      clock: fakeClock(),
      codexSinceDays: false,
      timers: timers.timers,
    });

    loop.stop();
    await loop.runNow();

    expect(await readFile(statePath, 'utf-8').catch(() => undefined)).toBeUndefined();
  });
});

describe('interval configuration', () => {
  const original = process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS;
    else process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS = original;
  });

  test('defaults to 15 minutes, honours an override, and 0 means "disabled"', () => {
    delete process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS;
    expect(configuredIntervalMs()).toBe(DEFAULT_INTERVAL_MS);

    process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS = '60000';
    expect(configuredIntervalMs()).toBe(60_000);

    process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS = '0';
    expect(configuredIntervalMs()).toBe(0);

    // Garbage must not silently disable maintenance.
    process.env.HUMEMORY_MAINTENANCE_INTERVAL_MS = 'soon';
    expect(configuredIntervalMs()).toBe(DEFAULT_INTERVAL_MS);
  });
});
