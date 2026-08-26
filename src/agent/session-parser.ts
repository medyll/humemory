import { isCodexRollout, parseCodexRollout } from './codex-rollout-parser.js';

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
}

export interface ParsedSession {
  sessionId: string;
  directory: string;
  messages: SessionMessage[];
  rawText: string;
  /**
   * When the session was *lived*, not when it was read. A rollout swept weeks
   * after the fact must encode as a trace of that day, otherwise every import
   * lands on the import date and the memory loses its timeline — and, with it,
   * the age decay works from.
   */
  occurredAt?: Date;
}

/** The instant a transcript line carries, when it carries a usable one. */
export function messageTime(message: SessionMessage | undefined): Date | undefined {
  if (!message?.timestamp) return undefined;
  const at = new Date(message.timestamp);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** The last usable instant in a run of messages — the session's own clock. */
export function lastMessageTime(messages: SessionMessage[]): Date | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const at = messageTime(messages[i]);
    if (at) return at;
  }
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text') return block.text ?? '';
        if (block?.type === 'tool_result') return '';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content ?? '');
}

// Parse Claude Code hook stdin payload (JSON with transcript array)
export function parseClaudeHookPayload(raw: string, directory: string): ParsedSession {
  try {
    const payload = JSON.parse(raw);

    // Format: { session_id, transcript: [{role, content}] }
    if (payload.transcript && Array.isArray(payload.transcript)) {
      const messages: SessionMessage[] = payload.transcript.map((m: any) => ({
        role: m.role ?? 'assistant',
        content: extractText(m.content),
        timestamp: m.timestamp,
      }));

      return {
        sessionId: payload.session_id ?? `session-${Date.now()}`,
        directory: payload.cwd ?? directory,
        messages,
        rawText: messages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
        occurredAt: lastMessageTime(messages),
      };
    }

    // Format: array of messages directly
    if (Array.isArray(payload)) {
      const messages: SessionMessage[] = payload.map((m: any) => ({
        role: m.role ?? 'assistant',
        content: extractText(m.content),
        timestamp: m.timestamp,
      }));
      return {
        sessionId: `session-${Date.now()}`,
        directory,
        messages,
        rawText: messages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
        occurredAt: lastMessageTime(messages),
      };
    }
  } catch {
    // Not JSON — treat as raw text transcript
  }

  // JSONL: each line is a message
  const lines = raw.split('\n').filter(Boolean);
  const messages: SessionMessage[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.role && obj.content !== undefined) {
        messages.push({ role: obj.role, content: extractText(obj.content) });
      }
    } catch {
      // Not JSONL line, skip
    }
  }

  if (messages.length > 0) {
    return {
      sessionId: `session-${Date.now()}`,
      directory,
      messages,
      rawText: messages.map(m => `${m.role}: ${m.content}`).join('\n\n'),
      occurredAt: lastMessageTime(messages),
    };
  }

  // Fallback: plain text
  return {
    sessionId: `session-${Date.now()}`,
    directory,
    messages: [{ role: 'assistant', content: raw }],
    rawText: raw,
  };
}

/**
 * Entry point for any local agent transcript: detects the producer and hands
 * off. Claude hook payloads and Codex rollouts are both JSON on stdin, so the
 * dispatch is on shape, not on a flag the caller has to remember to pass.
 */
export function parseAgentSession(raw: string, directory: string): ParsedSession {
  return isCodexRollout(raw) ? parseCodexRollout(raw, directory) : parseClaudeHookPayload(raw, directory);
}
