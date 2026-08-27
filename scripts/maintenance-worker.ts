#!/usr/bin/env bun
/**
 * One non-blocking maintenance pass over sessions queued by local agent hooks.
 *
 * The pass itself lives in src/agent/maintenance-runner.ts, shared with the API
 * process, which runs it on a timer. This script stays for manual runs
 * (`pnpm maintenance`) and for a machine that does not keep the API resident.
 */

import { runMaintenancePass, resolveMaintenanceClient, defaultLlmTimeoutMs } from '../src/agent/maintenance-runner.js';

const llmTimeoutMs = defaultLlmTimeoutMs();
const client = await resolveMaintenanceClient(llmTimeoutMs);

// --skip-codex for a machine where the rollouts are imported some other way.
const codexSinceDays = process.argv.includes('--skip-codex')
  ? false as const
  : Number(process.env.HUMEMORY_MAINTENANCE_CODEX_DAYS ?? 1);

const { worker: result } = await runMaintenancePass({ client, llmTimeoutMs, codexSinceDays });

if (result.busy) {
  if (process.env.HUMEMORY_VERBOSE === '1') console.error('[humemory] maintenance: another worker is active');
} else if (process.env.HUMEMORY_VERBOSE === '1' || result.failed > 0) {
  console.error(
    `[humemory] maintenance: ${result.processed}/${result.discovered} jobs, ` +
    `${result.memoriesStored} memories, ${result.failed} retained, ${result.deadLettered} dead-lettered`,
  );
}

if (result.failed > 0) process.exitCode = 1;
