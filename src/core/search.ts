import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const flexsearch = require('flexsearch');
const { Document } = flexsearch;

import type { Memory, SearchQuery, SearchResult, DecayLevel } from './types.js';

/**
 * Moteur de recherche inversée avec BM25
 * Cherche d'abord sur les versions dégradées (Niveau 3), puis remonte
 */
export class InverseSearchEngine {
  private index: any;
  private memories: Map<string, Memory> = new Map();

  constructor() {
    // Index FlexSearch optimisé pour les mots-clés
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
   * Ajoute un souvenir à l'index
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
   * Met à jour un souvenir dans l'index
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
   * Recherche inversée : commence par Niveau 3, remonte si besoin
   */
  search(query: SearchQuery): SearchResult[] {
    const results: SearchResult[] = [];
    const { query: searchQuery, maxLevel = 3, limit = 10 } = query;

    // Stratégie de recherche par niveau (du plus dégradé au plus détaillé)
    const searchOrder: { field: string; level: DecayLevel }[] = [
      { field: 'level3Keywords', level: 3 },
      { field: 'level2Essential', level: 2 },
      { field: 'level1Summary', level: 1 },
      { field: 'content', level: 0 },
    ];

    const seenIds = new Set<string>();

    for (const { field, level } of searchOrder) {
      // Skip si on a dépassé le niveau max
      if (level > maxLevel) continue;

      // Recherche sur ce niveau
      const matches = this.index.search({
        query: searchQuery,
        field,
        limit: limit * 2, // Prendre plus large pour filtrer après
      });

      // FlexSearch retourne [{field, result: [ids]}]
      // Extraire les IDs de tous les champs matchés
      const ids: string[] = [];
      for (const match of matches) {
        if (match && typeof match === 'object' && 'result' in match) {
          ids.push(...(match.result as string[]));
        } else if (typeof match === 'string') {
          ids.push(match);
        }
      }

      // Traiter les résultats
      for (const id of ids) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const memory = this.memories.get(id);
        if (!memory) continue;

        // Filtres optionnels
        if (query.directory && memory.directory !== query.directory) continue;
        if (query.sessionId && memory.sessionId !== query.sessionId) continue;

        results.push({
          memory,
          matchLevel: level,
          score: this.calculateScore(memory, searchQuery, level),
        });

        if (results.length >= limit) {
          return results.sort((a, b) => b.score - a.score);
        }
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Calcule un score de pertinence
   */
  private calculateScore(memory: Memory, query: string, matchLevel: DecayLevel): number {
    let score = 100;

    // Bonus pour match sur niveau dégradé (plus rapide = plus utile)
    const levelBonus = (4 - matchLevel) * 10;
    score += levelBonus;

    // Bonus pour récence
    const daysSinceCreation = (Date.now() - memory.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreation < 7) {
      score += 20;
    } else if (daysSinceCreation < 30) {
      score += 10;
    }

    // Bonus pour rappels fréquents
    score += memory.recallCount * 5;

    // Bonus pour saillance
    score += memory.saillance * 0.2;

    // Pénalité si contenu très long (moins précis)
    if (memory.content.length > 1000) {
      score -= 10;
    }

    return Math.min(100, score);
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
