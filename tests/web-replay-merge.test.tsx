import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ReplayTab } from '../web/components/ReplayTab.tsx';
import { SimilarPanel } from '../web/components/SimilarPanel.tsx';
import type { Memory } from '../src/core/types.js';

/**
 * Replay and merging (story S6-04) — the last two views to leave the vanilla
 * dashboard. No network: `fetch` is stubbed.
 */

const realFetch = globalThis.fetch;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    content: 'The worker race condition was fixed with an async mutex',
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
    return new Response(JSON.stringify(key ? routes[key] : { error: 'not stubbed' }), {
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
    { type: 'encoded', content: 'first encoded trace', timestamp: '2026-06-01T10:00:00.000Z' },
    { type: 'decayed', content: 'decayed trace', timestamp: '2026-06-01T11:00:00.000Z' },
    { type: 'recalled', content: 'recalled trace', timestamp: '2026-06-01T12:00:00.000Z' },
  ],
};

beforeEach(() => cleanup());
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe('ReplayTab', () => {
  test('with no session, says so instead of showing an empty player', async () => {
    stubFetch({ '/sessions': { success: true, sessions: [] } });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText(/No session to replay/)).toBeDefined());
  });

  test('loads the first session and shows only the first event', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);

    // The encoded event appears in both panes: transcript and event list.
    await waitFor(() => expect(screen.getAllByText(/first encoded trace/).length).toBe(2));
    // The cursor sits at the start: what follows is not revealed yet.
    expect(screen.queryByText(/recalled trace/)).toBeNull();
    expect(screen.getByText('1 / 3')).toBeDefined();
  });

  test('moving the cursor reveals events and updates the counters', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getAllByText(/first encoded trace/).length).toBe(2));

    fireEvent.change(screen.getByLabelText(/Position in the session/), { target: { value: '2' } });

    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());
    expect(screen.getByText(/recalled trace/)).toBeDefined();

    const counts = screen.getByText(/📥 Encoded:/).parentElement!;
    expect(counts.textContent).toContain('1'); // one of each type
  });

  test('Reset returns to the start', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Position/), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());
  });

  test('switching session restarts from zero', async () => {
    stubFetch({ '/sessions/': EVENTS, '/sessions': SESSIONS });

    render(<ReplayTab />);
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Position/), { target: { value: '2' } });
    await waitFor(() => expect(screen.getByText('3 / 3')).toBeDefined());

    // Without a reset, a long session's index would point outside a short one.
    fireEvent.change(screen.getByLabelText('Session'), { target: { value: 'session-b' } });
    await waitFor(() => expect(screen.getByText('1 / 3')).toBeDefined());
  });
});

describe('SimilarPanel', () => {
  test('lists candidates with their score', async () => {
    stubFetch({
      '/similar': {
        success: true,
        results: [{ memory: memory({ id: 'm2', content: 'neighbouring trace' }), score: 72.4 }],
      },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);

    await waitFor(() => expect(screen.getByText('neighbouring trace')).toBeDefined());
    expect(screen.getByText('Score 72')).toBeDefined();
  });

  test('with no candidate, says so', async () => {
    stubFetch({ '/similar': { success: true, results: [] } });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText(/No trace close enough/)).toBeDefined());
  });

  test('merging requires a confirmation that shows the target', async () => {
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'target trace' }), score: 80 }] },
      '/merge': { success: true },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('target trace')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Merge/ }));

    // Nothing left yet: a merge is irreversible, so it gets confirmed.
    expect(calls.some((c) => c.url.includes('/merge'))).toBe(false);
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('target trace');
    expect(dialog.textContent).toMatch(/irreversible/i);
  });

  test('confirming sends the merge with the right target and notifies the parent', async () => {
    let merged = false;
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'target' }), score: 80 }] },
      '/merge': { success: true },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => (merged = true)} />);
    await waitFor(() => expect(screen.getByText('target')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Merge/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm the merge/ }));

    await waitFor(() => expect(merged).toBe(true));
    const call = calls.find((c) => c.url.includes('/merge'))!;
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/memories/m1/merge'); // the source is the current trace
    expect(call.body).toContain('m2'); // the target travels in the body
  });

  test('cancelling closes the confirmation without merging', async () => {
    const calls = stubFetch({
      '/similar': { success: true, results: [{ memory: memory({ id: 'm2', content: 'target' }), score: 80 }] },
    });

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('target')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Merge/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some((c) => c.url.includes('/merge'))).toBe(false);
  });

  test('a merge error is shown, not swallowed', async () => {
    globalThis.fetch = (async (input: any) => {
      const url = String(input);
      if (url.includes('/similar')) {
        return new Response(
          JSON.stringify({ success: true, results: [{ memory: memory({ id: 'm2', content: 'target' }), score: 80 }] })
        );
      }
      return new Response(JSON.stringify({ error: 'merge failed' }), { status: 500 });
    }) as typeof fetch;

    render(<SimilarPanel memory={memory()} onMerged={() => {}} />);
    await waitFor(() => expect(screen.getByText('target')).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Merge/ }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm the merge/ }));

    await waitFor(() => {
      expect(screen.getAllByRole('alert').some((el) => el.textContent?.includes('merge failed'))).toBe(true);
    });
  });
});
