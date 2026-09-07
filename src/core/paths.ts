import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const installationRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Preserve an existing checkout's data; new installs use user-owned storage. */
export function dataDirectory(): string {
  if (process.env.HUMEMORY_DATA_DIR) return resolve(process.env.HUMEMORY_DATA_DIR);
  const legacy = join(installationRoot, 'data');
  if (existsSync(join(legacy, 'humemory.db'))) return legacy;
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'humemory');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'humemory');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'humemory');
}

export function databasePath(): string {
  return process.env.HUMEMORY_DB ?? join(dataDirectory(), 'humemory.db');
}

export function queueDirectory(): string {
  return process.env.HUMEMORY_QUEUE ?? join(dataDirectory(), 'maintenance-queue');
}

export function modelCacheDirectory(): string {
  return process.env.HUMEMORY_MODEL_CACHE ?? join(dataDirectory(), 'models');
}

/**
 * Root of the installed package — the anchor auxiliary entry points (hooks,
 * MCP server, bundled dashboard) are resolved against. `humemory doctor`
 * checks them from here so a package that ships the wrong `files` list fails
 * loudly instead of at the first hook invocation.
 */
export function installationDirectory(): string {
  return installationRoot;
}
