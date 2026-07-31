import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { useAsync } from '../hooks/useAsync.js';

/**
 * Rejeu d'une session — portage JSX de `public/js/replay.js`.
 *
 * Contrairement aux visualisations, il n'y a rien d'impératif ici : c'est un
 * curseur, deux listes et trois compteurs. L'original les tenait à jour à coups
 * d'`innerHTML` et de handlers `onclick` réassignés à chaque chargement de
 * session ; en JSX, l'affichage se déduit de l'index courant.
 */

export type ReplayEventType = 'encoded' | 'decayed' | 'recalled';

export interface ReplayEvent {
  type: ReplayEventType;
  content: string;
  timestamp: string;
}

const EVENT_META: Record<ReplayEventType, { icon: string; label: string }> = {
  encoded: { icon: '📥', label: 'Encodage' },
  decayed: { icon: '📉', label: 'Dégradation' },
  recalled: { icon: '🔄', label: 'Rappel' },
};

const TICK_MS = 1000;

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('fr-FR');
}

export function ReplayTab() {
  const sessions = useAsync(() => api.listSessions(), []);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);

  const available = sessions.data?.sessions ?? [];
  const current = sessionId ?? available[0]?.sessionId ?? null;

  const session = useAsync(
    async () => (current ? ((await api.getSession(current)) as { events?: ReplayEvent[] }) : null),
    [current]
  );

  const events: ReplayEvent[] = useMemo(() => session.data?.events ?? [], [session.data]);

  // Changer de session repart du début, sinon l'index d'une session longue
  // pointerait au-delà de la fin d'une session courte.
  useEffect(() => {
    setIndex(0);
    setPlaying(false);
  }, [current]);

  useEffect(() => {
    if (!playing || events.length === 0) return;

    const timer = setInterval(() => setIndex((i) => (i + 1 >= events.length ? 0 : i + 1)), TICK_MS);
    return () => clearInterval(timer);
  }, [playing, events.length]);

  const visible = events.slice(0, index + 1);
  const counts = useMemo(() => {
    const acc = { encoded: 0, decayed: 0, recalled: 0 };
    for (const e of visible) if (e.type in acc) acc[e.type]++;
    return acc;
  }, [visible]);

  const reset = useCallback(() => {
    setIndex(0);
    setPlaying(false);
  }, []);

  if (sessions.loading) return <p role="status">Chargement des sessions…</p>;
  if (sessions.error)
    return (
      <p role="alert" className="error">
        {sessions.error.message}
      </p>
    );

  if (available.length === 0) {
    return (
      <p className="empty">
        Aucune session à rejouer. Elles se créent à mesure que des traces sont encodées.
      </p>
    );
  }

  return (
    <div className="replay-tab">
      <div className="field">
        <label htmlFor="replay-session">Session</label>
        <select
          id="replay-session"
          value={current ?? ''}
          onChange={(e) => setSessionId(e.target.value)}
        >
          {available.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.sessionId} — {s.count} traces — {new Date(s.firstEvent).toLocaleDateString('fr-FR')}
            </option>
          ))}
        </select>
      </div>

      {session.loading && <p role="status">Chargement de la session…</p>}

      {!session.loading && events.length === 0 && <p className="empty">Session vide.</p>}

      {events.length > 0 && (
        <>
          <div className="replay-panes">
            <section className="replay-transcript" aria-label="Transcript">
              <h3>Transcript</h3>
              {visible
                .filter((e) => e.type === 'encoded')
                .slice(-10)
                .map((e, i) => (
                  <article key={`${e.timestamp}-${i}`} className="replay-message">
                    <time>{time(e.timestamp)}</time>
                    <p>
                      {e.content.slice(0, 150)}
                      {e.content.length > 150 ? '…' : ''}
                    </p>
                  </article>
                ))}
            </section>

            <section className="replay-events" aria-label="Événements mémoire">
              <h3>Événements mémoire</h3>
              {visible.slice(-20).map((e, i) => {
                const meta = EVENT_META[e.type] ?? { icon: '•', label: e.type };
                return (
                  <div key={`${e.timestamp}-${i}`} className={`replay-event ${e.type}`}>
                    <span aria-hidden="true">{meta.icon}</span>
                    <span className="replay-event-label">
                      {meta.label}: {e.content.slice(0, 80)}
                      {e.content.length > 80 ? '…' : ''}
                    </span>
                    <time>{time(e.timestamp)}</time>
                  </div>
                );
              })}
            </section>
          </div>

          <div className="replay-timeline">
            <button type="button" onClick={() => setPlaying((p) => !p)}>
              {playing ? '⏸ Pause' : '▶ Play'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, events.length - 1)}
              value={index}
              onChange={(e) => setIndex(Number(e.target.value))}
              aria-label="Position dans la session"
            />
            <span className="replay-position">
              {index + 1} / {events.length}
            </span>
            <button type="button" className="secondary" onClick={reset}>
              ↺ Reset
            </button>
          </div>

          <div className="replay-counts">
            <span>📥 Encodées : <strong>{counts.encoded}</strong></span>
            <span>📉 Dégradées : <strong>{counts.decayed}</strong></span>
            <span>🔄 Rappelées : <strong>{counts.recalled}</strong></span>
          </div>
        </>
      )}
    </div>
  );
}
