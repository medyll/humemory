/**
 * Galaxie mnésique — graphe force-directed d3.
 *
 * Portage de `public/js/galaxy.js`. Le tracé d3 est repris tel quel : d3 possède
 * son sous-arbre SVG, le réécrire en JSX n'apporterait rien. Trois choses
 * changent, toutes structurelles : le module est un ESM (plus de globales), il
 * reçoit son conteneur au lieu de le chercher par id, et il rend une fonction de
 * démontage — sans elle, la simulation continuerait de tourner après un
 * changement d'onglet.
 */

import * as d3 from 'd3';
import type { Memory } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { LEVEL_COLORS, levelName, LEVEL_LABELS, type VizContext } from './levels.js';

interface GalaxyNode extends d3.SimulationNodeDatum {
  id: string;
  directory: string;
  saillance: number;
  level: Memory['currentLevel'];
  photographic?: boolean;
  memory: Memory;
}

interface GalaxyLink extends d3.SimulationLinkDatum<GalaxyNode> {
  source: string | GalaxyNode;
  target: string | GalaxyNode;
}

export function createMount(ctx: VizContext = {}) {
  return async function mount(container: HTMLElement): Promise<() => void> {
    container.innerHTML = '';

    const { memories } = await api.listMemories({ limit: 500 });

    const width = container.clientWidth || 1200;
    const height = 700;

    const svg = d3.select(container).append('svg').attr('width', width).attr('height', height);

    const legend = document.createElement('div');
    legend.className = 'galaxy-legend';
    legend.innerHTML = `
      <div style="font-weight:600;margin-bottom:.5rem;">Niveaux de decay</div>
      ${LEVEL_LABELS.map(
        (_, level) => `
        <div class="galaxy-legend-item">
          <div class="galaxy-legend-dot" style="background:${LEVEL_COLORS[level as 0]};"></div>
          <span>L${level} — ${levelName(level as 0)}</span>
        </div>`
      ).join('')}
      <div style="margin-top:1rem;font-size:.8rem;color:var(--muted);">
        Taille = force mnésique<br>Position = lieu mental
      </div>`;
    container.appendChild(legend);

    // Un cercle de « lieux mentaux » : chaque répertoire attire ses traces.
    const directories = [...new Set(memories.map((m) => m.directory))];
    const radius = Math.min(width, height) * 0.3;
    const angleStep = (2 * Math.PI) / Math.max(1, directories.length);

    const dirCenters: Record<string, { x: number; y: number }> = {};
    directories.forEach((dir, i) => {
      dirCenters[dir] = {
        x: width / 2 + radius * Math.cos(i * angleStep),
        y: height / 2 + radius * Math.sin(i * angleStep),
      };
    });

    const nodes: GalaxyNode[] = memories.map((m) => ({
      id: m.id,
      directory: m.directory,
      saillance: m.saillance,
      level: m.currentLevel,
      photographic: m.photographic,
      memory: m,
    }));

    // Une arête par fusion : la trace absorbée reste reliée à celle qui l'a reprise.
    const links: GalaxyLink[] = memories
      .filter((m) => m.mergedIntoId && memories.some((t) => t.id === m.mergedIntoId))
      .map((m) => ({ source: m.id, target: m.mergedIntoId! }));

    const simulation = d3
      .forceSimulation(nodes)
      .force('link', d3.forceLink<GalaxyNode, GalaxyLink>(links).id((d) => d.id).distance(50))
      .force('charge', d3.forceManyBody().strength(-30))
      .force('x', d3.forceX<GalaxyNode>((d) => dirCenters[d.directory]?.x ?? width / 2).strength(0.1))
      .force('y', d3.forceY<GalaxyNode>((d) => dirCenters[d.directory]?.y ?? height / 2).strength(0.1))
      .force('collision', d3.forceCollide<GalaxyNode>().radius((d) => Math.max(5, d.saillance / 10)));

    const chart = svg.append('g');

    svg.call(
      d3.zoom<SVGSVGElement, unknown>().scaleExtent([0.3, 5]).on('zoom', (event) => {
        chart.attr('transform', event.transform);
      }) as any
    );

    const linkElements = chart
      .append('g')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('class', 'galaxy-link')
      .attr('stroke', '#3f3f4e')
      .attr('stroke-opacity', 0.3);

    const nodeElements = chart
      .append('g')
      .selectAll<SVGCircleElement, GalaxyNode>('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('class', 'galaxy-node')
      .attr('r', (d) => Math.max(4, d.saillance / 8))
      .attr('fill', (d) => LEVEL_COLORS[d.level])
      .attr('opacity', (d) => Math.max(0.4, d.saillance / 100))
      .attr('stroke', (d) => (d.photographic ? '#8b5cf6' : 'none'))
      .attr('stroke-width', (d) => (d.photographic ? 2 : 0))
      .style('cursor', 'pointer')
      .on('click', (_event, d) => ctx.onSelectMemory?.(d.id))
      .on('mouseover', (event: MouseEvent, d) => {
        d3.select(event.target as SVGCircleElement)
          .transition()
          .duration(200)
          .attr('r', Math.max(6, d.saillance / 6));
      })
      .on('mouseout', (event: MouseEvent, d) => {
        d3.select(event.target as SVGCircleElement)
          .transition()
          .duration(200)
          .attr('r', Math.max(4, d.saillance / 8));
      })
      .call(
        d3
          .drag<SVGCircleElement, GalaxyNode>()
          .on('start', (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on('end', (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    chart
      .append('g')
      .selectAll('text')
      .data(directories)
      .enter()
      .append('text')
      .attr('x', (d) => dirCenters[d].x)
      .attr('y', (d) => dirCenters[d].y - radius * 0.15)
      .attr('text-anchor', 'middle')
      .attr('fill', '#a1a1aa')
      .attr('font-size', '12px')
      .attr('font-weight', '600')
      .text((d) => d.split(/[\\/]/).pop() || d);

    simulation.on('tick', () => {
      linkElements
        .attr('x1', (d) => (d.source as GalaxyNode).x!)
        .attr('y1', (d) => (d.source as GalaxyNode).y!)
        .attr('x2', (d) => (d.target as GalaxyNode).x!)
        .attr('y2', (d) => (d.target as GalaxyNode).y!);

      nodeElements.attr('cx', (d) => d.x!).attr('cy', (d) => d.y!);
    });

    // La simulation tourne en continu : sans arrêt explicite, elle survivrait au
    // démontage du composant et continuerait de consommer du CPU.
    return () => {
      simulation.stop();
      container.innerHTML = '';
    };
  };
}
