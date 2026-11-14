/** Safe, merge-only MCP registration for locally installed agent clients. */
import { mkdir, readFile, writeFile, rename, rm } from 'fs/promises';
import { randomUUID } from 'crypto';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { isDeepStrictEqual } from 'util';
import { databasePath } from '../core/paths.js';
import { AdvisoryLock } from '../store/sqlite.js';

export type HumemoryMcpClient = 'kimi' | 'opencode' | 'codex' | 'claude';

export interface McpClientSetupOptions {
  clients: HumemoryMcpClient[];
  projectRoot: string;
  dbPath?: string;
  bunPath?: string;
  kimiHome?: string;
  openCodeConfig?: string;
  codexHome?: string;
  claudeConfig?: string;
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
  return mergeTextFile(path, (original) => {
    const current = readJson(original, path);
    const before = JSON.stringify(current);
    const next = update(current);
    return before === JSON.stringify(next) ? original : `${JSON.stringify(next, null, 2)}\n`;
  }, dryRun);
}

async function mergeTextFile(
  path: string,
  update: (original: string | null) => string | null,
  dryRun: boolean,
): Promise<boolean> {
  const apply = async () => {
  const original = await readOptional(path);
  const next = update(original);
  const changed = original !== next;
  if (changed && next !== null && !dryRun) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { mode: 0o600, flag: 'wx' });
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

/** Encode only the server's values; the rest of the TOML stays byte-for-byte intact. */
function tomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`).join(', ')} }`;
  }
  throw new Error('Unsupported value in Codex humemory configuration');
}

function mergeCodexToml(original: string | null, path: string, server: Record<string, unknown>): string {
  const raw = original ?? '';
  let current: Record<string, any>;
  try { current = Bun.TOML.parse(raw); }
  catch { throw new Error(`Refusing to rewrite invalid TOML: ${path}`); }
  const existing = current.mcp_servers?.humemory;
  if (existing !== undefined && (!existing || typeof existing !== 'object' || Array.isArray(existing))) {
    throw new Error(`Refusing to rewrite invalid Codex humemory table: ${path}`);
  }
  if (existing?.url !== undefined) throw new Error(`Refusing to replace a remote Codex humemory server: ${path}`);
  const next = { ...existing, ...server, env: { ...existing?.env, ...server.env as object } };
  if (isDeepStrictEqual(existing, next)) return raw;

  // Recognise ordinary table headers, including quoted names. The semantic check
  // below refuses inline/dotted definitions and apparent headers inside strings.
  const key = `(?:mcp_servers|"mcp_servers"|'mcp_servers')\\s*\\.\\s*(?:humemory|"humemory"|'humemory')`;
  const owned = new RegExp(`^\\s*\\[\\s*${key}(?:\\s*\\.[^\\]]+)?\\s*\\]\\s*(?:#.*)?$`);
  let removing = false;
  const kept = raw.split(/(?<=\n)/).filter((line) => {
    if (/^\s*\[/.test(line)) removing = owned.test(line.trimEnd());
    return !removing;
  }).join('');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const block = ['[mcp_servers.humemory]', ...Object.entries(next).map(([k, v]) => `${JSON.stringify(k)} = ${tomlValue(v)}`)].join(eol);
  const result = `${kept}${kept && !kept.endsWith('\n') ? eol : ''}${eol}${block}${eol}`;
  try {
    const parsed = Bun.TOML.parse(result) as Record<string, any>;
    const expected = { ...current, mcp_servers: { ...current.mcp_servers, humemory: next } };
    if (!isDeepStrictEqual(parsed, expected)) throw new Error('unrelated settings changed');
  } catch {
    throw new Error(`Refusing to rewrite unsupported Codex TOML layout: ${path}`);
  }
  return result;
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
    if (client === 'codex') {
      const path = join(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
      const changed = await mergeTextFile(path, (original) => mergeCodexToml(original, path, {
        command: bunPath,
        args: ['run', serverPath],
        env: { HUMEMORY_AGENT: 'codex', HUMEMORY_DB: dbPath },
      }), dryRun);
      entries.push({ client, path, changed });
      continue;
    }
    if (client === 'kimi' || client === 'claude') {
      const path = client === 'claude'
        ? resolve(options.claudeConfig ?? join(homedir(), '.claude.json'))
        : join(options.kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code'), 'mcp.json');
      const changed = await mergeFile(path, (current) => ({
        ...current,
        mcpServers: {
          ...((current.mcpServers as Record<string, unknown> | undefined) ?? {}),
          humemory: {
            ...(client === 'claude' ? { type: 'stdio' } : {}),
            command: bunPath,
            args: ['run', serverPath],
            env: { HUMEMORY_AGENT: client, HUMEMORY_DB: dbPath },
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
