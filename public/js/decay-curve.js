function renderDecayCurve(memory, canvas) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const padding = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  ctx.clearRect(0, 0, width, height);

  const colors = {
    0: '#22c55e',
    1: '#eab308',
    2: '#f97316',
    3: '#ef4444',
    4: '#6b7280',
  };

  const curve = projectDecayCurve(memory, 90);

  const xScale = (hours) => {
    const maxHours = 90 * 24;
    return padding.left + (hours / maxHours) * chartWidth;
  };

  const yScale = (saillance) => {
    return padding.top + chartHeight - (saillance / 100) * chartHeight;
  };

  ctx.strokeStyle = '#3f3f4e';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = yScale(i * 25);
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  ctx.fillStyle = '#a1a1aa';
  ctx.font = '11px -apple-system, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = yScale(i * 25);
    ctx.fillText(`${i * 25}`, padding.left - 8, y + 4);
  }

  ctx.textAlign = 'center';
  const dayMarks = [0, 7, 30, 60, 90];
  dayMarks.forEach(day => {
    const hours = day * 24;
    const x = xScale(hours);
    ctx.fillText(`${day}j`, x, height - 10);
  });

  const nowHours = (Date.now() - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60);
  const nowX = xScale(nowHours);

  ctx.strokeStyle = '#8b5cf6';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(nowX, padding.top);
  ctx.lineTo(nowX, height - padding.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = '#8b5cf6';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Maintenant', nowX, padding.top - 5);

  let lastLevel = -1;
  for (let i = 1; i < curve.length; i++) {
    const p0 = curve[i - 1];
    const p1 = curve[i];

    const x0 = xScale(p0.hoursElapsed);
    const y0 = yScale(p0.saillance);
    const x1 = xScale(p1.hoursElapsed);
    const y1 = yScale(p1.saillance);

    const isPast = p1.hoursElapsed <= nowHours;

    ctx.strokeStyle = colors[p1.level] || '#6b7280';
    ctx.lineWidth = 2;

    if (!isPast) {
      ctx.setLineDash([6, 4]);
    } else {
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();

    if (p1.level !== lastLevel && isPast) {
      const thresholdHours = [0, 24, 168, 720, 2160];
      const label = ['L0', 'L1', 'L2', 'L3', 'L4'][p1.level];
      ctx.fillStyle = colors[p1.level];
      ctx.font = 'bold 10px -apple-system, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(label, x1 + 4, y1 - 4);
      lastLevel = p1.level;
    }
  }

  ctx.setLineDash([]);

  if (memory.lastRecalled) {
    const recallHours = (new Date(memory.lastRecalled).getTime() - new Date(memory.createdAt).getTime()) / (1000 * 60 * 60);
    if (recallHours > 0 && recallHours < 90 * 24) {
      const rx = xScale(recallHours);
      const ry = yScale(100);

      ctx.fillStyle = '#06b6d4';
      ctx.beginPath();
      ctx.arc(rx, ry, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#06b6d4';
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
