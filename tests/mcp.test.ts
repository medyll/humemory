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
// A second agent: a *different process* with a different HUMEMORY_AGENT, on
// the same DB. That is what cross-agent means once identity comes from the
// environment — you cannot fake another agent by passing its name.
let kimiClient: Client;
let kimiTransport: StdioClientTransport;

/** Spawns one MCP server process with the given agent identity. */
async function connectAs(agent: string, dbPath: string) {
  const c = new Client({ name: `test-client-${agent}`, version: '0.0.1' });
  const t = new StdioClientTransport({
    command: process.execPath, // bun
    args: ['run', 'src/mcp/server.ts'],
    env: { ...process.env, HUMEMORY_DB: dbPath, HUMEMORY_AGENT: agent, NODE_ENV: 'test' },
    stderr: 'pipe',
  });
  await c.connect(t);
  return { client: c, transport: t };
}

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'humemory-mcp-'));
  const db = join(tmp, 'test.db');
  ({ client, transport } = await connectAs('claude', db));
  ({ client: kimiClient, transport: kimiTransport } = await connectAs('kimi', db));
}, 30_000);

afterAll(async () => {
  await transport.close();
  await kimiTransport.close();
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
      // No `agent` argument exists: identity is $HUMEMORY_AGENT of the server
      // process. Passing one must not change the attribution.
      arguments: { content: 'MCP smoke: unified memory across agents', keywords: ['mcp', 'smoke'], agent: 'kimi' },
    });
    const text = (added.content as any[])[0].text;
    expect(text).toContain('encoded:');
    expect(text).toContain('(claude)');
    expect(text).not.toContain('(kimi)');

    const found = await client.callTool({ name: 'humemory_search', arguments: { query: 'unified memory' } });
    expect((found.content as any[])[0].text).toContain('unified memory across agents');
  });

  test('intent_add arms a loop, intent_close closes it', async () => {
    const armed = await client.callTool({
      name: 'humemory_intent_add',
      arguments: { content: 'loop from MCP' },
    });
    const idLine = (armed.content as any[])[0].text.split('\n')[0];
    const id = idLine.replace('loop armed: ', '');
    const closed = await client.callTool({ name: 'humemory_intent_close', arguments: { id } });
    expect((closed.content as any[])[0].text).toContain('closed:');
  });

  test('cross-agent recall earns the reused verification', async () => {
    const added = await client.callTool({
      name: 'humemory_add',
      arguments: { content: 'reusable lesson', keywords: ['reuse'] },
    });
    const id = (added.content as any[])[0].text.match(/id: (.+)/)![1].trim();
    // Recalled by the *kimi process* — a different identity, established by
    // the environment rather than declared in the call.
    const recalled = await kimiClient.callTool({ name: 'humemory_recall', arguments: { id } });
    expect((recalled.content as any[])[0].text).toContain('verified:reused');
  });

  test('an agent cannot earn `reused` by naming itself someone else', async () => {
    const added = await client.callTool({
      name: 'humemory_add',
      arguments: { content: 'self-service verification attempt', keywords: ['selfserve'] },
    });
    const id = (added.content as any[])[0].text.match(/id: (.+)/)![1].trim();
    // Same process (claude) recalling its own trace while claiming to be kimi.
    const recalled = await client.callTool({
      name: 'humemory_recall',
      arguments: { id, agent: 'kimi' },
    });
    expect((recalled.content as any[])[0].text).not.toContain('verified:');
  });
});
