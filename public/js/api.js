const API_BASE = '';

async function fetchMemories(options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.level !== undefined) params.set('level', options.level);

  const response = await fetch(`${API_BASE}/memories?${params}`);
  const data = await response.json();
  return data.memories || [];
}

async function fetchMemory(id) {
  const response = await fetch(`${API_BASE}/memories/${id}`);
  const data = await response.json();
  return data.memory;
}

async function addMemory(payload) {
  const response = await fetch(`${API_BASE}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return await response.json();
}

async function recallMemory(id) {
  const response = await fetch(`${API_BASE}/memories/${id}/recall`, { method: 'POST' });
  return await response.json();
}

async function deleteMemory(id) {
  const response = await fetch(`${API_BASE}/memories/${id}`, { method: 'DELETE' });
  return await response.json();
}

async function searchMemories(query, filters = {}) {
  const params = new URLSearchParams({ q: query });
  if (filters.type) params.set('type', filters.type);
  if (filters.directory) params.set('directory', filters.directory);
  if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) params.set('dateTo', filters.dateTo);
  if (filters.minSaillance) params.set('minSaillance', filters.minSaillance);
  if (filters.minRecalls) params.set('minRecalls', filters.minRecalls);
  if (filters.maxLevel) params.set('maxLevel', filters.maxLevel);
  if (filters.limit) params.set('limit', filters.limit);

  const response = await fetch(`${API_BASE}/search?${params}`);
  const data = await response.json();
  return data.results || [];
}

async function togglePhotographic(id, enable) {
  const response = await fetch(`${API_BASE}/memories/${id}/photo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enable }),
  });
  return await response.json();
}

async function findSimilar(id, options = {}) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', options.limit);
  if (options.threshold) params.set('threshold', options.threshold);

  const response = await fetch(`${API_BASE}/memories/${id}/similar?${params}`);
  const data = await response.json();
  return data.results || [];
}

async function mergeMemories(sourceId, targetId, options = {}) {
  const response = await fetch(`${API_BASE}/memories/${sourceId}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ targetId, ...options }),
  });
  return await response.json();
}

async function runDecay() {
  const response = await fetch(`${API_BASE}/decay`, { method: 'POST' });
  return await response.json();
}

async function fetchStatus() {
  const response = await fetch(`${API_BASE}/status`);
  const data = await response.json();
  return data.status;
}
