import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ReplayTab } from '../web/components/ReplayTab.tsx';
import { SimilarPanel } from '../web/components/SimilarPanel.tsx';
import type { Memory } from '../src/core/types.js';

/**
 * Rejeu et fusion (story S6-04) — les deux dernières vues à quitter le
 * dashboard vanilla. Aucun réseau : `fetch` est stubbé.
 */

const realFetch = globalThis.fetch;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    content: 'La race condition du worker se réglait avec un mutex async',
    directory: '/src/core',
    day: '2026-06-01',
    keywords: ['race'],
    sessionId: 's1',
    memoryType: 'semantic',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    recallCount: 0,
    decayRate: 0.5,
    currentLevel: 0,
    saillance: 60,
    ...overrides,
  } as Memory;
}

function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });

    const key = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : { error: 'non stubbé' }), {
      status: key ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return calls;
}

const SESSIONS = {
  success: true,
  sessions: [
    { sessionId: 'session-a', count: 3, firstEvent: '2026-06-01T10:00:00.000Z' },
    { sessionId: 'session-b', count: 1, firstEvent: '2026-06-02T10:00:00.000Z' },
  ],
};

const EVENTS = {
  events: [
    { type: 'encoded', content: 'première trace encodée', timestamp: '2026-06-01T10:00:00.000Z' },
    { type: 'decayed', content: 'trace dégradée', timestamp: '2026-06-01T11:00:00.000Z' },
    { type: 'recalled', content: 'trace rappelée', timestamp: '2026-06-01T12:00:00.000Z' },
  ],
};

beforeEach(() => cleanup());
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe('ReplayTab', () => {
  test('sans session, le dit au lieu d\'afficher un lecteur vide', async () => {
    stubFetch({ '/sessions': { success: true, sessions: [] } });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText(/Aucune session/)).toBeDefined());
  });

  test('charge la première session et n\'affiche que le premier événement', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);

    // L'événement d'encodage figure dans les deux panneaux : transcript et liste.
    await waitFor(() => expect(screen.getAllByText(/première trace encodée/).length).toBe(2));
    // Le curseur est au début : la suite n'est pas encore révélée.
    expect(screen.queryByText(/trace rappelée/)).toBeNull();
    expect(screen.getByText('1 / 3')).toBeDefined();
  });

  test('déplacer le curseur révèle les événements et met à jour les compteurs', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getAllByText(/première trace encodée/).length).toBe(2));

    fireEvent.change(screen.getByLabelText(/Position dans la session/), { target: { value: '2' } });

    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());
    expect(screen.getByText(/trace rappelée/)).toBeDefined();

    const counts = screen.getByText(/Encodées/).parentElement!;
    expect(counts.textContent).toContain('1'); // une de chaque type
  });

  test('Reset ramène au début', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Position/), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());
  });

  test('changer de session repart de zéro', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Position/), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());

    // Sans remise à zéro, l'index d'une session longue pointerait hors d'une courte.
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'session-b' } });
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());
  });
});

describe('SimilarPanel', () => {
  test('liste les candidats avec leur score', async () => {
    stubFetch({
      '/similar': {
        success: true,
        results: [{ memory: memory({ id: 'm2', content: 'trace voisine' }), score: 72.4 }],
      },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);

    await waitFor(() => expect(screen.getByText('trace voisine')).toBeDefined());
    expect(screen.getByText('Score 72')).toBeDefined();
  });

  test('sans candidat, le dit', async () => {
    stubFetch({ '/similar': { success: true, results: [] } });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Aucune trace assez proche/)).toBeDefined());
  });

  test('la fusion exige une confirmation qui montre la cible', async () => {
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'trace cible' }), score: 80 }] },
      '/merge': { success: true },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('trace cible')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Fusionner/ }));

    // Rien n'est parti : la fusion est irréversible, elle se confirme.
    expect(calls.some((c) => c.url.includes('/merge'))).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('trace cible');
    expect(dialog.textContent).toMatch(/irréversible/i);
  });

  test('confirmer envoie la fusion avec la bonne cible et prévient le parent', async () => {
    let merged = false;
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'cible' }), score: 80 }] },
      '/merge': { success: true },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => (merged = true)} />);
    await waitFor(() => expect(screen.getByText('cible')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Fusionner/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmer la fusion/ }));

    await waitFor(() => expect(merged).toBe(true));
    const call = calls.find((c) => c.url.includes('/merge'))!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/memories/m1/merge'); // la source est la trace courante
    expect(call.body).toContain('m2'); // la cible part dans le corps
  });

  test('annuler referme la confirmation sans rien fusionner', async () => {
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'cible' }), score: 80 }] },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('cible')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Fusionner/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some((c) => c.url.includes('/merge'))).toBe(false);
  });

  test('une erreur de fusion est affichée, pas avalée', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/similar')) {
        return new Response(
          JSON.stringify({ success: true, results: [{ memory: memory({ id: 'm2', content: 'cible' }), score: 80 }] })
        );
      }
      return new Response(JSON.stringify({ error: 'fusion impossible' }), { status: 500 });
    }) as typeof fetch;

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('cible')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Fusionner/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirmer la fusion/ }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('fusion impossible'))).toBe(true);
    });
  });
});
