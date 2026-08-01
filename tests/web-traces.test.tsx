import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ImperativeView } from '../web/components/ImperativeView.tsx';
import { TracesTab } from '../web/components/TracesTab.tsx';
import { memoryZone, countByZone, relativeTime, consolidationLabel } from '../web/components/zones.ts';
import type { Memory } from '../src/core/types.js';

/**
 * Port of the existing views (story S6-03).
 * No network: `fetch` is stubbed. Imperative views are tested through their
 * contract (mount / unmount), not their pixels.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const realFetch = globalThis.fetch;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    content: 'The worker race condition was fixed with an async mutex',
    directory: '/src/core',
    day: '2026-06-01',
    keywords: ['race', 'mutex'],
    sessionId: 's1',
    memoryType: 'semantic',
    createdAt: new Date('2026-06-01T10:00:00.000Z'),
    recallCount: 2,
    decayRate: 0.5,
    currentLevel: 0,
    saillance: 80,
    ...overrides,
  } as Memory;
}

function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: any) => {
    const url = String(input);
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? routes[key] : { error: 'not stubbed' }), {
      status: key ? 200 : 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

beforeEach(() => cleanup());
afterEach(() => {
  globalThis.fetch = realFetch;
  cleanup();
});

describe('Temporal zones', () => {
  test('a fresh trace is in encoding', () => {
    expect(memoryZone(memory(), NOW)).toBe('encoding');
  });

  test('level 4 wins over age', () => {
    expect(memoryZone(memory({ currentLevel: 4 }), NOW)).toBe('dormant');
  });

  test('a drained trace lands in fragile, however recent', () => {
    // The zone crosses age and strength: it is not a synonym for the level.
    expect(memoryZone(memory({ saillance: 10 }), NOW)).toBe('fragile');
  });

  test('age slides a trace from zone to zone', () => {
    const at = (hours: number) =>
      memoryZone(memory({ createdAt: new Date(NOW.getTime() - hours * 3600_000) }), NOW);

    expect(at(2)).toBe('encoding');
    expect(at(48)).toBe('consolidating');
    expect(at(24 * 10)).toBe('consolidated');
    expect(at(24 * 45)).toBe('fragile');
    expect(at(24 * 200)).toBe('dormant');
  });

  test('countByZone covers every zone', () => {
    const counts = countByZone([memory(), memory({ currentLevel: 4 }), memory({ saillance: 5 })], NOW);
    expect(counts.encoding).toBe(1);
    expect(counts.dormant).toBe(1);
    expect(counts.fragile).toBe(1);
  });

  test('consolidation labels', () => {
    expect(consolidationLabel(0)).toBe('Encoding');
    expect(consolidationLabel(4)).toBe('Dormant');
  });

  test('relative time', () => {
    expect(relativeTime(new Date(NOW.getTime() - 30 * 60_000), NOW)).toBe('30min ago');
    expect(relativeTime(new Date(NOW.getTime() - 3 * 24 * 3600_000), NOW)).toBe('3d ago');
  });
});

describe('ImperativeView', () => {
  test('mounts the view inside its container', async () => {
    let received: HTMLElement | null = null;

    render(
      <ImperativeView
        viewKey="v"
        label="the view"
        load={async () => ({
          mount: (container) => {
            received = container;
            container.innerHTML = '<b>drawn</b>';
            return () => {};
          },
        })}
      />
    );

    await waitFor(() => expect(received).not.toBeNull());
    expect(received!.innerHTML).toContain('drawn');
  });

  test('calls the teardown when the component goes away', async () => {
    let disposed = false;

    const { unmount } = render(
      <ImperativeView
        viewKey="v"
        label="the view"
        load={async () => ({
          mount: () => () => {
            disposed = true;
          },
        })}
      />
    );

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    unmount();

    // Without this, a d3 simulation or a three.js loop would outlive the tab.
    expect(disposed).toBe(true);
  });

  test('tears down even when the component leaves mid-load', async () => {
    let disposed = false;
    let release: (() => void) | null = null;

    const { unmount } = render(
      <ImperativeView
        viewKey="v"
        label="the view"
        load={() =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                mount: () => () => {
                  disposed = true;
                },
              });
          })
        }
      />
    );

    unmount(); // leaving before the module is ready
    release!();

    await waitFor(() => expect(disposed).toBe(true));
  });

  test('shows the error instead of an empty frame', async () => {
    render(
      <ImperativeView
        viewKey="v"
        label="the galaxy"
        load={async () => {
          throw new Error('WebGL unavailable');
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('WebGL unavailable');
    });
  });
});

describe('TracesTab', () => {
  test('lists traces and counts the zones', async () => {
    stubFetch({
      '/memories': {
        success: true,
        memories: [memory(), memory({ id: 'm2', content: 'dormant trace', currentLevel: 4 })],
      },
    });

    render(<TracesTab />);

    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    expect(screen.getByText('dormant trace')).toBeDefined();

    // Zone counters reflect the split: one fresh, one dormant.
    const dormant = screen.getByText('Dormant').closest('button')!;
    expect(dormant.textContent).toContain('1');
  });

  test('filtering by zone narrows the list', async () => {
    stubFetch({
      '/memories': {
        success: true,
        memories: [memory(), memory({ id: 'm2', content: 'dormant trace', currentLevel: 4 })],
      },
    });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByText('Dormant').closest('button')!);

    await waitFor(() => expect(screen.queryByText(/race condition/)).toBeNull());
    expect(screen.getByText('dormant trace')).toBeDefined();
  });

  test('the search waits for a pause in typing', async () => {
    const calls = stubFetch({
      '/memories': { success: true, memories: [memory()] },
      '/search': { success: true, results: [{ memory: memory({ id: 'found', content: 'found it' }), matchLevel: 3, score: 90 }] },
    });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Search a trace/), { target: { value: 'mutex' } });

    await waitFor(() => expect(calls.some((c) => c.includes('/search'))).toBe(true), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('found it')).toBeDefined());
  });

  test('opening a trace shows its detail and its curve', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory({ level1Summary: 'L1 summary' })] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByText(/race condition/).closest('button')!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('L1 summary');
    expect(dialog.querySelector('canvas')).not.toBeNull();
  });

  test('Escape closes the detail', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory()] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    fireEvent.click(screen.getByText(/race condition/).closest('button')!);
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('deletion asks for confirmation', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    fireEvent.click(screen.getByText(/race condition/).closest('button')!);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(calls.some((c) => c.includes('DELETE'))).toBe(false);
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeDefined();
  });
});

describe('Encoding and advanced filters', () => {
  test('the encoding form is collapsed by default', async () => {
    stubFetch({ '/memories': { success: true, memories: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encode a trace/)).toBeDefined());
    expect(screen.queryByLabelText('Content')).toBeNull();
  });

  test('encoding a trace sends content, type and keywords', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [], memory: memory() } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encode a trace/)).toBeDefined());
    fireEvent.click(screen.getByText(/Encode a trace/));

    fireEvent.change(screen.getByLabelText('Content'), { target: { value: 'new trace' } });
    fireEvent.change(screen.getByLabelText(/Retrieval cues/), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Encode' }));

    await waitFor(() => {
      const post = calls.find((c) => c.includes('/memories'));
      expect(post).toBeDefined();
    });
  });

  test('empty content is refused', async () => {
    stubFetch({ '/memories': { success: true, memories: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encode a trace/)).toBeDefined());
    fireEvent.click(screen.getByText(/Encode a trace/));
    fireEvent.click(screen.getByRole('button', { name: 'Encode' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/cannot be recalled/));
  });

  test('advanced filters are collapsed, and counted once active', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText('Minimum strength'), { target: { value: '70' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Filters \(1\)/ })).toBeDefined());
  });

  test('an active filter switches the query to /search', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText(/Minimum recalls/), { target: { value: '2' } });

    await waitFor(() => expect(calls.some((c) => c.includes('minRecalls=2'))).toBe(true));
  });

  test('clearing the filters returns to the plain list', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
    fireEvent.change(screen.getByLabelText('Minimum strength'), { target: { value: '70' } });
    await waitFor(() => expect(calls.some((c) => c.includes('minSaillance=70'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Clear filters/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^⚙️ Filters$/ })).toBeDefined());
  });
});
