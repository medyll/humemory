import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SQLiteStore } from '../src/store/sqlite.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'humemory-cli-'));
  roots.push(root);
  const db = join(root, 'test.db');
  const run = (...args: string[]) => spawnSync(process.execPath, [resolve('src/cli/index.ts'), ...args,
    ...(args[0] === 'sources' && args[1] === 'setup' ? ['--claude-config', join(root, '.claude.json')] : [])], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, NODE_ENV: 'test', HUMEMORY_DB: db, HUMEMORY_DATA_DIR: root,
      CODEX_HOME: join(root, 'codex'), KIMI_CODE_HOME: join(root, 'kimi'), OPENCODE_CONFIG: join(root, 'opencode.json') },
  });
  return { root, db, run };
}

test('CLI starts under Commander 15 and preserves all legacy level aliases', async () => {
  const { db, run } = fixture();
  for (const flags of [['-l1', '-l2', '-l3'], ['--level1', '--level2', '--level3']]) {
    const result = run('encode', 'CLI regression fixture', flags[0], 'summary', flags[1], 'essential', flags[2], 'keywords');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  const store = new SQLiteStore(db);
  try {
    const memories = await store.list();
    expect(memories).toHaveLength(2);
    for (const memory of memories) {
      expect(memory.level1Summary).toBe('summary');
      expect(memory.level2Essential).toBe('essential');
      expect(memory.level3Keywords).toBe('keywords');
    }
  } finally { store.close(); }
});

test('setup CLI selects Codex or combined clients and dry-run writes nothing', () => {
  const { root, run } = fixture();
  const codex = run('sources', 'setup', '--codex', '--dry-run');
  expect(codex.status).toBe(0);
  expect(codex.stdout).toContain('codex: would update');
  expect(codex.stdout).not.toContain('kimi:');
  expect(codex.stdout).not.toContain('opencode:');
  expect(codex.stdout).not.toContain('claude:');
  const claude = run('sources', 'setup', '--claude', '--dry-run');
  expect(claude.status).toBe(0);
  expect(claude.stdout).toContain('claude: would update');
  expect(claude.stdout).not.toContain('codex:');
  const combined = run('sources', 'setup', '--claude', '--codex', '--kimi', '--dry-run');
  expect(combined.status).toBe(0);
  expect(combined.stdout).toContain('kimi: would update');
  expect(combined.stdout).toContain('claude: would update');
  expect(combined.stdout).not.toContain('opencode:');
  const all = run('sources', 'setup', '--dry-run');
  expect(all.status).toBe(0);
  expect(all.stdout).toContain('opencode: would update');
  expect(all.stdout).toContain('codex: would update');
  expect(all.stdout).toContain('claude: would update');
  expect(readdirSync(root)).toEqual([]);
});
