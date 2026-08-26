import { describe, test, expect } from 'bun:test';
import { createCodexClient, codexArgs, flattenPrompt, unfence } from '../src/core/llm-cli-client.js';
import { generateMemoryLevels } from '../src/core/llm-generator.js';

const VALID_RESPONSE = JSON.stringify({
  level1Summary: 'The maintenance worker can consolidate through a local CLI agent.',
  level2Essential: 'Consolidation works without an API key.',
  level3Keywords: 'maintenance codex cli consolidation local agent fallback',
});

describe('codex CLI client', () => {
  test('never writes a codex session — a rollout would be re-ingested as a trace', () => {
    expect(codexArgs('/tmp/out.txt')).toContain('--ephemeral');
  });

  test('ignores the user config so codex hooks cannot re-enter humemory', () => {
    expect(codexArgs('/tmp/out.txt')).toContain('--ignore-user-config');
  });

  test('stays read-only and takes the prompt on stdin', () => {
    const args = codexArgs('/tmp/out.txt');
    expect(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2)).toEqual(['-s', 'read-only']);
    expect(args.at(-1)).toBe('-');
    expect(args).toContain('/tmp/out.txt');
  });

  test('passes a model only when one is configured', () => {
    expect(codexArgs('/tmp/out.txt')).not.toContain('-m');
    expect(codexArgs('/tmp/out.txt', 'gpt-5.6-sol')).toContain('gpt-5.6-sol');
  });

  test('flattens system blocks and messages into one prompt', () => {
    const prompt = flattenPrompt({
      system: [{ type: 'text', text: 'SYSTEM' }],
      messages: [{ role: 'user', content: 'TRACE' }],
    });
    expect(prompt).toBe('SYSTEM\n\nTRACE');
  });

  test('strips the json fence a chat-tuned model adds', () => {
    expect(unfence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(unfence('  {"a":1}  ')).toBe('{"a":1}');
  });

  test('feeds the consolidation path like any other LLMClient', async () => {
    const client = createCodexClient({ runner: async () => '```json\n' + VALID_RESPONSE + '\n```' });
    const result = await generateMemoryLevels('Consolidation through a local CLI agent.', 'semantic', client);

    expect(result.level2Essential).toBe('Consolidation works without an API key.');
    expect(result.level3Keywords).toContain('codex');
  });

  test('a missing binary degrades to the deterministic extractor', async () => {
    const client = createCodexClient({ runner: async () => { throw new Error('ENOENT: codex'); } });
    const result = await generateMemoryLevels('The queue must survive an absent CLI.', 'semantic', client);

    expect(result.level3Keywords).toContain('queue');
  });
});
