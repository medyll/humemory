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
export { systemClock, FakeClock } from './core/clock.js';
export { InMemoryEventBus } from './core/event-bus.js';
export { SqliteCueResolver, attachResolverToBus, intentionSaillance, parseCron, cronMatches, cronDueSince, eventTriggerMatches } from './core/cues.js';
export { processSession } from './agent/claude-hook.js';
export { parseClaudeHookPayload } from './agent/session-parser.js';
export { extractLearnings } from './agent/learning-extractor.js';
export type { Memory, SearchQuery, SearchResult, DecayLevel, MemoryStore, MergeResult,
  Intention, Cue, IntentionStatus, CueStatus, CueKind, TriggerSpec, TimeTriggerSpec, EventTriggerSpec,
  NewIntention, NewCue, IntentionStore } from './core/types.js';
export type { StoreOptions } from './store/sqlite.js';
export type { Clock } from './core/clock.js';
export type { CueResolver, CueResolverOptions } from './core/cues.js';
export type { AppEvent, AppEventType, AppEventOf, EventBus, EventHandler, Unsubscribe } from './core/event-bus.js';
export type { GeneratedLevels, LLMClient } from './core/llm-generator.js';
export type { ParsedSession, SessionMessage } from './agent/session-parser.js';
export type { ExtractedLearning } from './agent/learning-extractor.js';
export type { HookOptions, HookResult } from './agent/claude-hook.js';
