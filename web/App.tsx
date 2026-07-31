import { useCallback, useState } from 'react';
import { LoopsTab } from './components/LoopsTab.tsx';
import { TracesTab } from './components/TracesTab.tsx';
import { ReplayTab } from './components/ReplayTab.tsx';
import { ImperativeView } from './components/ImperativeView.tsx';

/**
 * Palais de mémoire — application React.
 *
 * Deux familles d'onglets. Les uns sont du React ordinaire (traces, boucles).
 * Les autres délèguent à une vue impérative (d3, three.js) chargée à la demande :
 * three.js et d3 pèsent plusieurs centaines de kilo-octets, rien ne justifie de
 * les servir à quelqu'un qui ne visite jamais la galaxie.
 */

type TabId = 'loops' | 'traces' | 'river' | 'galaxy' | 'replay' | 'promenade';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'loops', label: '🔁 Boucles' },
  { id: 'traces', label: '📊 Traces' },
  { id: 'river', label: '🌊 Rivière' },
  { id: 'galaxy', label: '🌌 Galaxie' },
  { id: 'replay', label: '🔄 Rejeu' },
  { id: 'promenade', label: '🚶 Promenade' },
];

export function App() {
  const [tab, setTab] = useState<TabId>('loops');
  const [focusedMemory, setFocusedMemory] = useState<string | null>(null);

  // Cliquer une trace dans une visualisation renvoie vers l'onglet qui sait
  // l'afficher, plutôt que de dupliquer la modale de détail dans chaque vue.
  const onSelectMemory = useCallback((id: string) => {
    setFocusedMemory(id);
    setTab('traces');
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span aria-hidden="true">🧠</span> Palais de mémoire
        </h1>
        <p className="tagline">humemory — traces qui se dégradent, boucles qui reviennent</p>
      </header>

      <nav className="tab-nav" role="tablist" aria-label="Vues">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'loops' && <LoopsTab />}
        {tab === 'traces' && <TracesTab initialSelection={focusedMemory} />}
        {tab === 'replay' && <ReplayTab />}

        {tab === 'river' && (
          <ImperativeView
            viewKey="river"
            label="la rivière du temps"
            height={600}
            load={() => import('./viz/river.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}

        {tab === 'galaxy' && (
          <ImperativeView
            viewKey="galaxy"
            label="la galaxie mnésique"
            height={700}
            load={() => import('./viz/galaxy.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}

        {tab === 'promenade' && (
          <ImperativeView
            viewKey="promenade"
            label="la promenade 3D"
            height={700}
            load={() => import('./viz/promenade.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}
      </main>
    </div>
  );
}
