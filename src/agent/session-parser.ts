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
