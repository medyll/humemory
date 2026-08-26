import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync, readdirSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { importCodexRollouts, defaultCodexSessionsDir, CODEX_SOURCE } from '../src/agent/codex-import.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

let root: string;
let sessionsDir: string;
let queueDir: string;

/** Lays out a fake `~/.codex/sessions/YYYY/MM/DD` tree from the fixtures. */
function placeRollout(name: string, fixture: string, day = '01'): string {
  const dir = join(sessionsDir, '2026', '08', day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-08-${day}T10-00-00-${name}.jsonl`);
  copyFileSync(join(FIXTURES, fixture), path);
  return path;
}

function queuedJobs(): string[] {
  try {
    return readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'humemory-codex-import-'));
  sessionsDir = join(root, 'sessions');
  queueDir = join(root, 'queue');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('codex rollout import', () => {
  test('queues a user thread and skips the subagent one', async () => {
    placeRollout('user', 'codex-rollout.user.jsonl');
    placeRollout('guardian', 'codex-rollout.subagent.jsonl', '02');

    const result = await importCodexRollouts({ queueDir, sessionsDir });

    expect(result.scanned).toBe(2);
    expect(result.queued).toBe(1);
    expect(result.created).toBe(1);
    expect(result.skippedSubagent).toBe(1);
    expect(queuedJobs()).toHaveLength(1);
  });

  test('imports subagent threads when explicitly asked', async () => {
    placeRollout('guardian', 'codex-rollout.subagent.jsonl');
    const result = await importCodexRollouts({ queueDir, sessionsDir, includeSubagents: true });

    expect(result.queued).toBe(1);
    expect(result.skippedSubagent).toBe(0);
  });

  test('re-importing the same rollout does not create a second job', async () => {
    placeRollout('user', 'codex-rollout.user.jsonl');

    await importCodexRollouts({ queueDir, sessionsDir });
    const second = await importCodexRollouts({ queueDir, sessionsDir });

    expect(second.queued).toBe(1);
    expect(second.created).toBe(0);
    expect(queuedJobs()).toHaveLength(1);
  });

  test('the job carries the codex provenance and the thread cwd', async () => {
    placeRollout('user', 'codex-rollout.user.jsonl');
    await importCodexRollouts({ queueDir, sessionsDir });

    const job = JSON.parse(await Bun.file(join(queueDir, queuedJobs()[0])).text());
    expect(job.source).toBe(CODEX_SOURCE);
    expect(job.agent).toBe('codex');
    expect(job.directory).toBe('/dev/humemory');
    expect(job.sessionId).toBe('01a02f57-4c91-7bc3-9435-d479f2c1ec44');
  });

  test('honours the age window by file mtime', async () => {
    const path = placeRollout('user', 'codex-rollout.user.jsonl');
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(path, old, old);

    const result = await importCodexRollouts({
      queueDir, sessionsDir,
      since: new Date('2026-08-01T00:00:00Z'),
    });

    expect(result.queued).toBe(0);
    expect(result.skippedOld).toBe(1);
  });

  test('stops at the limit', async () => {
    placeRollout('a', 'codex-rollout.user.jsonl', '01');
    placeRollout('b', 'codex-rollout.user.jsonl', '02');

    const result = await importCodexRollouts({ queueDir, sessionsDir, limit: 1 });
    expect(result.queued).toBe(1);
  });

  test('a dry run writes nothing', async () => {
    placeRollout('user', 'codex-rollout.user.jsonl');
    const result = await importCodexRollouts({ queueDir, sessionsDir, dryRun: true });

    expect(result.queued).toBe(1);
    expect(queuedJobs()).toHaveLength(0);
  });

  test('a rollout without a single turn is not queued', async () => {
    const dir = join(sessionsDir, '2026', '08', '03');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'rollout-2026-08-03T10-00-00-empty.jsonl'),
      '{"type":"session_meta","payload":{"session_id":"empty","cwd":"/dev/x","thread_source":"user"}}\n',
    );

    const result = await importCodexRollouts({ queueDir, sessionsDir });
    expect(result.skippedEmpty).toBe(1);
    expect(result.queued).toBe(0);
  });

  test('an absent codex install is not an error', async () => {
    const result = await importCodexRollouts({ queueDir, sessionsDir: join(root, 'nope') });
    expect(result).toMatchObject({ scanned: 0, queued: 0 });
  });

  test('the default sessions directory follows CODEX_HOME', () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(root, 'codex-home');
    try {
      expect(defaultCodexSessionsDir()).toBe(join(root, 'codex-home', 'sessions'));
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
