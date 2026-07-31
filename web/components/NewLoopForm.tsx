import { useState, type FormEvent } from 'react';
import type { TriggerSpec } from '../../src/core/types.js';
import { parseCueArg, CueArgError } from '../../src/core/cue-arg.js';

export interface NewLoopFormProps {
  defaultDirectory: string;
  onSubmit: (input: { content: string; directory: string; expiresAt?: string; cues: TriggerSpec[] }) => Promise<void>;
}

/**
 * Armement d'une boucle.
 *
 * Les cues se saisissent au même format qu'en ligne de commande
 * (`event:file_open:src/a.ts`, `cron:0 9 * * 1`) et passent par le même parseur.
 * Une seule syntaxe à apprendre, un seul parseur à tester.
 */
export function NewLoopForm({ defaultDirectory, onSubmit }: NewLoopFormProps) {
  const [content, setContent] = useState('');
  const [directory, setDirectory] = useState(defaultDirectory);
  const [expiresAt, setExpiresAt] = useState('');
  const [cuesRaw, setCuesRaw] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!content.trim()) {
      setError('Décris la boucle : c\'est ce que tu reliras dans trois semaines.');
      return;
    }

    // Validé avant l'envoi : un cue mal formé serait stocké et ne réveillerait rien.
    let cues: TriggerSpec[];
    try {
      cues = cuesRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map(parseCueArg);
    } catch (err) {
      setError(err instanceof CueArgError ? err.message : String(err));
      return;
    }

    setBusy(true);
    try {
      await onSubmit({
        content: content.trim(),
        directory: directory.trim() || defaultDirectory,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
        cues,
      });
      setContent('');
      setCuesRaw('');
      setExpiresAt('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="new-loop" onSubmit={handleSubmit}>
      <div className="field">
        <label htmlFor="loop-content">Boucle à ouvrir</label>
        <input
          id="loop-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="refactorer la validation de token"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="loop-directory">Lieu mental</label>
          <input id="loop-directory" value={directory} onChange={(e) => setDirectory(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="loop-expires">Échéance (facultative)</label>
          <input
            id="loop-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="loop-cues">Déclencheurs — un par ligne</label>
        <textarea
          id="loop-cues"
          rows={3}
          value={cuesRaw}
          onChange={(e) => setCuesRaw(e.target.value)}
          placeholder={'event:file_open:src/auth/service.ts\ncron:0 9 * * 1\ntime:2026-12-31'}
        />
      </div>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <button type="submit" disabled={busy}>
        {busy ? 'Armement…' : 'Armer la boucle'}
      </button>
    </form>
  );
}
