import { describe, expect, test } from 'bun:test';
import { readFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { processSession } from '../src/agent/claude-hook.js';
import { JevMemoryAdvisor, resolveConfiguredJevAdvisor } from '../src/agent/jev-advisor.js';
import {
  adviseInShadow,
  salienceForBand,
  sanitizeMemoryCandidate,
  type MemoryAdvisor,
  type ShadowDecisionRecord,
} from '../src/agent/memory-advisor.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jev-candidates.json');

const successfulResponse = {
  model: 'jev-1.13.0',
  answers: {
    should_store: { type: 'noul', noul: 0.91 },
    memory_type: {
      type: 'choice', choice: 'procedural', confidence: 0.82,
      probabilities: { episodic: 0.04, semantic: 0.14, procedural: 0.82 },
    },
    salience_band: {
      type: 'score', score: 3.2, confidence: 0.76,
      legend: { 0: 'discard', 1: 'low', 2: 'normal', 3: 'high', 4: 'exceptional' },
      probabilities: { 0: 0, 1: 0.02, 2: 0.08, 3: 0.62, 4: 0.28 },
    },
    contains_sensitive_material: { type: 'noul', noul: 0.03 },
  },
  usage: { input_tokens: 100, output_tokens: 40 },
};

describe('Jev local privacy envelope', () => {
  test('the labelled evaluation corpus has all four product decisions', async () => {
    const fixtures = JSON.parse(await readFile(fixturePath, 'utf8')) as Array<any>;
    expect(fixtures).toHaveLength(4);
    for (const fixture of fixtures) {
      expect(typeof fixture.expected.shouldStore).toBe('boolean');
      expect(['episodic', 'semantic', 'procedural']).toContain(fixture.expected.memoryType);
      expect(['discard', 'low', 'normal', 'high', 'exceptional']).toContain(fixture.expected.salienceBand);
    }
  });

  test('rejects credentials before transmission', () => {
    const result = sanitizeMemoryCandidate({
      content: 'Authorization: Bearer sk-proj-synthetic-abcdefghijklmnop',
      currentMemoryType: 'episodic',
      source: 'hook',
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe('sensitive_material');
  });

  test('redacts local paths and identities, trims command output, and caps length', () => {
    const result = sanitizeMemoryCandidate({
      content: `Fixed C:\\Users\\Mydde\\project\\src\\a.ts on username=Mydde host=workstation.\nstdout:\n${'x'.repeat(2_000)}\n\nKeep this rule.`,
      currentMemoryType: 'procedural',
      source: 'hook',
    }, { maxCharacters: 120 });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.candidate.content).not.toContain('Mydde');
    expect(result.candidate.content).not.toContain('workstation');
    expect(result.candidate.content).not.toContain('C:\\');
    expect(result.candidate.content.length).toBeLessThanOrEqual(120);
    expect(result.candidate.redactions).toContain('path');
    expect(result.candidate.redactions).toContain('identity');
    expect(result.candidate.redactions).toContain('command_output');
  });

  test('only explicitly approved automatic sources are eligible', () => {
    const result = sanitizeMemoryCandidate({
      content: 'A human explicitly asked to remember this.',
      currentMemoryType: 'semantic',
      source: 'human',
    });
    expect(result.accepted).toBe(false);
    if (!result.accepted) expect(result.reason).toBe('source_not_allowed');
  });
});

describe('Jev provider contract — network-free', () => {
  test('sends atomic typed questions and validates the response', async () => {
    let request: RequestInit | undefined;
    const advisor = new JevMemoryAdvisor({
      apiKey: 'test-key',
      fetch: async (_url, init) => {
        request = init;
        return new Response(JSON.stringify(successfulResponse), { status: 200 });
      },
    });
    const advice = await advisor.advise({
      content: 'Use a circuit breaker after three consecutive failures.',
      currentMemoryType: 'procedural', source: 'hook', truncated: false, redactions: [],
    });
    const body = JSON.parse(String(request?.body));
    expect(Object.keys(body.questions).sort()).toEqual([
      'contains_sensitive_material', 'memory_type', 'salience_band', 'should_store',
    ]);
    expect(advice).toEqual({
      shouldStore: 0.91,
      memoryType: 'procedural',
      memoryTypeConfidence: 0.82,
      salienceBand: 'high',
      provider: 'jev',
      containsSensitiveMaterial: 0.03,
    });
    expect(salienceForBand(advice.salienceBand)).toBe(75);
  });

  test('a malformed response becomes a contained shadow failure', async () => {
    const advisor = new JevMemoryAdvisor({
      apiKey: 'test-key',
      fetch: async () => new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    });
    const record = await adviseInShadow({
      content: 'A useful automatic learning long enough to evaluate safely.',
      currentMemoryType: 'semantic', source: 'hook',
    }, advisor);
    expect(record.outcome).toBe('failed');
    expect(record.errorKind).toBe('provider_failure');
  });

  test('timeouts are contained and expose no provider error text', async () => {
    const advisor = new JevMemoryAdvisor({
      apiKey: 'test-key', timeoutMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('secret provider detail')));
      }),
    });
    const record = await adviseInShadow({
      content: 'A useful automatic learning long enough to evaluate safely.',
      currentMemoryType: 'semantic', source: 'hook',
    }, advisor);
    expect(record.outcome).toBe('failed');
    expect(JSON.stringify(record)).not.toContain('secret provider detail');
  });

  test('an API key alone does not enable network and advisory is capped to shadow', () => {
    expect(resolveConfiguredJevAdvisor({ TYPESAFE_API_KEY: 'present' }).effectiveMode).toBe('off');
    const missing = resolveConfiguredJevAdvisor({ HUMEMORY_JEV_MODE: 'shadow' });
    expect(missing.advisor).toBeUndefined();
    expect(missing.unavailableReason).toBe('missing_api_key');
    const capped = resolveConfiguredJevAdvisor({ HUMEMORY_JEV_MODE: 'advisory', TYPESAFE_API_KEY: 'present' });
    expect(capped.requestedMode).toBe('advisory');
    expect(capped.effectiveMode).toBe('shadow');
    expect(capped.advisor).toBeDefined();
  });
});

describe('shadow-only acquisition wiring', () => {
  test('provider failure still stores the automatic candidate', async () => {
    const records: ShadowDecisionRecord[] = [];
    const failingAdvisor: MemoryAdvisor = { advise: async () => { throw new Error('offline'); } };
    const transcript = JSON.stringify({
      session_id: 'jev-shadow-session', cwd: '/test/project',
      transcript: [{
        role: 'assistant',
        content: 'Implemented a durable retry circuit breaker that stops maintenance after three consecutive infrastructure failures.',
      }],
    });
    const result = await processSession(transcript, {
      dbPath: ':memory:', directory: '/test/project', source: 'hook',
      memoryAdvisor: failingAdvisor,
      advisorReporter: (record) => records.push(record),
    });
    expect(result.memoriesStored).toBe(1);
    expect(result.advisorComparisons).toBe(1);
    expect(records).toHaveLength(1);
    expect(records[0].outcome).toBe('failed');
    expect(records[0].baseline.shouldStore).toBe(true);
    expect(records[0].candidateHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(records[0])).not.toContain('circuit breaker');
  });

  test('a local privacy rejection also leaves storage unchanged', async () => {
    let calls = 0;
    const advisor: MemoryAdvisor = {
      advise: async () => {
        calls += 1;
        return { shouldStore: 0, memoryType: 'episodic', memoryTypeConfidence: 1, salienceBand: 'discard', provider: 'jev' };
      },
    };
    const transcript = JSON.stringify({
      session_id: 'jev-private-session', cwd: '/test/project',
      transcript: [{
        role: 'assistant',
        content: 'The deployment used Authorization: Bearer sk-proj-synthetic-abcdefghijklmnop and should be documented later.',
      }],
    });
    const result = await processSession(transcript, {
      dbPath: ':memory:', directory: '/test/project', source: 'hook', memoryAdvisor: advisor,
    });
    expect(result.memoriesStored).toBe(1);
    expect(calls).toBe(0);
  });

  test('low-confidence advice is recorded but cannot change storage', async () => {
    const records: ShadowDecisionRecord[] = [];
    const advisor: MemoryAdvisor = {
      advise: async () => ({
        shouldStore: 0.49,
        memoryType: 'episodic',
        memoryTypeConfidence: 0.05,
        salienceBand: 'low',
        provider: 'jev',
      }),
    };
    const transcript = JSON.stringify({
      session_id: 'jev-uncertain-session', cwd: '/test/project',
      transcript: [{
        role: 'assistant',
        content: 'The project now uses an isolated temporary database for every maintenance test suite.',
      }],
    });
    const result = await processSession(transcript, {
      dbPath: ':memory:', directory: '/test/project', source: 'hook', memoryAdvisor: advisor,
      advisorReporter: (record) => records.push(record),
    });
    expect(result.memoriesStored).toBe(1);
    expect(records[0].advice?.memoryTypeConfidence).toBe(0.05);
    expect(records[0].baseline.shouldStore).toBe(true);
  });
});
