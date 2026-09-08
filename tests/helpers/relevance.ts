/**
 * Relevance measurement — audit improvement #1.
 *
 * The suite proves the machinery works; nothing proved that the *right* memory
 * comes back. This helper seeds a frozen corpus at controlled ages, runs its
 * queries, and scores the answers with the usual retrieval metrics.
 *
 * Two rules keep the number honest:
 *
 * 1. The corpus is frozen. Tuning a trace so a threshold passes measures the
 *    tuning, not the engine.
 * 2. Thresholds are floors recording what the engine does today, not targets
 *    describing what it should do. A floor that rises is a result; a floor that
 *    is lowered needs a sentence saying why.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { SQLiteStore } from '../../src/store/sqlite.js';
import type { Memory, Intention, TriggerSpec } from '../../src/core/types.js';
import type { FakeClock } from '../../src/core/clock.js';
import { T0 } from './clock.js';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures');

export interface RelevanceMemoryFixture {
  key: string;
  content: string;
  directory: string;
  keywords: string[];
  sessionId: string;
  memoryType: 'episodic' | 'semantic' | 'procedural';
  /** Hours *before* T0 the trace was encoded — drives its decay level. */
  ageHours: number;
}

export interface QueryCase {
  id: string;
  query: string;
  directory?: string;
  /** Fixture keys that should come back. */
  relevant: string[];
  /** Fixture keys whose presence in the top results is a false positive. */
  absent: string[];
}

export interface DueCase {
  id: string;
  at: string;
  due: string[];
}

export interface ContextCase {
  id: string;
  directory: string;
  expectLoops: string[];
  rejectLoops: string[];
}

export interface RelevanceCorpus {
  memories: RelevanceMemoryFixture[];
  queries: QueryCase[];
  intentions: { key: string; content: string; directory: string; expiresInHours?: number; cues: TriggerSpec[] }[];
  dueCases: DueCase[];
  contextCases: ContextCase[];
}

export function relevanceCorpus(file = 'relevance.corpus.json'): RelevanceCorpus {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf-8')) as RelevanceCorpus;
}

export interface SeededCorpus {
  /** Fixture key → stored trace. */
  byKey: Record<string, Memory>;
  /** Trace id → fixture key, for scoring results back to keys. */
  keyOf: Map<string, string>;
  intentions: Record<string, Intention>;
}

/**
 * Seeds the corpus so each trace carries its fixture age, then leaves the clock
 * at T0 with decay applied. Ages are produced by rewinding the clock before the
 * write — the store stamps `createdAt` from it — which is the only way to get a
 * realistic level spread without waiting weeks.
 */
export async function seedRelevanceCorpus(
  store: SQLiteStore,
  clock: FakeClock,
  corpus: RelevanceCorpus = relevanceCorpus()
): Promise<SeededCorpus> {
  const byKey: Record<string, Memory> = {};
  const keyOf = new Map<string, string>();

  for (const fixture of corpus.memories) {
    clock.set(new Date(T0.getTime() - fixture.ageHours * 3600_000));
    const stored = await store.add({
      content: fixture.content,
      directory: fixture.directory,
      keywords: fixture.keywords,
      sessionId: fixture.sessionId,
      memoryType: fixture.memoryType,
      day: clock.now().toISOString().split('T')[0],
      // Levels come from the LLM generator in production; here they are derived
      // deterministically so no network or model decides what a degraded trace
      // still holds. See deriveLevels below.
      ...deriveLevels(fixture),
    } as any);
    byKey[fixture.key] = stored;
    keyOf.set(stored.id, fixture.key);
  }

  clock.set(T0);
  await store.updateDecay();

  // Re-read: updateDecay moved levels, and the stored objects above are stale.
  for (const [key, memory] of Object.entries(byKey)) {
    const fresh = await store.getById(memory.id);
    if (fresh) byKey[key] = fresh;
  }

  const intentions: Record<string, Intention> = {};
  for (const fixture of corpus.intentions) {
    const expiresAt =
      fixture.expiresInHours === undefined
        ? undefined
        : new Date(T0.getTime() + fixture.expiresInHours * 3600_000);
    intentions[fixture.key] = await store.addIntention(
      { content: fixture.content, directory: fixture.directory, expiresAt },
      fixture.cues
    );
  }

  return { byKey, keyOf, intentions };
}

/**
 * Deterministic L1/L2/L3 from the fixture itself: the first sentence as the
 * summary, a clipped gist, and the declared keywords. A degraded trace must
 * still be findable, and that is exactly what the L3 line is measured on — so
 * it has to be real, not empty.
 */
function deriveLevels(fixture: RelevanceMemoryFixture) {
  const firstSentence = `${fixture.content.split('. ')[0]}.`;
  return {
    level1Summary: firstSentence,
    level2Essential: firstSentence.slice(0, 120),
    level3Keywords: fixture.keywords.join(' '),
  };
}

// --- metrics ----------------------------------------------------------------

export interface QueryScore {
  id: string;
  /** Fraction of the expected traces found in the top k. */
  recall: number;
  /** Fraction of the top k that was expected. Undefined when nothing was expected. */
  precision: number | undefined;
  /** 1/rank of the first expected trace, 0 if none appeared. */
  reciprocalRank: number;
  /** Expected traces that never appeared. */
  missed: string[];
  /** Traces the case named as forbidden that appeared anyway. */
  falsePositives: string[];
  /** Fixture keys actually returned, in rank order. Unknown ids show as their id. */
  returned: string[];
}

export interface CorpusScore {
  perQuery: QueryScore[];
  /** Mean recall over the cases that expect something. */
  meanRecall: number;
  /** Mean reciprocal rank over the cases that expect something. */
  mrr: number;
  /** Cases where a forbidden trace appeared in the top k. */
  falsePositiveCases: number;
  /** Cases expecting nothing that correctly returned nothing relevant. */
  emptyCasesClean: number;
  emptyCasesTotal: number;
}

export function scoreQuery(
  testCase: QueryCase,
  returnedKeys: string[],
  k: number
): QueryScore {
  const top = returnedKeys.slice(0, k);
  const expected = new Set(testCase.relevant);
  const hits = top.filter((key) => expected.has(key));
  const firstHit = top.findIndex((key) => expected.has(key));

  return {
    id: testCase.id,
    recall: expected.size === 0 ? 1 : hits.length / expected.size,
    precision: top.length === 0 ? undefined : hits.length / top.length,
    reciprocalRank: firstHit === -1 ? 0 : 1 / (firstHit + 1),
    missed: testCase.relevant.filter((key) => !top.includes(key)),
    falsePositives: testCase.absent.filter((key) => top.includes(key)),
    returned: top,
  };
}

export function aggregate(scores: QueryScore[], corpus: RelevanceCorpus): CorpusScore {
  const expectingCases = corpus.queries.filter((q) => q.relevant.length > 0).map((q) => q.id);
  const scoring = scores.filter((s) => expectingCases.includes(s.id));
  const emptyScores = scores.filter((s) => !expectingCases.includes(s.id));

  const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);

  return {
    perQuery: scores,
    meanRecall: mean(scoring.map((s) => s.recall)),
    mrr: mean(scoring.map((s) => s.reciprocalRank)),
    falsePositiveCases: scores.filter((s) => s.falsePositives.length > 0).length,
    emptyCasesClean: emptyScores.filter((s) => s.falsePositives.length === 0).length,
    emptyCasesTotal: emptyScores.length,
  };
}

/** Runs every query in the corpus against the store and scores the answers. */
export async function measureRetrieval(
  store: SQLiteStore,
  seeded: SeededCorpus,
  corpus: RelevanceCorpus,
  options: { k?: number; limit?: number } = {}
): Promise<CorpusScore> {
  const k = options.k ?? 5;
  // Ask for more than k so the ranking, not the truncation, decides the top k.
  const limit = options.limit ?? Math.max(k * 3, 15);

  const scores: QueryScore[] = [];
  for (const testCase of corpus.queries) {
    const results = await store.search({
      query: testCase.query,
      directory: testCase.directory,
      limit,
    });
    const returnedKeys = results.map((r) => seeded.keyOf.get(r.memory.id) ?? r.memory.id);
    scores.push(scoreQuery(testCase, returnedKeys, k));
  }
  return aggregate(scores, corpus);
}
