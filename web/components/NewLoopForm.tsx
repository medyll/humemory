import { useState, type FormEvent } from 'react';
import type { TriggerSpec } from '../../src/core/types.js';
import { parseCueArg, CueArgError } from '../../src/core/cue-arg.js';

export interface NewLoopFormProps {
  defaultDirectory: string;
  onSubmit: (input: { content: string; directory: string; expiresAt?: string; cues: TriggerSpec[] }) => Promise<void>;
}

/**
 * Arming a loop.
 *
 * Cues are typed in the same syntax as on the command line
 * (`event:file_open:src/a.ts`, `cron:0 9 * * 1`) and go through the same parser.
 * One syntax to learn, one parser to test.
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
      setError('Describe the loop: this is what you will reread in three weeks.');
      return;
    }

    // Validated before sending: a malformed cue would be stored and would never wake anything.
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
        <label htmlFor="loop-content">Loop to open</label>
        <input
          id="loop-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="refactor token validation"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="loop-directory">Mental place</label>
          <input id="loop-directory" value={directory} onChange={(e) => setDirectory(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="loop-expires">Deadline (optional)</label>
          <input
            id="loop-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
      </div>

      <div className="field">
        <label htmlFor="loop-cues">Triggers — one per line</label>
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
        {busy ? 'Arming…' : 'Arm the loop'}
      </button>
    </form>
  );
}
