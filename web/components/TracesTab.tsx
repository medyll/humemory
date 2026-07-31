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
 * Onglet Traces — portage JSX de `public/js/dashboard.js`.
 *
 * C'est la seule vue du portage à être réécrite plutôt que wrappée : elle était
 * faite de chaînes `innerHTML` et de `onclick` en attribut, ce qui se traduit
 * directement en composants. Les visualisations, elles, restent impératives.
 */

function StrengthDots({ saillance }: { saillance: number }) {
  return (
    <span className="strength-dots" aria-label={`Force ${saillance} sur 100`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} className={saillance >= i * 20 ? 'strength-dot active' : 'strength-dot'} />
      ))}
    </span>
  );
}

/** Courbe d'oubli d'une trace : canvas piloté à la main, comme les autres viz. */
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

  // Échap ferme : une modale qui ne se ferme qu'à la souris est une impasse.
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
      <div className="modal" role="dialog" aria-modal="true" aria-label="Détail de la trace" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <span className="cue-tag">
            {icon} {label}
          </span>
          <span className="cue-tag">{consolidationLabel(memory.currentLevel)}</span>
          {memory.photographic && <span className="photo-badge">🔒 Photographique</span>}
          <button type="button" className="secondary" onClick={onClose} aria-label="Fermer">
            ✕
          </button>
        </header>

        <p className="modal-content">{memory.content}</p>

        <dl className="modal-meta">
          <div><dt>Lieu</dt><dd>{memory.directory}</dd></div>
          <div><dt>Session</dt><dd>{memory.sessionId}</dd></div>
          <div><dt>Encodée</dt><dd>{new Date(memory.createdAt).toLocaleString('fr-FR')}</dd></div>
          <div><dt>Réactivations</dt><dd>{memory.recallCount}</dd></div>
          <div><dt>Force</dt><dd>{memory.saillance}/100</dd></div>
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
            🔄 Réactiver
          </button>
          <button type="button" className="secondary" onClick={() => onTogglePhoto(memory.id, !memory.photographic)}>
            {memory.photographic ? '🔓 Laisser se dégrader' : '🔒 Mode photographique'}
          </button>
          <button type="button" className="secondary" onClick={() => setShowSimilar((v) => !v)}>
            🔍 Similaires
          </button>
          {confirmingDelete ? (
            <button type="button" className="danger" onClick={() => onDelete(memory.id)}>
              Confirmer la suppression
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => setConfirmingDelete(true)}>
              Supprimer
            </button>
          )}
        </div>

        {showSimilar && <SimilarPanel memory={memory} onMerged={onMerged} />}
      </div>
    </div>
  );
}

export interface TracesTabProps {
  /** Trace à ouvrir d'emblée — utilisé quand on clique une trace dans une visualisation. */
  initialSelection?: string | null;
}

export function TracesTab({ initialSelection = null }: TracesTabProps) {
  const [zone, setZone] = useState<Zone | null>(null);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selected, setSelected] = useState<string | null>(initialSelection);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<SearchFilters>({});

  // Une nouvelle trace désignée depuis une visualisation ouvre son détail.
  useEffect(() => {
    if (initialSelection) setSelected(initialSelection);
  }, [initialSelection]);

  // La recherche part quand la frappe se calme, pas à chaque touche.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const activeFilters = Object.values(filters).filter((v) => v !== undefined && v !== '').length;

  const traces = useAsync(async () => {
    // Les filtres avancés passent par /search, qui sait les appliquer ; sans
    // requête ni filtre, une simple liste suffit.
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
          placeholder="Rechercher par indice de récupération…"
          aria-label="Rechercher une trace"
        />
        <button
          type="button"
          className={activeFilters > 0 ? 'tab active' : 'tab'}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          ⚙️ Filtres{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </button>
      </div>

      {showFilters && (
        <div className="advanced-filters">
          <div className="field">
            <label htmlFor="f-from">Encodée après</label>
            <input id="f-from" type="date" value={filters.dateFrom ?? ''} onChange={(e) => setFilter({ dateFrom: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-to">Encodée avant</label>
            <input id="f-to" type="date" value={filters.dateTo ?? ''} onChange={(e) => setFilter({ dateTo: e.target.value || undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-saillance">Force minimale</label>
            <input id="f-saillance" type="number" min={0} max={100} value={filters.minSaillance ?? ''} onChange={(e) => setFilter({ minSaillance: e.target.value ? Number(e.target.value) : undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-recalls">Réactivations minimales</label>
            <input id="f-recalls" type="number" min={0} value={filters.minRecalls ?? ''} onChange={(e) => setFilter({ minRecalls: e.target.value ? Number(e.target.value) : undefined })} />
          </div>
          <div className="field">
            <label htmlFor="f-directory">Lieu mental</label>
            <input id="f-directory" value={filters.directory ?? ''} onChange={(e) => setFilter({ directory: e.target.value || undefined })} />
          </div>
          <button type="button" className="secondary" onClick={() => setFilters({})}>
            Effacer les filtres
          </button>
        </div>
      )}

      {traces.loading && <p role="status">Chargement…</p>}
      {traces.error && (
        <p role="alert" className="error">
          {traces.error.message}
        </p>
      )}
      {!traces.loading && shown.length === 0 && <p className="empty">Aucune trace ici.</p>}

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
