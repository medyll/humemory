import { useState, type FormEvent } from 'react';
import type { MemoryType } from '../../src/core/types.js';
import { api } from '../api/client.js';

/**
 * Encodage manuel d'une trace — portage de `showAddModal`/`addMemory`.
 *
 * L'original ouvrait une modale ; ici c'est un panneau repliable, parce qu'une
 * modale qui ne fait qu'un formulaire coupe la vue pour rien.
 */

const TYPES: Array<{ value: MemoryType; label: string }> = [
  { value: 'semantic', label: '📖 Sémantique' },
  { value: 'episodic', label: '📅 Épisodique' },
  { value: 'procedural', label: '⚡ Procédurale' },
];

export function NewTraceForm({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [directory, setDirectory] = useState('');
  const [keywords, setKeywords] = useState('');
  const [memoryType, setMemoryType] = useState<MemoryType>('semantic');
  const [photographic, setPhotographic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!content.trim()) {
      setError('Une trace sans contenu ne se rappelle pas.');
      return;
    }

    setBusy(true);
    try {
      await api.createMemory({
        content: content.trim(),
        directory: directory.trim() || undefined,
        keywords: keywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean),
        memoryType,
        photographic,
      });
      setContent('');
      setKeywords('');
      setPhotographic(false);
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="new-trace-toggle">
        + Encoder une trace
      </button>
    );
  }

  return (
    <form className="new-loop" onSubmit={submit}>
      <div className="field">
        <label htmlFor="trace-content">Contenu</label>
        <textarea
          id="trace-content"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Ce qu'il faudra se rappeler…"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="trace-directory">Lieu mental</label>
          <input
            id="trace-directory"
            value={directory}
            onChange={(e) => setDirectory(e.target.value)}
            placeholder="/src/auth"
          />
        </div>
        <div className="field">
          <label htmlFor="trace-type">Type</label>
          <select id="trace-type" value={memoryType} onChange={(e) => setMemoryType(e.target.value as MemoryType)}>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="field">
        <label htmlFor="trace-keywords">Indices de récupération (séparés par des virgules)</label>
        <input
          id="trace-keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="auth, token, middleware"
        />
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={photographic}
          onChange={(e) => setPhotographic(e.target.checked)}
        />
        🔒 Mode photographique — cette trace ne se dégradera jamais
      </label>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="loop-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Encodage…' : 'Encoder'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Annuler
        </button>
      </div>
    </form>
  );
}
