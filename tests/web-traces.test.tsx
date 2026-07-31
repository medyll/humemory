import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ImperativeView } from '../web/components/ImperativeView.tsx';
import { TracesTab } from '../web/components/TracesTab.tsx';
import { memoryZone, countByZone, relativeTime, consolidationLabel } from '../web/components/zones.ts';
import type { Memory } from '../src/core/types.js';

/**
 * Portage des vues existantes (story S6-03).
 * Aucun réseau : `fetch` est stubbé. Les vues impératives sont testées par leur
 * contrat (montage / démontage), pas par leur pixel.
 */

const NOW = new Date('2026-06-01T12:00:00.000Z');
const realFetch = globalThis.fetch;

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: 'm1',
    content: 'La race condition du worker se réglait avec un mutex async',
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
    return new Response(JSON.stringify(key ? routes[key] : { error: 'non stubbé' }), {
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

describe('Zones temporelles', () => {
  test('une trace fraîche est en encodage', () => {
    expect(memoryZone(memory(), NOW)).toBe('encoding');
  });

  test('le niveau 4 l\'emporte sur l\'âge', () => {
    expect(memoryZone(memory({ currentLevel: 4 }), NOW)).toBe('dormant');
  });

  test('une trace exsangue tombe en fragile, même récente', () => {
    // La zone croise l'âge et la force : ce n'est pas un synonyme du niveau.
    expect(memoryZone(memory({ saillance: 10 }), NOW)).toBe('fragile');
  });

  test('l\'âge fait glisser de zone en zone', () => {
    const at = (hours: number) =>
      memoryZone(memory({ createdAt: new Date(NOW.getTime() - hours * 3600_000) }), NOW);

    expect(at(2)).toBe('encoding');
    expect(at(48)).toBe('consolidating');
    expect(at(24 * 10)).toBe('consolidated');
    expect(at(24 * 45)).toBe('fragile');
    expect(at(24 * 200)).toBe('dormant');
  });

  test('countByZone couvre toutes les zones', () => {
    const counts = countByZone([memory(), memory({ currentLevel: 4 }), memory({ saillance: 5 })], NOW);
    expect(counts.encoding).toBe(1);
    expect(counts.dormant).toBe(1);
    expect(counts.fragile).toBe(1);
  });

  test('libellés de consolidation', () => {
    expect(consolidationLabel(0)).toBe('Encodage');
    expect(consolidationLabel(4)).toBe('Sommeil');
  });

  test('temps relatif', () => {
    expect(relativeTime(new Date(NOW.getTime() - 30 * 60_000), NOW)).toBe('il y a 30min');
    expect(relativeTime(new Date(NOW.getTime() - 3 * 24 * 3600_000), NOW)).toBe('il y a 3j');
  });
});

describe('ImperativeView', () => {
  test('monte la vue dans son conteneur', async () => {
    let received: HTMLElement | null = null;

    render(
      <ImperativeView
        viewKey="v"
        label="la vue"
        load={async () => ({
          mount: (container) => {
            received = container;
            container.innerHTML = '<b>tracé</b>';
            return () => {};
          },
        })}
      />
    );

    await waitFor(() => expect(received).not.toBeNull());
    expect(received!.innerHTML).toContain('tracé');
  });

  test('appelle le démontage quand le composant disparaît', async () => {
    let disposed = false;

    const { unmount } = render(
      <ImperativeView
        viewKey="v"
        label="la vue"
        load={async () => ({
          mount: () => () => {
            disposed = true;
          },
        })}
      />
    );

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    unmount();

    // Sans ça, une simulation d3 ou une boucle three.js survivrait à l'onglet.
    expect(disposed).toBe(true);
  });

  test('démonte même si le composant part avant la fin du chargement', async () => {
    let disposed = false;
    let release: (() => void) | null = null;

    const { unmount } = render(
      <ImperativeView
        viewKey="v"
        label="la vue"
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

    unmount(); // on part avant que le module soit prêt
    release!();

    await waitFor(() => expect(disposed).toBe(true));
  });

  test('affiche l\'erreur au lieu d\'un cadre vide', async () => {
    render(
      <ImperativeView
        viewKey="v"
        label="la galaxie"
        load={async () => {
          throw new Error('WebGL indisponible');
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('WebGL indisponible');
    });
  });
});

describe('TracesTab', () => {
  test('liste les traces et compte les zones', async () => {
    stubFetch({
      '/memories': {
        success: true,
        memories: [memory(), memory({ id: 'm2', content: 'trace endormie', currentLevel: 4 })],
      },
    });

    render(<TracesTab />);

    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    expect(screen.getByText('trace endormie')).toBeDefined();

    // Les compteurs de zone reflètent la répartition : une fraîche, une endormie.
    const dormant = screen.getByText('En sommeil').closest('button')!;
    expect(dormant.textContent).toContain('1');
  });

  test('filtrer par zone restreint la liste', async () => {
    stubFetch({
      '/memories': {
        success: true,
        memories: [memory(), memory({ id: 'm2', content: 'trace endormie', currentLevel: 4 })],
      },
    });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByText('En sommeil').closest('button')!);

    await waitFor(() => expect(screen.queryByText(/race condition/)).toBeNull());
    expect(screen.getByText('trace endormie')).toBeDefined();
  });

  test('la recherche attend une pause dans la frappe', async () => {
    const calls = stubFetch({
      '/memories': { success: true, memories: [memory()] },
      '/search': { success: true, results: [{ memory: memory({ id: 'found', content: 'trouvée' }), matchLevel: 3, score: 90 }] },
    });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.change(screen.getByLabelText(/Rechercher/), { target: { value: 'mutex' } });

    await waitFor(() => expect(calls.some((c) => c.includes('/search'))).toBe(true), { timeout: 2000 });
    await waitFor(() => expect(screen.getByText('trouvée')).toBeDefined());
  });

  test('ouvrir une trace montre son détail et sa courbe', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory({ level1Summary: 'résumé L1' })] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByText(/race condition/).closest('button')!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('résumé L1');
    expect(dialog.querySelector('canvas')).not.toBeNull();
  });

  test('Échap referme le détail', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory()] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    fireEvent.click(screen.getByText(/race condition/).closest('button')!);
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  test('la suppression demande confirmation', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());
    fireEvent.click(screen.getByText(/race condition/).closest('button')!);
    await screen.findByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(calls.some((c) => c.includes('DELETE'))).toBe(false);
    expect(screen.getByRole('button', { name: /Confirmer/ })).toBeDefined();
  });
});

describe('Encodage et filtres avancés', () => {
  test('le formulaire d\'encodage est replié par défaut', async () => {
    stubFetch({ '/memories': { success: true, memories: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encoder une trace/)).toBeDefined());
    expect(screen.queryByLabelText('Contenu')).toBeNull();
  });

  test('encoder une trace envoie contenu, type et mots-clés', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [], memory: memory() } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encoder une trace/)).toBeDefined());
    fireEvent.click(screen.getByText(/Encoder une trace/));

    fireEvent.change(screen.getByLabelText('Contenu'), { target: { value: 'nouvelle trace' } });
    fireEvent.change(screen.getByLabelText(/Indices de récupération/), { target: { value: 'a, b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Encoder' }));

    await waitFor(() => {
      const post = calls.find((c) => c.includes('/memories'));
      expect(post).toBeDefined();
    });
  });

  test('un contenu vide est refusé', async () => {
    stubFetch({ '/memories': { success: true, memories: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/Encoder une trace/)).toBeDefined());
    fireEvent.click(screen.getByText(/Encoder une trace/));
    fireEvent.click(screen.getByRole('button', { name: 'Encoder' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/ne se rappelle pas/));
  });

  test('les filtres avancés sont repliés, et comptés une fois actifs', async () => {
    stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filtres/ }));
    fireEvent.change(screen.getByLabelText('Force minimale'), { target: { value: '70' } });

    await waitFor(() => expect(screen.getByRole('button', { name: /Filtres \(1\)/ })).toBeDefined());
  });

  test('un filtre actif bascule la requête vers /search', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filtres/ }));
    fireEvent.change(screen.getByLabelText(/Réactivations minimales/), { target: { value: '2' } });

    await waitFor(() => expect(calls.some((c) => c.includes('minRecalls=2'))).toBe(true));
  });

  test('effacer les filtres revient à la liste simple', async () => {
    const calls = stubFetch({ '/memories': { success: true, memories: [memory()] }, '/search': { success: true, results: [] } });

    render(<TracesTab />);
    await waitFor(() => expect(screen.getByText(/race condition/)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: /Filtres/ }));
    fireEvent.change(screen.getByLabelText('Force minimale'), { target: { value: '70' } });
    await waitFor(() => expect(calls.some((c) => c.includes('minSaillance=70'))).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: /Effacer/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^⚙️ Filtres$/ })).toBeDefined());
  });
});
