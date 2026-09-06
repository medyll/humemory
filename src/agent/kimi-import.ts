/** Import Kimi Code sessions into the shared maintenance queue. */
import { isAbsolute, join, resolve } from 'path';
import { homedir } from 'os';
import { readdir, readFile, stat } from 'fs/promises';
import { enqueueSession } from './maintenance-queue.js';
import { parseKimiSession } from './kimi-session-parser.js';
import { serializeAgentSession } from './session-parser.js';

export const KIMI_SOURCE = 'kimi-code-session';

export interface KimiImportOptions {
  queueDir: string;
  kimiHome?: string;
  since?: Date;
  limit?: number;
  dryRun?: boolean;
  maxLearnings?: number;
}

export interface KimiImportResult {
  scanned: number;
  queued: number;
  created: number;
  skippedEmpty: number;
  skippedOld: number;
  unreadable: number;
}

interface KimiIndexEntry {
  sessionDir?: string;
}

export function defaultKimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
}

async function discoverFromIndex(kimiHome: string): Promise<string[]> {
  try {
    const raw = await readFile(join(kimiHome, 'session_index.jsonl'), 'utf8');
    const found: string[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as KimiIndexEntry;
        if (!entry.sessionDir) continue;
        found.push(isAbsolute(entry.sessionDir) ? entry.sessionDir : resolve(kimiHome, entry.sessionDir));
      } catch {
        // One partially-written index line does not invalidate earlier sessions.
      }
    }
    return found;
  } catch {
    return [];
  }
}

async function discoverByState(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  if (entries.some((entry) => entry.isFile() && entry.name === 'state.json')) return [dir];
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) found.push(...await discoverByState(join(dir, entry.name)));
  }
  return found;
}

export async function importKimiSessions(options: KimiImportOptions): Promise<KimiImportResult> {
  const kimiHome = options.kimiHome ?? defaultKimiHome();
  const indexed = await discoverFromIndex(kimiHome);
  const sessionDirs = [...new Set(indexed.length ? indexed : await discoverByState(join(kimiHome, 'sessions')))];
  const candidates: Array<{ dir: string; modified: Date }> = [];
  const result: KimiImportResult = {
    scanned: sessionDirs.length,
    queued: 0,
    created: 0,
    skippedEmpty: 0,
    skippedOld: 0,
    unreadable: 0,
  };

  for (const dir of sessionDirs) {
    try {
      const modified = (await stat(join(dir, 'agents', 'main', 'wire.jsonl'))).mtime;
      if (options.since && modified < options.since) {
        result.skippedOld += 1;
        continue;
      }
      candidates.push({ dir, modified });
    } catch {
      result.unreadable += 1;
    }
  }

  candidates.sort((a, b) => a.modified.getTime() - b.modified.getTime());
  for (const candidate of candidates) {
    if (options.limit !== undefined && result.queued >= options.limit) break;
    try {
      const [wire, state] = await Promise.all([
        readFile(join(candidate.dir, 'agents', 'main', 'wire.jsonl'), 'utf8'),
        readFile(join(candidate.dir, 'state.json'), 'utf8'),
      ]);
      const parsed = parseKimiSession(wire, state, candidate.dir);
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
        source: KIMI_SOURCE,
        agent: 'kimi',
        maxLearnings: options.maxLearnings,
      });
      if (queued.created) result.created += 1;
    } catch {
      result.unreadable += 1;
    }
  }
  return result;
}
