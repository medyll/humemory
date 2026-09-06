import type { ParsedSession, SessionMessage } from './session-parser.js';

interface OpenCodeExport {
  info?: {
    id?: string;
    directory?: string;
    path?: string;
  };
  messages?: Array<{
    info?: {
      role?: string;
      time?: { created?: number | string };
    };
    parts?: Array<{ type?: string; text?: string }>;
  }>;
}

function timestamp(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** Parse the public `opencode export` JSON shape, excluding tools and reasoning. */
export function parseOpenCodeExport(raw: string, fallbackDirectory: string): ParsedSession {
  const payload = JSON.parse(raw) as OpenCodeExport;
  const messages: SessionMessage[] = [];

  for (const entry of payload.messages ?? []) {
    const role = entry.info?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = (entry.parts ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text!.trim())
      .filter(Boolean)
      .join('\n');
    if (!content) continue;
    messages.push({ role, content, timestamp: timestamp(entry.info?.time?.created) });
  }

  const occurredAt = [...messages]
    .reverse()
    .map((message) => message.timestamp ? new Date(message.timestamp) : undefined)
    .find((date) => date && !Number.isNaN(date.getTime()));

  return {
    sessionId: payload.info?.id ?? 'opencode-unknown-session',
    directory: payload.info?.directory ?? payload.info?.path ?? fallbackDirectory,
    messages,
    rawText: messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
    occurredAt,
  };
}
