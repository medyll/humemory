import type { Memory, DecayLevel } from './types.js';

/**
 * Decay configuration.
 */
export const DECAY_CONFIG = {
  // Base time for each level, in hours
  levelThresholds: [0, 24, 168, 720, 2160], // 0h, 1j, 1sem, 1mois, 3mois
  
  // How much each recall slows decay
  recallBonus: 0.3,        // every recall adds 30% more time
  
  // Salience threshold above which decay slows down
  saillanceThreshold: 70,

  // Phase 6.0.1 — verified traces age more slowly
  verifiedMultiplier: 1.5,

  // Phase 6.0.1 / Claude R3-B8 — cap on the PRODUCT of all slowdown
  // multipliers (recall × salience × verified). Without this, the unbounded
  // `1 + recallCount * recallBonus` term makes verified+salient+recalled
  // traces effectively photographic — which is not forgetting.
  maxTotalSlowdown: 2.5,

  // Phase 6.0.2 — contradiction collapse (Kimi B9, accepted by Claude R3):
  // first refutation divides saillance by `contradictionDivisor`, further ones
  // by `refuteDivisor` (cap `refuteCap` refutations), never below the floor.
  contradictionDivisor: 4,
  refuteDivisor: 2,
  refuteCap: 3,
  contradictionFloor: 5,
  
  // Decay cycle: how often the sweep runs, in hours
  decayCycleHours: 24,
};

/**
 * Current decay level of a trace.
 */
export function calculateDecayLevel(memory: Memory, now: Date = new Date()): DecayLevel {
  if (memory.photographic) {
    return 0; // Photographic mode — no decay
  }
  if (memory.currentLevel === 4 || memory.mergedIntoId) {
    return 4; // already lost or merged
  }
  
  const hoursSinceCreation = (now.getTime() - memory.createdAt.getTime()) / (1000 * 60 * 60);
  const hoursSinceRecall = memory.lastRecalled 
    ? (now.getTime() - memory.lastRecalled.getTime()) / (1000 * 60 * 60)
    : Infinity;
  
  // Use whichever of the two is more recent
  const effectiveAge = Math.min(hoursSinceCreation, hoursSinceRecall);
  
  // Appliquer le bonus de rappel
  const recallMultiplier = 1 + (memory.recallCount * DECAY_CONFIG.recallBonus);

  // Appliquer le bonus de saillance
  const saillanceMultiplier = memory.saillance >= DECAY_CONFIG.saillanceThreshold ? 1.5 : 1;

  // Phase 6.0.1 — le bonus de vérification
  const verifiedMultiplier = memory.verified ? DECAY_CONFIG.verifiedMultiplier : 1;

  // Cap on the PRODUCT (R3/B8): the unbounded recall term counts toward it.
  const totalSlowdown = Math.min(
    recallMultiplier * saillanceMultiplier * verifiedMultiplier,
    DECAY_CONFIG.maxTotalSlowdown
  );
  const finalAge = effectiveAge / totalSlowdown;
  
  // Determine the level
  for (let i = 3; i >= 0; i--) {
    if (finalAge >= DECAY_CONFIG.levelThresholds[i]) {
      return i as DecayLevel;
    }
  }
  
  return 0;
}

/**
 * Salience score of a trace.
 * Based on recent recalls, connections and emotional charge.
 */
export function calculateSaillance(memory: Memory, now: Date = new Date()): number {
  let score = 50; // baseline
  
  // Bonus for recent recalls (within 7 days)
  if (memory.lastRecalled) {
    const daysSinceRecall = (now.getTime() - memory.lastRecalled.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceRecall < 7) {
      score += 20;
    } else if (daysSinceRecall < 30) {
      score += 10;
    }
  }
  
  // Bonus for how often it was recalled
  score += Math.min(memory.recallCount * 5, 20);
  
  // Bonus for keywords: more tags means better connected
  score += Math.min(memory.keywords.length * 3, 15);
  
  // Crude emotional-charge detection. The list stays bilingual on purpose: traces
  // are written in whatever language the developer works in, and dropping the
  // French markers would silently weaken salience on French content.
  const emotionalWords = [
    'important', 'urgent', 'critical', 'attention', 'wow', 'awesome', 'damn', 'problem', 'error', 'broken',
    'génial', 'merde', 'problème', 'erreur', 'super',
  ];
  const contentLower = memory.content.toLowerCase();
  const hasEmotion = emotionalWords.some(word => contentLower.includes(word));
  if (hasEmotion) {
    score += 10;
  }
  
  return Math.min(score, 100);
}

/**
 * Initial decay rate.
 * 0.0 = very slow, 1.0 = very fast.
 */
export function calculateDecayRate(content: string, keywords: string[]): number {
  // Base rate
  let rate = 0.5;
  
  // Long content decays more slowly: there is more detail worth keeping
  if (content.length > 500) {
    rate -= 0.1;
  } else if (content.length < 100) {
    rate += 0.1;
  }
  
  // Many keywords means better connected, so slower decay
  if (keywords.length > 5) {
    rate -= 0.1;
  }
  
  return Math.max(0.1, Math.min(1.0, rate));
}

export interface DecayCurvePoint {
  time: Date;
  level: DecayLevel;
  saillance: number;
  hoursElapsed: number;
}

/**
 * Projects a trace's forgetting curve over `daysAhead` days, one point every six
 * hours.
 *
 * It lives here, next to the rules it samples, rather than in the visualisation
 * code: a curve drawn from a diverging copy of the algorithm would tell a story
 * the system does not actually live.
 */
export function projectDecayCurve(memory: Memory, daysAhead = 90): DecayCurvePoint[] {
  const points: DecayCurvePoint[] = [];
  const createdAt = new Date(memory.createdAt).getTime();
  const totalMs = daysAhead * 24 * 3600_000;
  const stepMs = 6 * 3600_000;

  for (let t = 0; t <= totalMs; t += stepMs) {
    const at = new Date(createdAt + t);
    points.push({
      time: at,
      level: calculateDecayLevel(memory, at),
      saillance: calculateSaillance(memory, at),
      hoursElapsed: t / 3600_000,
    });
  }

  return points;
}

/**
 * Updates every trace in a collection.
 */
export function updateAllDecay(memories: Memory[], now: Date = new Date()): Memory[] {
  return memories.map(memory => {
    const newLevel = calculateDecayLevel(memory, now);
    const newSaillance = calculateSaillance(memory, now);
    
    // Mark as lost/merged once level 4 is reached
    if (newLevel === 4 && memory.currentLevel !== 4) {
      // TODO: merging logic still to implement
      console.log(`Memory ${memory.id} marked as decayed (level 4)`);
    }
    
    return {
      ...memory,
      currentLevel: newLevel,
      saillance: newSaillance,
    };
  });
}
