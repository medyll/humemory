/**
 * Niveaux de dégradation de la mémoire
 * 0 = détail complet (frais)
 * 1 = résumé (quelques jours)
 * 2 = essentiel (semaines)
 * 3 = mots-clés (mois)
 * 4 = perdu/fusionné
 */
export type DecayLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Types de mémoire (neuroscience cognitive)
 * - Episodic: souvenirs d'événements vécus (contexte temporel/spatial)
 * - Semantic: connaissances factuelles, concepts
 * - Procedural: savoir-faire, gestes, routines
 */
export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export interface Memory {
  id: string;
  content: string;           // Niveau 0 (détail complet)
  level1Summary?: string;    // Niveau 1 (résumé)
  level2Essential?: string;  // Niveau 2 (essentiel)
  level3Keywords?: string;   // Niveau 3 (mots-clés pour BM25)
  
  // Métadonnées légères
  directory: string;         // Projet/source
  day: string;               // YYYY-MM-DD
  keywords: string[];        // Mots-clés tagués
  sessionId: string;         // Session de travail
  memoryType: MemoryType;    // Type de mémoire
  
  // Cycle de vie
  createdAt: Date;
  lastRecalled?: Date;
  recallCount: number;       // Nombre de rappels
  
  // Dégradation
  decayRate: number;         // 0.0 (lent) à 1.0 (rapide)
  currentLevel: DecayLevel;  // Niveau actuel de dégradation
  saillance: number;         // Score 0-100
  
  // Fusion
  mergedIntoId?: string;     // ID du souvenir fusionné (si niveau 4)
}

export interface SearchQuery {
  query: string;
  directory?: string;
  sessionId?: string;
  maxLevel?: DecayLevel;     // Niveau max de dégradation à inclure
  limit?: number;
  // Enriched filters
  memoryType?: MemoryType;
  dateFrom?: Date;           // Filter: createdAt >= dateFrom
  dateTo?: Date;             // Filter: createdAt <= dateTo
  minSaillance?: number;     // Filter: saillance >= minSaillance
  minRecalls?: number;       // Filter: recallCount >= minRecalls
}

export interface SearchResult {
  memory: Memory;
  matchLevel: DecayLevel;    // Niveau où le match a été trouvé
  score: number;             // Score de pertinence
}

export interface MergeResult {
  source: Memory;
  target: Memory;
  mergedContent?: string;
}

export interface MemoryStore {
  add(memory: Omit<Memory, 'id' | 'createdAt' | 'recallCount' | 'decayRate' | 'currentLevel' | 'saillance'>, options?: { autoGenerate?: boolean }): Promise<Memory>;
  getById(id: string): Promise<Memory | null>;
  search(query: SearchQuery): Promise<SearchResult[]>;
  recall(id: string): Promise<Memory>;
  updateDecay(): Promise<void>;
  delete(id: string): Promise<void>;
  list(options?: { limit?: number; level?: DecayLevel; type?: MemoryType }): Promise<Memory[]>;
  findSimilar(id: string, options?: { limit?: number; threshold?: number }): Promise<SearchResult[]>;
  merge(sourceId: string, targetId: string, options?: { autoMergeContent?: boolean; client?: import('./llm-generator.js').LLMClient }): Promise<MergeResult>;
}
