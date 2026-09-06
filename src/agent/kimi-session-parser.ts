import type { ParsedSession, SessionMessage } from './session-parser.js';

interface KimiWireRecord {
  type?: string;
  time?: number | string;
  input?: unknown;
  origin?: { kind?: string };
  message?: {
    role?: string;
    origin?: { kind?: string };
    content?: unknown;
  };
  event?: {
    type?: string;
    turnId?: string;
    part?: { type?: string; text?: string };
  };
}

interface KimiState {
  id?: string;
  cwd?: string;
}

function timestamp(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const numeric = typeof value === 'number' ? value : Number(value);
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function textParts(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      const record = part as { type?: string; text?: string };
      return !record.type || record.type === 'text' ? (record.text ?? '') : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Parse Kimi Code's documented session wire into the common agent transcript. */
export function parseKimiSession(
  wire: string,
  stateRaw: string,
  fallbackDirectory: string,
): ParsedSession {
  let state: KimiState = {};
  try {
    state = JSON.parse(stateRaw) as KimiState;
  } catch {
    // A partially-written state file must not hide an otherwise valid wire.
  }

  const messages: SessionMessage[] = [];
  let assistantText: string[] = [];
  let assistantTimestamp: string | undefined;
  let activeTurn: string | undefined;

  const flushAssistant = () => {
    const content = assistantText.join('').trim();
    if (content) messages.push({ role: 'assistant', content, timestamp: assistantTimestamp });
    assistantText = [];
    assistantTimestamp = undefined;
    activeTurn = undefined;
  };

  for (const line of wire.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: KimiWireRecord;
    try {
      record = JSON.parse(line) as KimiWireRecord;
    } catch {
      continue;
    }

    if (record.type === 'context.append_message') {
      if (record.message?.role !== 'user' || record.message.origin?.kind !== 'user') continue;
      flushAssistant();
      const content = textParts(record.message.content).trim();
      const previous = messages.at(-1);
      if (content && !(previous?.role === 'user' && previous.content === content)) {
        messages.push({ role: 'user', content, timestamp: timestamp(record.time) });
      }
      continue;
    }

    // Older wires may have the prompt event without the mirrored context event.
    if (record.type === 'turn.prompt' && record.origin?.kind === 'user') {
      const content = textParts(record.input).trim();
      const previous = messages.at(-1);
      if (content && !(previous?.role === 'user' && previous.content === content)) {
        flushAssistant();
        messages.push({ role: 'user', content, timestamp: timestamp(record.time) });
      }
      continue;
    }

    if (record.type !== 'context.append_loop_event') continue;
    const event = record.event;
    if (event?.type !== 'content.part' || event.part?.type !== 'text' || !event.part.text) continue;
    if (activeTurn && event.turnId && event.turnId !== activeTurn) flushAssistant();
    activeTurn = event.turnId ?? activeTurn;
    assistantTimestamp ??= timestamp(record.time);
    assistantText.push(event.part.text);
  }
  flushAssistant();

  const occurredAt = [...messages]
    .reverse()
    .map((message) => message.timestamp ? new Date(message.timestamp) : undefined)
    .find((date) => date && !Number.isNaN(date.getTime()));

  return {
    sessionId: state.id ?? 'kimi-unknown-session',
    directory: state.cwd ?? fallbackDirectory,
    messages,
    rawText: messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
    occurredAt,
  };
}
