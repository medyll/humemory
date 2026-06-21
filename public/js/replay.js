let replaySessions = [];
let replayCurrentSession = null;
let replayEvents = [];
let replayCurrentIndex = 0;
let replayPlaying = false;
let replayPlayInterval = null;

async function initReplay() {
  const container = document.getElementById('replayContainer');
  if (!container) return;

  container.innerHTML = '';

  try {
    const data = await fetchReplaySessions();
    replaySessions = data;

    if (replaySessions.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>Aucune session disponible</h3>
          <p>Les sessions sont créées automatiquement lors de l'encodage de traces mnésiques.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div style="margin-bottom: 1.5rem;">
        <label style="display: block; margin-bottom: 0.5rem; font-size: 0.9rem; color: var(--text-muted);">Sélectionner une session</label>
        <select id="replaySessionSelect" style="width: 100%; padding: 0.75rem; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; color: var(--text);">
          ${replaySessions.map(s => `
            <option value="${s.sessionId}">${s.sessionId} — ${s.count} traces — ${new Date(s.firstEvent).toLocaleDateString('fr-FR')}</option>
          `).join('')}
        </select>
      </div>
      <div class="replay-container" id="replayMain">
        <div class="replay-transcript" id="replayTranscript">
          <h3 style="margin-bottom: 1rem;">Transcript</h3>
          <div id="replayMessages"></div>
        </div>
        <div class="replay-visualization" id="replayViz">
          <h3 style="margin-bottom: 1rem;">Événements mémoire</h3>
          <div id="replayEventList"></div>
        </div>
        <div class="replay-timeline">
          <div style="display: flex; gap: 1rem; align-items: center; margin-bottom: 1rem;">
            <button id="replayPlayBtn" class="primary">▶ Play</button>
            <input type="range" id="replaySlider" min="0" max="0" value="0" style="flex: 1;">
            <span id="replayTimeLabel">0 / 0</span>
            <button id="replayResetBtn">↺ Reset</button>
          </div>
          <div style="display: flex; gap: 2rem; font-size: 0.85rem; color: var(--text-muted);">
            <span>📥 Encodées: <strong id="replayEncodedCount">0</strong></span>
            <span>📉 Dégradées: <strong id="replayDecayedCount">0</strong></span>
            <span>🔄 Rappelées: <strong id="replayRecalledCount">0</strong></span>
          </div>
        </div>
      </div>
    `;

    const select = document.getElementById('replaySessionSelect');
    select.addEventListener('change', () => {
      loadReplaySession(select.value);
    });

    if (replaySessions.length > 0) {
      loadReplaySession(replaySessions[0].sessionId);
    }

  } catch (error) {
    container.innerHTML = `<div class="empty-state"><h3>Erreur</h3><p>${error.message}</p></div>`;
  }
}

async function loadReplaySession(sessionId) {
  try {
    const data = await fetchReplaySession(sessionId);
    replayCurrentSession = data;
    replayEvents = data.events;
    replayCurrentIndex = 0;

    const slider = document.getElementById('replaySlider');
    slider.max = replayEvents.length - 1;
    slider.value = 0;

    updateReplayDisplay();

    const playBtn = document.getElementById('replayPlayBtn');
    const resetBtn = document.getElementById('replayResetBtn');

    playBtn.onclick = () => {
      if (replayPlaying) {
        clearInterval(replayPlayInterval);
        replayPlaying = false;
        playBtn.textContent = '▶ Play';
      } else {
        replayPlaying = true;
        playBtn.textContent = '⏸ Pause';
        replayPlayInterval = setInterval(() => {
          replayCurrentIndex++;
          if (replayCurrentIndex >= replayEvents.length) {
            replayCurrentIndex = 0;
          }
          slider.value = replayCurrentIndex;
          updateReplayDisplay();
        }, 1000);
      }
    };

    resetBtn.onclick = () => {
      replayCurrentIndex = 0;
      slider.value = 0;
      updateReplayDisplay();
      if (replayPlaying) {
        clearInterval(replayPlayInterval);
        replayPlaying = false;
        playBtn.textContent = '▶ Play';
      }
    };

    slider.oninput = () => {
      replayCurrentIndex = parseInt(slider.value);
      updateReplayDisplay();
    };

  } catch (error) {
    console.error('Error loading replay session:', error);
  }
}

function updateReplayDisplay() {
  const messagesDiv = document.getElementById('replayMessages');
  const eventsDiv = document.getElementById('replayEventList');
  const timeLabel = document.getElementById('replayTimeLabel');
  const encodedCount = document.getElementById('replayEncodedCount');
  const decayedCount = document.getElementById('replayDecayedCount');
  const recalledCount = document.getElementById('replayRecalledCount');

  if (!messagesDiv || !eventsDiv) return;

  const visibleEvents = replayEvents.slice(0, replayCurrentIndex + 1);

  let encoded = 0;
  let decayed = 0;
  let recalled = 0;

  visibleEvents.forEach(e => {
    if (e.type === 'encoded') encoded++;
    else if (e.type === 'decayed') decayed++;
    else if (e.type === 'recalled') recalled++;
  });

  encodedCount.textContent = encoded;
  decayedCount.textContent = decayed;
  recalledCount.textContent = recalled;

  timeLabel.textContent = `${replayCurrentIndex + 1} / ${replayEvents.length}`;

  messagesDiv.innerHTML = visibleEvents
    .filter(e => e.type === 'encoded')
    .slice(-10)
    .map(e => `
      <div class="replay-message">
        <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.25rem;">
          ${new Date(e.timestamp).toLocaleTimeString('fr-FR')}
        </div>
        <div>${e.content.slice(0, 150)}${e.content.length > 150 ? '…' : ''}</div>
      </div>
    `).join('');

  eventsDiv.innerHTML = visibleEvents
    .slice(-20)
    .map(e => {
      const icon = e.type === 'encoded' ? '📥' : e.type === 'decayed' ? '📉' : '🔄';
      const label = e.type === 'encoded' ? 'Encodage' : e.type === 'decayed' ? 'Dégradation' : 'Rappel';
      return `
        <div class="replay-event ${e.type}">
          <span>${icon}</span>
          <span style="flex: 1;">${label}: ${e.content.slice(0, 80)}${e.content.length > 80 ? '…' : ''}</span>
          <span style="color: var(--text-muted); font-size: 0.75rem;">${new Date(e.timestamp).toLocaleTimeString('fr-FR')}</span>
        </div>
      `;
    }).join('');
}

async function fetchReplaySessions() {
  const response = await fetch(`${API_BASE}/sessions`);
  const data = await response.json();
  return data.sessions || [];
}

async function fetchReplaySession(sessionId) {
  const response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}`);
  const data = await response.json();
  return data;
}
