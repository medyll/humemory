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
 * The gap this first measured — FlexSearch requiring every query term inside a
 * SINGLE field, so a query straddling the L3 keyword line and the content
 * returned nothing (A13) — is fixed by the near-miss pass in `search.ts`.
 * Recall went 0.846 → 1.000.
 *
 * One false positive is accepted, and it is a trade-off rather than a defect.
 * The index uses `charset: 'latin:advanced'`, a phonetic encoder that collapses
 * lock/log/local — so "sqlite concurrent write lock" genuinely matches three of
 * its four terms against the auth token race, which contains "logging". That
 * same encoder is the only thing that answers a one-word misspelling
 * (`q-typo-single-term`, `q-typo-single-rare`): the near-miss pass needs two
 * terms, so it cannot help there. Switching to `latin:default` measured 0 false
 * positives and 0 recall on both typo queries. Precision on one multi-term
 * query is the cheaper thing to give up in a memory that people query from
 * half-remembered fragments.
 */
const MEAN_RECALL_FLOOR = 1; // measured 1.000 — all 18 answerable queries
const MRR_FLOOR = 1; // measured 1.000 — every match lands at rank 1
/** See the note above: the encoder's phonetic collapsing, kept on purpose. */
const FALSE_POSITIVE_CEILING = 1;
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

  test('false positives stay within the measured ceiling', async () => {
    const score = await measureRetrieval(store, seeded, corpus, { k: K });
    const offenders = score.perQuery
      .filter((row) => row.falsePositives.length > 0)
      .map((row) => `${row.id}: ${row.falsePositives.join(', ')}`);

    // Precision is the half a keyword engine fails quietly: it answers
    // confidently with the wrong neighbour rather than admitting a miss. The
    // ceiling is 1, not 0, and the header explains which one and why.
    expect(offenders.length).toBeLessThanOrEqual(FALSE_POSITIVE_CEILING);
  });

  test('the phonetic encoder still answers a one-word misspelling', async () => {
    // Guards the trade-off from being silently undone: swapping the charset to
    // latin:default takes the false-positive count to zero and takes these to
    // zero recall as well. Whoever changes it should have to change this test.
    for (const query of ['sqlyte', 'checkpont']) {
      const results = await store.search({ query, limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    }
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
