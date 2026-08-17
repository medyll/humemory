/**
 * Front-end HTTP client.
 *
 * Types come from `src/core/types.ts` — the same ones the store and the API use.
 * No duplicated front-end types: if the model changes, the front end stops
 * compiling, which is exactly the intended behaviour.
 */

import type { Intention, Cue, Memory, MemoryType, TriggerSpec, IntentionStatus } from '../../src/core/types.js';

/** An intention as the API returns it: with its short id. */
export interface IntentionDTO extends Omit<Intention, 'createdAt' | 'expiresAt' | 'firedAt' | 'closedAt'> {
  loopId: string;
  createdAt: string;
  expiresAt?: string;
  firedAt?: string;
  closedAt?: string;
}

export interface CueDTO extends Omit<Cue, 'armedAt' | 'firedAt'> {
  armedAt: string;
  firedAt?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Optional bearer token, required server-side only when HUMEMORY_API_TOKEN is set
// (SECURITY_AUDIT.md H-01). Kept in localStorage so the dashboard survives reloads
// without re-prompting; never sent anywhere but this same-origin API.
const TOKEN_KEY = 'humemory_api_token';

export function getApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return ''; // localStorage unavailable (privacy mode, SSR, etc.)
  }
}

export function setApiToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Non-fatal: the token just won't persist across reloads.
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getApiToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-humemory-token': token } : {}),
      ...init?.headers,
    },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError((body as any)?.error ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
}

/** Advanced search filters — ported from the old ⚙️ panel. */
export interface SearchFilters {
  limit?: number;
  maxLevel?: number;
  directory?: string;
  type?: MemoryType;
  dateFrom?: string;
  dateTo?: string;
  minSaillance?: number;
  minRecalls?: number;
}

export interface CreateMemoryInput {
  content: string;
  directory?: string;
  keywords?: string[];
  memoryType?: MemoryType;
  photographic?: boolean;
}

export interface CreateIntentionInput {
  content: string;
  directory: string;
  expiresAt?: string;
  cues?: TriggerSpec[];
}

export const api = {
  listIntentions(params: { status?: IntentionStatus | IntentionStatus[]; directory?: string } = {}) {
    const query = new URLSearchParams();
    if (params.status) {
      query.set('status', Array.isArray(params.status) ? params.status.join(',') : params.status);
    }
    if (params.directory) query.set('directory', params.directory);

    const suffix = query.toString() ? `?${query}` : '';
    return request<{ intentions: IntentionDTO[]; count: number }>(`/intentions${suffix}`);
  },

  getIntention(id: string) {
    return request<{ intention: IntentionDTO; cues: CueDTO[] }>(`/intentions/${id}`);
  },

  createIntention(input: CreateIntentionInput) {
    return request<{ intention: IntentionDTO }>('/intentions', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  closeIntention(id: string, commit?: string) {
    return request<{ intention: IntentionDTO }>(`/intentions/${id}/close`, {
      method: 'POST',
      body: JSON.stringify({ commit }),
    });
  },

  fireIntention(id: string) {
    return request<{ intention: IntentionDTO }>(`/intentions/${id}/fire`, { method: 'POST' });
  },

  deleteIntention(id: string) {
    return request<{ success: boolean }>(`/intentions/${id}`, { method: 'DELETE' });
  },

  addCue(intentionId: string, triggerSpec: TriggerSpec) {
    return request<{ cue: CueDTO }>('/cues', {
      method: 'POST',
      body: JSON.stringify({ intentionId, triggerSpec }),
    });
  },

  /** Sweep: expires overdue loops, fires deadlines that have come due. */
  resolveCues() {
    return request<{ expired: number; fired: IntentionDTO[]; count: number }>('/cues/resolve', {
      method: 'POST',
    });
  },

  listMemories(params: { limit?: number; level?: number } = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.level !== undefined) query.set('level', String(params.level));

    const suffix = query.toString() ? `?${query}` : '';
    return request<{ success: boolean; memories: Memory[] }>(`/memories${suffix}`);
  },

  search(q: string, filters: SearchFilters = {}) {
    const query = new URLSearchParams({ q });
    if (filters.limit) query.set('limit', String(filters.limit));
    if (filters.maxLevel !== undefined) query.set('maxLevel', String(filters.maxLevel));
    if (filters.directory) query.set('directory', filters.directory);
    if (filters.type) query.set('type', filters.type);
    if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
    if (filters.dateTo) query.set('dateTo', filters.dateTo);
    if (filters.minSaillance !== undefined) query.set('minSaillance', String(filters.minSaillance));
    if (filters.minRecalls !== undefined) query.set('minRecalls', String(filters.minRecalls));

    return request<{ success: boolean; results: Array<{ memory: Memory; matchLevel: number; score: number }> }>(
      `/search?${query}`
    );
  },

  createMemory(input: CreateMemoryInput) {
    return request<{ success: boolean; memory: Memory }>('/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  getMemory(id: string) {
    return request<{ success: boolean; memory: Memory }>(`/memories/${id}`);
  },

  recallMemory(id: string) {
    return request<{ success: boolean; memory: Memory }>(`/memories/${id}/recall`, { method: 'POST' });
  },

  deleteMemory(id: string) {
    return request<{ success: boolean }>(`/memories/${id}`, { method: 'DELETE' });
  },

  setPhotographic(id: string, enable: boolean) {
    return request<{ success: boolean; memory: Memory }>(`/memories/${id}/photo`, {
      method: 'POST',
      body: JSON.stringify({ enable }),
    });
  },

  findSimilar(id: string, params: { limit?: number; threshold?: number } = {}) {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.threshold !== undefined) query.set('threshold', String(params.threshold));

    const suffix = query.toString() ? `?${query}` : '';
    return request<{ success: boolean; results: Array<{ memory: Memory; score: number }> }>(
      `/memories/${id}/similar${suffix}`
    );
  },

  /** Merges `sourceId` into `targetId`. Irreversible: the source drops to level 4. */
  mergeMemories(sourceId: string, targetId: string) {
    return request<{ success: boolean }>(`/memories/${sourceId}/merge`, {
      method: 'POST',
      body: JSON.stringify({ targetId }),
    });
  },

  listSessions() {
    return request<{ success: boolean; sessions: Array<{ sessionId: string; count: number; firstEvent: string }> }>(
      '/sessions'
    );
  },

  getSession(id: string) {
    return request<Record<string, any>>(`/sessions/${encodeURIComponent(id)}`);
  },

  status() {
    return request<Record<string, unknown>>('/status');
  },
};
