import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SQLiteStore } from '../src/store/sqlite.js';
import { SqliteCueResolver } from '../src/core/cues.js';
import { buildSessionContext } from '../src/agent/session-context.js';
import { FakeClock } from '../src/core/clock.js';
import { T0 } from './helpers/clock.js';
import {
  relevanceCorpus,
  seedRelevanceCorpus,
  measureRetrieval,
  type RelevanceCorpus,
  type SeededCorpus,
} from './helpers/relevance.js';

/**
 * Cognitive-quality gate — audit improvement #1.
 *
 * Every other suite asks "does the machinery work". This one asks "does the
 * right memory come back", which is the actual promise, and until now nothing
 * measured it.
 *
 * The thresholds below are FLOORS RECORDING TODAY'S BEHAVIOUR, measured on
 * 2026-09-08 with `pnpm measure:recall`, not targets anybody designed toward.
 * Retrieval is deterministic here — frozen clock, in-memory store, no model —
 * so a floor that moves means the engine moved. Raising one is a result worth
 * committing. Lowering one is a regression that needs a sentence saying why,
 * in the commit that lowers it.
 *
 * Known gap at the time of writing, visible in the report as two zero-recall
 * queries: FlexSearch matches all query terms within a SINGLE field, so a query
 * whose terms are spread across the L3 keyword line and the full content
 * returns nothing at all. "sqlite lock" finds the trace; "sqlite concurrent
 * write lock" finds nothing. The floors encode that gap rather than hiding it.
 */
const MEAN_RECALL_FLOOR = 0.84; // measured 0.846 — 11 of 13 answerable queries
const MRR_FLOOR = 0.84; // measured 0.846 — every match lands at rank 1
const K = 5;

describe('cognitive quality', () => {
  let corpus: RelevanceCorpus;
  let clock: FakeClock;
  let store: SQLiteStore;
  let seeded: SeededCorpus;

  beforeEach(async () => {
    corpus = relevanceCorpus();
    clock = new FakeClock(T0);
    store = new SQLiteStore(':memory:', { clock });
    seeded = await seedRelevanceCorpus(store, clock, corpus);
  });

  afterEach(() => {
    store.close();
  });

  test('the corpus actually degraded — otherwise nothing below is measured', async () => {
    const spread = [0, 0, 0, 0, 0];
    for (const memory of Object.values(seeded.byKey)) spread[memory.currentLevel]++;

    // Fresh traces are the easy case. A corpus that never left L0 would report
    // a flattering number about a situation the engine is never in.
    expect(spread[0]).toBeGreaterThan(0);
    expect(spread[2] + spread[3] + spread[4]).toBeGreaterThanOrEqual(10);
  });

  test('mean recall@5 holds its floor', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    expect(score.meanRecall).toBeGreaterThanOrEqual(MEAN_RECALL_FLOOR);
  });

  test('the first relevant trace ranks near the top', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    expect(score.mrr).toBeGreaterThanOrEqual(MRR_FLOOR);
  });

  test('no query surfaces a trace the case forbids', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    const offenders = score.perQuery
      .filter((row) => row.falsePositives.length > 0)
      .map((row) => `${row.id}: ${row.falsePositives.join(', ')}`);

    // Precision is the half a keyword engine fails quietly: it answers
    // confidently with the wrong neighbour rather than admitting a miss.
    expect(offenders).toEqual([]);
  });

  test('a query with no answer in the corpus returns no confident answer', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    expect(score.emptyCasesTotal).toBeGreaterThan(0);
    expect(score.emptyCasesClean).toBe(score.emptyCasesTotal);
  });

  test('every query that matches at all puts a relevant trace first', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    const matched = score.perQuery.filter((row) => row.reciprocalRank > 0);

    // Rank 1 or nothing: a hit buried at rank 4 in a corpus this small would
    // mean the ranking is not carrying its weight.
    expect(matched.every((row) => row.reciprocalRank === 1)).toBe(true);
  });

  describe('prospective — what comes due, and what must not', () => {
    for (const testCase of relevanceCorpus().dueCases) {
      test(`${testCase.id}`, async () => {
        // A fresh store per case: firing mutates state, and each case is an
        // independent "what would wake me at this instant".
        const caseClock = new FakeClock(T0);
        const caseStore = new SQLiteStore(':memory:', { clock: caseClock });
        try {
          const caseSeeded = await seedRelevanceCorpus(caseStore, caseClock, corpus);
          const resolver = new SqliteCueResolver(caseStore);
          const at = new Date(testCase.at);
          await resolver.expireStale(at);

          const keyById = new Map(
            Object.entries(caseSeeded.intentions).map(([key, intention]) => [intention.id, key])
          );
          const due = (await resolver.resolveTimeCues(at))
            .map((cue) => keyById.get(cue.targetId) ?? cue.targetId)
            .sort();

          expect(due).toEqual([...testCase.due].sort());
        } finally {
          caseStore.close();
        }
      });
    }
  });

  describe('injected context — what a session opens with', () => {
    for (const testCase of relevanceCorpus().contextCases) {
      test(`${testCase.id}`, async () => {
        const keyById = new Map(
          Object.entries(seeded.intentions).map(([key, intention]) => [intention.id, key])
        );
        const context = await buildSessionContext({
          store,
          directory: testCase.directory,
          clock,
        });
        const loops = context.openLoops.map((loop) => keyById.get(loop.id) ?? loop.id);

        for (const expected of testCase.expectLoops) expect(loops).toContain(expected);
        // The failure that matters: offering a neighbouring project's loop
        // because this one had nothing to say.
        for (const rejected of testCase.rejectLoops) expect(loops).not.toContain(rejected);
      });
    }
  });
});
