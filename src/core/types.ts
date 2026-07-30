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

  // Photographic mode — désactive la dégradation
  photographic?: boolean;
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

// ─────────────────────────────────────────────────────────────────────────────
// Mémoire prospective (Phase 5) — intentions & cues
//
// Une `Intention` est une boucle ouverte : « demain, refactorer fn X ». Elle ne
// se cherche pas, elle revient — portée par un ou plusieurs `Cue` armés sur le
// temps ou sur un event. Effet Zeigarnik : tant qu'elle est `armed`, sa saillance
// reste figée à 100 ; une fois `fired` sans être `closed`, elle se met à décliner
// comme une trace ordinaire. Voir PHASE5_PLAN.md § 5.1.
// ─────────────────────────────────────────────────────────────────────────────

/** armed = en attente · fired = remontée à l'agent · closed = accomplie · expired = deadline dépassée. */
export type IntentionStatus = 'armed' | 'fired' | 'closed' | 'expired';

export type CueStatus = 'armed' | 'fired' | 'cancelled';

export type CueKind = 'time' | 'event';

/** Déclencheur temporel : soit une date one-shot (`at`), soit une récurrence (`cron`). */
export interface TimeTriggerSpec {
  kind: 'time';
  at?: string; // ISO datetime
  cron?: string; // expression cron 5 champs
}

/**
 * Déclencheur événementiel. Pas de variante `commit` ici, à dessein : un commit ne
 * réveille pas une intention, il la *ferme* — c'est le hook post-commit (S5-03b)
 * qui s'en charge, pas le cue resolver.
 */
export type EventTriggerSpec =
  | { kind: 'event'; type: 'file_open'; path: string }
  | { kind: 'event'; type: 'branch_switch'; branch: string }
  | { kind: 'event'; type: 'error_pattern'; pattern: string };

export type TriggerSpec = TimeTriggerSpec | EventTriggerSpec;

export interface Intention {
  id: string;
  content: string;
  directory: string; // lieu mental
  createdAt: Date;
  expiresAt?: Date; // intention sans deadline = undefined
  status: IntentionStatus;
  firedAt?: Date;
  closedAt?: Date;
  closedByCommit?: string; // SHA du commit qui a fermé la boucle
  saillance: number; // figée à 100 tant que armed
  relatedMemoryId?: string; // lien optionnel vers une trace rétrospective
}

export interface Cue {
  id: string;
  intentionId: string;
  kind: CueKind;
  triggerSpec: TriggerSpec;
  status: CueStatus;
  armedAt: Date;
  firedAt?: Date;
}

/** Entrée d'écriture d'une intention : le store fixe id/createdAt/status/saillance. */
export type NewIntention = Omit<
  Intention,
  'id' | 'createdAt' | 'status' | 'saillance' | 'firedAt' | 'closedAt' | 'closedByCommit'
> & {
  status?: IntentionStatus;
  saillance?: number;
};

/** Entrée d'écriture d'un cue : le store fixe id/armedAt/status et déduit `kind` du spec. */
export type NewCue = {
  intentionId: string;
  triggerSpec: TriggerSpec;
  status?: CueStatus;
};

export interface IntentionStore {
  addIntention(intention: NewIntention, cues?: TriggerSpec[]): Promise<Intention>;
  getIntention(id: string): Promise<Intention | null>;
  listIntentions(options?: {
    status?: IntentionStatus | IntentionStatus[];
    directory?: string;
    limit?: number;
  }): Promise<Intention[]>;
  updateIntentionStatus(
    id: string,
    status: IntentionStatus,
    options?: { closedByCommit?: string }
  ): Promise<Intention>;
  deleteIntention(id: string): Promise<void>;

  addCue(cue: NewCue): Promise<Cue>;
  getCue(id: string): Promise<Cue | null>;
  listCues(options?: {
    intentionId?: string;
    status?: CueStatus | CueStatus[];
    kind?: CueKind;
    limit?: number;
  }): Promise<Cue[]>;
  updateCueStatus(id: string, status: CueStatus): Promise<Cue>;
  /** Enregistre un tir. `rearm` garde le cue `armed` (cas des cues récurrents). */
  markCueFired(id: string, options?: { rearm?: boolean }): Promise<Cue>;
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
  setPhotographic(id: string, value: boolean): Promise<Memory>;
}
