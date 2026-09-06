import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flexsearch = require('flexsearch');
const { Document } = flexsearch;

import type { Memory, SearchQuery, SearchResult, DecayLevel } from './types.js';
import { systemClock, type Clock } from './clock.js';
import { projectPath } from './project-path.js';

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
   * Inverse search: starts at level 3 and escalates when needed
   */
  search(query: SearchQuery): SearchResult[] {
    const results: SearchResult[] = [];
    const { query: searchQuery, maxLevel = 3, limit = 10 } = query;

    // Level-by-level strategy, from most degraded to most detailed
    const searchOrder: { field: string; level: DecayLevel }[] = [
      { field: 'level3Keywords', level: 3 },
      { field: 'level2Essential', level: 2 },
      { field: 'level1Summary', level: 1 },
      { field: 'content', level: 0 },
    ];

    const seenIds = new Set<string>();

    for (const { field, level } of searchOrder) {
      // Skip once past the caller's maximum level
      if (level > maxLevel) continue;

      // Recherche sur ce niveau
      const matches = this.index.search({
        query: searchQuery,
        field,
        limit: Math.max(1, this.memories.size), // rank all candidates after filtering
      });

      // FlexSearch retourne [{field, result: [ids]}]
      // Collect ids from every matched field
      const ids: string[] = [];
      for (const match of matches) {
        if (match && typeof match === 'object' && 'result' in match) {
          ids.push(...(match.result as string[]));
        } else if (typeof match === 'string') {
          ids.push(match);
        }
      }

      // Process the results
      for (const id of ids) {
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
          score: this.calculateScore(memory, searchQuery, level),
        });

      }
    }

    return results.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id)).slice(0, Math.max(0, limit));
  }

  /**
   * Calcule un score de pertinence
   */
  private calculateScore(memory: Memory, query: string, matchLevel: DecayLevel): number {
    let score = 100;

    // Bonus for matching on a degraded level: cheaper to reach, more useful
    const levelBonus = matchLevel * 10;
    score += levelBonus;

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
