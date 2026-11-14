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
  test('merges Claude user config without losing project state; supports preview, backup and repeated setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-claude-mcp-'));
    roots.push(root);
    const claudeConfig = join(root, '.claude.json');
    const original = JSON.stringify({
      theme: 'dark', projects: { '/work': { hasTrustDialogAccepted: true, mcpServers: { local: { command: 'local' } } } },
      mcpServers: { existing: { command: 'safe' } },
    });
    await writeFile(claudeConfig, original);
    const options = { clients: ['claude'] as ('claude')[], projectRoot: join(root, 'humemory'),
      claudeConfig, dbPath: join(root, 'memory.db'), bunPath: join(root, 'bun.exe') };
    expect((await setupHumemoryMcpClients({ ...options, dryRun: true }))[0]).toEqual({ client: 'claude', path: claudeConfig, changed: true });
    expect(await readFile(claudeConfig, 'utf8')).toBe(original);
    expect(await readdir(root)).toEqual(['.claude.json']);
    expect((await setupHumemoryMcpClients(options))[0].changed).toBe(true);
    const parsed = JSON.parse(await readFile(claudeConfig, 'utf8'));
    expect(parsed.theme).toBe('dark');
    expect(parsed.projects).toEqual(JSON.parse(original).projects);
    expect(parsed.mcpServers.existing.command).toBe('safe');
    expect(parsed.mcpServers.humemory).toEqual({ type: 'stdio', command: options.bunPath,
      args: ['run', join(options.projectRoot, 'src', 'mcp', 'server.ts')],
      env: { HUMEMORY_AGENT: 'claude', HUMEMORY_DB: options.dbPath } });
    const backup = (await readdir(root)).find(f => f.endsWith('.bak'))!;
    expect(await readFile(join(root, backup), 'utf8')).toBe(original);
    expect((await setupHumemoryMcpClients(options))[0].changed).toBe(false);
  });

  test('creates Claude config when missing and refuses malformed config without overwriting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-claude-new-'));
    roots.push(root);
    const claudeConfig = join(root, 'profile', '.claude.json');
    const options = { clients: ['claude'] as ('claude')[], projectRoot: root, claudeConfig, dbPath: ':memory:' };
    await setupHumemoryMcpClients(options);
    expect(JSON.parse(await readFile(claudeConfig, 'utf8')).mcpServers.humemory.env.HUMEMORY_AGENT).toBe('claude');
    for (const raw of ['{broken', '[]', '{"mcpServers":null}']) {
      await writeFile(claudeConfig, raw);
      await expect(setupHumemoryMcpClients(options)).rejects.toThrow('Refusing');
      expect(await readFile(claudeConfig, 'utf8')).toBe(raw);
    }
  });
  test('merges Codex TOML, preserves settings and comments, backs up and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-codex-mcp-'));
    roots.push(root);
    const path = join(root, 'config.toml');
    const original = '# keep this comment\r\nmodel = "local-test"\r\n[mcp_servers.existing]\r\ncommand = "safe"\r\n';
    await writeFile(path, original);
    const options = {
      clients: ['codex'] as const, projectRoot: join(root, 'project with spaces'),
      dbPath: join(root, 'memory.db'), bunPath: join(root, 'bun.exe'), codexHome: root,
    };
    const run = (dryRun = false) => setupHumemoryMcpClients({ ...options, clients: [...options.clients], dryRun });
    expect((await run(true))[0]).toEqual({ client: 'codex', path, changed: true });
    expect(await readFile(path, 'utf8')).toBe(original);
    expect(await readdir(root)).toEqual(['config.toml']);
    expect((await run())[0].changed).toBe(true);
    const updated = await readFile(path, 'utf8');
    expect(updated.startsWith(original)).toBe(true);
    const parsed = Bun.TOML.parse(updated) as any;
    expect(parsed.model).toBe('local-test');
    expect(parsed.mcp_servers.existing.command).toBe('safe');
    expect(parsed.mcp_servers.humemory).toEqual({
      command: options.bunPath, args: ['run', join(options.projectRoot, 'src', 'mcp', 'server.ts')],
      env: { HUMEMORY_AGENT: 'codex', HUMEMORY_DB: options.dbPath },
    });
    const backup = (await readdir(root)).find(f => f.endsWith('.bak'))!;
    expect(await readFile(join(root, backup), 'utf8')).toBe(original);
    expect((await run())[0].changed).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(updated);

    // A later installation path update preserves per-server policy and env.
    await writeFile(path, updated.replace('[mcp_servers.humemory]', '[mcp_servers.humemory]\nstartup_timeout_sec = 30\n')
      .replace('"HUMEMORY_AGENT" = "codex"', '"EXTRA" = "keep", "HUMEMORY_AGENT" = "codex"'));
    await setupHumemoryMcpClients({ ...options, clients: ['codex'], dbPath: join(root, 'new.db') });
    const changed = Bun.TOML.parse(await readFile(path, 'utf8')) as any;
    expect(changed.mcp_servers.humemory.startup_timeout_sec).toBe(30);
    expect(changed.mcp_servers.humemory.env.EXTRA).toBe('keep');
    expect(changed.mcp_servers.humemory.env.HUMEMORY_DB).toBe(join(root, 'new.db'));
  });

  test('creates a missing Codex config only when applying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-codex-new-'));
    roots.push(root);
    const codexHome = join(root, 'codex');
    const options = { clients: ['codex'] as ('codex')[], projectRoot: root, codexHome, dbPath: ':memory:' };
    expect((await setupHumemoryMcpClients({ ...options, dryRun: true }))[0].changed).toBe(true);
    expect(await readdir(root)).toEqual([]);
    await setupHumemoryMcpClients(options);
    const parsed = Bun.TOML.parse(await readFile(join(codexHome, 'config.toml'), 'utf8')) as any;
    expect(parsed.mcp_servers.humemory.env.HUMEMORY_DB).toBe(':memory:');
  });

  test('refuses invalid, remote and unsupported Codex layouts without rewriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'humemory-codex-invalid-'));
    roots.push(root);
    const path = join(root, 'config.toml');
    for (const original of ['invalid = [', '[mcp_servers.humemory]\nurl = "https://example.test"\n',
      'mcp_servers = { humemory = { command = "old" } }\n',
      'note = """\n[mcp_servers.humemory]\nkeep me\n"""\n']) {
      await writeFile(path, original);
      await expect(setupHumemoryMcpClients({ clients: ['codex'], projectRoot: root, codexHome: root, dbPath: ':memory:' })).rejects.toThrow('Refusing');
      expect(await readFile(path, 'utf8')).toBe(original);
    }
    expect((await readdir(root)).filter(f => f.endsWith('.bak'))).toEqual([]);
  });
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
