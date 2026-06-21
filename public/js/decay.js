const DECAY_CONFIG = {
  levelThresholds: [0, 24, 168, 720, 2160],
  recallBonus: 0.3,
  saillanceThreshold: 70,
  decayCycleHours: 24,
};

function calculateDecayLevel(memory, now = new Date()) {
  if (memory.photographic) return 0;
  if (memory.currentLevel === 4 || memory.mergedIntoId) return 4;

  const createdAt = new Date(memory.createdAt).getTime();
  const lastRecalled = memory.lastRecalled ? new Date(memory.lastRecalled).getTime() : null;

  const hoursSinceCreation = (now.getTime() - createdAt) / (1000 * 60 * 60);
  const hoursSinceRecall = lastRecalled
    ? (now.getTime() - lastRecalled) / (1000 * 60 * 60)
    : Infinity;

  const effectiveAge = Math.min(hoursSinceCreation, hoursSinceRecall);
  const recallMultiplier = 1 + (memory.recallCount * DECAY_CONFIG.recallBonus);
  const adjustedAge = effectiveAge / recallMultiplier;
  const saillanceMultiplier = memory.saillance >= DECAY_CONFIG.saillanceThreshold ? 1.5 : 1;
  const finalAge = adjustedAge / saillanceMultiplier;

  for (let i = 3; i >= 0; i--) {
    if (finalAge >= DECAY_CONFIG.levelThresholds[i]) {
      return i;
    }
  }
  return 0;
}

function calculateSaillance(memory, now = new Date()) {
  let score = 50;

  if (memory.lastRecalled) {
    const daysSinceRecall = (now.getTime() - new Date(memory.lastRecalled).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceRecall < 7) {
      score += 20;
    } else if (daysSinceRecall < 30) {
      score += 10;
    }
  }

  score += Math.min(memory.recallCount * 5, 20);
  score += Math.min((memory.keywords || []).length * 3, 15);

  const emotionalWords = ['important', 'urgent', 'critical', 'attention', 'wow', 'super', 'génial', 'merde', 'problème', 'erreur'];
  const contentLower = memory.content.toLowerCase();
  const hasEmotion = emotionalWords.some(word => contentLower.includes(word));
  if (hasEmotion) score += 10;

  return Math.min(score, 100);
}

function calculateDecayRate(content, keywords) {
  let rate = 0.5;
  if (content.length > 500) rate -= 0.1;
  else if (content.length < 100) rate += 0.1;
  if (keywords && keywords.length > 5) rate -= 0.1;
  return Math.max(0.1, Math.min(1.0, rate));
}

function projectDecayCurve(memory, daysAhead = 90) {
  const points = [];
  const createdAt = new Date(memory.createdAt).getTime();
  const totalMs = daysAhead * 24 * 60 * 60 * 1000;
  const stepMs = 6 * 60 * 60 * 1000;

  for (let t = 0; t <= totalMs; t += stepMs) {
    const now = new Date(createdAt + t);
    const simulatedMemory = {
      ...memory,
      createdAt: memory.createdAt,
    };
    const level = calculateDecayLevel(simulatedMemory, now);
    const saillance = calculateSaillance(simulatedMemory, now);
    points.push({
      time: now,
      level,
      saillance,
      hoursElapsed: t / (1000 * 60 * 60),
    });
  }
  return points;
}
