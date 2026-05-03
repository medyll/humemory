/**
 * humemory — Human-like memory system
 * 
 * Stocke des souvenirs avec dégradation progressive
 * et recherche inversée (dégradé → détail)
 */

export { SQLiteStore } from './store/sqlite.js';
export { InverseSearchEngine } from './core/search.js';
export { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay, DECAY_CONFIG } from './core/decay.js';
export { generateMemoryLevels } from './core/llm-generator.js';
export type { Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore } from './core/types.js';
export type { GeneratedLevels } from './core/llm-generator.js';
