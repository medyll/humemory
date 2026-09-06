/** Safe, merge-only MCP registration for locally installed agent clients. */
import { mkdir, readFile, writeFile, rename, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { databasePath } from '../core/paths.js';
import { AdvisoryLock } from '../store/sqlite.js';

export type HumemoryMcpClient = 'kimi' | 'opencode';

export interface McpClientSetupOptions {
  clients: HumemoryMcpClient[];
  projectRoot: string;
  dbPath?: string;
  bunPath?: string;
  kimiHome?: string;
  openCodeConfig?: string;
  dryRun?: boolean;
}

export interface McpClientSetupEntry {
  client: HumemoryMcpClient;
  path: string;
  changed: boolean;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function readJson(raw: string | null, path: string): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    for (const key of ['mcp', 'mcpServers']) {
      if (key in parsed && (!parsed[key] || typeof parsed[key] !== 'object' || Array.isArray(parsed[key]))) {
        throw new Error(`${key} must be an object`);
      }
    }
    return parsed;
  } catch (error) {
    throw new Error(`Refusing to rewrite invalid or commented JSON: ${path} (${(error as Error).message})`);
  }
}

async function mergeFile(
  path: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
  dryRun: boolean,
): Promise<boolean> {
  const apply = async () => {
  const original = await readOptional(path);
  const current = readJson(original, path);
  const before = JSON.stringify(current);
  const next = update(current);
  const changed = before !== JSON.stringify(next);
  if (changed && !dryRun) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      if (original !== null) await writeFile(`${path}.${randomUUID()}.bak`, original, { mode: 0o600, flag: 'wx' });
      if (await readOptional(path) !== original) throw new Error(`Configuration changed during setup: ${path}`);
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
  }
  return changed;
  };
  if (dryRun) return apply();
  await mkdir(dirname(path), { recursive: true });
  return new AdvisoryLock(path + '.setup', 50).withLock(apply);
}

export async function setupHumemoryMcpClients(options: McpClientSetupOptions): Promise<McpClientSetupEntry[]> {
  const projectRoot = resolve(options.projectRoot);
  const serverPath = join(projectRoot, 'src', 'mcp', 'server.ts');
  const configuredDb = options.dbPath ?? databasePath();
  const dbPath = configuredDb === ':memory:' ? configuredDb : resolve(configuredDb);
  const bunPath = resolve(options.bunPath ?? process.execPath);
  const dryRun = options.dryRun ?? false;
  const entries: McpClientSetupEntry[] = [];

  for (const client of [...new Set(options.clients)]) {
    if (client === 'kimi') {
      const path = join(options.kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'), 'mcp.json');
      const changed = await mergeFile(path, (current) => ({
        ...current,
        mcpServers: {
          ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}),
          humemory: {
            command: bunPath,
            args: ['run', serverPath],
            env: { HUMEMORY_AGENT: 'kimi', HUMEMORY_DB: dbPath },
          },
        },
      }), dryRun);
      entries.push({ client, path, changed });
      continue;
    }

    const path = options.openCodeConfig ?? process.env.OPENCODE_CONFIG ??
      join(homedir(), '.config', 'opencode', 'opencode.json');
    const changed = await mergeFile(path, (current) => ({
      ...current,
      $schema: current.$schema ?? 'https://opencode.ai/config.json',
      mcp: {
        ...((current.mcp as Record<string, unknown> | undefined) ?? {}),
        humemory: {
          type: 'local',
          command: [bunPath, 'run', serverPath],
          enabled: true,
          environment: { HUMEMORY_AGENT: 'opencode', HUMEMORY_DB: dbPath },
        },
      },
    }), dryRun);
    entries.push({ client, path, changed });
  }
  return entries;
}
