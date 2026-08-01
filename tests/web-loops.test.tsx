import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { LoopTension } from '../web/components/LoopTension.tsx';
import { LoopCard } from '../web/components/LoopCard.tsx';
import { NewLoopForm } from '../web/components/NewLoopForm.tsx';
import { hydrateIntention, type IntentionView } from '../web/api/hydrate.ts';
import type { Cue } from '../src/core/types.js';

/**
 * Prospective tab (story S6-02). Isolated components, no network.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');

function view(overrides: Record<string, unknown> = {}): IntentionView {
  return hydrateIntention({
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    loopId: 'loop-a1b2c3d4',
    content: 'Refactor token validation',
    directory: '/src/auth',
    status: 'armed',
    saillance: 100,
    createdAt: T0.toISOString(),
    ...overrides,
  } as any);
}

function cue(overrides: Partial<Cue> = {}): Cue {
  return {
    id: 'cue-1',
    intentionId: 'a1b2c3d4-0000-0000-0000-000000000000',
    kind: 'event',
    triggerSpec: { kind: 'event', type: 'file_open', path: 'src/auth/service.ts' },
    status: 'armed',
    armedAt: T0,
    ...overrides,
  } as Cue;
}

const noop = async () => {};

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('LoopTension', () => {
  test('an open loop stays at 100, even a year later', () => {
    render(<LoopTension intention={view()} now={new Date('2027-01-01T00:00:00Z')} />);

    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText(/pinned/)).toBeDefined();
  });

  test('a surfaced loop relaxes as days pass', () => {
    const fired = view({ status: 'fired', firedAt: T0.toISOString() });
    render(<LoopTension intention={fired} now={new Date('2026-01-03T00:00:00Z')} />);

    // The value comes from intentionSaillance, the same function the backend uses: 2d → 80.
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('80');
  });

  test('a closed loop is flat', () => {
    render(<LoopTension intention={view({ status: 'closed' })} now={T0} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('LoopCard', () => {
  test('shows the id, content, place and triggers', () => {
    render(
      <LoopCard intention={view()} cues={[cue()]} now={T0} onClose={noop} onFire={noop} onDelete={noop} />
    );

    expect(screen.getByText('loop-a1b2c3d4')).toBeDefined();
    expect(screen.getByText('Refactor token validation')).toBeDefined();
    expect(screen.getByText(/src\/auth\/service\.ts/)).toBeDefined();
  });

  test('flags a passed deadline before the sweep even runs', () => {
    const overdue = view({ expiresAt: '2025-12-31T00:00:00.000Z' });
    render(
      <LoopCard intention={overdue} cues={[]} now={T0} onClose={noop} onFire={noop} onDelete={noop} />
    );

    expect(screen.getByText(/deadline passed/)).toBeDefined();
  });

  test('closing reports the loop id back', async () => {
    const closed: string[] = [];
    render(
      <LoopCard
        intention={view()}
        cues={[]}
        now={T0}
        onClose={async (id) => {
          closed.push(id);
        }}
        onFire={noop}
        onDelete={noop}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(closed).toEqual(['a1b2c3d4-0000-0000-0000-000000000000']));
  });

  test('deletion asks for confirmation — never one click', async () => {
    const deleted: string[] = [];
    render(
      <LoopCard
        intention={view()}
        cues={[]}
        now={T0}
        onClose={noop}
        onFire={noop}
        onDelete={async (id) => {
          deleted.push(id);
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(deleted).toEqual([]); // nothing yet

    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    await waitFor(() => expect(deleted.length).toBe(1));
  });

  test('"Wake" is disabled when no cue is armed', () => {
    render(
      <LoopCard
        intention={view()}
        cues={[cue({ status: 'cancelled' })]}
        now={T0}
        onClose={noop}
        onFire={noop}
        onDelete={noop}
      />
    );

    expect(screen.getByRole('button', { name: 'Wake' }).hasAttribute('disabled')).toBe(true);
  });

  test('a closed loop offers no more actions', () => {
    render(
      <LoopCard
        intention={view({ status: 'closed', closedByCommit: 'deadbeef123' })}
        cues={[]}
        now={T0}
        onClose={noop}
        onFire={noop}
        onDelete={noop}
      />
    );

    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
    expect(screen.getByText(/closed by deadbee/)).toBeDefined();
  });
});

describe('NewLoopForm', () => {
  test('refuses a loop with no content', async () => {
    const submitted: unknown[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.click(screen.getByRole('button', { name: /Arm/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(submitted).toEqual([]);
  });

  test('parses cues in CLI format, one per line', async () => {
    const submitted: any[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.change(screen.getByLabelText(/Loop to open/), { target: { value: 'refactor X' } });
    fireEvent.change(screen.getByLabelText(/Triggers/), {
      target: { value: 'event:file_open:src/a.ts\ncron:0 9 * * 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Arm/ }));

    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].cues).toEqual([
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
  });

  test('a malformed cue is refused before sending', async () => {
    const submitted: unknown[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.change(screen.getByLabelText(/Loop to open/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Triggers/), { target: { value: 'telepathie:demain' } });
    fireEvent.click(screen.getByRole('button', { name: /Arm/ }));

    // Storing an invalid cue would give a loop that never wakes.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unknown prefix'));
    expect(submitted).toEqual([]);
  });

  test('a server error is shown, not swallowed', async () => {
    render(
      <NewLoopForm
        defaultDirectory="/src"
        onSubmit={async () => {
          throw new Error('database unavailable');
        }}
      />
    );

    fireEvent.change(screen.getByLabelText(/Loop to open/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Arm/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('database unavailable'));
  });
});
