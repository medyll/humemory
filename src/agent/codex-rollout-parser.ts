/**
 * Parses a Codex CLI rollout into the same `ParsedSession` the Claude hook produces.
 *
 * Codex persists one JSONL file per thread under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`. Every line is an
 * envelope `{ timestamp, type, payload }`; only two types carry a conversation:
 *
 *   session_meta   — first line: session id, cwd, and the thread's provenance
 *   response_item  — the turns, of which only `payload.type === 'message'` is one
 *
 * `reasoning`, `custom_tool_call` and `custom_tool_call_output` items are
 * dropped: the first is model-internal, the others are tool plumbing. The
 * Claude parser drops `tool_result` for the same reason — a learning comes from
 * what was decided, not from the mechanics of getting there.
 */

import { lastMessageTime, type ParsedSession, type SessionMessage } from './session-parser.js';

export interface CodexRolloutMeta {
  sessionId: string;
  directory?: string;
  /** `user` for a thread you typed into, `subagent` for one Codex spawned itself. */
  threadSource?: string;
  timestamp?: string;
}

/**
 * Turns Codex injects into the user side of the transcript: they are context,
 * not something a human said, and encoding them would fill the memory with
 * plugin catalogues and environment dumps.
 */
const INJECTED_USER_BLOCK = /^<(environment_context|recommended_plugins|user_instructions|instructions|skills?_context)>/;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block: any) => (block?.type === 'input_text' || block?.type === 'output_text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join('\n');
}

function lines(raw: string): any[] {
  const parsed: any[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A rollout being written to is legitimately truncated on its last line.
    }
  }
  return parsed;
}

/** Reads the provenance header without walking the whole transcript. */
export function readCodexRolloutMeta(raw: string): CodexRolloutMeta | null {
  for (const entry of lines(raw)) {
    if (entry?.type !== 'session_meta') continue;
    const payload = entry.payload ?? {};
    return {
      sessionId: payload.session_id ?? payload.id ?? '',
      directory: typeof payload.cwd === 'string' ? payload.cwd : undefined,
      threadSource: payload.thread_source,
      timestamp: payload.timestamp ?? entry.timestamp,
    };
  }
  return null;
}

/** True when this text is a Codex rollout rather than a Claude hook payload. */
export function isCodexRollout(raw: string): boolean {
  const first = raw.split('\n').find((line) => line.trim());
  if (!first) return false;
  try {
    const entry = JSON.parse(first);
    return entry?.type === 'session_meta' || entry?.type === 'response_item';
  } catch {
    return false;
  }
}

/** A thread Codex spawned for itself — judge passes, reviews — is not a lived session. */
export function isSubagentThread(meta: CodexRolloutMeta | null): boolean {
  return meta?.threadSource === 'subagent';
}

export function parseCodexRollout(raw: string, directory: string): ParsedSession {
  const entries = lines(raw);
  const meta = readCodexRolloutMeta(raw);
  const messages: SessionMessage[] = [];

  for (const entry of entries) {
    if (entry?.type !== 'response_item') continue;
    const payload = entry.payload ?? {};
    if (payload.type !== 'message') continue;
    // `developer` carries the base instructions, not a turn.
    if (payload.role !== 'user' && payload.role !== 'assistant') continue;

    const content = textOf(payload.content).trim();
    if (!content) continue;
    if (payload.role === 'user' && INJECTED_USER_BLOCK.test(content)) continue;

    messages.push({ role: payload.role, content, timestamp: entry.timestamp });
  }

  // A sweep can read a rollout weeks after the thread ran: the transcript's own
  // clock is what the trace must be dated by, not the moment of the sweep.
  const metaTime = meta?.timestamp ? new Date(meta.timestamp) : undefined;
  const occurredAt =
    lastMessageTime(messages) ??
    (metaTime && !Number.isNaN(metaTime.getTime()) ? metaTime : undefined);

  return {
    sessionId: meta?.sessionId || `codex-${Date.now()}`,
    directory: meta?.directory || directory,
    messages,
    occurredAt,
    rawText: messages.map((m) => `${m.role}: ${m.content}`).join('\n\n'),
  };
}
