#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook — écrit le contexte mnésique sur stdout.
 *
 * Ce que Claude Code lit sur stdout est injecté dans le contexte de la session :
 * l'agent démarre en sachant quelles boucles il avait laissées ouvertes sur ce
 * projet, au lieu de devoir aller les chercher.
 *
 * Usage dans Claude Code settings.json:
 * {
 *   "hooks": {
 *     "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/humemory/scripts/hook-session-start.ts" }] }]
 *   }
 * }
 *
 * Variables d'environnement:
 *   HUMEMORY_DB              — chemin DB (défaut: data/humemory.db relatif au script)
 *   HUMEMORY_DIR             — répertoire projet (défaut: cwd)
 *   HUMEMORY_SESSION_BUDGET  — nb max d'éléments par section (défaut: 10)
 *   HUMEMORY_SAILLANCE_MIN   — seuil de saillance des traces rappelées (défaut: 60)
 *   HUMEMORY_VERBOSE         — '1' pour tracer sur stderr
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

/** Branche git courante, ou undefined hors dépôt — jamais une exception. */
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

    // Rien de pertinent : on n'écrit rien, plutôt que de polluer le contexte.
    if (context.markdown) process.stdout.write(context.markdown);

    if (VERBOSE) {
      console.error(
        `[humemory] ${context.openLoops.length} boucle(s) ouverte(s), ` +
          `${context.traces.length} trace(s), ${context.firedNow.length} échéance(s) atteinte(s)`
      );
    }
  } catch (err) {
    // Un hook ne doit jamais bloquer une session : on log et on sort proprement.
    console.error(`[humemory] session-start hook error: ${err}`);
  } finally {
    store?.close();
  }

  process.exit(0);
}

main();
