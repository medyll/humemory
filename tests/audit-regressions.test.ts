import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { SQLiteStore } from '../src/store/sqlite.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import { fakeClock } from './helpers/clock.js';
import { atomicWrite } from '../src/agent/maintenance-queue.js';
import { readFile, readdir } from 'fs/promises';

const trace = { content: 'quasar observation', directory: '/test', day: '2026-01-01', keywords: ['quasar'], sessionId: 'audit' };

test('A09: failed Windows replacement preserves the old file and a complete recovery file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humemory-replace-'));
  const path = join(root, 'job.json');
  writeFileSync(path, 'old complete');
  try {
    await expect(atomicWrite(path, 'new complete', async () => { throw Object.assign(new Error('forced replacement failure'), { code: 'EPERM' }); })).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('old complete');
    const temporary = (await readdir(root)).find(f => f.endsWith('.tmp'))!;
    expect(await readFile(join(root, temporary), 'utf8')).toBe('new complete');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('A11: remap previews, backs up WAL data and moves traces and absolute file cues together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humemory-remap-'));
  const store = new SQLiteStore(join(root, 'memory.db'), { clock: fakeClock() });
  try {
    const memory = await store.add({ ...trace, directory: 'C:\\Old Project\\src' });
    const loop = await store.addIntention({ content: 'file', directory: 'C:\\Old Project' }, [{ kind: 'event', type: 'file_open', path: 'C:\\Old Project\\src\\é.ts' }]);
    const preview = await store.remapProjectRoot('c:/old project', '/new project');
    expect(preview.applied).toBe(false);
    expect(preview.changes.length).toBe(3);
    expect((await store.getById(memory.id))?.directory).toBe('C:\\Old Project\\src');
    const backupPath = join(root, 'backup.db');
    await store.remapProjectRoot('c:/old project', '/new project', { apply: true, backupPath });
    expect((await store.search({ query: 'quasar', directory: '/new project/src' })).length).toBe(1);
    expect((await store.getIntention(loop.id))?.directory).toBe('/new project');
    const backup = new SQLiteStore(backupPath, { clock: fakeClock() });
    try { expect((await backup.getById(memory.id))?.directory).toBe('C:\\Old Project\\src'); }
    finally { backup.close(); }
    expect((await store.remapProjectRoot('c:/old project', '/new project')).changes).toEqual([]);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('A01/A02: process reader refreshes and a killed lock owner releases exclusion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humemory-process-'));
  const path = join(root, 'memory.db');
  const helper = fileURLToPath(new URL('./helpers/audit-process.ts', import.meta.url));
  const store = new SQLiteStore(path, { clock: fakeClock() });
  const reader = Bun.spawn([process.execPath, helper, 'reader', path], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  let owner: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const output = reader.stdout.getReader();
    expect(new TextDecoder().decode((await output.read()).value)).toContain('ready');
    await store.add(trace);
    reader.stdin.end();
    expect(new TextDecoder().decode((await output.read()).value)).toContain('quasar observation');
    output.releaseLock();
    expect(await reader.exited).toBe(0);
    owner = Bun.spawn([process.execPath, helper, 'lock', path + '.lock'], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    const ready = (owner.stdout as ReadableStream<Uint8Array>).getReader();
    expect(new TextDecoder().decode((await ready.read()).value)).toContain('ready');
    ready.releaseLock();
    await expect(store.add(trace)).rejects.toThrow('Failed to acquire lock');
    owner.kill();
    await owner.exited;
    expect((await store.add(trace)).content).toBe(trace.content);
  } finally {
    reader.kill();
    owner?.kill();
    await reader.exited;
    if (owner) await owner.exited;
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('A01/A05: independent connections refresh additions, recalls and deletions in a new parent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humemory-audit-'));
  const path = join(root, 'espace é', 'memory.db');
  const a = new SQLiteStore(path, { clock: fakeClock() });
  const b = new SQLiteStore(path, { clock: fakeClock() });
  try {
    const memory = await a.add(trace);
    expect((await b.search({ query: 'quasar' }))[0].memory.id).toBe(memory.id);
    await a.recall(memory.id);
    expect((await b.search({ query: 'quasar' }))[0].memory.recallCount).toBe(1);
    await a.delete(memory.id);
    expect(await b.search({ query: 'quasar' })).toEqual([]);
  } finally { a.close(); b.close(); rmSync(root, { recursive: true, force: true }); }
});

test('A02: an orphan legacy lock cannot block writes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'humemory-lock-'));
  const path = join(root, 'memory.db');
  writeFileSync(path + '.lock', '');
  const store = new SQLiteStore(path, { clock: fakeClock() });
  try { expect((await store.add(trace)).content).toBe(trace.content); }
  finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('A03: cron wakes on successive days, once per occurrence, until closed', async () => {
  const clock = fakeClock();
  const store = new SQLiteStore(':memory:', { clock });
  const resolver = new SqliteCueResolver(store, { clock });
  try {
    const intention = await store.addIntention({ content: 'daily', directory: '/test' }, [{ kind: 'time', cron: '0 9 * * *' }]);
    for (let day = 0; day < 3; day++) {
      clock.advanceHours(24);
      const due = await resolver.resolveTimeCues();
      expect(due.length).toBe(1);
      await resolver.fire(due[0].id);
      expect(await resolver.resolveTimeCues()).toEqual([]);
    }
    await store.updateIntentionStatus(intention.id, 'closed');
    clock.advanceHours(24);
    expect(await resolver.resolveTimeCues()).toEqual([]);
  } finally { store.close(); }
});

test('A07: time and event cues beyond 500 candidates remain reachable', async () => {
  const clock = fakeClock();
  const store = new SQLiteStore(':memory:', { clock });
  const resolver = new SqliteCueResolver(store, { clock });
  try {
    for (let i = 0; i < 501; i++) {
      await store.addIntention({ content: 'later', directory: '/test' }, [
        { kind: 'time', at: '2099-01-01T00:00:00Z' },
        { kind: 'event', type: 'branch_switch', branch: 'other' },
      ]);
    }
    const wanted = await store.addIntention({ content: 'now', directory: '/test' }, [
      { kind: 'time', at: '2000-01-01T00:00:00Z' },
      { kind: 'event', type: 'branch_switch', branch: 'main' },
    ]);
    expect((await resolver.resolveTimeCues()).map(c => c.targetId)).toEqual([wanted.id]);
    expect((await resolver.resolveEventCues({ type: 'branch_switch', branch: 'main', directory: '/test' })).map(c => c.targetId)).toEqual([wanted.id]);
  } finally { store.close(); }
});

test('A06: ranking considers later candidates and recall bonuses', async () => {
  const store = new SQLiteStore(':memory:', { clock: fakeClock() });
  try {
    for (let i = 0; i < 12; i++) await store.add({ ...trace, sessionId: `s${i}` });
    const best = await store.add({ ...trace, sessionId: 'best' });
    await store.recall(best.id);
    const results = await store.search({ query: 'quasar', limit: 2 });
    expect(results[0].memory.id).toBe(best.id);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  } finally { store.close(); }
});
