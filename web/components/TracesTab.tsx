import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Memory } from '../../src/core/types.js';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';
import { renderDecayCurve } from '../viz/decay-curve.js';
import { SimilarPanel } from './SimilarPanel.tsx';
import { NewTraceForm } from './NewTraceForm.tsx';
import type { SearchFilters } from '../api/client.js';
import {
  ZONES,
  ZONE_ORDER,
  memoryZone,
  countByZone,
  consolidationLabel,
  typeMeta,
  relativeTime,
  type Zone,
} from './zones.js';

/**
 * Traces tab — JSX port of `public/js/dashboard.js`.
 *
 * The only view of the port that was rewritten rather than wrapped: it was made
 * of `innerHTML` strings and `onclick` attributes, which translate directly into
 * components. The visualisations stay imperative.
 */

function StrengthDots({ saillance }: { saillance: number }) {
  return (
    <span className="strength-dots" aria-label={`Strength ${saillance} out of 100`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={saillance >= i * 20 ? 'strength-dot active' : 'strength-dot'} />
      ))}
    </span>
  );
}

/** A trace's forgetting curve: a hand-driven canvas, like the other visualisations. */
function DecayCurve({ memory }: { memory: Memory }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (ref.current) renderDecayCurve(memory, ref.current);
  }, [memory]);

  return <canvas ref={ref} width={520} height={220} className="decay-canvas" />;
}

function MemoryDetail({
  memory,
  onClose,
  onRecall,
  onTogglePhoto,
  onDelete,
  onMerged,
}: {
  memory: Memory;
  onClose: () => void;
  onRecall: (id: string) => void;
  onTogglePhoto: (id: string, enable: boolean) => void;
  onDelete: (id: string) => void;
  onMerged: () => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showSimilar, setShowSimilar] = useState(false);

  // Escape closes: a modal you can only dismiss with the mouse is a dead end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { icon, label } = typeMeta(memory.memoryType);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Trace detail" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="cue-tag">
            {icon} {label}
          </span>
          <span className="cue-tag">{consolidationLabel(memory.currentLevel)}</span>
          {memory.photographic && <span className="photo-badge">🔒 Photographic</span>}
          <button type="button" className="secondary" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <p className="modal-content">{memory.content}</p>

        <dl className="modal-meta">
          <div><dt>Place</dt><dd>{memory.directory}</dd></div>
          <div><dt>Session</dt><dd>{memory.sessionId}</dd></div>
          <div><dt>Encoded</dt><dd>{new Date(memory.createdAt).toLocaleString()}</dd></div>
          <div><dt>Recalls</dt><dd>{memory.recallCount}</dd></div>
          <div><dt>Strength</dt><dd>{memory.saillance}/100</dd></div>
        </dl>

        {memory.level1Summary && (
          <div className="levels">
            <p><strong>L1</strong> {memory.level1Summary}</p>
            {memory.level2Essential && <p><strong>L2</strong> {memory.level2Essential}</p>}
            {memory.level3Keywords && <p><strong>L3</strong> {memory.level3Keywords}</p>}
          </div>
        )}

        <DecayCurve memory={memory} />

        <div className="modal-actions">
          <button type="button" onClick={() => onRecall(memory.id)}>
            🔄 Recall
          </button>
          <button type="button" className="secondary" onClick={() => onTogglePhoto(memory.id, !memory.photographic)}>
            {memory.photographic ? '🔓 Let it decay' : '🔒 Photographic mode'}
          </button>
          <button type="button" className="secondary" onClick={() => setShowSimilar((v) => !v)}>
            🔍 Similar
          </button>
          {confirmingDelete ? (
            <button type="button" className="danger" onClick={() => onDelete(memory.id)}>
              Confirm deletion
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmingDelete(true)}>
              Delete
            </button>
          )}
        </div>

        {showSimilar && <SimilarPanel memory={memory} onMerged={onMerged} />}
      </div>
    </div>
  );
}

export interface TracesTabProps {
  /** Trace to open straight away — used when clicking a trace in a visualisation. */
  initialSelection?: string | null;
}

export function TracesTab({ initialSelection = null }: TracesTabProps) {
  const [zone, setZone] = useState<Zone | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({});

  // A trace pointed at from a visualisation opens its detail.
  useEffect(() => {
    if (initialSelection) setSelected(initialSelection);
  }, [initialSelection]);

  // The search fires once typing settles, not on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const activeFilters = Object.values(filters).filter((v) => v !== undefined && v !== '').length;

  const traces = useAsync(async () => {
    // Advanced filters go through /search, which knows how to apply them; with
    // neither query nor filter, a plain list is enough.
    if (debounced || activeFilters > 0) {
      const { results } = await api.search(debounced || '*', { limit: 100, ...filters });
      return results.map((r) => r.memory);
    }
    const { memories } = await api.listMemories({ limit: 200 });
    return memories;
  }, [debounced, JSON.stringify(filters)]);

  const now = useMemo(() => new Date(), [traces.data]);
  const all = traces.data ?? [];
  const counts = useMemo(() => countByZone(all, now), [all, now]);
  const shown = zone ? all.filter((m) => memoryZone(m, now) === zone) : all;
  const current = all.find((m) => m.id === selected) ?? null;

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      await fn();
      setSelected(null);
      traces.reload();
    },
    [traces]
  );

  const setFilter = (patch: SearchFilters) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="traces-tab">
      <NewTraceForm onCreated={() => traces.reload()} />

      <div className="zones">
        {ZONE_ORDER.map((z) => (
          <button
            key={z}
            type="button"
            className={zone === z ? `zone-card zone-${z} active` : `zone-card zone-${z}`}
            aria-pressed={zone === z}
            onClick={() => setZone(zone === z ? null : z)}
          >
            <span className="zone-count">{counts[z]}</span>
            <span className="zone-label">{ZONES[z].label}</span>
          </button>
        ))}
      </div>

      <div className="search-row">
        <input
          className="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by retrieval cue…"
          aria-label="Search a trace"
        />
        <button
          type="button"
          className={activeFilters > 0 ? 'tab active' : 'tab'}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          ⚙️ Filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>
      </div>

      {showFilters && (
        <div className="advanced-filters">
          <div className="field">
            <label htmlFor="f-from">Encoded after</label>
            <input id="f-from" type="date" value={filters.dateFrom ?? ''} onChange={(e) => setFilter({ dateFrom: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Encoded before</label>
            <input id="f-to" type="date" value={filters.dateTo ?? ''} onChange={(e) => setFilter({ dateTo: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-saillance">Minimum strength</label>
            <input id="f-saillance" type="number" min={0} max={100} value={filters.minSaillance ?? ''} onChange={(e) => setFilter({ minSaillance: e.target.value ? Number(e.target.value) : undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-recalls">Minimum recalls</label>
            <input id="f-recalls" type="number" min={0} value={filters.minRecalls ?? ''} onChange={(e) => setFilter({ minRecalls: e.target.value ? Number(e.target.value) : undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-directory">Mental place</label>
            <input id="f-directory" value={filters.directory ?? ''} onChange={(e) => setFilter({ directory: e.target.value || undefined })} />
          </div>
          <button type="button" className="secondary" onClick={() => setFilters({})}>
            Clear filters
          </button>
        </div>
      )}

      {traces.loading && <p role="status">Loading…</p>}
      {traces.error && (
        <p role="alert" className="error">
          {traces.error.message}
        </p>
      )}
      {!traces.loading && shown.length === 0 && <p className="empty">No trace here.</p>}

      <ul className="memory-list">
        {shown.map((memory) => {
          const { icon, label } = typeMeta(memory.memoryType);
          return (
            <li
              key={memory.id}
              className={memory.photographic ? 'memory-item is-photographic' : 'memory-item'}
            >
              <button type="button" className="memory-open" onClick={() => setSelected(memory.id)}>
                <span
                  className={`memory-state ${memoryZone(memory, now)}`}
                  title={consolidationLabel(memory.currentLevel)}
                />
                <span className="memory-body">
                  <span className="memory-text">
                    {memory.content.slice(0, 200)}
                    {memory.content.length > 200 ? '…' : ''}
                  </span>
                  <span className="memory-meta">
                    <span>🕐 {relativeTime(memory.createdAt, now)}</span>
                    <span>🔁 {memory.recallCount}</span>
                    <StrengthDots saillance={memory.saillance} />
                    <span className="cue-tag">
                      {icon} {label}
                    </span>
                    {memory.photographic && <span className="photo-badge">🔒</span>}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {current && (
        <MemoryDetail
          memory={current}
          onClose={() => setSelected(null)}
          onRecall={(id) => act(() => api.recallMemory(id))}
          onTogglePhoto={(id, enable) => act(() => api.setPhotographic(id, enable))}
          onDelete={(id) => act(() => api.deleteMemory(id))}
          onMerged={() => act(async () => {})}
        />
      )}
    </div>
  );
}
