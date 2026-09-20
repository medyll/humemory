import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createKimiClient, type KimiClientOptions } from '../src/core/kimi-llm-client.js';
import { resolveMaintenanceClient } from '../src/agent/maintenance-runner.js';

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'humemory-kimi-test-')); dirs.push(dir);
  let runs = 0; let checks = 0; let percent = 5; let date = new Date('2026-09-11T22:01:00Z');
  const options: KimiClientOptions = { statePath: join(dir, 'budget.json'), queueDir: join(dir, 'queue'), now: () => date,
    quota: async () => { checks++; return { usedPercent: percent, data: { measured: percent } }; },
    run: async (_prompt, model) => { runs++; return { text: '{"ok":true}', model, activeTools: [], usage: { input_tokens: 100, output_tokens: 20 } }; },
  };
  return { dir, options, runs: () => runs, checks: () => checks, percent: (p: number) => { percent = p; }, date: (d: string) => { date = new Date(d); } };
}
const request = { messages: [{ role: 'user', content: 'A fixture, never a real transcript.' }] };

describe('guarded Kimi subscription client — no network', () => {
  test('daily budget survives client recreation and follows the Paris calendar', async () => {
    const f = await fixture();
    await createKimiClient(f.options).messages.create(request);
    await createKimiClient(f.options).messages.create(request);
    await expect(createKimiClient(f.options).messages.create(request)).rejects.toThrow('daily');
    expect(f.runs()).toBe(2); expect(f.checks()).toBe(4);
    const state = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    expect(state.days['2026-09-12'].calls).toHaveLength(2);
    f.date('2026-09-12T22:01:00Z');
    await createKimiClient(f.options).messages.create(request);
    expect(f.runs()).toBe(3);
  });
  test('concurrent clients share the same two-call limit', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => createKimiClient(f.options).messages.create(request)));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
    expect(f.runs()).toBe(2);
  });
  test('24% quota and unavailable quota both refuse transmission', async () => {
    const f = await fixture(); f.percent(24);
    await expect(createKimiClient(f.options).messages.create(request)).rejects.toThrow('quota');
    f.options.quota = async () => { throw new Error('offline quota'); };
    await expect(createKimiClient(f.options).messages.create(request)).rejects.toThrow('offline');
    expect(f.runs()).toBe(0);
  });
  test('failed output consumes its reservation and cannot create a retry storm', async () => {
    const f = await fixture(); f.options.run = async () => { throw new Error('bad turn'); };
    const client = createKimiClient(f.options);
    await expect(client.messages.create(request)).rejects.toThrow('bad turn');
    await expect(client.messages.create(request)).rejects.toThrow('bad turn');
    await expect(client.messages.create(request)).rejects.toThrow('daily');
    const state = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    expect(state.days['2026-09-12'].calls.map((c: any) => c.status)).toEqual(['failed', 'failed']);
  });
  test('large prompts and corrupt ledgers fail before any model call', async () => {
    const f = await fixture(); const client = createKimiClient(f.options);
    await expect(client.messages.create({ messages: [{ content: 'x'.repeat(7001) }] })).rejects.toThrow('7000');
    await writeFile(f.options.statePath, 'not json');
    await expect(client.messages.create(request)).rejects.toThrow();
    expect(f.runs()).toBe(0); expect(f.checks()).toBe(0);
  });
  test('an unexpected model or active tools rejects the response and spends the attempt', async () => {
    const f = await fixture();
    f.options.run = async () => ({ text: '{"ok":true}', model: 'wrong-model', activeTools: ['Bash'], usage: { input_tokens: 100, output_tokens: 20 } });
    await expect(createKimiClient(f.options).messages.create(request)).rejects.toThrow('verification');
    const state = JSON.parse(await readFile(f.options.statePath, 'utf8'));
    expect(state.days['2026-09-12'].calls[0].status).toBe('failed');
    expect(state.days['2026-09-12'].calls[0].usage.output_tokens).toBe(20);
  });
  test('a disabled project configuration resolves to the free local path', async () => {
    const f = await fixture();
    await writeFile(join(f.dir, 'maintenance-llm.json'), JSON.stringify({ enabled: false, provider: 'kimi' }));
    const prior = process.env.HUMEMORY_MAINTENANCE_LLM;
    delete process.env.HUMEMORY_MAINTENANCE_LLM;
    try { expect(await resolveMaintenanceClient(60000, join(f.dir, 'memory.db'), join(f.dir, 'queue'))).toBeUndefined(); }
    finally { if (prior !== undefined) process.env.HUMEMORY_MAINTENANCE_LLM = prior; }
  });
});
