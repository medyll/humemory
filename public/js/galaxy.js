let galaxyMemories = [];
let galaxySimulation = null;

async function initGalaxy() {
  const container = document.getElementById('galaxyCanvas');
  if (!container) return;

  container.innerHTML = '';

  try {
    galaxyMemories = await fetchMemories({ limit: 500 });

    const width = container.clientWidth || 1200;
    const height = 700;

    const svg = d3.select(container)
      .append('svg')
      .attr('width', width)
      .attr('height', height);

    const legend = document.createElement('div');
    legend.className = 'galaxy-legend';
    legend.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 0.5rem;">Niveaux de decay</div>
      ${Object.entries(LEVEL_COLORS).map(([level, color]) => `
        <div class="galaxy-legend-item">
          <div class="galaxy-legend-dot" style="background: ${color};"></div>
          <span>L${level} — ${LEVEL_LABELS[level].split('—')[1].trim()}</span>
        </div>
      `).join('')}
      <div style="margin-top: 1rem; font-size: 0.8rem; color: var(--text-muted);">
        Taille = force mnésique<br>
        Position = lieu mental
      </div>
    `;
    container.appendChild(legend);

    const directories = [...new Set(galaxyMemories.map(m => m.directory))];
    const dirCenters = {};
    const angleStep = (2 * Math.PI) / directories.length;
    const radius = Math.min(width, height) * 0.3;

    directories.forEach((dir, i) => {
      const angle = i * angleStep;
      dirCenters[dir] = {
        x: width / 2 + radius * Math.cos(angle),
        y: height / 2 + radius * Math.sin(angle),
      };
    });

    const links = [];
    galaxyMemories.forEach(m => {
      if (m.mergedIntoId) {
        const target = galaxyMemories.find(t => t.id === m.mergedIntoId);
        if (target) {
          links.push({ source: m.id, target: m.mergedIntoId });
        }
      }
    });

    const nodes = galaxyMemories.map(m => ({
      id: m.id,
      directory: m.directory,
      saillance: m.saillance,
      level: m.currentLevel,
      photographic: m.photographic,
      content: m.content,
      recallCount: m.recallCount,
      createdAt: m.createdAt,
      memory: m,
    }));

    const simulation = d3.forceSimulation(nodes)
      .force('link', d3.forceLink(links).id(d => d.id).distance(50))
      .force('charge', d3.forceManyBody().strength(-30))
      .force('x', d3.forceX(d => dirCenters[d.directory]?.x || width / 2).strength(0.1))
      .force('y', d3.forceY(d => dirCenters[d.directory]?.y || height / 2).strength(0.1))
      .force('collision', d3.forceCollide().radius(d => Math.max(5, d.saillance / 10)));

    const chart = svg.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.3, 5])
      .on('zoom', (event) => {
        chart.attr('transform', event.transform);
      });

    svg.call(zoom);

    const linkElements = chart.append('g')
      .selectAll('line')
      .data(links)
      .enter()
      .append('line')
      .attr('class', 'galaxy-link')
      .attr('stroke-opacity', 0.3);

    const nodeElements = chart.append('g')
      .selectAll('circle')
      .data(nodes)
      .enter()
      .append('circle')
      .attr('class', 'galaxy-node')
      .attr('r', d => Math.max(4, d.saillance / 8))
      .attr('fill', d => LEVEL_COLORS[d.level])
      .attr('opacity', d => Math.max(0.4, d.saillance / 100))
      .attr('stroke', d => d.photographic ? '#8b5cf6' : 'none')
      .attr('stroke-width', d => d.photographic ? 2 : 0)
      .on('click', (event, d) => {
        showGalaxyDetail(d);
      })
      .on('mouseover', (event, d) => {
        d3.select(event.target)
          .transition()
          .duration(200)
          .attr('r', Math.max(6, d.saillance / 6));
      })
      .on('mouseout', (event, d) => {
        d3.select(event.target)
          .transition()
          .duration(200)
          .attr('r', Math.max(4, d.saillance / 8));
      })
      .call(d3.drag()
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
        }));

    simulation.on('tick', () => {
      linkElements
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      nodeElements
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);
    });

    galaxySimulation = simulation;

    const dirLabels = chart.append('g')
      .selectAll('text')
      .data(directories)
      .enter()
      .append('text')
      .attr('x', d => dirCenters[d].x)
      .attr('y', d => dirCenters[d].y - radius * 0.15)
      .attr('text-anchor', 'middle')
      .attr('fill', '#a1a1aa')
      .attr('font-size', '12px')
      .attr('font-weight', '600')
      .text(d => d.split('/').pop() || d);

    function showGalaxyDetail(d) {
      currentMemories = [d.memory];
      showDetail(d.id);
    }

  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Erreur</h3><p>${error.message}</p></div>`;
  }
}
