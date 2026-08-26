#!/usr/bin/env bun
/** One non-blocking maintenance pass over sessions queued by local agent hooks. */

import Anthropic from '@anthropic-ai/sdk';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { LLMClient } from '../src/core/llm-generator.js';
import { createCodexClient } from '../src/core/llm-cli-client.js';
import { processMaintenanceQueue } from '../src/agent/maintenance-queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const queueDir = process.env.HUMEMORY_QUEUE ?? join(__dirname, '../data/maintenance-queue');
const dbPath = process.env.HUMEMORY_DB ?? join(__dirname, '../data/humemory.db');
const provider = process.env.HUMEMORY_MAINTENANCE_LLM ?? 'none';

const llmTimeoutMs = Number(process.env.HUMEMORY_MAINTENANCE_TIMEOUT_MS ?? 8_000);

// 'none' (the default) keeps consolidation deterministic and network-free.
let client: LLMClient | undefined;
if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
  client = new Anthropic() as unknown as LLMClient;
} else if (provider === 'codex') {
  // No API key needed: the logged-in `codex` CLI answers instead. Slower than an
  // SDK call (agent start-up), so it gets its own, larger budget.
  client = createCodexClient({ timeoutMs: llmTimeoutMs });
}

const result = await processMaintenanceQueue({
  queueDir,
  dbPath,
  client,
  llmTimeoutMs,
  maxJobs: Number(process.env.HUMEMORY_MAINTENANCE_BATCH ?? 20),
});

if (result.busy) {
  if (process.env.HUMEMORY_VERBOSE === '1') console.error('[humemory] maintenance: another worker is active');
} else if (process.env.HUMEMORY_VERBOSE === '1' || result.failed > 0) {
  console.error(
    `[humemory] maintenance: ${result.processed}/${result.discovered} jobs, ` +
    `${result.memoriesStored} memories, ${result.failed} retained, ${result.deadLettered} dead-lettered`,
  );
}

if (result.failed > 0) process.exitCode = 1;
