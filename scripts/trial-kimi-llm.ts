/** Bounded K3 CLI experiment using the exact excerpts from the Luna trial. */
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { createCodexClient, unfence } from '../src/core/llm-cli-client.js';
import { extractLearnings } from '../src/agent/learning-extractor.js';
import { generateMemoryLevels } from '../src/core/llm-generator.js';

const model = 'kimi-code/k3';
const kimi = join(homedir(), '.kimi-code/bin/kimi.exe');
const kimiHome = process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code');
const sourcePath = resolve('data/llm-trials/2026-09-12T17-31-39-326Z/report.json');
const source = JSON.parse(await readFile(sourcePath, 'utf8'));
const outputDir = resolve('data/llm-trials', new Date().toISOString().replace(/[:.]/g, '-') + '-kimi-k3');
const workspace = join(outputDir, 'workspace');
const profile = resolve('scripts/trial-kimi-profile.md');
await mkdir(join(workspace, '.kimi-code'), { recursive: true });
await mkdir(join(workspace, 'empty-skills'), { recursive: true });
await writeFile(join(workspace, '.kimi-code/local.toml'), '[thinking]\nenabled = true\neffort = "low"\n');
const report: any = { model, sourcePath, startedAt: new Date(), maxCalls: 3, tokenStop: 60_000,
  profile, status: 'prepared', calls: [], samples: [], writesToMemoryStore: false,
  sessionPersistence: 'Kimi creates normal local CLI sessions; the existing importer may discover them.' };

async function save() {
  report.finishedAt = new Date();
  report.usage = report.calls.reduce((sum: any, c: any) => {
    for (const [key, val] of Object.entries(c.usage ?? {})) if (typeof val === 'number') sum[key] = (sum[key] ?? 0) + val;
    return sum;
  }, {});
  report.usageComplete = report.calls.length > 0 && report.calls.every((c: any) => !!c.usage);
  await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outputDir, status: report.status, calls: report.calls.length,
    usage: report.usage, usageComplete: report.usageComplete, quotaBefore: report.quotaBefore,
    quotaAfter: report.quotaAfter, error: report.error }, null, 2));
}
if (!process.argv.includes('--run')) { await save(); process.exit(0); }

// Keep this owned loopback server's bearer token in memory, never in tool output.
const server = Bun.spawn([kimi, 'web', '--no-open', '--port', '58629'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
let banner = '';
async function drain(stream: ReadableStream) {
  const reader = stream.getReader(); const decoder = new TextDecoder();
  for (;;) { const x = await reader.read(); if (x.done) break; banner += decoder.decode(x.value, { stream: true }); }
}
const drains = [drain(server.stdout), drain(server.stderr)];
let bearer: string | undefined;
for (let i = 0; i < 40; i++) {
  bearer = banner.match(/(?:bearer\s+token|token)\s*[:=]\s*([\w.-]+)/i)?.[1]
    ?? banner.match(/[?&#]token=([\w.-]+)/)?.[1];
  if (bearer) break;
  await Bun.sleep(250);
}
async function quota() {
  if (!bearer) return { kind: 'unavailable', message: 'Could not obtain the local server bearer token.' };
  try {
    const response = await fetch('http://127.0.0.1:58629/api/v1/oauth/usage', {
      headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(10_000) });
    const body: any = await response.json();
    return body.data ?? { kind: 'error', message: 'Usage endpoint did not return account data.' };
  } catch { return { kind: 'unavailable', message: 'Usage endpoint failed.' }; }
}

let kind = 'extraction';
const client = createCodexClient({ timeoutMs: 120_000, runner: async (prompt, { timeoutMs }) => {
  if (report.calls.length >= 3) throw new Error('Three-call limit reached');
  if (report.calls.reduce((n: number, c: any) => n + (c.usage?.input_tokens ?? 0) + (c.usage?.output_tokens ?? 0), 0) >= 60_000)
    throw new Error('Observed 60,000-token stop reached');
  const call: any = { kind, requestedModel: model, promptCharacters: prompt.length, startedAt: new Date() };
  report.calls.push(call);
  try {
    const proc = Bun.spawn([kimi, '-m', model, '--agent-file', profile, '--skills-dir', join(workspace, 'empty-skills'),
      '-p', prompt, '--output-format', 'stream-json'], { cwd: workspace, stdout: 'pipe', stderr: 'pipe' });
    const stdoutPromise = new Response(proc.stdout).text();
    const stderrPromise = new Response(proc.stderr).text();
    const timer = setTimeout(() => { call.timedOut = true; proc.kill(); }, timeoutMs);
    call.exitCode = await proc.exited; clearTimeout(timer);
    const stdout = await stdoutPromise; const stderr = await stderrPromise;
    call.durationMs = Date.now() - new Date(call.startedAt).getTime();
    const events = stdout.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    await writeFile(join(outputDir, `call-${report.calls.length}.jsonl`), stdout);
    const index = (await readFile(join(kimiHome, 'session_index.jsonl'), 'utf8')).split('\n')
      .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const own = index.filter(e => resolve(e.workDir ?? '') === resolve(workspace)).at(-1);
    if (own?.sessionDir) {
      call.sessionDir = own.sessionDir;
      const wire = (await readFile(join(own.sessionDir, 'agents/main/wire.jsonl'), 'utf8')).split('\n')
        .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const binding = wire.find(e => e.type === 'profile.bind');
      call.actualModel = binding?.modelAlias; call.thinkingEffort = binding?.thinkingEffort;
      call.activeTools = binding?.activeToolNames;
      const usageRows = wire.filter(e => e.type === 'usage.record' && e.usage);
      call.rawUsage = usageRows.map(e => ({ model: e.model, usage: e.usage, scope: e.usageScope }));
      if (usageRows.length) call.usage = usageRows.reduce((s: any, e: any) => ({
        input_tokens: s.input_tokens + (e.usage.inputOther ?? 0) + (e.usage.inputCacheRead ?? 0) + (e.usage.inputCacheCreation ?? 0),
        cached_input_tokens: s.cached_input_tokens + (e.usage.inputCacheRead ?? 0),
        cache_write_input_tokens: s.cache_write_input_tokens + (e.usage.inputCacheCreation ?? 0),
        output_tokens: s.output_tokens + (e.usage.output ?? 0),
      }), { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 });
      call.text = wire.filter(e => e.type === 'context.append_loop_event' && e.event?.type === 'content.part' && e.event.part?.type === 'text')
        .map(e => e.event.part.text ?? '').join('');
    }
    if (call.exitCode !== 0) throw new Error(`Kimi CLI failed (${call.exitCode}): ${stderr.slice(-500)}`);
    if (call.actualModel !== model) throw new Error('Could not confirm K3 in the session binding');
    if (call.activeTools?.length) throw new Error('Unexpected tools enabled in the trial profile');
    if (!call.usage) throw new Error('No token measurement; stop before another call');
    const text = unfence(call.text || events.filter(e => e.role === 'assistant').map(e => e.content ?? '').join(''));
    const parsed = JSON.parse(text);
    if (kind === 'extraction' ? !Array.isArray(parsed) : !parsed.level1Summary || !parsed.level2Essential || !parsed.level3Keywords)
      throw new Error('Invalid result JSON');
    call.output = parsed; call.validJson = true; delete call.text;
    return text;
  } catch (error) { call.error = String(error); throw error; }
} });

try {
  report.quotaBefore = await quota();
  if (process.argv.includes('--quota-only')) {
    report.status = 'quota-measured';
  } else {
  if (report.quotaBefore.kind !== 'ok')
    throw new Error('Account quota unavailable; no model call is permitted.');
  const limits = report.quotaBefore.limits ?? [];
  if (limits.some((row: any) => Number(row.limit) > 0 && Number(row.used) >= Number(row.limit)))
    throw new Error('Included account quota exhausted; no model call is permitted.');
  if (report.quotaBefore.extra_usage?.balance_cents > 0)
    throw new Error('Extra-usage balance is available; stopped to avoid unapproved pay-as-you-go consumption.');
  for (const sample of source.samples.slice(0, 2)) {
    const session = { sessionId: sample.sessionId, directory: sample.directory, rawText: sample.excerpt, messages: [] };
    const llm = await extractLearnings(session, client, 2);
    report.samples.push({ sessionId: sample.sessionId, excerpt: sample.excerpt, llm });
  }
  kind = 'consolidation';
  const learning = source.samples[0].llm[0]; // Identical consolidation input to Luna.
  report.consolidationSource = learning;
  report.consolidation = await generateMemoryLevels(learning.content, learning.memoryType, client);
  if (report.calls.at(-1)?.error) throw new Error(report.calls.at(-1).error);
  report.status = 'completed';
  }
} catch (error) { report.status = 'failed'; report.error = String(error); }
finally {
  report.quotaAfter = await quota();
  server.kill(); await Promise.allSettled(drains);
}
await save();
if (!['completed', 'quota-measured'].includes(report.status)) process.exit(1);
