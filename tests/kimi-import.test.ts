import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { importKimiSessions, KIMI_SOURCE } from '../src/agent/kimi-import.js';
import { parseKimiSession } from '../src/agent/kimi-session-parser.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function wire(): string {
  return [
    { type: 'metadata', protocol_version: '1', created_at: 1_700_000_000_000 },
    { type: 'turn.prompt', time: 1_700_000_001_000, origin: { kind: 'user' }, input: [{ type: 'text', text: 'Repair the parser' }] },
    { type: 'context.append_message', time: 1_700_000_001_000, message: { role: 'user', origin: { kind: 'user' }, content: [{ type: 'text', text: 'Repair the parser' }] } },
    { type: 'context.append_message', time: 1_700_000_001_100, message: { role: 'user', origin: { kind: 'injection' }, content: [{ type: 'text', text: 'secret injected context' }] } },
    { type: 'context.append_loop_event', time: 1_700_000_002_000, event: { type: 'content.part', turnId: 'turn-1', part: { type: 'think', think: 'private reasoning' } } },
    { type: 'context.append_loop_event', time: 1_700_000_003_000, event: { type: 'content.part', turnId: 'turn-1', part: { type: 'text', text: 'Fixed ' } } },
    { type: 'context.append_loop_event', time: 1_700_000_003_100, event: { type: 'content.part', turnId: 'turn-1', part: { type: 'text', text: 'the parser.' } } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
}

describe('Kimi session import', () => {
  test('normalizes user and answer text without injections or reasoning', () => {
    const parsed = parseKimiSession(wire(), JSON.stringify({ id: 'kimi-1', cwd: '/work/project' }), '/fallback');
    expect(parsed.sessionId).toBe('kimi-1');
    expect(parsed.directory).toBe('/work/project');
    expect(parsed.messages).toEqual([
      { role: 'user', content: 'Repair the parser', timestamp: '2023-11-14T22:13:21.000Z' },
      { role: 'assistant', content: 'Fixed the parser.', timestamp: '2023-11-14T22:13:23.000Z' },
    ]);
    expect(parsed.rawText).not.toContain('private reasoning');
    expect(parsed.rawText).not.toContain('secret injected context');
  });

  test('discovers, queues, and re-imports one growing session idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-kimi-'));
    roots.push(root);
    const kimiHome = join(root, 'kimi');
    const queueDir = join(root, 'queue');
    const sessionDir = join(kimiHome, 'sessions', 'wd_test', 'session_kimi-1');
    await mkdir(join(sessionDir, 'agents', 'main'), { recursive: true });
    await writeFile(join(kimiHome, 'session_index.jsonl'), JSON.stringify({ sessionDir: join('sessions', 'wd_test', 'session_kimi-1'), sessionId: 'kimi-1', workDir: '/work/project' }));
    await writeFile(join(sessionDir, 'state.json'), JSON.stringify({ id: 'kimi-1', cwd: '/work/project' }));
    await writeFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), wire());

    const first = await importKimiSessions({ queueDir, kimiHome });
    expect(first).toMatchObject({ scanned: 1, queued: 1, created: 1, skippedEmpty: 0, unreadable: 0 });
    const jobs = (await readdir(queueDir)).filter((name) => name.endsWith('.json'));
    expect(jobs).toHaveLength(1);
    const job = JSON.parse(await readFile(join(queueDir, jobs[0]!), 'utf8'));
    expect(job.source).toBe(KIMI_SOURCE);
    expect(job.agent).toBe('kimi');
    expect(job.sessionId).toBe('kimi-1');

    const second = await importKimiSessions({ queueDir, kimiHome });
    expect(second).toMatchObject({ queued: 1, created: 0 });
  });
});
