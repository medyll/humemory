import { describe, test, expect, beforeEach } from 'bun:test';
import { generateMemoryLevels, type LLMClient } from '../src/core/llm-generator.js';

function makeMockClient(responseText: string): LLMClient {
  return {
    messages: {
      create: async (params: any) => ({
        content: [{ type: 'text', text: responseText }],
      }),
    },
  };
}

const VALID_RESPONSE = JSON.stringify({
  level1Summary: 'OAuth2 auth system with JWT tokens and refresh rotation.',
  level2Essential: 'Auth uses OAuth2 with JWT.',
  level3Keywords: 'oauth2 jwt auth tokens refresh security login session',
});

describe('generateMemoryLevels', () => {
  test('génère 3 niveaux depuis le contenu', async () => {
    const client = makeMockClient(VALID_RESPONSE);
    const result = await generateMemoryLevels(
      'I implemented an authentication system using OAuth2 with JWT tokens and refresh rotation.',
      'semantic',
      client
    );

    expect(result.level1Summary).toContain('OAuth2');
    expect(result.level2Essential).toContain('JWT');
    expect(result.level3Keywords).toContain('oauth2');
  });

  test('fallback si JSON invalide', async () => {
    const client = makeMockClient('not valid json at all');
    const content = 'Some memory content about CSS grid layouts and flexbox';
    const result = await generateMemoryLevels(content, 'procedural', client);

    expect(result.level1Summary).toBeTruthy();
    expect(result.level2Essential).toBeTruthy();
    expect(result.level3Keywords).toBeTruthy();
    // fallback uses beginning of content
    expect(result.level1Summary.length).toBeGreaterThan(0);
  });

  test('passe le type episodic dans le prompt', async () => {
    let capturedParams: any;
    const client: LLMClient = {
      messages: {
        create: async (params: any) => {
          capturedParams = params;
          return { content: [{ type: 'text', text: VALID_RESPONSE }] };
        },
      },
    };

    await generateMemoryLevels('test content', 'episodic', client);
    expect(capturedParams.messages[0].content).toContain('événement vécu');
  });

  test('passe le type procedural dans le prompt', async () => {
    let capturedParams: any;
    const client: LLMClient = {
      messages: {
        create: async (params: any) => {
          capturedParams = params;
          return { content: [{ type: 'text', text: VALID_RESPONSE }] };
        },
      },
    };

    await generateMemoryLevels('test content', 'procedural', client);
    expect(capturedParams.messages[0].content).toContain('savoir-faire');
  });
});

describe('SQLiteStore + autoGenerate', () => {
  test('auto-génère les niveaux si option activée', async () => {
    const { setLLMClient } = await import('../src/core/llm-generator.js');
    setLLMClient(makeMockClient(VALID_RESPONSE));

    const { SQLiteStore } = await import('../src/store/sqlite.js');
    const { rmSync } = await import('fs');
    const db = 'tests/test-autogen.db';
    try { rmSync(db); } catch {}

    const store = new SQLiteStore(db);
    const memory = await store.add(
      {
        content: 'Implemented OAuth2 auth with JWT tokens',
        directory: '/test',
        day: '2026-05-03',
        keywords: ['auth', 'oauth'],
        sessionId: 'test',
        memoryType: 'semantic',
      },
      { autoGenerate: true }
    );

    expect(memory.level1Summary).toBeTruthy();
    expect(memory.level2Essential).toBeTruthy();
    expect(memory.level3Keywords).toBeTruthy();

    store.close();
    try { rmSync(db); } catch {}
  });

  test('ne génère pas si level1Summary déjà fourni', async () => {
    const { setLLMClient } = await import('../src/core/llm-generator.js');
    let called = false;
    setLLMClient({
      messages: {
        create: async () => {
          called = true;
          return { content: [{ type: 'text', text: VALID_RESPONSE }] };
        },
      },
    });

    const { SQLiteStore } = await import('../src/store/sqlite.js');
    const { rmSync } = await import('fs');
    const db = 'tests/test-autogen2.db';
    try { rmSync(db); } catch {}

    const store = new SQLiteStore(db);
    await store.add(
      {
        content: 'Some content',
        directory: '/test',
        day: '2026-05-03',
        keywords: [],
        sessionId: 'test',
        memoryType: 'semantic',
        level1Summary: 'Already set summary',
      },
      { autoGenerate: true }
    );

    expect(called).toBe(false);
    store.close();
    try { rmSync(db); } catch {}
  });
});
