/** Import OpenCode's public session exports into the maintenance queue. */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { enqueueSession } from './maintenance-queue.js';
import { parseOpenCodeExport } from './opencode-session-parser.js';
import { serializeAgentSession } from './session-parser.js';

const execFileAsync = promisify(execFile);
export const OPENCODE_SOURCE = 'opencode-session';

export type OpenCodeCommandRunner = (args: string[]) => Promise<string>;

export interface OpenCodeImportOptions {
  queueDir: string;
  since?: Date;
  limit?: number;
  includeSubagents?: boolean;
  dryRun?: boolean;
  maxLearnings?: number;
  command?: string;
  run?: OpenCodeCommandRunner;
}

export interface OpenCodeImportResult {
  scanned: number;
  queued: number;
  created: number;
  skippedEmpty: number;
  unreadable: number;
}

interface OpenCodeSessionRow {
  id?: string;
  directory?: string;
}

export function defaultOpenCodeCommand(): string {
  return process.env.HUMEMORY_OPENCODE_COMMAND ?? (process.platform === 'win32' ? 'opencode.cmd' : 'opencode');
}

export function createOpenCodeRunner(command = defaultOpenCodeCommand()): OpenCodeCommandRunner {
  return async (args) => {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  };
}

export async function importOpenCodeSessions(options: OpenCodeImportOptions): Promise<OpenCodeImportResult> {
  const run = options.run ?? createOpenCodeRunner(options.command);
  const conditions: string[] = [];
  if (options.since) conditions.push(`time_updated >= ${options.since.getTime()}`);
  if (!options.includeSubagents) conditions.push('parent_id IS NULL');
  const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT id, directory FROM session${where} ORDER BY time_updated ASC`;
  const rows = JSON.parse(await run(['db', sql, '--format', 'json'])) as OpenCodeSessionRow[];
  const result: OpenCodeImportResult = {
    scanned: rows.length,
    queued: 0,
    created: 0,
    skippedEmpty: 0,
    unreadable: 0,
  };

  for (const row of rows) {
    if (options.limit !== undefined && result.queued >= options.limit) break;
    if (!row.id) {
      result.unreadable += 1;
      continue;
    }
    try {
      const parsed = parseOpenCodeExport(await run(['export', row.id]), row.directory ?? process.cwd());
      if (!parsed.messages.some((message) => message.role === 'user') ||
          !parsed.messages.some((message) => message.role === 'assistant')) {
        result.skippedEmpty += 1;
        continue;
      }
      result.queued += 1;
      if (options.dryRun) continue;
      const queued = await enqueueSession(serializeAgentSession(parsed), {
        queueDir: options.queueDir,
        directory: parsed.directory,
        source: OPENCODE_SOURCE,
        agent: 'opencode',
        maxLearnings: options.maxLearnings,
      });
      if (queued.created) result.created += 1;
    } catch {
      result.unreadable += 1;
    }
  }
  return result;
}
