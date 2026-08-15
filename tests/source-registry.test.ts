import { describe, expect, test } from 'bun:test';
import { win32 } from 'path';
import { discoverLocalAgentSources, KNOWN_AGENT_SOURCES } from '../src/agent/source-registry.js';

describe('local agent source discovery', () => {
  test('the catalog is non-exhaustive but includes Mistral as a first-class source', () => {
    const mistral = KNOWN_AGENT_SOURCES.find((source) => source.id === 'mistral-vibe');
    expect(mistral).toEqual(expect.objectContaining({
      name: 'Mistral Vibe',
      vendor: 'Mistral AI',
      commands: ['vibe'],
    }));
    expect(KNOWN_AGENT_SOURCES.map((source) => source.id)).toContain('gemini-cli');
    expect(KNOWN_AGENT_SOURCES).toContainEqual(expect.objectContaining({
      id: 'qwen-code',
      name: 'Qwen Code',
      commands: ['qwen'],
    }));
  });

  test('discovers data roots without reading session contents', () => {
    const present = new Set([
      win32.join('C:\\Users\\Ada', '.codex'),
      win32.join('C:\\Users\\Ada', '.kimi-code'),
      win32.join('D:\\mistral', 'home'),
    ]);
    const result = discoverLocalAgentSources({
      platform: 'win32',
      homeDir: 'C:\\Users\\Ada',
      env: { VIBE_HOME: 'D:\\mistral\\home' },
      exists: (path) => present.has(path),
    });

    expect(result.find((source) => source.id === 'codex')?.installed).toBe(true);
    expect(result.find((source) => source.id === 'kimi-code')?.installed).toBe(true);
    expect(result.find((source) => source.id === 'mistral-vibe')?.evidence).toEqual(['D:\\mistral\\home']);
    expect(result.find((source) => source.id === 'claude-code')?.installed).toBe(false);
  });

  test('discovers a command on PATH even when no data root exists yet', () => {
    const executable = win32.join('C:\\Tools', 'vibe.exe');
    const result = discoverLocalAgentSources({
      platform: 'win32',
      homeDir: 'C:\\Users\\Ada',
      env: { PATH: 'C:\\Tools', PATHEXT: '.EXE;.CMD' },
      exists: (path) => path.toLowerCase() === executable.toLowerCase(),
    });

    expect(result.find((source) => source.id === 'mistral-vibe')).toEqual(expect.objectContaining({
      installed: true,
      evidence: [executable],
    }));
  });

  test('honors Qwen runtime and home overrides', () => {
    const present = new Set(['D:\\qwen-runtime', 'D:\\qwen-home']);
    const result = discoverLocalAgentSources({
      platform: 'win32',
      homeDir: 'C:\\Users\\Ada',
      env: { QWEN_RUNTIME_DIR: 'D:\\qwen-runtime', QWEN_HOME: 'D:\\qwen-home' },
      exists: (path) => present.has(path),
    });

    expect(result.find((source) => source.id === 'qwen-code')).toEqual(expect.objectContaining({
      installed: true,
      evidence: ['D:\\qwen-runtime', 'D:\\qwen-home'],
    }));
  });
});
