/**
 * humemory — Human-like memory system
 * 
 * Stocke des souvenirs avec dégradation progressive
 * et recherche inversée (dégradé → détail)
 */

export { SQLiteStore } from './store/sqlite.js';
export { InverseSearchEngine } from './core/search.js';
export { calculateDecayLevel, calculateSaillance, calculateDecayRate, updateAllDecay, DECAY_CONFIG } from './core/decay.js';
export { generateMemoryLevels, setLLMClient } from './core/llm-generator.js';
export { processSession } from './agent/claude-hook.js';
export { parseClaudeHookPayload } from './agent/session-parser.js';
export { extractLearnings } from './agent/learning-extractor.js';
export type { Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MergeResult } from './core/types.js';
export type { GeneratedLevels, LLMClient } from './core/llm-generator.js';
export type { ParsedSession, SessionMessage } from './agent/session-parser.js';
export type { ExtractedLearning } from './agent/learning-extractor.js';
export type { HookOptions, HookResult } from './agent/claude-hook.js';
