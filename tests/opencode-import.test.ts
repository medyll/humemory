import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { importOpenCodeSessions, OPENCODE_SOURCE, type OpenCodeCommandRunner } from '../src/agent/opencode-import.js';
import { parseOpenCodeExport } from '../src/agent/opencode-session-parser.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const exported = JSON.stringify({
  info: { id: 'ses_open-1', directory: '/work/open' },
  messages: [
    { info: { role: 'user', time: { created: 1_700_000_001_000 } }, parts: [{ type: 'text', text: 'Repair OpenCode import' }] },
    { info: { role: 'assistant', time: { created: 1_700_000_002_000 } }, parts: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'tool', state: { output: 'private tool output' } },
      { type: 'text', text: 'Importer repaired.' },
    ] },
  ],
});

describe('OpenCode session import', () => {
  test('parses only public user and assistant text parts', () => {
    const parsed = parseOpenCodeExport(exported, '/fallback');
    expect(parsed.sessionId).toBe('ses_open-1');
    expect(parsed.messages.map((message) => [message.role, message.content])).toEqual([
      ['user', 'Repair OpenCode import'],
      ['assistant', 'Importer repaired.'],
    ]);
    expect(parsed.rawText).not.toContain('private reasoning');
    expect(parsed.rawText).not.toContain('private tool output');
  });

  test('enumerates through the CLI, queues once, and preserves attribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-opencode-'));
    roots.push(root);
    const queueDir = join(root, 'queue');
    const calls: string[][] = [];
    const run: OpenCodeCommandRunner = async (args) => {
      calls.push(args);
      if (args[0] === 'db') return JSON.stringify([{ id: 'ses_open-1', directory: '/work/open' }]);
      if (args[0] === 'export' && args[1] === 'ses_open-1') return exported;
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    };

    const first = await importOpenCodeSessions({
      queueDir,
      since: new Date(1_700_000_000_000),
      run,
    });
    expect(first).toMatchObject({ scanned: 1, queued: 1, created: 1, skippedEmpty: 0, unreadable: 0 });
    expect(calls[0]![1]).toContain('time_updated >= 1700000000000');
    expect(calls[0]![1]).toContain('parent_id IS NULL');

    const jobs = (await readdir(queueDir)).filter((name) => name.endsWith('.json'));
    expect(jobs).toHaveLength(1);
    const job = JSON.parse(await readFile(join(queueDir, jobs[0]!), 'utf8'));
    expect(job.source).toBe(OPENCODE_SOURCE);
    expect(job.agent).toBe('opencode');
    expect(job.sessionId).toBe('ses_open-1');

    const second = await importOpenCodeSessions({ queueDir, run });
    expect(second).toMatchObject({ queued: 1, created: 0 });
  });
});
