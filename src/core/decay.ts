import type { Memory, DecayLevel } from './types.js';

/**
 * Configuration de la dégradation
 */
export const DECAY_CONFIG = {
  // Temps de base pour chaque niveau (en heures)
  levelThresholds: [0, 24, 168, 720, 2160], // 0h, 1j, 1sem, 1mois, 3mois
  
  // Facteur de ralentissement par rappel
  recallBonus: 0.3,        // Chaque rappel ajoute 30% de temps
  
  // Seuil de saillance pour ralentir la dégradation
  saillanceThreshold: 70,  // Au-dessus de 70, dégradation ralentie
  
  // Cycle de dégradation (vérification toutes les X heures)
  decayCycleHours: 24,
};

/**
 * Calcule le niveau de dégradation actuel d'un souvenir
 */
export function calculateDecayLevel(memory: Memory, now: Date = new Date()): DecayLevel {
  if (memory.photographic) {
    return 0; // Photographic mode — no decay
  }
  if (memory.currentLevel === 4 || memory.mergedIntoId) {
    return 4; // Déjà perdu/fusionné
  }
  
  const hoursSinceCreation = (now.getTime() - memory.createdAt.getTime()) / (1000 * 60 * 60);
  const hoursSinceRecall = memory.lastRecalled 
    ? (now.getTime() - memory.lastRecalled.getTime()) / (1000 * 60 * 60)
    : Infinity;
  
  // Utiliser le plus récent des deux
  const effectiveAge = Math.min(hoursSinceCreation, hoursSinceRecall);
  
  // Appliquer le bonus de rappel
  const recallMultiplier = 1 + (memory.recallCount * DECAY_CONFIG.recallBonus);
  const adjustedAge = effectiveAge / recallMultiplier;
  
  // Appliquer le bonus de saillance
  const saillanceMultiplier = memory.saillance >= DECAY_CONFIG.saillanceThreshold ? 1.5 : 1;
  const finalAge = adjustedAge / saillanceMultiplier;
  
  // Déterminer le niveau
  for (let i = 3; i >= 0; i--) {
    if (finalAge >= DECAY_CONFIG.levelThresholds[i]) {
      return i as DecayLevel;
    }
  }
  
  return 0;
}

/**
 * Calcule le score de saillance d'un souvenir
 * Basé sur : rappels récents, connexions, charge émotionnelle
 */
export function calculateSaillance(memory: Memory, now: Date = new Date()): number {
  let score = 50; // Base
  
  // Bonus pour rappels récents (dans les 7 jours)
  if (memory.lastRecalled) {
    const daysSinceRecall = (now.getTime() - memory.lastRecalled.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceRecall < 7) {
      score += 20;
    } else if (daysSinceRecall < 30) {
      score += 10;
    }
  }
  
  // Bonus pour nombre de rappels
  score += Math.min(memory.recallCount * 5, 20);
  
  // Bonus pour mots-clés (plus de tags = plus connecté)
  score += Math.min(memory.keywords.length * 3, 15);
  
  // Détection de charge émotionnelle (mots simples)
  const emotionalWords = ['important', 'urgent', 'critical', 'attention', 'wow', 'super', 'génial', 'merde', 'problème', 'erreur'];
  const contentLower = memory.content.toLowerCase();
  const hasEmotion = emotionalWords.some(word => contentLower.includes(word));
  if (hasEmotion) {
    score += 10;
  }
  
  return Math.min(score, 100);
}

/**
 * Détermine le taux de dégradation initial
 * 0.0 = très lent, 1.0 = très rapide
 */
export function calculateDecayRate(content: string, keywords: string[]): number {
  // Base rate
  let rate = 0.5;
  
  // Contenu long = dégradation plus lente (plus de détails à préserver)
  if (content.length > 500) {
    rate -= 0.1;
  } else if (content.length < 100) {
    rate += 0.1;
  }
  
  // Beaucoup de mots-clés = plus connecté = dégradation plus lente
  if (keywords.length > 5) {
    rate -= 0.1;
  }
  
  return Math.max(0.1, Math.min(1.0, rate));
}

/**
 * Met à jour tous les souvenirs d'une collection
 */
export function updateAllDecay(memories: Memory[], now: Date = new Date()): Memory[] {
  return memories.map(memory => {
    const newLevel = calculateDecayLevel(memory, now);
    const newSaillance = calculateSaillance(memory, now);
    
    // Marquer comme fusionné/perdu si niveau 4
    if (newLevel === 4 && memory.currentLevel !== 4) {
      // TODO: Logique de fusion à implémenter
      console.log(`Memory ${memory.id} marked as decayed (level 4)`);
    }
    
    return {
      ...memory,
      currentLevel: newLevel,
      saillance: newSaillance,
    };
  });
}
