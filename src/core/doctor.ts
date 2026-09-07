/**
 * Install diagnostic — audit improvement #4.
 *
 * Reports what an installation actually resolved to: runtime, paths, write
 * rights, schema, lock state, models and auxiliary entry points. Deliberately
 * blind to content: it never opens a transcript, never reads a memory row and
 * never prints an environment variable's value — only whether one is set. A
 * diagnostic that leaks the palace it is diagnosing is worse than none.
 *
 * The entry-point check is the reason this exists at all: a package whose
 * `files` list omits a source an auxiliary entry imports (audit A04) is silent
 * until a hook fires days later. Here it fails immediately, on demand.
 */
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, statSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { arch, platform, release } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import {
  dataDirectory,
  databasePath,
  installationDirectory,
  modelCacheDirectory,
  queueDirectory,
} from './paths.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Stable machine-readable id, safe to grep in CI. */
  id: string;
  section: 'runtime' | 'paths' | 'storage' | 'locks' | 'models' | 'entrypoints';
  status: DoctorStatus;
  /** One line, no secrets, no memory content. */
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** Worst status across every check — the exit code the CLI maps to. */
  status: DoctorStatus;
}

export interface DoctorOptions {
  /** Overridden wholesale in tests so no probe touches the real palace. */
  paths?: {
    data: string;
    database: string;
    queue: string;
    modelCache: string;
  };
  installRoot?: string;
  /** Minimum runtime the package claims to support (`engines.bun`). */
  minimumBun?: string;
}

/** Env overrides worth reporting. Names only — a value can be a private path. */
const TRACKED_ENV = [
  'HUMEMORY_DATA_DIR',
  'HUMEMORY_DB',
  'HUMEMORY_QUEUE',
  'HUMEMORY_MODEL_CACHE',
  'HUMEMORY_HOST',
  'HUMEMORY_API_TOKEN',
  'PORT',
] as const;

/**
 * Auxiliary entry points, relative to the installation root. `optional` covers
 * what a source checkout legitimately lacks before a build (`dist`, the
 * bundled dashboard); a missing required file means the published archive is
 * broken for that entry point.
 */
const ENTRY_POINTS: { path: string; label: string; optional?: boolean }[] = [
  { path: 'bin/humemory.js', label: 'CLI shim' },
  { path: 'dist/cli/index.js', label: 'CLI implementation', optional: true },
  { path: 'src/mcp/server.ts', label: 'MCP server (registered by `humemory setup`)' },
  { path: 'src/api/server.ts', label: 'HTTP API' },
  { path: 'scripts/hook-session.ts', label: 'Stop hook' },
  { path: 'scripts/hook-session-start.ts', label: 'SessionStart hook' },
  { path: 'scripts/hook-post-commit.ts', label: 'post-commit hook' },
  { path: 'scripts/maintenance-worker.ts', label: 'maintenance worker' },
  { path: 'public/app', label: 'bundled dashboard', optional: true },
];

/** Tables the store creates. A missing one means an interrupted migration. */
const EXPECTED_TABLES = [
  'memories',
  'intentions',
  'cues',
  'scripts',
  'contradictions',
];

function compareSemver(actual: string, minimum: string): number {
  const parse = (v: string) => v.replace(/^[^\d]*/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(actual), parse(minimum)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

/** Probe by writing, not by reading a permission bit: ACLs lie on Windows. */
async function probeWritable(directory: string): Promise<{ status: DoctorStatus; detail: string }> {
  const probe = join(directory, `.humemory-doctor-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(probe, '', { flag: 'wx' });
    return { status: 'ok', detail: `writable — ${directory}` };
  } catch (error: any) {
    return { status: 'fail', detail: `not writable (${error?.code ?? 'unknown'}) — ${directory}` };
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
}

/**
 * Is the advisory lock at `lockFile` held right now? Acquiring and releasing
 * is the only honest answer — the lock has no wall-clock expiry to inspect
 * (audit A08), and its owner is the OS, not a mtime.
 */
function probeLock(lockFile: string): { status: DoctorStatus; detail: string } {
  const sqlitePath = `${lockFile}.sqlite`;
  if (!existsSync(sqlitePath)) return { status: 'ok', detail: `free (never taken) — ${lockFile}` };
  let connection: Database | null = null;
  try {
    connection = new Database(sqlitePath);
    connection.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    connection.exec('ROLLBACK');
    return { status: 'ok', detail: `free — ${lockFile}` };
  } catch (error: any) {
    const code = String(error?.code ?? '');
    if (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) {
      // Held by a live process. Not a fault: a worker may simply be running.
      return { status: 'warn', detail: `held by a live process — ${lockFile}` };
    }
    return { status: 'fail', detail: `unreadable (${code || 'unknown'}) — ${lockFile}` };
  } finally {
    connection?.close();
  }
}

function inspectDatabase(dbPath: string): DoctorCheck[] {
  if (dbPath === ':memory:') {
    return [{ id: 'db.open', section: 'storage', status: 'warn', detail: 'in-memory database — nothing persists' }];
  }
  if (!existsSync(dbPath)) {
    return [
      { id: 'db.open', section: 'storage', status: 'warn', detail: `absent, created on first write — ${dbPath}` },
    ];
  }
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const names = new Set(
      (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name)
    );
    const missing = EXPECTED_TABLES.filter((table) => !names.has(table));
    const journal = (db.query('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
    const checks: DoctorCheck[] = [
      {
        id: 'db.open',
        section: 'storage',
        status: 'ok',
        detail: `opened, ${names.size} tables, journal_mode=${journal} — ${dbPath}`,
      },
      {
        id: 'db.schema',
        section: 'storage',
        status: missing.length ? 'fail' : 'ok',
        detail: missing.length
          ? `missing tables: ${missing.join(', ')} — migration interrupted`
          : `all ${EXPECTED_TABLES.length} expected tables present`,
      },
    ];
    if (journal.toLowerCase() !== 'wal') {
      checks.push({
        id: 'db.wal',
        section: 'storage',
        status: 'warn',
        detail: `journal_mode is ${journal}; multi-process access expects WAL`,
      });
    }
    return checks;
  } catch (error: any) {
    return [
      { id: 'db.open', section: 'storage', status: 'fail', detail: `cannot open (${error?.code ?? 'unknown'}) — ${dbPath}` },
    ];
  } finally {
    db?.close();
  }
}

function inspectModels(cacheDir: string): DoctorCheck {
  if (!existsSync(cacheDir)) {
    return {
      id: 'models.cache',
      section: 'models',
      status: 'warn',
      detail: `no model cache — semantic recall downloads on first use (${cacheDir})`,
    };
  }
  // One level of vendor/model directories is enough to name what is installed;
  // walking the whole tree would be slow and tells the user nothing more.
  const vendors = readdirSync(cacheDir).filter((entry) => {
    try {
      return statSync(join(cacheDir, entry)).isDirectory();
    } catch {
      return false;
    }
  });
  const models: string[] = [];
  for (const vendor of vendors) {
    try {
      for (const model of readdirSync(join(cacheDir, vendor))) {
        if (statSync(join(cacheDir, vendor, model)).isDirectory()) models.push(`${vendor}/${model}`);
      }
    } catch {
      /* unreadable subdirectory tells us nothing; the cache check above stands */
    }
  }
  return {
    id: 'models.cache',
    section: 'models',
    status: models.length ? 'ok' : 'warn',
    detail: models.length ? `cached: ${models.join(', ')}` : `cache directory empty — ${cacheDir}`,
  };
}

function inspectEntryPoints(installRoot: string): DoctorCheck[] {
  return ENTRY_POINTS.map(({ path, label, optional }) => {
    const absolute = join(installRoot, path);
    const present = existsSync(absolute);
    return {
      id: `entry.${path}`,
      section: 'entrypoints' as const,
      status: present ? 'ok' : optional ? 'warn' : 'fail',
      detail: present
        ? `${label} — ${path}`
        : optional
          ? `${label} absent (build not run?) — ${path}`
          : `${label} MISSING from the installation — ${path}`,
    };
  });
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const paths = options.paths ?? {
    data: dataDirectory(),
    database: databasePath(),
    queue: queueDirectory(),
    modelCache: modelCacheDirectory(),
  };
  const installRoot = options.installRoot ?? installationDirectory();
  const checks: DoctorCheck[] = [];

  // --- runtime ---
  const bunVersion = typeof Bun === 'undefined' ? null : Bun.version;
  if (!bunVersion) {
    checks.push({
      id: 'runtime.bun',
      section: 'runtime',
      status: 'fail',
      detail: 'not running under bun — the store needs bun:sqlite',
    });
  } else if (options.minimumBun && compareSemver(bunVersion, options.minimumBun) < 0) {
    checks.push({
      id: 'runtime.bun',
      section: 'runtime',
      status: 'fail',
      detail: `bun ${bunVersion} is below the declared minimum ${options.minimumBun}`,
    });
  } else {
    checks.push({ id: 'runtime.bun', section: 'runtime', status: 'ok', detail: `bun ${bunVersion}` });
  }
  checks.push({
    id: 'runtime.platform',
    section: 'runtime',
    status: 'ok',
    detail: `${platform()} ${arch()} (kernel ${release()})`,
  });
  const setEnv = TRACKED_ENV.filter((name) => (process.env[name] ?? '') !== '');
  checks.push({
    id: 'runtime.env',
    section: 'runtime',
    // Names only. HUMEMORY_API_TOKEN's value must never reach a log.
    status: 'ok',
    detail: setEnv.length ? `overrides set: ${setEnv.join(', ')}` : 'no environment overrides set',
  });

  // --- paths and write rights ---
  for (const [id, directory] of [
    ['paths.data', paths.data],
    ['paths.queue', paths.queue],
    ['paths.modelCache', paths.modelCache],
  ] as const) {
    const probe = await probeWritable(directory);
    checks.push({ id, section: 'paths', status: probe.status, detail: probe.detail });
  }
  checks.push({
    id: 'paths.database',
    section: 'paths',
    status: 'ok',
    detail: `database resolves to ${paths.database}`,
  });
  checks.push({
    id: 'paths.install',
    section: 'paths',
    status: 'ok',
    detail: `installation root ${installRoot}`,
  });

  // --- storage, locks, models, entry points ---
  checks.push(...inspectDatabase(paths.database));
  if (paths.database !== ':memory:') {
    const dbLock = probeLock(`${paths.database}.lock`);
    checks.push({ id: 'locks.database', section: 'locks', ...dbLock });
  }
  const workerLock = probeLock(join(paths.queue, '.worker-lock'));
  checks.push({ id: 'locks.maintenance', section: 'locks', ...workerLock });
  checks.push(inspectModels(paths.modelCache));
  checks.push(...inspectEntryPoints(installRoot));

  const status: DoctorStatus = checks.some((c) => c.status === 'fail')
    ? 'fail'
    : checks.some((c) => c.status === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, status };
}

const SECTION_TITLES: Record<DoctorCheck['section'], string> = {
  runtime: 'Runtime',
  paths: 'Paths and write rights',
  storage: 'Database',
  locks: 'Locks',
  models: 'Embedding models',
  entrypoints: 'Entry points',
};

const MARKS: Record<DoctorStatus, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };

export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['', '🩺 humemory doctor', ''];
  for (const section of Object.keys(SECTION_TITLES) as DoctorCheck['section'][]) {
    const rows = report.checks.filter((check) => check.section === section);
    if (!rows.length) continue;
    lines.push(`${SECTION_TITLES[section]}:`);
    for (const row of rows) lines.push(`  ${MARKS[row.status]} ${row.detail}`);
    lines.push('');
  }
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  const warned = report.checks.filter((c) => c.status === 'warn').length;
  lines.push(
    report.status === 'ok'
      ? 'All checks passed.'
      : `${failed} failing, ${warned} to review out of ${report.checks.length} checks.`
  );
  return lines.join('\n');
}
