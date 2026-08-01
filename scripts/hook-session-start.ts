#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook — writes the mnemonic context to stdout.
 *
 * Whatever Claude Code reads on stdout is injected into the session context: the
 * agent starts out knowing which loops it left open on this project, instead of
 * having to go looking for them.
 *
 * Usage dans Claude Code settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/humemory/scripts/hook-session-start.ts" }] }]
 *   }
 * }
 *
 * Environment variables:
 *   HUMEMORY_DB              — database path (default: data/humemory.db, relative to this script)
 *   HUMEMORY_DIR             — project directory (default: cwd)
 *   HUMEMORY_SESSION_BUDGET  — max items per section (default: 10)
 *   HUMEMORY_SAILLANCE_MIN   — salience floor for recalled traces (default: 60)
 *   HUMEMORY_VERBOSE         — '1' to log on stderr
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SQLiteStore } from '../src/store/sqlite.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import { buildSessionContext, DEFAULT_SESSION_BUDGET, DEFAULT_SAILLANCE_THRESHOLD } from '../src/agent/session-context.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../data/humemory.db');
const DIRECTORY = process.env.HUMEMORY_DIR ?? process.cwd();
const VERBOSE = process.env.HUMEMORY_VERBOSE === '1';

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** Current git branch, or undefined outside a repository — never an exception. */
async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', 'branch', '--show-current'], {
      cwd,
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && out ? out : undefined;
  } catch {
    return undefined;
  }
}

async function main() {
  let store: SQLiteStore | undefined;

  try {
    store = new SQLiteStore(DB_PATH);
    const resolver = new SqliteCueResolver(store);

    const context = await buildSessionContext({
      store,
      resolver,
      directory: DIRECTORY,
      branch: await currentBranch(DIRECTORY),
      budget: positiveInt(process.env.HUMEMORY_SESSION_BUDGET, DEFAULT_SESSION_BUDGET),
      saillanceThreshold: positiveInt(process.env.HUMEMORY_SAILLANCE_MIN, DEFAULT_SAILLANCE_THRESHOLD),
    });

    // Nothing relevant: write nothing rather than pollute the context.
    if (context.markdown) process.stdout.write(context.markdown);

    if (VERBOSE) {
      console.error(
        `[humemory] ${context.openLoops.length} open loop(s), ` +
          `${context.traces.length} trace(s), ${context.firedNow.length} deadline(s) reached`
      );
    }
  } catch (err) {
    // A hook must never block a session: log it and exit cleanly.
    console.error(`[humemory] session-start hook error: ${err}`);
  } finally {
    store?.close();
  }

  process.exit(0);
}

main();
