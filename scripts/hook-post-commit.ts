#!/usr/bin/env bun
/**
 * Git post-commit hook — ferme les boucles que ce commit a purgées.
 *
 * Installation :
 *   git config core.hooksPath .githooks
 *
 * `.githooks/post-commit` appelle ce script. Il ne ferme automatiquement que
 * les boucles citées explicitement (`Closes loop-a1b2c3d4`) ; le reste est
 * proposé, jamais appliqué.
 *
 * Variables d'environnement :
 *   HUMEMORY_DB   — chemin DB (défaut: data/humemory.db relatif au script)
 *   HUMEMORY_DIR  — lieu mental (défaut: racine du dépôt git)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SQLiteStore } from '../src/store/sqlite.js';
import { applyCommitToLoops, renderCommitReport, type CommitInfo } from '../src/agent/commit-closer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../data/humemory.db');

/** Exécute une commande git, renvoie stdout ou null si elle échoue. */
async function git(args: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'ignore' });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

/** Décrit le commit qui vient d'être créé. Null si on n'est pas dans un dépôt. */
async function lastCommit(): Promise<CommitInfo | null> {
  const sha = await git(['rev-parse', 'HEAD']);
  if (!sha) return null;

  const message = (await git(['log', '-1', '--pretty=%B'])) ?? '';
  const root = (await git(['rev-parse', '--show-toplevel'])) ?? process.cwd();

  // Fichiers du commit. Un commit initial n'a pas de parent : --root couvre le cas.
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
    if (!commit) return; // pas un dépôt git : rien à faire

    store = new SQLiteStore(DB_PATH);
    const result = await applyCommitToLoops(store, commit);

    const report = renderCommitReport(result);
    if (report) process.stdout.write(`\n${report}`);
  } catch (err) {
    // Un hook git ne doit jamais faire échouer un commit déjà écrit.
    console.error(`[humemory] post-commit hook error: ${err}`);
  } finally {
    store?.close();
  }

  process.exit(0);
}

main();
