let riverMemories = [];
let riverSimulation = null;
let riverTimeOffset = 0;
let riverPlaying = false;
let riverPlayInterval = null;

const LEVEL_COLORS = {
  0: '#22c55e',
  1: '#eab308',
  2: '#f97316',
  3: '#ef4444',
  4: '#6b7280',
};

const LEVEL_LABELS = ['L0 — Encodage', 'L1 — Consolidation', 'L2 — Stable', 'L3 — Fragile', 'L4 — Sommeil'];

async function initRiver() {
  const container = document.getElementById('riverCanvas');
  if (!container) return;

  container.innerHTML = '';

  try {
    riverMemories = await fetchMemories({ limit: 500 });

    const width = container.clientWidth || 1200;
    const height = 600;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height);

    const margin = { top: 40, right: 40, bottom: 60, left: 120 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    const laneHeight = chartHeight / 5;

    const chart = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const dates = riverMemories.map(m => new Date(m.createdAt));
    const minDate = d3.min(dates);
    const maxDate = d3.max(dates);
    const timeRange = maxDate - minDate;
    const futureDate = new Date(maxDate.getTime() + 90 * 24 * 60 * 60 * 1000);

    const xScale = d3.scaleTime()
      .domain([minDate, futureDate])
      .range([0, chartWidth]);

    const xAxis = d3.axisBottom(xScale)
      .ticks(10)
      .tickFormat(d3.timeFormat('%d %b'));

    chart.append('g')
      .attr('transform', `translate(0,${chartHeight})`)
      .call(xAxis)
      .selectAll('text')
      .style('fill', '#a1a1aa')
      .style('font-size', '11px');

    chart.append('g')
      .call(d3.axisLeft(d3.scaleLinear().domain([0, 5]).range([0, chartHeight])).ticks(5).tickFormat(i => LEVEL_LABELS[i] || ''))
      .selectAll('text')
      .style('fill', '#a1a1aa')
      .style('font-size', '11px');

    for (let i = 0; i <= 5; i++) {
      chart.append('line')
        .attr('class', 'river-lane')
        .attr('x1', 0)
        .attr('x2', chartWidth)
        .attr('y1', i * laneHeight)
        .attr('y2', i * laneHeight);
    }

    const nowLine = chart.append('line')
      .attr('class', 'now-line')
      .attr('stroke', '#8b5cf6')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '6 4')
      .attr('y1', 0)
      .attr('y2', chartHeight);

    const memoriesGroup = chart.append('g').attr('class', 'memories-group');

    function updateRiver(timeOffset = 0) {
      const now = new Date(Date.now() + timeOffset);
      nowLine.attr('x1', xScale(now)).attr('x2', xScale(now));

      const pills = memoriesGroup.selectAll('.river-memory')
        .data(riverMemories, d => d.id);

      pills.exit().remove();

      const enter = pills.enter()
        .append('g')
        .attr('class', 'river-memory')
        .on('click', (event, d) => {
          showRiverDetail(d);
        })
        .on('mouseover', (event, d) => {
          showRiverTooltip(event, d);
        })
        .on('mouseout', () => {
          hideRiverTooltip();
        });

      enter.append('rect')
        .attr('rx', 6)
        .attr('ry', 6);

      enter.append('text')
        .attr('font-size', '9px')
        .attr('fill', '#e4e4e7')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em');

      const merged = enter.merge(pills);

      merged.each(function(d) {
        const simulatedNow = new Date(new Date(d.createdAt).getTime() + timeOffset);
        const level = calculateDecayLevel(d, simulatedNow);
        const saillance = calculateSaillance(d, simulatedNow);
        const x = xScale(new Date(d.createdAt));
        const y = level * laneHeight + laneHeight / 2;
        const pillWidth = Math.max(30, Math.min(80, d.content.length / 3));
        const pillHeight = 20;
        const opacity = Math.max(0.3, saillance / 100);

        const g = d3.select(this);

        g.select('rect')
          .attr('x', x - pillWidth / 2)
          .attr('y', y - pillHeight / 2)
          .attr('width', pillWidth)
          .attr('height', pillHeight)
          .attr('fill', LEVEL_COLORS[level])
          .attr('opacity', opacity)
          .attr('stroke', d.photographic ? '#8b5cf6' : 'none')
          .attr('stroke-width', d.photographic ? 2 : 0);

        g.select('text')
          .attr('x', x)
          .attr('y', y)
          .text(d.content.slice(0, 12));
      });
    }

    updateRiver(0);

    const controls = document.createElement('div');
    controls.className = 'river-controls';
    controls.innerHTML = `
      <button id="riverPlayBtn">▶ Play</button>
      <input type="range" id="riverSlider" min="0" max="${90 * 24 * 60 * 60 * 1000}" value="0" step="${60 * 60 * 1000}">
      <span id="riverTimeLabel">Aujourd'hui</span>
      <button id="riverResetBtn">↺ Reset</button>
    `;
    container.appendChild(controls);

    const slider = document.getElementById('riverSlider');
    const timeLabel = document.getElementById('riverTimeLabel');
    const playBtn = document.getElementById('riverPlayBtn');
    const resetBtn = document.getElementById('riverResetBtn');

    slider.addEventListener('input', () => {
      riverTimeOffset = parseInt(slider.value);
      updateRiver(riverTimeOffset);
      const days = Math.floor(riverTimeOffset / (24 * 60 * 60 * 1000));
      timeLabel.textContent = days === 0 ? "Aujourd'hui" : `J+${days} jours`;
    });

    playBtn.addEventListener('click', () => {
      if (riverPlaying) {
        clearInterval(riverPlayInterval);
        riverPlaying = false;
        playBtn.textContent = '▶ Play';
      } else {
        riverPlaying = true;
        playBtn.textContent = '⏸ Pause';
        riverPlayInterval = setInterval(() => {
          riverTimeOffset += 24 * 60 * 60 * 1000;
          if (riverTimeOffset > 90 * 24 * 60 * 60 * 1000) {
            riverTimeOffset = 0;
          }
          slider.value = riverTimeOffset;
          updateRiver(riverTimeOffset);
          const days = Math.floor(riverTimeOffset / (24 * 60 * 60 * 1000));
          timeLabel.textContent = days === 0 ? "Aujourd'hui" : `J+${days} jours`;
        }, 200);
      }
    });

    resetBtn.addEventListener('click', () => {
      riverTimeOffset = 0;
      slider.value = 0;
      updateRiver(0);
      timeLabel.textContent = "Aujourd'hui";
      if (riverPlaying) {
        clearInterval(riverPlayInterval);
        riverPlaying = false;
        playBtn.textContent = '▶ Play';
      }
    });

    function showRiverTooltip(event, d) {
      let tooltip = document.getElementById('riverTooltip');
      if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = 'riverTooltip';
        tooltip.className = 'river-tooltip';
        document.body.appendChild(tooltip);
      }

      const now = new Date(Date.now() + riverTimeOffset);
      const level = calculateDecayLevel(d, now);
      const saillance = calculateSaillance(d, now);

      tooltip.innerHTML = `
        <div style="margin-bottom: 0.5rem; font-weight: 600;">${LEVEL_LABELS[level]}</div>
        <div style="margin-bottom: 0.5rem;">${d.content.slice(0, 100)}${d.content.length > 100 ? '…' : ''}</div>
        <div style="color: var(--text-muted); font-size: 0.8rem;">
          <div>Force: ${saillance}/100</div>
          <div>Rappels: ${d.recallCount}</div>
          <div>Encodé: ${new Date(d.createdAt).toLocaleDateString('fr-FR')}</div>
          ${d.photographic ? '<div style="color: #8b5cf6;">🔒 Photographique</div>' : ''}
        </div>
      `;

      tooltip.style.display = 'block';
      tooltip.style.left = (event.pageX + 10) + 'px';
      tooltip.style.top = (event.pageY - 10) + 'px';
    }

    function hideRiverTooltip() {
      const tooltip = document.getElementById('riverTooltip');
      if (tooltip) tooltip.style.display = 'none';
    }

    function showRiverDetail(d) {
      currentMemories = [d];
      showDetail(d.id);
    }

  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Erreur</h3><p>${error.message}</p></div>`;
  }
}
