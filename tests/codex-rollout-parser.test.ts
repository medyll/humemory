import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isCodexRollout,
  isSubagentThread,
  parseCodexRollout,
  readCodexRolloutMeta,
} from '../src/agent/codex-rollout-parser.js';
import { parseAgentSession } from '../src/agent/session-parser.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const userRollout = readFileSync(join(FIXTURES, 'codex-rollout.user.jsonl'), 'utf-8');
const subagentRollout = readFileSync(join(FIXTURES, 'codex-rollout.subagent.jsonl'), 'utf-8');

describe('codex rollout parser', () => {
  test('recognises a rollout and leaves a Claude payload alone', () => {
    expect(isCodexRollout(userRollout)).toBe(true);
    expect(isCodexRollout('{"session_id":"s1","transcript":[]}')).toBe(false);
    expect(isCodexRollout('')).toBe(false);
  });

  test('reads provenance without walking the transcript', () => {
    const meta = readCodexRolloutMeta(userRollout)!;
    expect(meta.sessionId).toBe('01a02f57-4c91-7bc3-9435-d479f2c1ec44');
    expect(meta.directory).toBe('/dev/humemory');
    expect(isSubagentThread(meta)).toBe(false);
    expect(isSubagentThread(readCodexRolloutMeta(subagentRollout))).toBe(true);
  });

  test('keeps the human turns and the answers', () => {
    const session = parseCodexRollout(userRollout, '/fallback');
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(session.messages[0].content).toContain('127.0.0.1');
    expect(session.messages[1].content).toContain('loopback');
    expect(session.directory).toBe('/dev/humemory');
  });

  test('drops reasoning and tool plumbing — a learning is what was decided', () => {
    const session = parseCodexRollout(userRollout, '/fallback');
    expect(session.rawText).not.toContain('chain of thought');
    expect(session.rawText).not.toContain('custom_tool_call');
    expect(session.rawText).not.toContain('rg HUMEMORY_HOST');
  });

  test('drops the context codex injects as user turns', () => {
    const session = parseCodexRollout(userRollout, '/fallback');
    expect(session.rawText).not.toContain('environment_context');
    expect(session.rawText).not.toContain('base instructions');
  });

  test('survives a rollout truncated mid-write', () => {
    const truncated = userRollout.trimEnd() + '\n{"timestamp":"2026-08-24T16:38:27.0';
    expect(parseCodexRollout(truncated, '/fallback').messages).toHaveLength(2);
  });

  test('falls back to the caller directory when the header has none', () => {
    const headerless =
      '{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"hello"}]}}';
    const session = parseCodexRollout(headerless, '/fallback');
    expect(session.directory).toBe('/fallback');
    expect(session.sessionId).toMatch(/^codex-/);
  });
});

describe('parseAgentSession dispatch', () => {
  test('routes a rollout to the codex parser', () => {
    expect(parseAgentSession(userRollout, '/fallback').sessionId).toBe('01a02f57-4c91-7bc3-9435-d479f2c1ec44');
  });

  test('still routes a claude hook payload to the claude parser', () => {
    const payload = JSON.stringify({ session_id: 'claude-1', transcript: [{ role: 'user', content: 'ping' }] });
    const session = parseAgentSession(payload, '/fallback');
    expect(session.sessionId).toBe('claude-1');
    expect(session.messages[0].content).toBe('ping');
  });
});
