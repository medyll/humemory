import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { App } from '../web/App.tsx';
import { LoopBadge } from '../web/components/LoopBadge.tsx';

/**
 * Tests du front React (story S6-01).
 *
 * `fetch` est stubbé, pas de serveur : la suite reste hermétique et sans réseau,
 * comme le reste (docs/TESTING.md). Le DOM vient de happy-dom, préchargé par
 * bunfig.toml — même runner que les tests backend.
 */

const realFetch = globalThis.fetch;

/** Remplace fetch par une table de réponses, et journalise les appels. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });

    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: 'route non stubbée' }), { status: 404 });

    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  return calls;
}

function intention(overrides: Record<string, unknown> = {}) {
  return {
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    loopId: 'loop-a1b2c3d4',
    content: 'Refactorer la validation de token',
    directory: '/src/auth',
    status: 'armed',
    saillance: 100,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('LoopBadge', () => {
  test('rend chaque état avec son libellé', () => {
    render(<LoopBadge status="armed" />);
    expect(screen.getByText(/ouverte/)).toBeDefined();

    cleanup();
    render(<LoopBadge status="closed" />);
    expect(screen.getByText(/fermée/)).toBeDefined();
  });

  test('expose l\'état en attribut, pour que le CSS le colore', () => {
    const { container } = render(<LoopBadge status="fired" />);
    expect(container.querySelector('[data-status="fired"]')).not.toBeNull();
  });
});

describe('App', () => {
  test('affiche les boucles ouvertes renvoyées par l\'API', async () => {
    stubFetch({ '/intentions': { intentions: [intention()], count: 1 } });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Refactorer la validation de token')).toBeDefined();
    });
    expect(screen.getByText('loop-a1b2c3d4')).toBeDefined();
    expect(screen.getByText('/src/auth')).toBeDefined();
  });

  test('ne demande que les boucles armées', async () => {
    const calls = stubFetch({ '/intentions': { intentions: [], count: 0 } });

    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].url).toContain('status=armed');
  });

  test('dit quand il n\'y a rien, plutôt que d\'afficher une liste vide', async () => {
    stubFetch({ '/intentions': { intentions: [], count: 0 } });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/Aucune boucle ouverte/)).toBeDefined();
    });
  });

  test('remonte une erreur d\'API au lieu de rester muet', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'base indisponible' }), { status: 500 })) as typeof fetch;

    render(<App />);

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('base indisponible');
    });
  });

  test('le bouton de ménage appelle /cues/resolve puis recharge', async () => {
    const calls = stubFetch({
      '/cues/resolve': { expired: 1, fired: [], count: 0 },
      '/intentions': { intentions: [intention()], count: 1 },
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Refactorer/)).toBeDefined());

    const before = calls.length;
    screen.getByRole('button', { name: /balai/i }).click();

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/cues/resolve') && c.method === 'POST')).toBe(true);
    });
    // Le rechargement suit le ménage : la liste ne doit pas rester périmée.
    await waitFor(() => expect(calls.length).toBeGreaterThan(before + 1));
  });
});
