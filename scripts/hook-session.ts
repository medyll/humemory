#!/usr/bin/env bun
/**
 * Claude Code stop hook — lit le transcript depuis stdin, stocke les apprentissages.
 *
 * Usage dans Claude Code settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/humemory/scripts/hook-session.ts" }] }]
 *   }
 * }
 *
 * Variables d'environnement:
 *   HUMEMORY_DB     — chemin DB (défaut: data/humemory.db relatif au script)
 *   HUMEMORY_DIR    — répertoire projet (défaut: cwd)
 *   HUMEMORY_MAX    — max apprentissages par session (défaut: 5)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { processSession } from '../src/agent/claude-hook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.HUMEMORY_DB ?? join(__dirname, '../data/humemory.db');
const DIRECTORY = process.env.HUMEMORY_DIR ?? process.cwd();
const MAX_LEARNINGS = parseInt(process.env.HUMEMORY_MAX ?? '5');

async function main() {
  let rawInput = '';

  // Read from stdin (Claude Code hook passes transcript via stdin)
  for await (const chunk of Bun.stdin.stream()) {
    rawInput += new TextDecoder().decode(chunk);
  }

  if (!rawInput.trim()) {
    process.exit(0);
  }

  try {
    const result = await processSession(rawInput, {
      dbPath: DB_PATH,
      directory: DIRECTORY,
      maxLearnings: MAX_LEARNINGS,
      verbose: process.env.HUMEMORY_VERBOSE === '1',
    });

    if (result.memoriesStored > 0) {
      console.error(`[humemory] ${result.memoriesStored} apprentissage(s) mémorisé(s) — session ${result.sessionId}`);
    }
  } catch (err) {
    // Never block Claude Code — log to stderr only
    console.error(`[humemory] hook error: ${err}`);
  }

  process.exit(0);
}

main();
