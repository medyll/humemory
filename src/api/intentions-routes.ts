/**
 * HTTP routes for prospective memory — Phase 5.4.
 *
 * Sub-router mounted by `src/api/server.ts`. It takes its store as a parameter
 * rather than opening one at module load: that is what makes it testable without
 * touching the production database (see docs/TESTING.md).
 */

import { Hono } from 'hono';
import type { SQLiteStore } from '../store/sqlite.js';
import {
  SqliteCueResolver,
  loopId,
  isDangerousPattern,
  MAX_PATTERN_LENGTH,
  MAX_MATCH_TEXT_LENGTH,
} from '../core/cues.js';
import {
  LimitExceeded,
  boundedString,
  MAX_CONTENT_LENGTH,
  MAX_SHORT_FIELD_LENGTH,
  MAX_COLLECTION_ITEMS,
} from './limits.js';
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

/** Input validation error — surfaced as a 400 rather than a 500. */
class BadRequest extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BadRequest'; // scripts-routes matches on this across module boundaries
  }
}

function parseStatuses<T extends string>(raw: string | undefined, allowed: T[]): T[] | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const invalid = values.filter((v) => !allowed.includes(v as T));
  if (invalid.length) throw new BadRequest(`Unknown status: ${invalid.join(', ')}`);
  return values as T[];
}

function parseLimit(raw: string | undefined, fallback = 50): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 500) {
    throw new BadRequest('limit must be an integer between 1 and 500');
  }
  return n;
}

/**
 * Validates a trigger coming off the network. Incoming JSON is not trusted: a
 * malformed `triggerSpec` would be stored as is and would never wake anything.
 */
export function validateTriggerSpec(raw: unknown): TriggerSpec {
  if (!raw || typeof raw !== 'object') throw new BadRequest('triggerSpec is required');
  const spec = raw as Record<string, unknown>;

  if (spec.kind === 'time') {
    const { at, cron } = spec;
    if (at === undefined && cron === undefined) {
      throw new BadRequest('a time cue requires "at" (ISO) or "cron"');
    }
    if (at !== undefined) {
      if (typeof at !== 'string' || Number.isNaN(new Date(at).getTime())) {
        throw new BadRequest('"at" must be a valid ISO date');
      }
    }
    if (cron !== undefined && typeof cron !== 'string') {
      throw new BadRequest('"cron" must be a string');
    }
    return { kind: 'time', ...(at ? { at: at as string } : {}), ...(cron ? { cron: cron as string } : {}) };
  }

  if (spec.kind === 'event') {
    switch (spec.type) {
      case 'file_open':
        if (typeof spec.path !== 'string' || !spec.path) throw new BadRequest('"path" is required');
        return { kind: 'event', type: 'file_open', path: spec.path };
      case 'branch_switch':
        if (typeof spec.branch !== 'string' || !spec.branch) throw new BadRequest('"branch" is required');
        return { kind: 'event', type: 'branch_switch', branch: spec.branch };
      case 'error_pattern':
        if (typeof spec.pattern !== 'string' || !spec.pattern) throw new BadRequest('"pattern" is required');
        // SECURITY_AUDIT.md M-01: refuse oversized/backtracking-prone patterns here
        // rather than silently degrading them to a literal search at match time.
        if (spec.pattern.length > MAX_PATTERN_LENGTH) {
          throw new BadRequest(`"pattern" must be at most ${MAX_PATTERN_LENGTH} characters`);
        }
        if (isDangerousPattern(spec.pattern)) {
          throw new BadRequest('"pattern" contains a nested quantifier that risks catastrophic backtracking');
        }
        return { kind: 'event', type: 'error_pattern', pattern: spec.pattern };
      default:
        throw new BadRequest('unknown event type (file_open | branch_switch | error_pattern)');
    }
  }

  throw new BadRequest('kind must be "time" or "event"');
}

/** Validates an event pushed to `POST /events`. */
export function validateAppEvent(raw: unknown): AppEvent {
  if (!raw || typeof raw !== 'object') throw new BadRequest('event is required');
  const e = raw as Record<string, unknown>;

  if (typeof e.type !== 'string' || !EVENT_TYPES.includes(e.type as any)) {
    throw new BadRequest(`type must be one of: ${EVENT_TYPES.join(', ')}`);
  }
  if (typeof e.directory !== 'string' || !e.directory) throw new BadRequest('"directory" is required');

  switch (e.type) {
    case 'file_open':
      if (typeof e.path !== 'string' || !e.path) throw new BadRequest('"path" is required');
      return { type: 'file_open', path: e.path, directory: e.directory };
    case 'branch_switch':
      if (typeof e.branch !== 'string' || !e.branch) throw new BadRequest('"branch" is required');
      return { type: 'branch_switch', branch: e.branch, directory: e.directory };
    case 'error_pattern':
      if (typeof e.text !== 'string' || !e.text) throw new BadRequest('"text" is required');
      if (e.text.length > MAX_MATCH_TEXT_LENGTH) {
        throw new BadRequest(`"text" must be at most ${MAX_MATCH_TEXT_LENGTH} characters`);
      }
      return { type: 'error_pattern', text: e.text, directory: e.directory };
    default:
      if (typeof e.sha !== 'string' || !e.sha) throw new BadRequest('"sha" is required');
      return {
        type: 'commit',
        sha: e.sha,
        message: typeof e.message === 'string' ? e.message : '',
        files: Array.isArray(e.files) ? (e.files.filter((f) => typeof f === 'string') as string[]) : [],
        directory: e.directory,
      };
  }
}

/** JSON shape of an intention: the short id is exposed, since that is what humans handle. */
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

  // Invalid input is the client's error, not the server's — including a value
  // that busts a size limit (SECURITY_AUDIT.md M-02).
  const guard = async (c: any, fn: () => Promise<Response>): Promise<Response> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BadRequest || err instanceof LimitExceeded) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  };

  app.post('/intentions', (c) =>
    guard(c, async () => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.content !== 'string' || !body.content.trim()) {
        throw new BadRequest('"content" is required');
      }
      if (typeof body.directory !== 'string' || !body.directory) {
        throw new BadRequest('"directory" is required');
      }

      // SECURITY_AUDIT.md M-02: bound the stored fields and the cue collection.
      const content = boundedString(body.content, MAX_CONTENT_LENGTH, 'content');
      const directory = boundedString(body.directory, MAX_SHORT_FIELD_LENGTH, 'directory');

      let expiresAt: Date | undefined;
      if (body.expiresAt) {
        expiresAt = new Date(body.expiresAt);
        if (Number.isNaN(expiresAt.getTime())) throw new BadRequest('"expiresAt" is invalid');
      }

      if (Array.isArray(body.cues) && body.cues.length > MAX_COLLECTION_ITEMS) {
        throw new BadRequest(`"cues" must hold at most ${MAX_COLLECTION_ITEMS} items`);
      }
      const cues: TriggerSpec[] = Array.isArray(body.cues)
        ? body.cues.map((spec: unknown) => validateTriggerSpec(spec))
        : [];

      const intention = await store.addIntention(
        {
          content: content.trim(),
          directory,
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
      if (!intention) return c.json({ error: 'Intention not found' }, 404);

      const cues = await store.listCues({ intentionId: intention.id });
      return c.json({ intention: serializeIntention(intention), cues: cues.map(serializeCue) });
    })
  );

  /** Closes a loop. Remaining cues are cancelled — otherwise they would wake a ghost. */
  app.post('/intentions/:id/close', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention not found' }, 404);

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

  /** Force-fire, useful for debugging and for the dashboard. */
  app.post('/intentions/:id/fire', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention not found' }, 404);

      const intention = await store.updateIntentionStatus(id, 'fired');
      return c.json({ intention: serializeIntention(intention) });
    })
  );

  app.delete('/intentions/:id', (c) =>
    guard(c, async () => {
      const id = c.req.param('id');
      if (!(await store.getIntention(id))) return c.json({ error: 'Intention not found' }, 404);

      await store.deleteIntention(id); // cues cascade away
      return c.json({ success: true });
    })
  );

  app.post('/cues', (c) =>
    guard(c, async () => {
      const body = await c.req.json().catch(() => null);
      if (!body || typeof body.intentionId !== 'string') throw new BadRequest('"intentionId" is required');
      if (!(await store.getIntention(body.intentionId))) {
        return c.json({ error: 'Intention not found' }, 404);
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
        throw new BadRequest('kind must be "time" or "event"');
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

  /** Pushes an event: the resolver wakes the loops that match. */
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

  /** Sweeps: expires overdue loops, fires due time cues. */
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
