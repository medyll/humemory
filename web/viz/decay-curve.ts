/**
 * Courbe d'oubli d'une trace, au canvas.
 *
 * Portage de `public/js/decay-curve.js` : le tracé est repris tel quel, mais la
 * projection vient désormais de `projectDecayCurve` (src/core/decay.ts) au lieu
 * d'une copie de l'algorithme côté front. La vue montre la courbe que le système
 * applique, pas une approximation qui lui ressemble.
 */

import type { Memory, DecayLevel } from '../../src/core/types.js';
import { projectDecayCurve } from '../../src/core/decay.js';

const LEVEL_COLORS: Record<DecayLevel, string> = {
  0: '#22c55e',
  1: '#eab308',
  2: '#f97316',
  3: '#ef4444',
  4: '#6b7280',
};

const LEVEL_LABELS = ['L0', 'L1', 'L2', 'L3', 'L4'];

export interface DecayCurveOptions {
  /** Instant de référence du repère « Maintenant ». */
  now?: Date;
  daysAhead?: number;
}

export function renderDecayCurve(
  memory: Memory,
  canvas: HTMLCanvasElement,
  options: DecayCurveOptions = {}
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const { now = new Date(), daysAhead = 90 } = options;
  const { width, height } = canvas;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  const curve = projectDecayCurve(memory, daysAhead);
  const maxHours = daysAhead * 24;

  const xScale = (hours: number) => padding.left + (hours / maxHours) * chartWidth;
  const yScale = (saillance: number) => padding.top + chartHeight - (saillance / 100) * chartHeight;

  // Grille horizontale + graduations de saillance
  ctx.strokeStyle = '#3f3f4e';
  ctx.lineWidth = 1;
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = yScale(i * 25);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
    ctx.fillText(`${i * 25}`, padding.left - 8, y + 4);
  }

  // Graduations de temps
  ctx.textAlign = 'center';
  for (const day of [0, 7, 30, 60, 90]) {
    if (day > daysAhead) continue;
    ctx.fillText(`${day}j`, xScale(day * 24), height - 10);
  }

  // Repère « maintenant »
  const nowHours = (now.getTime() - new Date(memory.createdAt).getTime()) / 3600_000;
  const nowX = xScale(nowHours);

  ctx.strokeStyle = '#8b5cf6';
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(nowX, padding.top);
  ctx.lineTo(nowX, height - padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#8b5cf6';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillText('Maintenant', nowX, padding.top - 5);

  // La courbe : trait plein pour le passé, pointillé pour la projection.
  let lastLevel = -1;
  for (let i = 1; i < curve.length; i++) {
    const p0 = curve[i - 1];
    const p1 = curve[i];
    const isPast = p1.hoursElapsed <= nowHours;

    ctx.strokeStyle = LEVEL_COLORS[p1.level] ?? '#6b7280';
    ctx.lineWidth = 2;
    ctx.setLineDash(isPast ? [] : [6, 4]);

    ctx.beginPath();
    ctx.moveTo(xScale(p0.hoursElapsed), yScale(p0.saillance));
    ctx.lineTo(xScale(p1.hoursElapsed), yScale(p1.saillance));
    ctx.stroke();

    if (p1.level !== lastLevel && isPast) {
      ctx.fillStyle = LEVEL_COLORS[p1.level];
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(LEVEL_LABELS[p1.level], xScale(p1.hoursElapsed) + 4, yScale(p1.saillance) - 4);
      lastLevel = p1.level;
    }
  }
  ctx.setLineDash([]);

  // Marqueur de rappel : le moment où la trace a été réactivée.
  if (memory.lastRecalled) {
    const recallHours =
      (new Date(memory.lastRecalled).getTime() - new Date(memory.createdAt).getTime()) / 3600_000;

    if (recallHours > 0 && recallHours < maxHours) {
      const rx = xScale(recallHours);
      const ry = yScale(100);

      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(rx, ry, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '9px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('🔄 Recall', rx, ry - 10);
    }
  }

  if (memory.photographic) {
    ctx.fillStyle = 'rgba(139, 92, 246, 0.1)';
    ctx.fillRect(padding.left, padding.top, chartWidth, chartHeight);

    ctx.fillStyle = '#8b5cf6';
    ctx.font = 'bold 12px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🔒 Mode photographique — pas de dégradation', width / 2, height / 2);
  }
}
