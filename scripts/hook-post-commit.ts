#!/usr/bin/env bun
/**
 * Git post-commit hook — closes the loops this commit purged.
 *
 * Install with:
 *   git config core.hooksPath .githooks
 *
 * `.githooks/post-commit` calls this script. It only closes loops named
 * explicitly (`Closes loop-a1b2c3d4`); everything else is suggested, never
 * applied.
 *
 * Environment variables:
 *   HUMEMORY_DB   — database path (default: data/humemory.db, relative to this script)
 *   HUMEMORY_DIR  — mental place (default: the git repository root)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SQLiteStore } from '../src/store/sqlite.js';
import { applyCommitToLoops, renderCommitReport, type CommitInfo } from '../src/agent/commit-closer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../data/humemory.db');

/** Runs a git command, returning stdout or null when it fails. */
async function git(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/** Describes the commit just created. Null when not inside a repository. */
async function lastCommit(): Promise<CommitInfo | null> {
  const sha = await git(['rev-parse', 'HEAD']);
  if (!sha) return null;

  const message = (await git(['log', '-1', '--pretty=%B'])) ?? '';
  const root = (await git(['rev-parse', '--show-toplevel'])) ?? process.cwd();

  // Files in the commit. An initial commit has no parent; this form covers it.
  const raw = await git(['show', '--name-only', '--pretty=format:', '--no-renames', sha]);
  const files = (raw ?? '').split('\n').map((f) => f.trim()).filter(Boolean);

  return {
    sha,
    message,
    files,
    directory: process.env.HUMEMORY_DIR ?? root,
  };
}

async function main() {
  let store: SQLiteStore | undefined;

  try {
    const commit = await lastCommit();
    if (!commit) return; // not a git repository: nothing to do

    store = new SQLiteStore(DB_PATH);
    const result = await applyCommitToLoops(store, commit);

    const report = renderCommitReport(result);
    if (report) process.stdout.write(`\n${report}`);
  } catch (err) {
    // A git hook must never fail a commit that is already written.
    console.error(`[humemory] post-commit hook error: ${err}`);
  } finally {
    store?.close();
  }

  process.exit(0);
}

main();
