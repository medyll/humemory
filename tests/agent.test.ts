import { describe, test, expect } from 'bun:test';
import { parseClaudeHookPayload } from '../src/agent/session-parser.js';
import { extractLearnings } from '../src/agent/learning-extractor.js';
import { processSession } from '../src/agent/claude-hook.js';
import type { LLMClient } from '../src/core/llm-generator.js';
import { rmSync } from 'fs';

const SAMPLE_PAYLOAD = JSON.stringify({
  session_id: 'test-session-001',
  cwd: '/test/project',
  transcript: [
    { role: 'user', content: 'Fix the SQLite migration bug' },
    { role: 'assistant', content: 'I found the bug in the migration script. The issue was that the ALTER TABLE statement was not handling existing columns properly. Fixed by wrapping in try/catch.' },
    { role: 'user', content: 'Also add a new index for performance' },
    { role: 'assistant', content: 'Added CREATE INDEX IF NOT EXISTS idx_type ON memories(memory_type). This will speed up type-filtered queries by 3-5x.' },
  ],
});

const MOCK_LEARNINGS = JSON.stringify([
  {
    content: 'SQLite migration: wrap ALTER TABLE in try/catch to handle existing columns',
    memoryType: 'procedural',
    keywords: ['sqlite', 'migration', 'alter-table'],
    level3Keywords: 'sqlite migration alter table error handling',
  },
  {
    content: 'Added idx_type index on memories(memory_type) for 3-5x query speedup on type filters',
    memoryType: 'semantic',
    keywords: ['sqlite', 'index', 'performance'],
    level3Keywords: 'sqlite index performance memory_type',
  },
]);

function makeMockClient(responseText: string): LLMClient {
  return {
    messages: {
      create: async () => ({ content: [{ type: 'text', text: responseText }] }),
    },
  };
}

describe('session-parser', () => {
  test('parse Claude Code hook JSON payload', () => {
    const session = parseClaudeHookPayload(SAMPLE_PAYLOAD, '/fallback');
    expect(session.sessionId).toBe('test-session-001');
    expect(session.directory).toBe('/test/project');
    expect(session.messages).toHaveLength(4);
    expect(session.messages[0].role).toBe('user');
  });

  test('parse JSONL format', () => {
    const jsonl = [
      JSON.stringify({ role: 'user', content: 'hello' }),
      JSON.stringify({ role: 'assistant', content: 'world' }),
    ].join('\n');

    const session = parseClaudeHookPayload(jsonl, '/test');
    expect(session.messages).toHaveLength(2);
    expect(session.messages[1].content).toBe('world');
  });

  test('fallback: plain text', () => {
    const session = parseClaudeHookPayload('some plain text transcript', '/test');
    expect(session.messages).toHaveLength(1);
    expect(session.rawText).toContain('plain text');
  });

  test('extrait le cwd depuis le payload', () => {
    const payload = JSON.stringify({ session_id: 'x', cwd: '/my/project', transcript: [] });
    const session = parseClaudeHookPayload(payload, '/fallback');
    expect(session.directory).toBe('/my/project');
  });
});

describe('learning-extractor', () => {
  test('extrait les apprentissages depuis un transcript', async () => {
    const session = parseClaudeHookPayload(SAMPLE_PAYLOAD, '/test');
    const client = makeMockClient(MOCK_LEARNINGS);
    const learnings = await extractLearnings(session, client, 5);

    expect(learnings).toHaveLength(2);
    expect(learnings[0].memoryType).toBe('procedural');
    expect(learnings[0].keywords).toContain('sqlite');
    expect(learnings[1].memoryType).toBe('semantic');
  });

  test('fallback si JSON invalide — retourne dernier message assistant', async () => {
    const session = parseClaudeHookPayload(SAMPLE_PAYLOAD, '/test');
    const client = makeMockClient('not json');
    const learnings = await extractLearnings(session, client, 5);

    expect(learnings).toHaveLength(1);
    expect(learnings[0].memoryType).toBe('episodic');
    expect(learnings[0].content.length).toBeGreaterThan(0);
  });

  test('respecte maxLearnings', async () => {
    const session = parseClaudeHookPayload(SAMPLE_PAYLOAD, '/test');
    const client = makeMockClient(MOCK_LEARNINGS);
    const learnings = await extractLearnings(session, client, 1);
    expect(learnings.length).toBeLessThanOrEqual(1);
  });
});

describe('processSession (integration)', () => {
  const DB = 'tests/test-hook.db';

  test('stocke les apprentissages extraits en DB', async () => {
    try { rmSync(DB); } catch {}
    const client = makeMockClient(MOCK_LEARNINGS);

    const result = await processSession(SAMPLE_PAYLOAD, {
      dbPath: DB,
      directory: '/test/project',
      maxLearnings: 5,
      client,
    });

    expect(result.memoriesStored).toBe(2);
    expect(result.sessionId).toBe('test-session-001');
    expect(result.learnings).toHaveLength(2);

    try { rmSync(DB); } catch {}
  });

  test('retourne 0 si transcript vide', async () => {
    try { rmSync(DB); } catch {}
    const emptyPayload = JSON.stringify({ session_id: 'empty', transcript: [] });
    const client = makeMockClient('[]');

    const result = await processSession(emptyPayload, {
      dbPath: DB,
      directory: '/test',
      maxLearnings: 5,
      client,
    });

    expect(result.memoriesStored).toBe(0);
    try { rmSync(DB); } catch {}
  });
});
