import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctor, renderDoctorReport, type DoctorReport } from '../src/core/doctor.js';
import { SQLiteStore, AdvisoryLock } from '../src/store/sqlite.js';

const temporaries: string[] = [];

function temporaryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'humemory-doctor-'));
  temporaries.push(dir);
  return dir;
}

/** A resolved-paths set entirely inside a temp root — never the real palace. */
function pathsUnder(root: string) {
  return {
    data: root,
    database: join(root, 'humemory.db'),
    queue: join(root, 'maintenance-queue'),
    modelCache: join(root, 'models'),
  };
}

/**
 * A fake installation with every entry point the doctor requires. Tests that
 * care about a *missing* entry delete one from this baseline, so a new required
 * entry point in `doctor.ts` does not silently pass every test here.
 */
function completeInstall(): string {
  const root = temporaryRoot();
  for (const dir of ['bin', 'dist/cli', 'src/mcp', 'src/api', 'scripts', 'public/app']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const file of [
    'bin/humemory.js',
    'dist/cli/index.js',
    'src/mcp/server.ts',
    'src/api/server.ts',
    'scripts/hook-session.ts',
    'scripts/hook-session-start.ts',
    'scripts/hook-post-commit.ts',
    'scripts/maintenance-worker.ts',
  ]) {
    writeFileSync(join(root, file), '');
  }
  return root;
}

function check(report: DoctorReport, id: string) {
  const found = report.checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}" in report: ${report.checks.map((c) => c.id).join(', ')}`);
  return found;
}

afterEach(() => {
  for (const dir of temporaries.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('doctor', () => {
  test('a complete install with a fresh profile reports no failure', async () => {
    const report = await runDoctor({ paths: pathsUnder(temporaryRoot()), installRoot: completeInstall() });

    expect(report.status).not.toBe('fail');
    expect(check(report, 'runtime.bun').status).toBe('ok');
    // A profile with no database yet is a warning, not a fault: the store
    // creates it on first write (audit A05).
    expect(check(report, 'db.open').status).toBe('warn');
    expect(check(report, 'paths.data').status).toBe('ok');
  });

  test('creates the data, queue and model directories it probes', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);

    const report = await runDoctor({ paths, installRoot: completeInstall() });

    expect(check(report, 'paths.queue').status).toBe('ok');
    expect(check(report, 'paths.modelCache').status).toBe('ok');
    // The probe file itself must not survive the run.
    expect(check(report, 'paths.data').detail).toContain('writable');
  });

  test('a missing required entry point fails the report — the A04 packaging trap', async () => {
    const installRoot = completeInstall();
    rmSync(join(installRoot, 'src', 'mcp', 'server.ts'));

    const report = await runDoctor({ paths: pathsUnder(temporaryRoot()), installRoot });

    expect(report.status).toBe('fail');
    const entry = check(report, 'entry.src/mcp/server.ts');
    expect(entry.status).toBe('fail');
    expect(entry.detail).toContain('MISSING');
  });

  test('an unbuilt dist is a warning, not a failure', async () => {
    const installRoot = completeInstall();
    rmSync(join(installRoot, 'dist', 'cli', 'index.js'));

    const report = await runDoctor({ paths: pathsUnder(temporaryRoot()), installRoot });

    expect(check(report, 'entry.dist/cli/index.js').status).toBe('warn');
    expect(report.status).toBe('warn');
  });

  test('reads a real database schema and journal mode', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);
    const store = new SQLiteStore(paths.database);
    store.close();

    const report = await runDoctor({ paths, installRoot: completeInstall() });

    expect(check(report, 'db.open').status).toBe('ok');
    expect(check(report, 'db.open').detail).toContain('journal_mode=wal');
    expect(check(report, 'db.schema').status).toBe('ok');
  });

  test('a truncated schema is reported as an interrupted migration', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);
    const store = new SQLiteStore(paths.database);
    store.close();
    // Drop a table behind the store's back: what an interrupted migration or a
    // hand-edited database looks like from the outside.
    const { Database } = await import('bun:sqlite');
    const raw = new Database(paths.database);
    raw.exec('DROP TABLE cues');
    raw.close();

    const report = await runDoctor({ paths, installRoot: completeInstall() });

    expect(check(report, 'db.schema').status).toBe('fail');
    expect(check(report, 'db.schema').detail).toContain('cues');
  });

  test('a held maintenance lock reports a live worker, not a fault', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);
    mkdirSync(paths.queue, { recursive: true });
    const lock = new AdvisoryLock(join(paths.queue, '.worker-lock'), 1);
    await lock.acquire();

    try {
      const report = await runDoctor({ paths, installRoot: completeInstall() });
      const held = check(report, 'locks.maintenance');
      expect(held.status).toBe('warn');
      expect(held.detail).toContain('held by a live process');
      expect(report.status).not.toBe('fail');
    } finally {
      lock.release();
    }
  });

  test('a released lock reads as free on the next pass', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);
    mkdirSync(paths.queue, { recursive: true });
    const lock = new AdvisoryLock(join(paths.queue, '.worker-lock'), 1);
    await lock.acquire();
    lock.release();

    const report = await runDoctor({ paths, installRoot: completeInstall() });

    expect(check(report, 'locks.maintenance').status).toBe('ok');
    expect(check(report, 'locks.maintenance').detail).toContain('free');
  });

  test('names cached embedding models without walking their weights', async () => {
    const root = temporaryRoot();
    const paths = pathsUnder(root);
    mkdirSync(join(paths.modelCache, 'Xenova', 'bge-m3'), { recursive: true });

    const report = await runDoctor({ paths, installRoot: completeInstall() });

    const models = check(report, 'models.cache');
    expect(models.status).toBe('ok');
    expect(models.detail).toContain('Xenova/bge-m3');
  });

  test('a runtime below the declared minimum fails', async () => {
    const report = await runDoctor({
      paths: pathsUnder(temporaryRoot()),
      installRoot: completeInstall(),
      minimumBun: '99.0.0',
    });

    expect(check(report, 'runtime.bun').status).toBe('fail');
    expect(report.status).toBe('fail');
  });

  test('a satisfied minimum passes, range prefix included', async () => {
    const report = await runDoctor({
      paths: pathsUnder(temporaryRoot()),
      installRoot: completeInstall(),
      minimumBun: '>=1.0.0',
    });

    expect(check(report, 'runtime.bun').status).toBe('ok');
  });

  test('reports environment overrides by name and never by value', async () => {
    const secret = 'super-secret-token-value';
    process.env.HUMEMORY_API_TOKEN = secret;
    try {
      const report = await runDoctor({ paths: pathsUnder(temporaryRoot()), installRoot: completeInstall() });

      const env = check(report, 'runtime.env');
      expect(env.detail).toContain('HUMEMORY_API_TOKEN');
      // The whole point of the check: a diagnostic must be safe to paste.
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(renderDoctorReport(report)).not.toContain(secret);
    } finally {
      delete process.env.HUMEMORY_API_TOKEN;
    }
  });

  test('the rendered report lists every check under a section heading', async () => {
    const report = await runDoctor({ paths: pathsUnder(temporaryRoot()), installRoot: completeInstall() });

    const rendered = renderDoctorReport(report);
    expect(rendered).toContain('Entry points:');
    expect(rendered).toContain('Locks:');
    for (const c of report.checks) expect(rendered).toContain(c.detail);
  });
});
