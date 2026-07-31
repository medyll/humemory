/**
 * Routes HTTP de la mémoire prospective — Phase 5.4.
 *
 * Sous-routeur monté par `src/api/server.ts`. Il prend son store en paramètre
 * plutôt que d'en ouvrir un au chargement du module : c'est ce qui le rend
 * testable sans toucher la DB de production (cf. docs/TESTING.md).
 */

import { Hono } from 'hono';
import type { SQLiteStore } from '../store/sqlite.js';
import { SqliteCueResolver, loopId } from '../core/cues.js';
import type { AppEvent } from '../core/event-bus.js';
import type {
  Cue,
  Intention,
  IntentionStatus,
  CueStatus,
  CueKind,
  TriggerSpec,
} from '../core/types.js';
import type { Clock } from '../core/clock.js';

const INTENTION_STATUSES: IntentionStatus[] = ['armed', 'fired', 'closed', 'expired'];
const CUE_STATUSES: CueStatus[] = ['armed', 'fired', 'cancelled'];
const CUE_KINDS: CueKind[] = ['time', 'event'];
const EVENT_TYPES = ['file_open', 'branch_switch', 'error_pattern', 'commit'] as const;

/** Erreur de validation d'entrée — remontée en 400 plutôt qu'en 500. */
class BadRequest extends Error {}

function parseStatuses<T extends string>(raw: string | undefined, allowed: T[]): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = values.filter((v) => !allowed.includes(v as T));
  if (invalid.length) throw new BadRequest(`Statut inconnu: ${invalid.join(', ')}`);
  return values as T[];
}

function parseLimit(raw: string | undefined, fallback = 50): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new BadRequest('limit doit être un entier entre 1 et 500');
  }
  return n;
}

/**
 * Valide un déclencheur venu du réseau. On ne fait pas confiance au JSON entrant :
 * un `triggerSpec` mal formé serait stocké tel quel et ne réveillerait jamais rien.
 */
export function validateTriggerSpec(raw: unknown): TriggerSpec {
  if (!raw || typeof raw !== 'object') throw new BadRequest('triggerSpec requis');
  const spec = raw as Record<string, unknown>;

  if (spec.kind === 'time') {
    const { at, cron } = spec;
    if (at === undefined && cron === undefined) {
      throw new BadRequest('un cue time exige "at" (ISO) ou "cron"');
    }
    if (at !== undefined) {
      if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) {
        throw new BadRequest('"at" doit être une date ISO valide');
      }
    }
    if (cron !== undefined && typeof cron !== 'string') {
      throw new BadRequest('"cron" doit être une chaîne');
    }
    return { kind: 'time', ...(at ? { at: at as string } : {}), ...(cron ? { cron: cron as string } : {}) };
  }

  if (spec.kind === 'event') {
    switch (spec.type) {
      case 'file_open':
        if (typeof spec.path !== 'string' || !spec.path) throw new BadRequest('"path" requis');
        return { kind: 'event', type: 'file_open', path: spec.path };
      case 'branch_switch':
        if (typeof spec.branch !== 'string' || !spec.branch) throw new BadRequest('"branch" requis');
        return { kind: 'event', type: 'branch_switch', branch: spec.branch };
      case 'error_pattern':
        if (typeof spec.pattern !== 'string' || !spec.pattern) throw new BadRequest('"pattern" requis');
        return { kind: 'event', type: 'error_pattern', pattern: spec.pattern };
      default:
        throw new BadRequest('type d\'event inconnu (file_open | branch_switch | error_pattern)');
    }
  }

  throw new BadRequest('kind doit valoir "time" ou "event"');
}

/** Valide un event poussé sur `POST /events`. */
export function validateAppEvent(raw: unknown): AppEvent {
  if (!raw || typeof raw !== 'object') throw new BadRequest('event requis');
  const e = raw as Record<string, unknown>;

  if (typeof e.type !== 'string' || !EVENT_TYPES.includes(e.type as any)) {
    throw new BadRequest(`type doit être l'un de: ${EVENT_TYPES.join(', ')}`);
  }
  if (typeof e.directory !== 'string' || !e.directory) throw new BadRequest('"directory" requis');

  switch (e.type) {
    case 'file_open':
      if (typeof e.path !== 'string' || !e.path) throw new BadRequest('"path" requis');
      return { type: 'file_open', path: e.path, directory: e.directory };
    case 'branch_switch':
      if (typeof e.branch !== 'string' || !e.branch) throw new BadRequest('"branch" requis');
      return { type: 'branch_switch', branch: e.branch, directory: e.directory };
    case 'error_pattern':
      if (typeof e.text !== 'string' || !e.text) throw new BadRequest('"text" requis');
      return { type: 'error_pattern', text: e.text, directory: e.directory };
    default:
      if (typeof e.sha !== 'string' || !e.sha) throw new BadRequest('"sha" requis');
      return {
        type: 'commit',
        sha: e.sha,
        message: typeof e.message === 'string' ? e.message : '',
        files: Array.isArray(e.files) ? (e.files.filter((f) => typeof f === 'string') as string[]) : [],
        directory: e.directory,
      };
  }
}

/** Forme JSON d'une intention : on expose l'identifiant court, c'est lui que l'humain manipule. */
function serializeIntention(intention: Intention) {
  return { ...intention, loopId: loopId(intention.id) };
}

function serializeCue(cue: Cue) {
  return cue;
}

export interface IntentionRoutesOptions {
  clock?: Clock;
}

export function createIntentionRoutes(store: SQLiteStore, options: IntentionRoutesOptions = {}) {
  const app = new Hono();
  const resolver = new SqliteCueResolver(store, { clock: options.clock });

  // Une entrée invalide est une erreur du client, pas du serveur.
  const guard = async (c: any, fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  app.post('/intentions', (c) =>
    guard(c, async () => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.content !== 'string' || !body.content.trim()) {
        throw new BadRequest('"content" requis');
      }
      if (typeof body.directory !== 'string' || !body.directory) {
        throw new BadRequest('"directory" requis');
      }

      let expiresAt: Date | undefined;
      if (body.expiresAt) {
        expiresAt = new Date(body.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) throw new BadRequest('"expiresAt" invalide');
      }

      const cues: TriggerSpec[] = Array.isArray(body.cues)
        ? body.cues.map((spec: unknown) => validateTriggerSpec(spec))
        : [];

      const intention = await store.addIntention(
        {
          content: body.content.trim(),
          directory: body.directory,
          expiresAt,
          relatedMemoryId: typeof body.relatedMemoryId === 'string' ? body.relatedMemoryId : undefined,
        },
        cues
      );

      return c.json({ intention: serializeIntention(intention) }, 201);
    })
  );

  app.get('/intentions', (c) =>
    guard(c, async () => {
      const status = parseStatuses(c.req.query('status'), INTENTION_STATUSES);
      const directory = c.req.query('directory');
      const limit = parseLimit(c.req.query('limit'));

      const intentions = await store.listIntentions({ status, directory, limit });
      return c.json({ intentions: intentions.map(serializeIntention), count: intentions.length });
    })
  );

  app.get('/intentions/:id', (c) =>
    guard(c, async () => {
      const intention = await store.getIntention(c.req.param('id'));
      if (!intention) return c.json({ error: 'Intention introuvable' }, 404);

      const cues = await store.listCues({ intentionId: intention.id });
      return c.json({ intention: serializeIntention(intention), cues: cues.map(serializeCue) });
    })
  );

  /** Ferme une boucle. Les cues restants sont annulés — sinon ils réveilleraient un fantôme. */
  app.post('/intentions/:id/close', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention introuvable' }, 404);

      const body = await c.req.json().catch(() => ({}));
      const intention = await store.updateIntentionStatus(id, 'closed', {
        closedByCommit: typeof body?.commit === 'string' ? body.commit : undefined,
      });

      for (const cue of await store.listCues({ intentionId: id, status: 'armed' })) {
        await store.updateCueStatus(cue.id, 'cancelled');
      }

      return c.json({ intention: serializeIntention(intention) });
    })
  );

  /** Force-fire, utile en debug et pour le dashboard. */
  app.post('/intentions/:id/fire', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention introuvable' }, 404);

      const intention = await store.updateIntentionStatus(id, 'fired');
      return c.json({ intention: serializeIntention(intention) });
    })
  );

  app.delete('/intentions/:id', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention introuvable' }, 404);

      await store.deleteIntention(id); // les cues partent en cascade
      return c.json({ success: true });
    })
  );

  app.post('/cues', (c) =>
    guard(c, async () => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.intentionId !== 'string') throw new BadRequest('"intentionId" requis');
      if (!(await store.getIntention(body.intentionId))) {
        return c.json({ error: 'Intention introuvable' }, 404);
      }

      const cue = await store.addCue({
        intentionId: body.intentionId,
        triggerSpec: validateTriggerSpec(body.triggerSpec),
      });
      return c.json({ cue: serializeCue(cue) }, 201);
    })
  );

  app.get('/cues', (c) =>
    guard(c, async () => {
      const status = parseStatuses(c.req.query('status'), CUE_STATUSES);
      const kindRaw = c.req.query('kind');
      if (kindRaw && !CUE_KINDS.includes(kindRaw as CueKind)) {
        throw new BadRequest('kind doit valoir "time" ou "event"');
      }

      const cues = await store.listCues({
        intentionId: c.req.query('intentionId'),
        status,
        kind: kindRaw as CueKind | undefined,
        limit: parseLimit(c.req.query('limit')),
      });
      return c.json({ cues: cues.map(serializeCue), count: cues.length });
    })
  );

  /** Pousse un event : le resolver réveille les boucles qui matchent. */
  app.post('/events', (c) =>
    guard(c, async () => {
      const event = validateAppEvent(await c.req.json().catch(() => null));

      const fired: Intention[] = [];
      for (const cue of await resolver.resolveEventCues(event)) {
        fired.push(await resolver.fire(cue.id));
      }

      return c.json({ event, fired: fired.map(serializeIntention), count: fired.length });
    })
  );

  /** Passe le balai : expire les boucles périmées, tire les cues temporels échus. */
  app.post('/cues/resolve', (c) =>
    guard(c, async () => {
      const expired = await resolver.expireStale();

      const fired: Intention[] = [];
      for (const cue of await resolver.resolveTimeCues()) {
        fired.push(await resolver.fire(cue.id));
      }

      return c.json({ expired, fired: fired.map(serializeIntention), count: fired.length });
    })
  );

  return app;
}
