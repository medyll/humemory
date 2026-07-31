/**
 * River of time — traces drift down the decay lanes.
 *
 * Ported from `public/js/river.js`. The d3 drawing is taken as is; what changes
 * is structural:
 * - levels come from `calculateDecayLevel`/`calculateSaillance`
 *   (src/core/decay.ts) rather than a front-end copy of the algorithm;
 * - the animated playback and the tooltip attached to `body` are now torn down.
 *   The original left its `setInterval` running and abandoned its tooltip in the
 *   document after a tab change.
 */

import * as d3 from 'd3';
import type { Memory } from '../../src/core/types.js';
import { calculateDecayLevel, calculateSaillance } from '../../src/core/decay.js';
import { api } from '../api/client.js';
import { LEVEL_COLORS, LEVEL_LABELS, type VizContext } from './levels.js';

const DAY_MS = 24 * 3600_000;
const HORIZON_MS = 90 * DAY_MS;

export function createMount(ctx: VizContext = {}) {
  return async function mount(container: HTMLElement): Promise<() => void> {
    container.innerHTML = '';

    const { memories } = await api.listMemories({ limit: 500 });
    const traces = memories.map((m) => ({ ...m, createdAt: new Date(m.createdAt) })) as Memory[];

    const width = container.clientWidth || 1200;
    const height = 600;
    const margin = { top: 40, right: 40, bottom: 60, left: 120 };
    const chartWidth = width - margin.left - margin.right;
    const chartHeight = height - margin.top - margin.bottom;
    const laneHeight = chartHeight / 5;

    const svg = d3.select(container).append('svg').attr('width', width).attr('height', height);
    const chart = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`);

    const dates = traces.map((m) => new Date(m.createdAt));
    const minDate = d3.min(dates) ?? new Date();
    const maxDate = d3.max(dates) ?? new Date();
    const xScale = d3
      .scaleTime()
      .domain([minDate, new Date(maxDate.getTime() + HORIZON_MS)])
      .range([0, chartWidth]);

    chart
      .append('g')
      .attr('transform', `translate(0,${chartHeight})`)
      .call(d3.axisBottom(xScale).ticks(10).tickFormat(d3.timeFormat('%d %b') as any))
      .selectAll('text')
      .style('fill', '#a1a1aa')
      .style('font-size', '11px');

    chart
      .append('g')
      .call(
        d3
          .axisLeft(d3.scaleLinear().domain([0, 5]).range([0, chartHeight]))
          .ticks(5)
          .tickFormat((i) => LEVEL_LABELS[Number(i)] ?? '') as any
      )
      .selectAll('text')
      .style('fill', '#a1a1aa')
      .style('font-size', '11px');

    for (let i = 0; i <= 5; i++) {
      chart
        .append('line')
        .attr('class', 'river-lane')
        .attr('stroke', '#262b38')
        .attr('x1', 0)
        .attr('x2', chartWidth)
        .attr('y1', i * laneHeight)
        .attr('y2', i * laneHeight);
    }

    const nowLine = chart
      .append('line')
      .attr('stroke', '#8b5cf6')
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '6 4')
      .attr('y1', 0)
      .attr('y2', chartHeight);

    const memoriesGroup = chart.append('g');

    // Tooltip: created here and removed on teardown, unlike the original.
    const tooltip = document.createElement('div');
    tooltip.className = 'river-tooltip';
    tooltip.style.display = 'none';
    document.body.appendChild(tooltip);

    let timeOffset = 0;

    function showTooltip(event: MouseEvent, d: Memory) {
      const at = new Date(Date.now() + timeOffset);
      const level = calculateDecayLevel(d, at);
      const saillance = calculateSaillance(d, at);

      tooltip.innerHTML = `
        <div style="margin-bottom:.5rem;font-weight:600;">${LEVEL_LABELS[level]}</div>
        <div style="margin-bottom:.5rem;">${d.content.slice(0, 100)}${d.content.length > 100 ? '…' : ''}</div>
        <div style="color:var(--muted);font-size:.8rem;">
          <div>Strength: ${saillance}/100</div>
          <div>Recalls: ${d.recallCount}</div>
          <div>Encoded: ${new Date(d.createdAt).toLocaleDateString()}</div>
          ${d.photographic ? '<div style="color:#8b5cf6;">🔒 Photographic</div>' : ''}
        </div>`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${event.pageX + 10}px`;
      tooltip.style.top = `${event.pageY - 10}px`;
    }

    function update(offset = 0) {
      const at = new Date(Date.now() + offset);
      nowLine.attr('x1', xScale(at)).attr('x2', xScale(at));

      const pills = memoriesGroup
        .selectAll<SVGGElement, Memory>('.river-memory')
        .data(traces, (d) => d.id);

      pills.exit().remove();

      const enter = pills
        .enter()
        .append('g')
        .attr('class', 'river-memory')
        .style('cursor', 'pointer')
        .on('click', (_e, d) => ctx.onSelectMemory?.(d.id))
        .on('mouseover', (event: MouseEvent, d) => showTooltip(event, d))
        .on('mouseout', () => {
          tooltip.style.display = 'none';
        });

      enter.append('rect').attr('rx', 6).attr('ry', 6);
      enter
        .append('text')
        .attr('font-size', '9px')
        .attr('fill', '#e4e4e7')
        .attr('text-anchor', 'middle')
        .attr('dy', '0.35em');

      enter.merge(pills).each(function (d) {
        // Simulated time advances from each trace's creation: that offset is what
        // makes traces drift from one lane to the next.
        const simulatedNow = new Date(new Date(d.createdAt).getTime() + offset);
        const level = calculateDecayLevel(d, simulatedNow);
        const saillance = calculateSaillance(d, simulatedNow);

        const x = xScale(new Date(d.createdAt));
        const y = level * laneHeight + laneHeight / 2;
        const pillWidth = Math.max(30, Math.min(80, d.content.length / 3));
        const pillHeight = 20;

        const g = d3.select(this);
        g.select('rect')
          .attr('x', x - pillWidth / 2)
          .attr('y', y - pillHeight / 2)
          .attr('width', pillWidth)
          .attr('height', pillHeight)
          .attr('fill', LEVEL_COLORS[level])
          .attr('opacity', Math.max(0.3, saillance / 100))
          .attr('stroke', d.photographic ? '#8b5cf6' : 'none')
          .attr('stroke-width', d.photographic ? 2 : 0);

        g.select('text').attr('x', x).attr('y', y).text(d.content.slice(0, 12));
      });
    }

    update(0);

    // ── Playback controls ───────────────────────────────────────────────────
    const controls = document.createElement('div');
    controls.className = 'river-controls';
    controls.innerHTML = `
      <button type="button" data-role="play">▶ Play</button>
      <input type="range" data-role="slider" min="0" max="${HORIZON_MS}" value="0" step="${3600_000}">
      <span data-role="label">Today</span>
      <button type="button" data-role="reset">↺ Reset</button>`;
    container.appendChild(controls);

    const slider = controls.querySelector<HTMLInputElement>('[data-role="slider"]')!;
    const label = controls.querySelector<HTMLElement>('[data-role="label"]')!;
    const playBtn = controls.querySelector<HTMLButtonElement>('[data-role="play"]')!;
    const resetBtn = controls.querySelector<HTMLButtonElement>('[data-role="reset"]')!;

    let timer: ReturnType<typeof setInterval> | null = null;

    const setOffset = (value: number) => {
      timeOffset = value;
      slider.value = String(value);
      const days = Math.floor(value / DAY_MS);
      label.textContent = days === 0 ? 'Today' : `D+${days} days`;
      update(value);
    };

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
      playBtn.textContent = '▶ Play';
    };

    slider.addEventListener('input', () => setOffset(Number(slider.value)));

    playBtn.addEventListener('click', () => {
      if (timer) {
        stop();
        return;
      }
      playBtn.textContent = '⏸ Pause';
      timer = setInterval(() => setOffset(timeOffset >= HORIZON_MS ? 0 : timeOffset + DAY_MS), 200);
    });

    resetBtn.addEventListener('click', () => {
      stop();
      setOffset(0);
    });

    return () => {
      stop();
      tooltip.remove();
      container.innerHTML = '';
    };
  };
}
