#!/usr/bin/env bun
/**
 * Packaging verification — audit A04/A05 acceptance criteria.
 *
 * Builds the archive, installs it into a temporary directory *outside* the
 * checkout, and exercises every entry point there: CLI, hooks, maintenance,
 * MCP and API. The install path deliberately contains a space and an accent,
 * and the data directory is a virgin profile, because both are the shapes that
 * broke before.
 *
 * The invariant this defends: no step may reach back into the source checkout.
 * A `files` list that forgets a source an auxiliary entry imports passes every
 * unit test and fails here, which is exactly the failure A04 describes.
 *
 * Run: `pnpm verify:package` (needs network for the dependency install).
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A space and an accent: the two path shapes that break naive quoting. */
const AWKWARD_SEGMENT = 'humemory vérif';

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];
let installedRoot = '';
let workspace = '';

function record(name: string, ok: boolean, detail: string): boolean {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

/**
 * `pnpm` and `npm` are `.cmd` shims on Windows, and since the CVE-2024-27980
 * fix node refuses to spawn a batch file without a shell (EINVAL). Node does
 * not quote arguments for `shell: true` either, so the command line is built
 * and quoted here — the paths in play contain a space and an accent by design.
 */
function needsWindowsShell(command: string): boolean {
  return process.platform === 'win32' && (command === 'pnpm' || command === 'npm');
}

function quoteForCmd(argument: string): string {
  return `"${argument.replace(/"/g, '\\"')}"`;
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {}
) {
  const viaShell = needsWindowsShell(command);
  const result = spawnSync(
    viaShell ? `${command} ${args.map(quoteForCmd).join(' ')}` : command,
    viaShell ? [] : args,
    {
      cwd: options.cwd ?? (installedRoot ? workspace : repoRoot),
      // A clean-ish env: the point is to prove the install stands alone, so the
      // caller's HUMEMORY_* overrides must not leak into the child.
      env: { ...strippedEnv(), ...(options.env ?? {}) },
      input: options.input,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 180_000,
      shell: viaShell,
    }
  );
  // A spawn that never started reports no status and no output: without this,
  // the failure row reads as an empty string and says nothing at all.
  const spawnError = result.error
    ? `${(result.error as NodeJS.ErrnoException).code ?? 'spawn failed'}: ${result.error.message}`
    : '';
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: [result.stderr ?? '', spawnError].filter(Boolean).join('\n'),
  };
}

function strippedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // HUMEMORY_*: the caller's overrides must not decide where the installed
    // copy stores anything — this script sets its own profile.
    if (key.startsWith('HUMEMORY_')) continue;
    // NODE_ENV: CI runs the unit suite with NODE_ENV=test, and the store then
    // refuses to open its own resolved database (docs/TESTING.md guard). This
    // is a real install being exercised, not the hermetic suite.
    if (key === 'NODE_ENV') continue;
    env[key] = value;
  }
  return env;
}

/** First line of a failure, for a one-line report row. */
function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}

// --- 1. Build and pack ------------------------------------------------------

function buildAndPack(): string | null {
  // CI already builds before this step; a second full build there buys nothing.
  if (process.env.HUMEMORY_SKIP_BUILD === '1') {
    const built = existsSync(join(repoRoot, 'dist', 'cli', 'index.js'));
    if (!record('build (reused)', built, built ? '' : 'HUMEMORY_SKIP_BUILD=1 but dist/ is absent')) return null;
  } else {
    const build = run('pnpm', ['build'], { timeoutMs: 600_000 });
    if (!record('build', build.code === 0, build.code === 0 ? '' : firstLine(build.stderr || build.stdout))) {
      return null;
    }
  }

  workspace = mkdtempSync(join(tmpdir(), 'humemory-pack-'));
  const packDir = join(workspace, AWKWARD_SEGMENT, 'archive');
  mkdirSync(packDir, { recursive: true });

  // `pnpm pack --pack-destination` keeps the tarball out of the checkout, so a
  // failed run never leaves a stray .tgz behind to be committed.
  const pack = run('pnpm', ['pack', '--pack-destination', packDir], { timeoutMs: 300_000 });
  if (!record('pack', pack.code === 0, pack.code === 0 ? '' : firstLine(pack.stderr || pack.stdout))) {
    return null;
  }

  const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
  if (!tarball) {
    record('pack: tarball present', false, `no .tgz in ${packDir}`);
    return null;
  }
  record('pack: tarball present', true, tarball);
  return join(packDir, tarball);
}

// --- 2. Install outside the checkout ----------------------------------------

function installTarball(tarball: string): string | null {
  const consumer = join(workspace, AWKWARD_SEGMENT, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'humemory-package-check', version: '0.0.0', private: true }, null, 2)}\n`
  );

  // npm, not pnpm: pnpm's default symlinked store would resolve some paths back
  // through a global store, which weakens the "stands alone" claim.
  const install = run('npm', ['install', '--no-audit', '--no-fund', '--loglevel', 'error', tarball], {
    cwd: consumer,
    timeoutMs: 600_000,
  });
  if (!record('install outside the checkout', install.code === 0, install.code === 0 ? consumer : firstLine(install.stderr || install.stdout))) {
    return null;
  }

  const root = join(consumer, 'node_modules', 'humemory');
  if (!existsSync(root)) {
    record('installed package present', false, root);
    return null;
  }
  return root;
}

// --- 3. Exercise the entry points -------------------------------------------

interface Profile {
  data: string;
  queue: string;
  env: Record<string, string>;
}

function virginProfile(): Profile {
  // Nested, non-existent parents: A05's reproduction, from the outside.
  const data = join(workspace, AWKWARD_SEGMENT, 'profil neuf', 'état');
  const queue = join(data, 'maintenance-queue');
  return {
    data,
    queue,
    env: {
      HUMEMORY_DATA_DIR: data, HUMEMORY_AGENT: 'package-check',
      HUMEMORY_MAINTENANCE_INTERVAL_MS: '0', HUMEMORY_MAINTENANCE_LLM: 'none',
      ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '',
    },
  };
}

function checkDoctor(root: string, profile: Profile) {
  const doctor = run('bun', [join(root, 'bin', 'humemory.js'), 'doctor', '--json'], { env: profile.env });
  if (doctor.code !== 0) {
    record('doctor', false, firstLine(doctor.stderr || doctor.stdout));
    return;
  }
  try {
    const report = JSON.parse(doctor.stdout) as { status: string; checks: { id: string; status: string; detail: string }[] };
    const failures = report.checks.filter((c) => c.status === 'fail');
    record(
      'doctor: no failing check in the installed copy',
      failures.length === 0,
      failures.length ? failures.map((f) => `${f.id}: ${f.detail}`).join(' | ') : `${report.checks.length} checks`
    );
    const installRoot = report.checks.find((c) => c.id === 'paths.install')?.detail ?? '';
    record(
      'doctor: resolves to the installed root, not the checkout',
      !installRoot.includes(repoRoot),
      installRoot
    );
  } catch (error) {
    record('doctor: JSON report', false, firstLine(String(error)));
  }
}

function checkCli(root: string, profile: Profile) {
  const bin = join(root, 'bin', 'humemory.js');
  const marker = 'quasarpackagecheck';

  const encode = run('bun', [bin, 'encode', `synthetic trace ${marker}`, '--keywords', marker], { env: profile.env });
  record('cli: encode into a virgin profile', encode.code === 0, encode.code === 0 ? '' : firstLine(encode.stderr || encode.stdout));

  const search = run('bun', [bin, 'search', marker], { env: profile.env });
  record(
    'cli: search finds what was just encoded',
    search.code === 0 && search.stdout.includes(marker),
    search.code === 0 ? '' : firstLine(search.stderr || search.stdout)
  );

  const status = run('bun', [bin, 'status'], { env: profile.env });
  record('cli: status', status.code === 0, status.code === 0 ? '' : firstLine(status.stderr || status.stdout));

  // `maintenance status` exits 1 on staleness by design, and a virgin profile is
  // stale by definition. What is being verified here is that the command runs
  // from the installed tree and reports, not that the loop has already run.
  const maintenance = run('bun', [bin, 'maintenance', 'status', '--json'], { env: profile.env });
  let reported = false;
  try {
    reported = typeof (JSON.parse(maintenance.stdout) as { stale?: boolean }).stale === 'boolean';
  } catch {
    reported = false;
  }
  record('cli: maintenance status reports', reported, reported ? '' : firstLine(maintenance.stderr || maintenance.stdout));
}

function checkHook(root: string, profile: Profile) {
  const hook = join(root, 'scripts', 'hook-session.ts');
  // A minimal synthetic transcript: two turns, no real conversation content.
  const transcript = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'synthetic prompt for the package check' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'synthetic reply' }] } }),
  ].join('\n');

  const result = run('bun', [hook], { env: { ...profile.env, HUMEMORY_VERBOSE: '1' }, input: transcript });
  const queued = existsSync(profile.queue) && readdirSync(profile.queue).some((file) => file.endsWith('.json'));
  record(
    'hook: Stop hook queues a session from the installed copy',
    result.code === 0 && queued,
    queued ? profile.queue : firstLine(result.stderr || result.stdout) || 'no job written'
  );
}

async function checkMcp(root: string, profile: Profile): Promise<void> {
  const server = join(root, 'src', 'mcp', 'server.ts');
  const child = spawn('bun', [server], {
    cwd: workspace,
    env: { ...strippedEnv(), ...profile.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const request = `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'humemory-package-check', version: '0.0.0' },
    },
  })}\n`;

  const answered = await new Promise<boolean>((resolveDone) => {
    let buffer = '';
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      resolveDone(ok);
    };
    const timer = setTimeout(() => finish(false), 30_000);
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk);
      // One well-formed JSON-RPC reply is the whole proof: the server started
      // from the installed tree and resolved its imports.
      if (buffer.includes('"result"') && buffer.includes('"jsonrpc"')) finish(true);
    });
    child.on('error', () => finish(false));
    child.on('exit', () => finish(false));
    child.stdin.write(request);
  });

  await stopChild(child);
  record('mcp: stdio server answers initialize', answered, answered ? '' : 'no JSON-RPC result within 30s');
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    child.once('exit', () => done());
    child.kill('SIGKILL');
  });
}

function checkMaintenanceAndStartHook(root: string, profile: Profile) {
  const worker = run('bun', [join(root, 'scripts', 'maintenance-worker.ts'), '--skip-imports'], {
    env: { ...profile.env, HUMEMORY_VERBOSE: '1' },
  });
  const pending = existsSync(profile.queue)
    ? readdirSync(profile.queue).filter(file => file.endsWith('.json') || file.endsWith('.processing')) : ['missing queue'];
  const processed = /maintenance: 1\/1 jobs/.test(worker.stderr);
  record('maintenance: drains synthetic queue without importing local histories', worker.code === 0 && pending.length === 0 && processed,
    worker.code === 0 && pending.length === 0 && processed ? '' : firstLine(worker.stderr || worker.stdout));
  const start = run('bun', [join(root, 'scripts', 'hook-session-start.ts')], {
    env: { ...profile.env, HUMEMORY_VERBOSE: '1', HUMEMORY_DIR: workspace },
  });
  record('hook: SessionStart loads from the installed copy', start.code === 0 && /open loop\(s\)/.test(start.stderr), firstLine(start.stderr));
  const commit = run('bun', [join(root, 'scripts', 'hook-post-commit.ts')], { env: profile.env });
  record('hook: post-commit loads outside a git checkout', commit.code === 0 && !/hook error/.test(commit.stderr), firstLine(commit.stderr));
  const consolidate = run('bun', [join(root, 'scripts', 'consolidate.js')], { env: profile.env });
  record('consolidation: distributed script runs', consolidate.code === 0, consolidate.code === 0 ? '' : firstLine(consolidate.stderr));
}

async function checkApi(root: string, profile: Profile): Promise<void> {
  const server = join(root, 'src', 'api', 'server.ts');
  // A high, fixed-but-unlikely port: the API refuses non-loopback hosts, and a
  // random port keeps parallel runs from colliding.
  const port = String(31_000 + Math.floor(Math.random() * 2000));
  const child = spawn('bun', [server], {
    cwd: workspace,
    env: { ...strippedEnv(), ...profile.env, PORT: port, HUMEMORY_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let healthy = false;
  let detail = 'server never answered /health';
  child.on('error', (error) => { detail = error.message; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        healthy = true;
        detail = `GET /health ${response.status}`;
        break;
      }
      detail = `GET /health ${response.status}`;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await stopChild(child);
  record('api: serves /health from the installed copy', healthy, detail);
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`\n📦 humemory package verification\n   source: ${repoRoot}\n`);

  const tarball = buildAndPack();
  if (tarball) {
    installedRoot = installTarball(tarball) ?? '';
    if (installedRoot) {
      const profile = virginProfile();
      checkDoctor(installedRoot, profile);
      checkCli(installedRoot, profile);
      checkHook(installedRoot, profile);
      checkMaintenanceAndStartHook(installedRoot, profile);
      await checkMcp(installedRoot, profile);
      await checkApi(installedRoot, profile);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(
    `\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} checks passed.`
  );
  for (const failure of failed) console.log(`   ✗ ${failure.name}: ${failure.detail}`);

  if (workspace && process.env.HUMEMORY_KEEP_WORKSPACE !== '1') {
    if (!resolve(workspace).startsWith(resolve(tmpdir()) + sep) || !basename(workspace).startsWith('humemory-pack-')) {
      throw new Error('Refusing to remove a workspace outside the package-check temporary root');
    }
    rmSync(workspace, { recursive: true, force: true });
  } else if (workspace) {
    console.log(`\nWorkspace kept at ${workspace}`);
  }

  process.exit(failed.length ? 1 : 0);
}

await main();
