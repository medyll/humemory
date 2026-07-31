import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { LoopTension } from '../web/components/LoopTension.tsx';
import { LoopCard } from '../web/components/LoopCard.tsx';
import { NewLoopForm } from '../web/components/NewLoopForm.tsx';
import { hydrateIntention, type IntentionView } from '../web/api/hydrate.ts';
import type { Cue } from '../src/core/types.js';

/**
 * Onglet prospectif (story S6-02). Composants isolés, aucun réseau.
 */

const T0 = new Date('2026-01-01T00:00:00.000Z');

function view(overrides: Record<string, unknown> = {}): IntentionView {
  return hydrateIntention({
    id: 'a1b2c3d4-0000-0000-0000-000000000000',
    loopId: 'loop-a1b2c3d4',
    content: 'Refactorer la validation de token',
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
  test('une boucle ouverte reste à 100, même un an plus tard', () => {
    render(<LoopTension intention={view()} now={new Date('2027-01-01T00:00:00Z')} />);

    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText(/figée/)).toBeDefined();
  });

  test('une boucle remontée se relâche avec les jours', () => {
    const fired = view({ status: 'fired', firedAt: T0.toISOString() });
    render(<LoopTension intention={fired} now={new Date('2026-01-03T00:00:00Z')} />);

    // La valeur vient d'intentionSaillance, la même fonction que le back : 2j → 80.
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('80');
  });

  test('une boucle fermée est à plat', () => {
    render(<LoopTension intention={view({ status: 'closed' })} now={T0} />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0');
  });
});

describe('LoopCard', () => {
  test('affiche identifiant, contenu, lieu et déclencheurs', () => {
    render(
      <LoopCard intention={view()} cues={[cue()]} now={T0} onClose={noop} onFire={noop} onDelete={noop} />
    );

    expect(screen.getByText('loop-a1b2c3d4')).toBeDefined();
    expect(screen.getByText('Refactorer la validation de token')).toBeDefined();
    expect(screen.getByText(/src\/auth\/service\.ts/)).toBeDefined();
  });

  test('signale une échéance dépassée avant même le balai', () => {
    const overdue = view({ expiresAt: '2025-12-31T00:00:00.000Z' });
    render(
      <LoopCard intention={overdue} cues={[]} now={T0} onClose={noop} onFire={noop} onDelete={noop} />
    );

    expect(screen.getByText(/échéance dépassée/)).toBeDefined();
  });

  test('la fermeture remonte l\'identifiant de la boucle', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    await waitFor(() => expect(closed).toEqual(['a1b2c3d4-0000-0000-0000-000000000000']));
  });

  test('la suppression demande confirmation — jamais en un clic', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(deleted).toEqual([]); // rien encore

    fireEvent.click(screen.getByRole('button', { name: /Confirmer/ }));
    await waitFor(() => expect(deleted.length).toBe(1));
  });

  test('« Réveiller » est désactivé sans cue armé', () => {
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

    expect(screen.getByRole('button', { name: 'Réveiller' }).hasAttribute('disabled')).toBe(true);
  });

  test('une boucle fermée n\'offre plus d\'action', () => {
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

    expect(screen.queryByRole('button', { name: 'Fermer' })).toBeNull();
    expect(screen.getByText(/fermée par deadbee/)).toBeDefined();
  });
});

describe('NewLoopForm', () => {
  test('refuse une boucle sans contenu', async () => {
    const submitted: unknown[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.click(screen.getByRole('button', { name: /Armer/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(submitted).toEqual([]);
  });

  test('parse les cues au format CLI, un par ligne', async () => {
    const submitted: any[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.change(screen.getByLabelText(/Boucle à ouvrir/), { target: { value: 'refactor X' } });
    fireEvent.change(screen.getByLabelText(/Déclencheurs/), {
      target: { value: 'event:file_open:src/a.ts\ncron:0 9 * * 1' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Armer/ }));

    await waitFor(() => expect(submitted.length).toBe(1));
    expect(submitted[0].cues).toEqual([
      { kind: 'event', type: 'file_open', path: 'src/a.ts' },
      { kind: 'time', cron: '0 9 * * 1' },
    ]);
  });

  test('un cue mal formé est refusé avant l\'envoi', async () => {
    const submitted: unknown[] = [];
    render(<NewLoopForm defaultDirectory="/src" onSubmit={async (i) => void submitted.push(i)} />);

    fireEvent.change(screen.getByLabelText(/Boucle à ouvrir/), { target: { value: 'x' } });
    fireEvent.change(screen.getByLabelText(/Déclencheurs/), { target: { value: 'telepathie:demain' } });
    fireEvent.click(screen.getByRole('button', { name: /Armer/ }));

    // Stocker un cue invalide donnerait une boucle qui ne se réveille jamais.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('préfixe inconnu'));
    expect(submitted).toEqual([]);
  });

  test('une erreur du serveur est affichée, pas avalée', async () => {
    render(
      <NewLoopForm
        defaultDirectory="/src"
        onSubmit={async () => {
          throw new Error('base indisponible');
        }}
      />
    );

    fireEvent.change(screen.getByLabelText(/Boucle à ouvrir/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /Armer/ }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('base indisponible'));
  });
});
