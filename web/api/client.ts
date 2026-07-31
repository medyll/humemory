/**
 * Client HTTP du front.
 *
 * Les types viennent de `src/core/types.ts` — les mêmes que ceux du store et de
 * l'API. Pas de types dupliqués côté front : si le modèle change, le front ne
 * compile plus, ce qui est exactement le comportement voulu.
 */

import type { Intention, Cue, Memory, TriggerSpec, IntentionStatus } from '../../src/core/types.js';

/** Une intention telle que l'API la renvoie : avec son identifiant court. */
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError((body as any)?.error ?? `HTTP ${res.status}`, res.status);
  }
  return body as T;
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

  /** Ménage : expire les boucles périmées, tire les échéances atteintes. */
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

  search(q: string, filters: { limit?: number; maxLevel?: number; directory?: string } = {}) {
    const query = new URLSearchParams({ q });
    if (filters.limit) query.set('limit', String(filters.limit));
    if (filters.maxLevel !== undefined) query.set('maxLevel', String(filters.maxLevel));
    if (filters.directory) query.set('directory', filters.directory);

    return request<{ success: boolean; results: Array<{ memory: Memory; matchLevel: number; score: number }> }>(
      `/search?${query}`
    );
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
