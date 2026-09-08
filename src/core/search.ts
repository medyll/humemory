import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flexsearch = require('flexsearch');
const { Document } = flexsearch;

import type { Memory, SearchQuery, SearchResult, DecayLevel } from './types.js';
import { systemClock, type Clock } from './clock.js';
import { projectPath } from './project-path.js';

/**
 * Cost of having matched only part of the query. Larger than the widest level
 * bonus (3 * 10) so no partial match can outrank an exact one.
 */
const PARTIAL_MATCH_PENALTY = 35;

/** FlexSearch answers as [{field, result: [ids]}] or, sometimes, bare ids. */
function flattenIds(matches: any): string[] {
  if (!Array.isArray(matches)) return [];
  const ids: string[] = [];
  for (const match of matches) {
    if (typeof match === 'string') ids.push(match);
    else if (Array.isArray(match?.result)) ids.push(...(match.result as string[]));
  }
  return ids;
}

/**
 * Inverse search engine, FlexSearch candidates with heuristic ranking.
 * Queries the degraded layers first (level 3), then escalates.
 */
export class InverseSearchEngine {
  private index: any;
  private memories: Map<string, Memory> = new Map();
  private clock: Clock;

  constructor(options: { clock?: Clock } = {}) {
    // The recency bonus depends on "now" — injectable so scoring is deterministic
    // in tests (docs/TESTING.md → pillar 2).
    this.clock = options.clock ?? systemClock;
    // FlexSearch index tuned for keywords
    this.index = new Document({
      tokenize: 'forward',
      charset: 'latin:advanced',
      optimize: true,
      document: {
        id: 'id',
        index: ['level3Keywords', 'level2Essential', 'level1Summary', 'content'],
      },
    });
  }

  /**
   * Adds a memory to the index
   */
  add(memory: Memory): void {
    this.memories.set(memory.id, memory);
    
    this.index.add({
      id: memory.id,
      level3Keywords: memory.level3Keywords || '',
      level2Essential: memory.level2Essential || '',
      level1Summary: memory.level1Summary || '',
      content: memory.content,
    });
  }

  /**
   * Updates a memory in the index
   */
  update(memory: Memory): void {
    this.index.remove(memory.id);
    this.add(memory);
  }

  /**
   * Supprime un souvenir de l'index
   */
  remove(id: string): void {
    this.index.remove(id);
    this.memories.delete(id);
  }

  /**
   * Inverse search: starts at level 3 and escalates when needed.
   *
   * Two passes. The first is strict, and answers almost every query. The second
   * only runs when the first found nothing anywhere, and exists because of
   * audit A13: FlexSearch requires EVERY query term inside a SINGLE field, and
   * the decay levels are indexed as separate fields — so a query whose terms
   * straddle the L3 keyword line and the full content matched neither and
   * returned nothing at all. "sqlite lock" found the trace; "sqlite concurrent
   * write lock" found silence, which is the worst possible answer to a user
   * being more precise.
   */
  search(query: SearchQuery): SearchResult[] {
    const { query: searchQuery, maxLevel = 3, limit = 10 } = query;

    // Level-by-level strategy, from most degraded to most detailed
    const searchOrder: { field: string; level: DecayLevel }[] = [
      { field: 'level3Keywords', level: 3 },
      { field: 'level2Essential', level: 2 },
      { field: 'level1Summary', level: 1 },
      { field: 'content', level: 0 },
    ];
    const levels = searchOrder.filter(({ level }) => level <= maxLevel);

    const strict = this.collect(query, levels, (field) => this.strictIds(searchQuery, field));
    // Whole-query match found something: it is the better answer by definition,
    // and relaxing further would only add neighbours below it.
    const results = strict.length
      ? strict
      : this.collect(query, levels, (field) => this.nearMissIds(searchQuery, field), true);

    return results
      .sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id))
      .slice(0, Math.max(0, limit));
  }

  /** Runs one pass over the levels, filtering and scoring what the ids yield. */
  private collect(
    query: SearchQuery,
    levels: { field: string; level: DecayLevel }[],
    idsFor: (field: string) => string[],
    partial = false
  ): SearchResult[] {
    const results: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const { field, level } of levels) {
      for (const id of idsFor(field)) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const memory = this.memories.get(id);
        if (!memory) continue;

        // Filtres optionnels
        if (query.directory && projectPath(memory.directory) !== projectPath(query.directory)) continue;
        if (query.sessionId && memory.sessionId !== query.sessionId) continue;
        if (query.memoryType && memory.memoryType !== query.memoryType) continue;
        if (query.dateFrom && new Date(memory.day) < query.dateFrom) continue;
        if (query.dateTo && new Date(memory.day) > query.dateTo) continue;
        if (query.minSaillance !== undefined && memory.saillance < query.minSaillance) continue;
        if (query.minRecalls !== undefined && memory.recallCount < query.minRecalls) continue;

        results.push({
          memory,
          matchLevel: level,
          score: this.calculateScore(memory, query.query, level, partial),
        });
      }
    }

    return results;
  }

  /** Ids matching the whole query inside one field — FlexSearch's own AND. */
  private strictIds(searchQuery: string, field: string): string[] {
    return flattenIds(
      this.index.search({
        query: searchQuery,
        field,
        limit: Math.max(1, this.memories.size), // rank all candidates after filtering
      })
    );
  }

  /**
   * Ids matching all but at most one term of the query inside one field.
   *
   * FlexSearch's own `suggest: true` would accept a single term out of five,
   * which turns a missed recall into a confident wrong neighbour — measurably:
   * it put an auth token race at the top of "sqlite concurrent write lock".
   * Counting the terms ourselves keeps the near-misses and drops the strangers.
   */
  private nearMissIds(searchQuery: string, field: string): string[] {
    const terms = searchQuery.split(/\s+/).filter(Boolean);
    if (terms.length < 2) return [];

    const hits = new Map<string, number>();
    for (const term of terms) {
      for (const id of this.strictIds(term, field)) {
        hits.set(id, (hits.get(id) ?? 0) + 1);
      }
    }

    const required = terms.length - 1;
    return [...hits.entries()]
      .filter(([, count]) => count >= required)
      // More terms satisfied first: the pass keeps insertion order downstream.
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id]) => id);
  }

  /**
   * Calcule un score de pertinence
   */
  private calculateScore(
    memory: Memory,
    query: string,
    matchLevel: DecayLevel,
    partial = false
  ): number {
    let score = 100;

    // Bonus for matching on a degraded level: cheaper to reach, more useful
    const levelBonus = matchLevel * 10;
    score += levelBonus;

    // A partial match satisfied only some of the query terms (A13 fallback).
    // The penalty exceeds the widest level bonus on purpose: an exact match at
    // any level must outrank a partial one at every level, or a loose hit on
    // the keyword line would bury an exact hit in the full content.
    if (partial) score -= PARTIAL_MATCH_PENALTY;

    // Recency bonus
    const daysSinceCreation =
      (this.clock.now().getTime() - memory.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation < 7) {
      score += 20;
    } else if (daysSinceCreation < 30) {
      score += 10;
    }

    // Bonus for frequent recalls
    score += memory.recallCount * 5;

    // Bonus pour saillance
    score += memory.saillance * 0.2;

    // Penalty for very long content: less precise
    if (memory.content.length > 1000) {
      score -= 10;
    }

    return score;
  }

  /**
   * Retourne tous les souvenirs (pour debug/sync)
   */
  getAll(): Memory[] {
    return Array.from(this.memories.values());
  }

  /**
   * Clear l'index
   */
  clear(): void {
    this.index = new Document({
      tokenize: 'forward',
      charset: 'latin:advanced',
      optimize: true,
      document: {
        id: 'id',
        index: ['level3Keywords', 'level2Essential', 'level1Summary', 'content'],
      },
    });
    this.memories.clear();
  }
}
