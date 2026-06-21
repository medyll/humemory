let currentMemories = [];
let searchTimeout;
let currentZone = null;

const ZONES = {
  encoding: { label: 'Encodage récent', maxHours: 24 },
  consolidating: { label: 'En consolidation', maxHours: 24 * 7 },
  consolidated: { label: 'Consolidé', maxHours: 24 * 30 },
  fragile: { label: 'Fragile', maxHours: 24 * 90 },
  dormant: { label: 'En sommeil', maxHours: Infinity }
};

function getMemoryZone(createdAt, currentLevel, saillance) {
  const hours = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
  if (currentLevel === 4) return 'dormant';
  if (saillance < 30) return 'fragile';
  if (hours < ZONES.encoding.maxHours) return 'encoding';
  if (hours < ZONES.consolidating.maxHours) return 'consolidating';
  if (hours < ZONES.consolidated.maxHours) return 'consolidated';
  if (hours < ZONES.fragile.maxHours) return 'fragile';
  return 'dormant';
}

function getConsolidationLevel(currentLevel) {
  const labels = ['Encodage', 'Consolidation', 'Stable', 'Fragile', 'Sommeil'];
  return labels[currentLevel] || 'Inconnu';
}

async function loadMemories() {
  const container = document.getElementById('memoryContainer');
  container.innerHTML = '<div class="loading">Chargement des traces mnésiques...</div>';

  try {
    currentMemories = await fetchMemories({ limit: 1000 });
    updateContextFilter(currentMemories);

    const sortBy = document.getElementById('sortBy').value;
    if (sortBy === 'force') {
      currentMemories.sort((a, b) => b.saillance - a.saillance);
    } else if (sortBy === 'reactivations') {
      currentMemories.sort((a, b) => b.recallCount - a.recallCount);
    } else {
      currentMemories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    groupAndRender(currentMemories);
    updateTemporalZones(currentMemories);
  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Erreur de récupération</h3><p>${error.message}</p></div>`;
  }
}

function updateContextFilter(memories) {
  const contexts = [...new Set(memories.map(m => m.directory))];
  const select = document.getElementById('contextFilter');
  if (contexts.length === 0) return;
  select.innerHTML = '<option value="">Tous les contextes</option>' +
    contexts.map(c => `<option value="${c}">${c}</option>`).join('');
}

function groupAndRender(memories) {
  const container = document.getElementById('memoryContainer');

  if (currentZone) {
    memories = memories.filter(m => getMemoryZone(m.createdAt, m.currentLevel, m.saillance) === currentZone);
  }

  const typeFilter = document.getElementById('typeFilter').value;
  if (typeFilter) memories = memories.filter(m => m.memoryType === typeFilter);

  const contextFilter = document.getElementById('contextFilter').value;
  if (contextFilter) memories = memories.filter(m => m.directory === contextFilter);

  const minS = parseInt(document.getElementById('filterMinSaillance').value);
  const minR = parseInt(document.getElementById('filterMinRecalls').value);
  const fromVal = document.getElementById('filterFrom').value;
  const toVal = document.getElementById('filterTo').value;
  const photoOnly = document.getElementById('filterPhotographic').checked;
  if (!isNaN(minS) && minS > 0) memories = memories.filter(m => m.saillance >= minS);
  if (!isNaN(minR) && minR > 0) memories = memories.filter(m => m.recallCount >= minR);
  if (fromVal) memories = memories.filter(m => m.day >= fromVal);
  if (toVal) memories = memories.filter(m => m.day <= toVal);
  if (photoOnly) memories = memories.filter(m => m.photographic);

  if (memories.length === 0) {
    container.innerHTML = `<div class="empty-state"><h3>Aucune trace mnésique</h3><p>Commencez par encoder votre premier souvenir</p></div>`;
    return;
  }

  const byContext = {};
  memories.forEach(m => {
    if (!byContext[m.directory]) byContext[m.directory] = [];
    byContext[m.directory].push(m);
  });

  container.innerHTML = Object.entries(byContext).map(([context, mems]) => `
    <div class="context-section">
      <div class="context-header">
        <span class="context-icon">📍</span>
        <h2>${context}</h2>
        <span style="color: var(--text-muted); font-size: 0.9rem;">${mems.length} trace${mems.length > 1 ? 's' : ''}</span>
      </div>
      <div class="memory-list">
        ${mems.map(m => renderMemoryItem(m)).join('')}
      </div>
    </div>
  `).join('');
}

function renderMemoryItem(memory) {
  const zone = getMemoryZone(memory.createdAt, memory.currentLevel, memory.saillance);
  const typeIcon = memory.memoryType === 'episodic' ? '📅' : memory.memoryType === 'semantic' ? '📖' : '⚡';
  const typeLabel = memory.memoryType === 'episodic' ? 'Episodique' : memory.memoryType === 'semantic' ? 'Sémantique' : 'Procédurale';
  const photoBadge = memory.photographic ? `<span class="photo-badge">🔒 Photo</span>` : '';

  return `
    <div class="memory-item ${memory.photographic ? 'is-photographic' : ''}" onclick="showDetail('${memory.id}')">
      <div class="memory-state ${zone}" title="${getConsolidationLevel(memory.currentLevel)}"></div>
      <div class="memory-content">
        <p>${escapeHtml(memory.content.slice(0, 200))}${memory.content.length > 200 ? '…' : ''}</p>
        <div class="memory-meta">
          <span>🕐 ${getRelativeTime(memory.createdAt)}</span>
          <span>🔁 ${memory.recallCount} réactivation${memory.recallCount > 1 ? 's' : ''}</span>
          <span class="strength-indicator">
            <span>Force</span>
            <div class="strength-dots">
              ${[1,2,3,4,5].map(i => `<div class="strength-dot ${memory.saillance >= i * 20 ? 'active' : ''}"></div>`).join('')}
            </div>
          </span>
          <span class="cue-tag" style="padding: 0.25rem 0.5rem; font-size: 0.75rem;">${typeIcon} ${typeLabel}</span>
          ${photoBadge}
        </div>
      </div>
      <div class="memory-actions">
        <button onclick="event.stopPropagation(); handleRecall('${memory.id}')" title="Réactiver cette trace">🔄</button>
        <button onclick="event.stopPropagation(); handleTogglePhoto('${memory.id}', ${!memory.photographic})" title="${memory.photographic ? 'Désactiver mode photo' : 'Activer mode photo'}">${memory.photographic ? '🔓' : '🔒'}</button>
      </div>
    </div>
  `;
}

function updateTemporalZones(memories) {
  const counts = { encoding: 0, consolidating: 0, consolidated: 0, fragile: 0, dormant: 0 };
  memories.forEach(m => {
    const zone = getMemoryZone(m.createdAt, m.currentLevel, m.saillance);
    counts[zone]++;
  });
  document.getElementById('countEncoding').textContent = counts.encoding;
  document.getElementById('countConsolidating').textContent = counts.consolidating;
  document.getElementById('countConsolidated').textContent = counts.consolidated;
  document.getElementById('countFragile').textContent = counts.fragile;
  document.getElementById('countDormant').textContent = counts.dormant;
}

function filterByZone(zone) {
  currentZone = currentZone === zone ? null : zone;
  document.querySelectorAll('.zone-card').forEach(card => card.classList.remove('active'));
  if (currentZone) {
    document.querySelector(`.zone-${currentZone}`).classList.add('active');
  }
  loadMemories();
}

function showDetail(id) {
  const memory = currentMemories.find(m => m.id === id);
  if (!memory) return;

  const zone = getMemoryZone(memory.createdAt, memory.currentLevel, memory.saillance);
  const consolidationLevel = getConsolidationLevel(memory.currentLevel);

  const content = document.getElementById('modalContent');
  content.innerHTML = `
    <div class="memory-detail">
      <div>
        <div class="detail-label">Trace mnésique</div>
        <div class="detail-value" style="font-size: 1.1rem; margin-top: 0.5rem;">${escapeHtml(memory.content)}</div>
      </div>

      <div class="decay-curve-container">
        <canvas id="decayCurveCanvas" width="600" height="200"></canvas>
      </div>

      <div class="detail-row">
        <div class="detail-label">État de consolidation</div>
        <div class="detail-value">
          <span style="font-size: 1.1rem;">${consolidationLevel}</span>
          <div class="consolidation-track">
            <div class="consolidation-bar">
              <div class="consolidation-segment stage-1 ${memory.currentLevel >= 0 ? 'active' : ''}"></div>
              <div class="consolidation-segment stage-2 ${memory.currentLevel >= 1 ? 'active' : ''}"></div>
              <div class="consolidation-segment stage-3 ${memory.currentLevel >= 2 ? 'active' : ''}"></div>
              <div class="consolidation-segment stage-4 ${memory.currentLevel >= 3 ? 'active' : ''}"></div>
              <div class="consolidation-segment stage-5 ${memory.currentLevel >= 4 ? 'active' : ''}"></div>
            </div>
          </div>
          <div class="consolidation-labels">
            <span>Encodage</span>
            <span>Consolidation</span>
            <span>Stable</span>
            <span>Fragile</span>
            <span>Sommeil</span>
          </div>
        </div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Type de mémoire</div>
        <div class="detail-value">
          <span class="cue-tag">${memory.memoryType === 'episodic' ? '📅 Episodique' : memory.memoryType === 'semantic' ? '📖 Sémantique' : '⚡ Procédurale'}</span>
        </div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Lieu mental</div>
        <div class="detail-value">${escapeHtml(memory.directory)}</div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Contexte d'encodage</div>
        <div class="detail-value">${escapeHtml(memory.sessionId)}</div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Date d'encodage</div>
        <div class="detail-value">${new Date(memory.createdAt).toLocaleString('fr-FR')}</div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Dernière réactivation</div>
        <div class="detail-value">${memory.lastRecalled ? new Date(memory.lastRecalled).toLocaleString('fr-FR') : 'Jamais réactivé'}</div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Nombre de réactivations</div>
        <div class="detail-value">${memory.recallCount}</div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Force mnésique</div>
        <div class="detail-value">
          <span class="strength-indicator">
            <span>${memory.saillance}/100</span>
            <div class="strength-dots">
              ${[1,2,3,4,5].map(i => `<div class="strength-dot ${memory.saillance >= i * 20 ? 'active' : ''}"></div>`).join('')}
            </div>
          </span>
        </div>
      </div>

      <div class="detail-row">
        <div class="detail-label">Taux d'oubli</div>
        <div class="detail-value">${(memory.decayRate * 100).toFixed(0)}%</div>
      </div>

      ${memory.keywords && memory.keywords.length > 0 ? `
      <div>
        <div class="detail-label">Indices de récupération</div>
        <div class="cues-list">
          ${memory.keywords.map(k => `<span class="cue-tag">${escapeHtml(k)}</span>`).join('')}
        </div>
      </div>
      ` : ''}

      ${memory.level3Keywords ? `
      <div>
        <div class="detail-label">Trace pour recherche</div>
        <div class="detail-value">${escapeHtml(memory.level3Keywords)}</div>
      </div>
      ` : ''}

      <div style="display: flex; gap: 0.5rem; margin-top: 1rem; flex-wrap: wrap;">
        <button class="primary" onclick="handleRecall('${memory.id}')">🔄 Réactiver</button>
        <button onclick="handleTogglePhoto('${memory.id}', ${!memory.photographic})" style="background: var(--surface-2); border-color: ${memory.photographic ? 'var(--primary)' : 'var(--border)'}; color: ${memory.photographic ? 'var(--primary)' : 'var(--text)'};">${memory.photographic ? '🔒 Photo actif' : '🔓 Activer photo'}</button>
        <button onclick="showSimilar('${memory.id}')" style="background: var(--surface-2);">🔍 Similaires</button>
        <button onclick="handleDelete('${memory.id}')" style="background: #ef4444; border-color: #ef4444; margin-left: auto;">🗑️ Oublier</button>
      </div>
      <div id="similarPanel-${memory.id}"></div>
    </div>
  `;

  document.getElementById('detailModal').classList.add('active');

  setTimeout(() => {
    const canvas = document.getElementById('decayCurveCanvas');
    if (canvas) renderDecayCurve(memory, canvas);
  }, 50);
}

function showAddModal() {
  document.getElementById('addModal').classList.add('active');
  document.getElementById('addContent').focus();
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
}

async function addMemory(event) {
  event.preventDefault();

  const content = document.getElementById('addContent').value;
  const directory = document.getElementById('addDirectory').value;
  const sessionId = document.getElementById('addSession').value;
  const keywordsStr = document.getElementById('addKeywords').value;
  const level3 = document.getElementById('addLevel3').value;
  const memoryType = document.getElementById('addMemoryType').value;

  try {
    const data = await addMemory({
      content,
      directory,
      sessionId,
      keywords: keywordsStr ? keywordsStr.split(',').map(k => k.trim()).filter(Boolean) : [],
      level3Keywords: level3,
      memoryType,
    });

    if (data.success) {
      closeModal('addModal');
      document.getElementById('addContent').value = '';
      document.getElementById('addKeywords').value = '';
      document.getElementById('addLevel3').value = '';
      loadMemories();
    } else {
      alert('Erreur: ' + data.error);
    }
  } catch (error) {
    alert('Erreur: ' + error.message);
  }
}

async function handleRecall(id) {
  try {
    await recallMemory(id);
    loadMemories();
  } catch (error) {
    alert('Erreur: ' + error.message);
  }
}

async function handleDelete(id) {
  if (!confirm('Oublier cette trace mnésique ?')) return;
  try {
    await deleteMemory(id);
    loadMemories();
  } catch (error) {
    alert('Erreur: ' + error.message);
  }
}

async function handleSearch(query) {
  if (!query) {
    loadMemories();
    return;
  }

  try {
    const type = document.getElementById('typeFilter').value;
    const from = document.getElementById('filterFrom').value;
    const to = document.getElementById('filterTo').value;
    const minS = document.getElementById('filterMinSaillance').value;
    const minR = document.getElementById('filterMinRecalls').value;

    const results = await searchMemories(query, {
      type,
      dateFrom: from,
      dateTo: to,
      minSaillance: minS,
      minRecalls: minR,
    });

    let memories = results.map(r => r.memory);
    if (document.getElementById('filterPhotographic').checked) {
      memories = memories.filter(m => m.photographic);
    }
    currentMemories = memories;
    groupAndRender(memories);
  } catch (error) {
    console.error('Search error:', error);
  }
}

async function handleTogglePhoto(id, enable) {
  try {
    await togglePhotographic(id, enable);
    loadMemories();
    closeModal('detailModal');
  } catch (error) {
    alert('Erreur: ' + error.message);
  }
}

async function showSimilar(id) {
  const panel = document.getElementById(`similarPanel-${id}`);
  if (!panel) return;

  panel.innerHTML = '<div class="similar-panel"><h4>Recherche en cours…</h4></div>';

  try {
    const results = await findSimilar(id, { limit: 5, threshold: 30 });

    if (results.length === 0) {
      panel.innerHTML = '<div class="similar-panel"><h4>Aucune trace similaire trouvée</h4></div>';
      return;
    }

    panel.innerHTML = `
      <div class="similar-panel">
        <h4>Traces similaires (${results.length})</h4>
        ${results.map(r => `
          <div class="similar-item">
            <p>${escapeHtml(r.memory.content.slice(0, 120))}${r.memory.content.length > 120 ? '…' : ''}</p>
            <span class="score">Score ${Math.round(r.score)}</span>
            <button onclick="confirmMerge('${id}', '${r.memory.id}')" style="padding: 0.3rem 0.6rem; font-size: 0.78rem; white-space: nowrap;">🔀 Fusionner</button>
          </div>
        `).join('')}
      </div>
    `;
  } catch (error) {
    panel.innerHTML = `<div class="similar-panel"><h4>Erreur: ${error.message}</h4></div>`;
  }
}

async function confirmMerge(sourceId, targetId) {
  const source = currentMemories.find(m => m.id === sourceId);
  const target = currentMemories.find(m => m.id === targetId);
  const label = target ? target.content.slice(0, 60) + '…' : targetId;
  if (!confirm(`Fusionner dans "${label}" ?\n\nLa trace source passera en niveau 4 (fusionnée).`)) return;

  try {
    const data = await mergeMemories(sourceId, targetId);
    if (data.success) {
      closeModal('detailModal');
      loadMemories();
    } else {
      alert('Erreur: ' + data.error);
    }
  } catch (error) {
    alert('Erreur: ' + error.message);
  }
}

function toggleAdvancedFilters() {
  const panel = document.getElementById('advancedFilters');
  const btn = document.getElementById('btnAdvanced');
  panel.classList.toggle('open');
  btn.style.borderColor = panel.classList.contains('open') ? 'var(--primary)' : 'var(--border)';
}

function clearAdvancedFilters() {
  document.getElementById('filterFrom').value = '';
  document.getElementById('filterTo').value = '';
  document.getElementById('filterMinSaillance').value = '';
  document.getElementById('filterMinRecalls').value = '';
  document.getElementById('filterPhotographic').checked = false;
  loadMemories();
}

function debouncedSearch() {
  clearTimeout(searchTimeout);
  const query = document.getElementById('searchInput').value;
  searchTimeout = setTimeout(() => handleSearch(query), 300);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getRelativeTime(date) {
  const now = new Date();
  const d = new Date(date);
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return "À l'instant";
  if (diffMins < 60) return `Il y a ${diffMins} min`;
  if (diffHours < 24) return `Il y a ${diffHours} h`;
  if (diffDays < 7) return `Il y a ${diffDays} j`;
  return d.toLocaleDateString('fr-FR');
}

document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.classList.remove('active');
  });
});

loadMemories();
