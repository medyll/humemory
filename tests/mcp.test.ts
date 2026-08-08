/**
 * Phase 6.2 — MCP server smoke test: a real client connects over stdio,
 * lists tools, encodes and searches against a hermetic temp DB.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let tmp: string;
let client: Client;
let transport: StdioClientTransport;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'humemory-mcp-'));
  client = new Client({ name: 'test-client', version: '0.0.1' });
  transport = new StdioClientTransport({
    command: process.execPath, // bun
    args: ['run', 'src/mcp/server.ts'],
    env: { ...process.env, HUMEMORY_DB: join(tmp, 'test.db'), NODE_ENV: 'test' },
    stderr: 'pipe',
  });
  await client.connect(transport);
}, 30_000);

afterAll(async () => {
  await transport.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('MCP server (stdio, hermetic DB)', () => {
  test('lists the humemory tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const expected of ['humemory_add', 'humemory_search', 'humemory_recall', 'humemory_intent_add', 'humemory_intent_close', 'humemory_dreams']) {
      expect(names).toContain(expected);
    }
  });

  test('add then search round-trips a trace with attribution', async () => {
    const added = await client.callTool({
      name: 'humemory_add',
      arguments: { content: 'MCP smoke: unified memory across agents', keywords: ['mcp', 'smoke'], agent: 'kimi' },
    });
    const text = (added.content as any[])[0].text;
    expect(text).toContain('encoded:');
    expect(text).toContain('(kimi)');

    const found = await client.callTool({ name: 'humemory_search', arguments: { query: 'unified memory' } });
    expect((found.content as any[])[0].text).toContain('unified memory across agents');
  });

  test('intent_add arms a loop, intent_close closes it', async () => {
    const armed = await client.callTool({
      name: 'humemory_intent_add',
      arguments: { content: 'loop from MCP', agent: 'codex' },
    });
    const idLine = (armed.content as any[])[0].text.split('\n')[0];
    const id = idLine.replace('loop armed: ', '');
    const closed = await client.callTool({ name: 'humemory_intent_close', arguments: { id } });
    expect((closed.content as any[])[0].text).toContain('closed:');
  });

  test('cross-agent recall earns the reused verification', async () => {
    const added = await client.callTool({
      name: 'humemory_add',
      arguments: { content: 'reusable lesson', keywords: ['reuse'], agent: 'claude' },
    });
    const id = (added.content as any[])[0].text.match(/id: (.+)/)![1].trim();
    const recalled = await client.callTool({ name: 'humemory_recall', arguments: { id, agent: 'kimi' } });
    expect((recalled.content as any[])[0].text).toContain('verified:reused');
  });
});
