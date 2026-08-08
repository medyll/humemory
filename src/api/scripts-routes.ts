/**
 * HTTP routes for cognitive scripts — Phase 8.3.
 *
 * Sub-router mounted by `src/api/server.ts`, same testability contract as
 * intentions-routes.ts: the store comes in as a parameter, never opened here.
 *
 * Trust gate (8.3): anything arriving over HTTP is agent-authored and lands
 * as a DRAFT — a header is a claim, not a fact (6.0.1 identity rule). Only
 * the human `activate` call flips a draft to active; drafts never fire.
 */

import { Hono } from 'hono';
import type { SQLiteStore } from '../store/sqlite.js';
import type { Script, ScriptStatus, TriggerSpec } from '../core/types.js';
import { validateTriggerSpec } from './intentions-routes.js';

const SCRIPT_STATUSES: ScriptStatus[] = ['draft', 'active', 'archived'];

/** Input validation error — surfaced as a 400 rather than a 500. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest'; // subclasses default to 'Error' — see guard
  }
}

function serializeScript(script: Script) {
  return { ...script, shortId: script.id.slice(0, 8) };
}

function validateSteps(raw: unknown): string[] {
  if (!Array.isArray(raw) || !raw.length) throw new BadRequest('"steps" must be a non-empty array');
  const steps = raw.map((s) => (typeof s === 'string' ? s.trim() : ''));
  if (steps.some((s) => !s)) throw new BadRequest('every step must be a non-empty string');
  return steps;
}

export function createScriptRoutes(store: SQLiteStore) {
  const app = new Hono();

  const guard = async (c: any, fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      // validateTriggerSpec throws intentions-routes' own BadRequest class —
      // instanceof would miss it across module boundaries, so match by name.
      if (err instanceof Error && err.name === 'BadRequest') {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  /** Unambiguous prefix match — humans handle short ids, like dream review. */
  const findByPrefix = async (prefix: string): Promise<Script | null> => {
    const direct = await store.getScript(prefix);
    if (direct) return direct;
    const all = await store.listScripts({ status: SCRIPT_STATUSES, limit: 500 });
    const hits = all.filter((s) => s.id.startsWith(prefix));
    return hits.length === 1 ? hits[0] : null;
  };

  app.post('/scripts', (c) =>
    guard(c, async () => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.name !== 'string' || !body.name.trim()) {
        throw new BadRequest('"name" is required');
      }
      if (typeof body.description !== 'string' || !body.description.trim()) {
        throw new BadRequest('"description" is required');
      }
      if (typeof body.directory !== 'string' || !body.directory) {
        throw new BadRequest('"directory" is required');
      }
      const steps = validateSteps(body.steps);
      const cues: TriggerSpec[] = Array.isArray(body.cues)
        ? body.cues.map((spec: unknown) => validateTriggerSpec(spec))
        : [];

      const script = await store.addScript(
        {
          name: body.name.trim(),
          description: body.description.trim(),
          steps,
          directory: body.directory,
          pinned: body.pinned === true,
          // HTTP = agent claim → draft, always (8.3). No source override.
          source: 'agent',
          agent: c.req.header('X-Humemory-Agent') || undefined,
        },
        cues
      );

      return c.json({ script: serializeScript(script) }, 201);
    })
  );

  app.get('/scripts', (c) =>
    guard(c, async () => {
      const raw = c.req.query('status');
      let status: ScriptStatus[] | undefined;
      if (raw) {
        const values = raw.split(',').map((s) => s.trim());
        const invalid = values.filter((v) => !SCRIPT_STATUSES.includes(v as ScriptStatus));
        if (invalid.length) throw new BadRequest(`Unknown status: ${invalid.join(', ')}`);
        status = values as ScriptStatus[];
      }
      const scripts = await store.listScripts({
        status,
        directory: c.req.query('directory'),
        limit: 500,
      });
      return c.json({ scripts: scripts.map(serializeScript), count: scripts.length });
    })
  );

  app.get('/scripts/:id', (c) =>
    guard(c, async () => {
      const script = await findByPrefix(c.req.param('id'));
      if (!script) return c.json({ error: 'Script not found' }, 404);
      const cues = await store.listCues({ targetKind: 'script', targetId: script.id });
      return c.json({ script: serializeScript(script), cues });
    })
  );

  app.post('/scripts/:id/activate', (c) =>
    guard(c, async () => {
      const script = await findByPrefix(c.req.param('id'));
      if (!script) return c.json({ error: 'Script not found' }, 404);
      return c.json({ script: serializeScript(await store.updateScriptStatus(script.id, 'active')) });
    })
  );

  app.post('/scripts/:id/archive', (c) =>
    guard(c, async () => {
      const script = await findByPrefix(c.req.param('id'));
      if (!script) return c.json({ error: 'Script not found' }, 404);
      return c.json({ script: serializeScript(await store.updateScriptStatus(script.id, 'archived')) });
    })
  );

  app.post('/scripts/:id/fire', (c) =>
    guard(c, async () => {
      const script = await findByPrefix(c.req.param('id'));
      if (!script) return c.json({ error: 'Script not found' }, 404);
      if (script.status !== 'active') {
        return c.json({ error: `Script is ${script.status} — only active drills fire` }, 409);
      }
      return c.json({ script: serializeScript(await store.markScriptFired(script.id)) });
    })
  );

  return app;
}
