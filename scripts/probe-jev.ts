/**
 * Explicit live probe over synthetic, human-labelled candidates.
 * It prints fixture ids, hashes and decisions, never the candidate text.
 */
import { readFile } from 'fs/promises';
import { resolve } from 'path';
import { JevMemoryAdvisor } from '../src/agent/jev-advisor.js';
import { sanitizeMemoryCandidate } from '../src/agent/memory-advisor.js';

if (!process.argv.includes('--run')) {
  console.error('Live network probe not started. Re-run with --run and TYPESAFE_API_KEY set.');
  process.exitCode = 2;
} else {
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error('TYPESAFE_API_KEY is required');
  const fixtures = JSON.parse(await readFile(resolve('tests/fixtures/jev-candidates.json'), 'utf8')) as Array<any>;
  const advisor = new JevMemoryAdvisor({ apiKey });
  const results: any[] = [];

  for (const fixture of fixtures) {
    const sanitized = sanitizeMemoryCandidate({
      content: fixture.content,
      currentMemoryType: fixture.expected.memoryType,
      source: 'hook',
    });
    if (!sanitized.accepted) {
      results.push({
        id: fixture.id,
        candidateHash: sanitized.hash,
        expected: fixture.expected,
        localDecision: { accepted: false, reason: sanitized.reason },
      });
      continue;
    }
    const started = performance.now();
    const advice = await advisor.advise(sanitized.candidate);
    results.push({
      id: fixture.id,
      candidateHash: sanitized.hash,
      expected: fixture.expected,
      localDecision: {
        accepted: true,
        truncated: sanitized.candidate.truncated,
        redactions: sanitized.candidate.redactions,
      },
      advice,
      latencyMs: Math.round(performance.now() - started),
    });
  }

  console.log(JSON.stringify({ model: process.env.HUMEMORY_JEV_MODEL ?? 'jev-latest', results }, null, 2));
}
