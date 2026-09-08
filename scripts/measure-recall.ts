#!/usr/bin/env bun
/**
 * Cognitive-quality report — audit improvement #1.
 *
 * Runs the frozen relevance corpus and prints what came back, per query. The
 * regression gate lives in `tests/relevance.test.ts`; this is the human-facing
 * half, for when a number moves and you need to see *which* recall broke.
 *
 * Hermetic by construction: in-memory store, frozen clock, no model, no
 * network. Run: `pnpm measure:recall` (add `--json` for the raw scores).
 */
import { SQLiteStore } from '../src/store/sqlite.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import { buildSessionContext } from '../src/agent/session-context.js';
import { FakeClock } from '../src/core/clock.js';
import { T0 } from '../tests/helpers/clock.js';
import {
  relevanceCorpus,
  seedRelevanceCorpus,
  measureRetrieval,
  type CorpusScore,
} from '../tests/helpers/relevance.js';

const asJson = process.argv.includes('--json');

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return `${'█'.repeat(filled)}${'·'.repeat(width - filled)}`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(0)}%`.padStart(4);
}

async function main() {
  const corpus = relevanceCorpus();
  const clock = new FakeClock(T0);
  const store = new SQLiteStore(':memory:', { clock });
  const seeded = await seedRelevanceCorpus(store, clock, corpus);

  // --- level spread: a corpus where everything is fresh measures nothing ---
  const spread = [0, 0, 0, 0, 0];
  for (const memory of Object.values(seeded.byKey)) spread[memory.currentLevel]++;

  const score: CorpusScore = await measureRetrieval(store, seeded, corpus);

  // --- prospective: which loops come due, and which wrongly do ---
  const dueRows: { id: string; expected: string[]; actual: string[]; ok: boolean }[] = [];
  for (const testCase of corpus.dueCases) {
    // A fresh store per case: firing a cue mutates state, and each case
    // describes an independent "what would wake me at this instant".
    const caseClock = new FakeClock(T0);
    const caseStore = new SQLiteStore(':memory:', { clock: caseClock });
    const caseSeeded = await seedRelevanceCorpus(caseStore, caseClock, corpus);
    const resolver = new SqliteCueResolver(caseStore);
    const at = new Date(testCase.at);
    await resolver.expireStale(at);
    const idOf = new Map(Object.entries(caseSeeded.intentions).map(([key, i]) => [i.id, key]));
    const due = await resolver.resolveTimeCues(at);
    const actual = due
      .map((cue) => idOf.get(cue.targetId) ?? cue.targetId)
      .sort();
    const expected = [...testCase.due].sort();
    dueRows.push({
      id: testCase.id,
      expected,
      actual,
      ok: JSON.stringify(expected) === JSON.stringify(actual),
    });
    caseStore.close();
  }

  // --- injected context: what a session actually opens with ---
  const contextRows: { id: string; loops: string[]; ok: boolean }[] = [];
  for (const testCase of corpus.contextCases) {
    const idOf = new Map(Object.entries(seeded.intentions).map(([key, i]) => [i.id, key]));
    const context = await buildSessionContext({
      store,
      directory: testCase.directory,
      clock,
    });
    const loops = context.openLoops.map((loop) => idOf.get(loop.id) ?? loop.id).sort();
    const ok =
      testCase.expectLoops.every((key) => loops.includes(key)) &&
      testCase.rejectLoops.every((key) => !loops.includes(key));
    contextRows.push({ id: testCase.id, loops, ok });
  }

  if (asJson) {
    console.log(JSON.stringify({ spread, retrieval: score, due: dueRows, context: contextRows }, null, 2));
    store.close();
    return;
  }

  console.log('\n🧠 humemory — cognitive quality report');
  console.log(`   corpus: ${corpus.memories.length} traces, ${corpus.queries.length} queries, frozen at ${T0.toISOString()}\n`);

  console.log('Consolidation spread (a corpus that never degraded measures nothing):');
  const stateNames = ['L0 full', 'L1 summary', 'L2 essential', 'L3 keywords', 'L4 lost'];
  spread.forEach((count, level) => console.log(`  ${stateNames[level].padEnd(13)} ${String(count).padStart(2)}`));

  console.log('\nRetrieval, per query (k=5):');
  console.log('  recall  rank   query');
  for (const row of score.perQuery) {
    const rank = row.reciprocalRank ? `#${Math.round(1 / row.reciprocalRank)}` : '—';
    const flag = row.falsePositives.length ? '  ⚠ false positive: ' + row.falsePositives.join(', ') : '';
    console.log(`  ${bar(row.recall, 10)} ${pct(row.recall)} ${rank.padStart(4)}   ${row.id}${flag}`);
    if (row.missed.length) console.log(`  ${' '.repeat(21)}missed: ${row.missed.join(', ')}`);
  }

  console.log('\nAggregate:');
  // Three decimals, not a rounded percentage: a floor copied from "85%" when
  // the real figure is 0.846 fails the moment it is committed.
  console.log(`  mean recall@5        ${score.meanRecall.toFixed(3)}`);
  console.log(`  MRR                  ${score.mrr.toFixed(3)}`);
  console.log(`  false-positive cases ${score.falsePositiveCases}/${score.perQuery.length}`);
  console.log(`  clean "no answer"    ${score.emptyCasesClean}/${score.emptyCasesTotal}`);

  console.log('\nProspective — which loops come due:');
  for (const row of dueRows) {
    console.log(`  ${row.ok ? '✅' : '❌'} ${row.id.padEnd(20)} expected [${row.expected.join(', ')}] got [${row.actual.join(', ')}]`);
  }

  console.log('\nInjected context — loops offered when a session opens:');
  for (const row of contextRows) {
    console.log(`  ${row.ok ? '✅' : '❌'} ${row.id.padEnd(20)} [${row.loops.join(', ')}]`);
  }
  console.log();

  store.close();
}

await main();
