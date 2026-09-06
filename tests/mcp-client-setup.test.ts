import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { setupHumemoryMcpClients } from '../src/agent/mcp-client-setup.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('MCP client setup', () => {
  test('rejects invalid object shapes without rewriting and backs up valid originals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-mcp-shape-'));
    roots.push(root);
    const path = join(root, 'mcp.json');
    for (const invalid of ['[]', 'null', '{"mcpServers": []}', '{"mcpServers": null}']) {
      await writeFile(path, invalid);
      await expect(setupHumemoryMcpClients({ clients: ['kimi'], projectRoot: root, kimiHome: root })).rejects.toThrow('Refusing');
      expect(await readFile(path, 'utf8')).toBe(invalid);
    }
    const original = '{"mcpServers":{"third-party":{"command":"safe"}}}';
    await writeFile(path, original);
    await setupHumemoryMcpClients({ clients: ['kimi'], projectRoot: root, kimiHome: root });
    const backup = (await readdir(root)).find(f => f.endsWith('.bak'))!;
    expect(await readFile(join(root, backup), 'utf8')).toBe(original);
  });
  test('merges humemory into Kimi and OpenCode without removing existing servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-mcp-'));
    roots.push(root);
    const kimiHome = join(root, 'kimi');
    const openCodeConfig = join(root, 'opencode', 'opencode.json');
    await mkdir(kimiHome, { recursive: true });
    await mkdir(join(root, 'opencode'), { recursive: true });
    await writeFile(join(kimiHome, 'mcp.json'), JSON.stringify({ mcpServers: { existing: { command: 'old' } } }));
    await writeFile(openCodeConfig, JSON.stringify({ mcp: { existing: { type: 'remote', url: 'https://example.test' } } }));

    const result = await setupHumemoryMcpClients({
      clients: ['kimi', 'opencode'],
      projectRoot: join(root, 'humemory'),
      dbPath: join(root, 'memory.db'),
      bunPath: join(root, 'bun.exe'),
      kimiHome,
      openCodeConfig,
    });
    expect(result.every((entry) => entry.changed)).toBe(true);

    const kimi = JSON.parse(await readFile(join(kimiHome, 'mcp.json'), 'utf8'));
    expect(kimi.mcpServers.existing.command).toBe('old');
    expect(kimi.mcpServers.humemory.env.HUMEMORY_AGENT).toBe('kimi');

    const opencode = JSON.parse(await readFile(openCodeConfig, 'utf8'));
    expect(opencode.mcp.existing.url).toBe('https://example.test');
    expect(opencode.mcp.humemory.environment.HUMEMORY_AGENT).toBe('opencode');

    const unchanged = await setupHumemoryMcpClients({
      clients: ['kimi', 'opencode'], projectRoot: join(root, 'humemory'),
      dbPath: join(root, 'memory.db'), bunPath: join(root, 'bun.exe'), kimiHome, openCodeConfig,
    });
    expect(unchanged.every((entry) => !entry.changed)).toBe(true);
  });
});
