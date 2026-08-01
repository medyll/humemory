import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { App } from '../web/App.tsx';
import { LoopBadge } from '../web/components/LoopBadge.tsx';

/**
 * React front-end tests (story S6-01).
 *
 * `fetch` is stubbed and there is no server: the suite stays hermetic and offline
 * like the rest (docs/TESTING.md). The DOM comes from happy-dom, preloaded by
 * bunfig.toml — the same runner as the backend tests.
 */

const realFetch = globalThis.fetch;

/** Replaces fetch with a response table and logs the calls. */
function stubFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; method: string }> = [];

  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });

    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response(JSON.stringify({ error: 'route not stubbed' }), { status: 404 });

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
    content: 'Refactor token validation',
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
  test('renders every state with its label', () => {
    render(<LoopBadge status="armed" />);
    expect(screen.getByText(/open/)).toBeDefined();

    cleanup();
    render(<LoopBadge status="closed" />);
    expect(screen.getByText(/closed/)).toBeDefined();
  });

  test('exposes the state as an attribute so CSS can colour it', () => {
    const { container } = render(<LoopBadge status="fired" />);
    expect(container.querySelector('[data-status="fired"]')).not.toBeNull();
  });
});

describe('App', () => {
  test('shows the open loops the API returns', async () => {
    stubFetch({ '/intentions': { intentions: [intention()], count: 1 } });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText('Refactor token validation')).toBeDefined();
    });
    expect(screen.getByText('loop-a1b2c3d4')).toBeDefined();
    // The mental place shares its line with the loop's age.
    expect(screen.getByText(/\/src\/auth/)).toBeDefined();
  });

  test('only asks for armed loops', async () => {
    const calls = stubFetch({ '/intentions': { intentions: [], count: 0 } });

    render(<App />);

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].url).toContain('status=armed');
  });

  test('says when there is nothing, rather than showing an empty list', async () => {
    stubFetch({ '/intentions': { intentions: [], count: 0 } });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/No open loop/)).toBeDefined();
    });
  });

  test('surfaces an API error instead of staying silent', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'database unavailable' }), { status: 500 })) as typeof fetch;

    render(<App />);

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('database unavailable');
    });
  });

  test('the sweep button calls /cues/resolve then reloads', async () => {
    const calls = stubFetch({
      '/cues/resolve': { expired: 1, fired: [], count: 0 },
      '/intentions': { intentions: [intention()], count: 1 },
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText(/Refactor/)).toBeDefined());

    const before = calls.length;
    screen.getByRole('button', { name: /sweep/i }).click();

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/cues/resolve') && c.method === 'POST')).toBe(true);
    });
    // The reload follows the sweep: the list must not stay stale.
    await waitFor(() => expect(calls.length).toBeGreaterThan(before + 1));
  });
});
