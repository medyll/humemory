import { useCallback, useState } from 'react';
import { LoopsTab } from './components/LoopsTab.tsx';
import { TracesTab } from './components/TracesTab.tsx';
import { ReplayTab } from './components/ReplayTab.tsx';
import { ImperativeView } from './components/ImperativeView.tsx';
import { getApiToken, setApiToken } from './api/client.ts';

/**
 * Memory palace — React application.
 *
 * Two families of tabs. Some are ordinary React (traces, loops). The others
 * delegate to an imperative view (d3, three.js) loaded on demand: three.js and d3
 * weigh hundreds of kilobytes, and there is no reason to serve them to someone
 * who never visits the galaxy.
 */

type TabId = 'loops' | 'traces' | 'river' | 'galaxy' | 'replay' | 'promenade';

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'loops', label: '🔁 Loops' },
  { id: 'traces', label: '📊 Traces' },
  { id: 'river', label: '🌊 River' },
  { id: 'galaxy', label: '🌌 Galaxy' },
  { id: 'replay', label: '🔄 Replay' },
  { id: 'promenade', label: '🚶 Walk' },
];

export function App() {
  const [tab, setTab] = useState<TabId>('loops');
  const [focusedMemory, setFocusedMemory] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState(getApiToken());
  const [showTokenField, setShowTokenField] = useState(false);

  // Clicking a trace in a visualisation sends you to the tab that knows how to
  // show it, rather than duplicating the detail modal in every view.
  const onSelectMemory = useCallback((id: string) => {
    setFocusedMemory(id);
    setTab('traces');
  }, []);

  return (
    <div className="app">
      <header className="app-header">
        <h1>
          <span aria-hidden="true">🧠</span> Memory palace
        </h1>
        <p className="tagline">humemory — traces that decay, loops that come back</p>
        <button
          type="button"
          className="token-toggle"
          title="API token (only needed when the server sets HUMEMORY_API_TOKEN)"
          onClick={() => setShowTokenField((v) => !v)}
        >
          🔑
        </button>
        {showTokenField && (
          <form
            className="token-form"
            onSubmit={(e) => {
              e.preventDefault();
              setApiToken(tokenDraft.trim());
              setShowTokenField(false);
            }}
          >
            <input
              type="password"
              value={tokenDraft}
              onChange={(e) => setTokenDraft(e.target.value)}
              placeholder="HUMEMORY_API_TOKEN"
              autoComplete="off"
            />
            <button type="submit">Save</button>
          </form>
        )}
      </header>

      <nav className="tab-nav" role="tablist" aria-label="Views">
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
            label="the river of time"
            height={600}
            load={() => import('./viz/river.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}

        {tab === 'galaxy' && (
          <ImperativeView
            viewKey="galaxy"
            label="the memory galaxy"
            height={700}
            load={() => import('./viz/galaxy.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}

        {tab === 'promenade' && (
          <ImperativeView
            viewKey="promenade"
            label="the 3D walk"
            height={700}
            load={() => import('./viz/promenade.js').then((m) => ({ mount: m.createMount({ onSelectMemory }) }))}
          />
        )}
      </main>
    </div>
  );
}
