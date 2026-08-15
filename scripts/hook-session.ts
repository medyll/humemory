#!/usr/bin/env bun
/**
 * Claude Code Stop hook — durably queues the transcript and exits without an LLM call.
 *
 * Usage dans Claude Code settings.json:
 * {
 *   "hooks": {
 *     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "bun /path/to/humemory/scripts/hook-session.ts" }] }]
 *   }
 * }
 *
 * Environment variables:
 *   HUMEMORY_QUEUE  — durable inbox (default: data/maintenance-queue)
 *   HUMEMORY_DIR    — project directory (default: cwd)
 *   HUMEMORY_MAX    — max learnings per session (default: 5)
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { enqueueSession } from '../src/agent/maintenance-queue.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const QUEUE_DIR = process.env.HUMEMORY_QUEUE ?? join(__dirname, '../data/maintenance-queue');
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
    const result = await enqueueSession(rawInput, {
      queueDir: QUEUE_DIR,
      directory: DIRECTORY,
      maxLearnings: MAX_LEARNINGS,
      source: 'claude-code',
      agent: process.env.HUMEMORY_AGENT ?? 'claude',
    });

    if (process.env.HUMEMORY_VERBOSE === '1') {
      console.error(`[humemory] session ${result.created ? 'queued' : 'already queued'} — ${result.job.sessionId}`);
    }
  } catch (err) {
    // Never block Claude Code — the raw transcript remains with the source on failure.
    console.error(`[humemory] hook error: ${err}`);
  }

  process.exit(0);
}

main();
