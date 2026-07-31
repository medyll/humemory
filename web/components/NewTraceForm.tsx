import { useState, type FormEvent } from 'react';
import type { MemoryType } from '../../src/core/types.js';
import { api } from '../api/client.js';

/**
 * Manual encoding of a trace — ported from `showAddModal`/`addMemory`.
 *
 * The original opened a modal; this is a collapsible panel, because a modal that
 * holds nothing but a form cuts the view for no reason.
 */

const TYPES: Array<{ value: MemoryType; label: string }> = [
  { value: 'semantic', label: '📖 Semantic' },
  { value: 'episodic', label: '📅 Episodic' },
  { value: 'procedural', label: '⚡ Procedural' },
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
      setError('A trace with no content cannot be recalled.');
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
        + Encode a trace
      </button>
    );
  }

  return (
    <form className="new-loop" onSubmit={submit}>
      <div className="field">
        <label htmlFor="trace-content">Content</label>
        <textarea
          id="trace-content"
          rows={3}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="What will need to be remembered…"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="trace-directory">Mental place</label>
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
        <label htmlFor="trace-keywords">Retrieval cues (comma separated)</label>
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
        🔒 Photographic mode — this trace will never decay
      </label>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <div className="loop-actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Encoding…' : 'Encode'}
        </button>
        <button type="button" className="secondary" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
