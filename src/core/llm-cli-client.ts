/**
 * `LLMClient` backed by a local agent CLI instead of a hosted API key.
 *
 * humemory's consolidation path is deterministic and network-free by default;
 * this adapter exists for machines that have no `ANTHROPIC_API_KEY` but do have
 * a logged-in coding agent on the PATH. It is opt-in
 * (`HUMEMORY_MAINTENANCE_LLM=codex`) and every failure falls back to the
 * deterministic extractor upstream, so a missing binary is never fatal.
 *
 * Three flags matter and none of them are cosmetic:
 *   --ephemeral           no rollout is written under ~/.codex/sessions. Without
 *                         it, each consolidation leaves a session that humemory
 *                         would later ingest as a trace — memory eating itself.
 *   --ignore-user-config  skips the user's skills, plugins and hooks. Cheaper
 *                         (~2k fewer tokens per call, half the latency) and it
 *                         stops a humemory Stop hook wired into codex from
 *                         re-entering humemory while maintenance is running.
 *   -s read-only          consolidation summarises text; it never needs a write.
 */

import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { LLMClient } from './llm-generator.js';

/** Runs one non-interactive agent turn and resolves with its final message. */
export type CliRunner = (prompt: string, opts: { timeoutMs: number }) => Promise<string>;

export interface CodexClientOptions {
  /** Model id. Unset means the CLI's own default — mini models are rejected on ChatGPT accounts. */
  model?: string;
  /** Wall-clock budget for one turn. Agent start-up alone is several seconds. */
  timeoutMs?: number;
  /** Injected in tests; the default spawns the real `codex` binary. */
  runner?: CliRunner;
}

/** Strips the ```json fences a chat-tuned model wraps around structured output. */
export function unfence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
  return (fenced ? fenced[1] : text).trim();
}

/** Flattens an Anthropic-shaped request into one prompt string for a CLI turn. */
export function flattenPrompt(params: any): string {
  const blocks: string[] = [];
  const system = params?.system;
  if (typeof system === 'string') blocks.push(system);
  else if (Array.isArray(system)) {
    for (const part of system) if (typeof part?.text === 'string') blocks.push(part.text);
  }
  for (const message of params?.messages ?? []) {
    const content = message?.content;
    if (typeof content === 'string') blocks.push(content);
    else if (Array.isArray(content)) {
      for (const part of content) if (typeof part?.text === 'string') blocks.push(part.text);
    }
  }
  return blocks.join('\n\n');
}

export function codexArgs(outputPath: string, model?: string): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-s', 'read-only',
    '-c', 'model_reasoning_effort="low"',
    '-c', 'model_verbosity="low"',
    ...(model ? ['-m', model] : []),
    '--color', 'never',
    '-o', outputPath,
    '-',
  ];
}

const spawnCodex: CliRunner = async (prompt, { timeoutMs }) => {
  const dir = mkdtempSync(join(tmpdir(), 'humemory-codex-'));
  const outputPath = join(dir, 'last-message.txt');
  try {
    const proc = Bun.spawn(['codex', ...codexArgs(outputPath, process.env.HUMEMORY_LLM_MODEL)], {
      stdin: new TextEncoder().encode(prompt),
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    let code: number;
    try {
      code = await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    if (code !== 0) throw new Error(`codex exec exited ${code}: ${(await new Response(proc.stderr).text()).slice(0, 200)}`);
    return readFileSync(outputPath, 'utf-8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * Wraps a coding-agent CLI in the `LLMClient` shape the consolidation path expects.
 * Only the fields `generateMemoryLevels` reads are honoured — this is a duck, not
 * an SDK: no streaming, no tools, no token accounting.
 */
export function createCodexClient(options: CodexClientOptions = {}): LLMClient {
  const runner = options.runner ?? spawnCodex;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    messages: {
      create: async (params: any) => {
        const text = await runner(flattenPrompt(params), { timeoutMs });
        return { content: [{ type: 'text', text: unfence(text) }] };
      },
    },
  };
}
