/**
 * Cue resolver — Phase 5.2.
 *
 * You do not search for an intention: it comes back. This module decides *when*.
 * It reads the armed cues and answers two questions, one temporal
 * (`resolveTimeCues`), one event-driven (`resolveEventCues`); then `fire()` marks
 * both cue and intention as surfaced to the agent.
 *
 * The data layer (tables, CRUD) is Phase 5.1, in `src/store/sqlite.ts`; there is
 * nothing but decisions here. See PHASE5_PLAN.md § 5.2.
 */

import type {
  Cue,
  Intention,
  IntentionStore,
  TimeTriggerSpec,
  EventTriggerSpec,
} from './types.js';
import type { AppEvent, EventBus, Unsubscribe } from './event-bus.js';
import { systemClock, type Clock } from './clock.js';

export interface CueResolver {
  /** Time cues due at `now` (not yet fired, or recurring and due again). */
  resolveTimeCues(now?: Date): Promise<Cue[]>;
  /** Event cues matching this event. */
  resolveEventCues(event: AppEvent): Promise<Cue[]>;
  /** Marks cue and intention as fired. Returns the woken intention. */
  fire(cueId: string): Promise<Intention>;
  /** Expires intentions past their deadline. Returns how many. */
  expireStale(now?: Date): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron — minimal matcher, 5 fields (minute hour day-of-month month day-of-week)
// ─────────────────────────────────────────────────────────────────────────────

const CRON_RANGES: Array<[min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // heure
  [1, 31], // jour du mois
  [1, 12], // mois
  [0, 6], // jour de la semaine, 0 = dimanche
];

/** Expands a cron field (`*`, `5`, `1-5`, `*\/15`, `1-9/2`, lists) into a value set. */
function expandCronField(field: string, index: number): Set<number> | null {
  const [min, max] = CRON_RANGES[index];
  const values = new Set<number>();

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) return null;
      lo = a;
      hi = b;
    } else {
      const n = Number(rangePart);
      if (!Number.isInteger(n)) return null;
      lo = n;
      hi = n;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  return values.size ? values : null;
}

interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

/** Parses a 5-field cron expression. Returns null when it is invalid. */
export function parseCron(expr: string): ParsedCron | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  const sets = fields.map((f, i) => expandCronField(f, i));
  if (sets.some((s) => s === null)) return null;

  const [minute, hour, dom, month, dow] = sets as Set<number>[];
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

/**
 * True when `date` (to the minute, in UTC) lands on a cron occurrence.
 *
 * When day-of-month and day-of-week are both restricted, standard cron combines
 * them with OR, not AND — `0 9 1 * 1` means "the 1st of the month **or** on a
 * Monday". That semantics is kept so nothing surprises anyone.
 */
export function cronMatches(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute.has(date.getUTCMinutes())) return false;
  if (!parsed.hour.has(date.getUTCHours())) return false;
  if (!parsed.month.has(date.getUTCMonth() + 1)) return false;

  const domHit = parsed.dom.has(date.getUTCDate());
  const dowHit = parsed.dow.has(date.getUTCDay());

  if (parsed.domRestricted && parsed.dowRestricted) return domHit || dowHit;
  if (parsed.domRestricted) return domHit;
  if (parsed.dowRestricted) return dowHit;
  return true;
}

/**
 * Cron catch-up window, in minutes (7 days).
 *
 * The resolver is not a daemon: it runs at SessionStart, so only now and then.
 * Without catch-up, an occurrence falling between two sessions would be lost. So
 * time is walked backwards minute by minute from `now` to the last known
 * reference, capped by this window — beyond it, an occurrence is considered too
 * old to be worth a wake-up.
 */
export const CRON_CATCHUP_MINUTES = 7 * 24 * 60;

/** True when a cron occurrence exists in the half-open interval (since, now]. */
export function cronDueSince(expr: string, since: Date, now: Date): boolean {
  const parsed = parseCron(expr);
  if (!parsed) return false; // invalid expression: never due, never a crash

  const MINUTE = 60_000;
  const nowMin = Math.floor(now.getTime() / MINUTE);
  const sinceMin = Math.floor(since.getTime() / MINUTE);
  const floor = Math.max(sinceMin + 1, nowMin - CRON_CATCHUP_MINUTES);

  for (let m = nowMin; m >= floor; m--) {
    if (cronMatches(parsed, new Date(m * MINUTE))) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event matching
// ─────────────────────────────────────────────────────────────────────────────

/** Normalises separators so Windows and POSIX paths match alike. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * A cue is only eligible within its mental place: the event must come from the
 * intention's `directory` or a subdirectory. Without this, a loop opened on one
 * project would wake while working on another — the database is shared across
 * projects.
 */
function directoryMatches(intentionDir: string, eventDir: string | undefined): boolean {
  if (!eventDir) return true; // event without context: no filtering
  const a = normalizePath(intentionDir).replace(/\/$/, '');
  const b = normalizePath(eventDir).replace(/\/$/, '');
  return b === a || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** Tests an error pattern. An invalid regex falls back to a literal search. */
function errorPatternMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/** True when this event trigger matches this event. */
export function eventTriggerMatches(spec: EventTriggerSpec, event: AppEvent): boolean {
  switch (spec.type) {
    case 'file_open': {
      if (event.type !== 'file_open') return false;
      const want = normalizePath(spec.path);
      const got = normalizePath(event.path);
      // Suffix accepted: a cue armed on 'src/auth/service.ts' must match an event
      // carrying the absolute path of the same file.
      return got === want || got.endsWith(`/${want}`);
    }
    case 'branch_switch':
      return event.type === 'branch_switch' && event.branch === spec.branch;
    case 'error_pattern':
      return event.type === 'error_pattern' && errorPatternMatches(spec.pattern, event.text);
    default:
      return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Short loop identity
// ─────────────────────────────────────────────────────────────────────────────

/** Length of the UUID prefix used as a readable loop identifier. */
export const LOOP_ID_LENGTH = 8;

/**
 * Short identifier shown to the agent: `loop-a1b2c3d4`. This is what a human
 * retypes into a commit message (`Closes loop-a1b2c3d4`) — a full UUID would
 * never be retyped by hand.
 */
export function loopId(intentionId: string): string {
  return `loop-${intentionId.slice(0, LOOP_ID_LENGTH)}`;
}

/** Extracts short loop ids mentioned in a text (a commit message). */
export function extractLoopIds(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\bloop-([0-9a-f]{4,36})\b/gi)) {
    found.add(m[1].toLowerCase());
  }
  return [...found];
}

/** Finds the intention a short id points to, when it is unambiguous. */
export function matchIntentionByShortId(
  intentions: Intention[],
  shortId: string
): Intention | null {
  const needle = shortId.toLowerCase();
  const hits = intentions.filter((i) => i.id.toLowerCase().startsWith(needle));
  // An ambiguous prefix closes nothing: better to do nothing than close the wrong loop.
  return hits.length === 1 ? hits[0] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decay rules for intentions
// ─────────────────────────────────────────────────────────────────────────────

/** Salience decline of a fired intention, in points per day (the Zeigarnik pull fading). */
export const INTENTION_FADE_PER_DAY = 10;

/**
 * Current salience of an intention (PHASE5_PLAN.md § 5.2):
 * - `armed`   → pinned at 100: an open loop stays salient, it does not decay
 * - `fired` and not `closed` → declines from `firedAt`: the Zeigarnik pull fades
 * - `closed`  → 0: archived, kept for history
 * - `expired` → 0: soft-deleted
 */
export function intentionSaillance(intention: Intention, now: Date): number {
  switch (intention.status) {
    case 'armed':
      return 100;
    case 'closed':
    case 'expired':
      return 0;
    case 'fired': {
      if (!intention.firedAt) return intention.saillance;
      const days = (now.getTime() - intention.firedAt.getTime()) / 86_400_000;
      return Math.max(0, Math.round(100 - days * INTENTION_FADE_PER_DAY));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolver
// ─────────────────────────────────────────────────────────────────────────────

export interface CueResolverOptions {
  clock?: Clock;
}

export class SqliteCueResolver implements CueResolver {
  private clock: Clock;

  constructor(private store: IntentionStore, options: CueResolverOptions = {}) {
    this.clock = options.clock ?? systemClock;
  }

  /**
   * A cue only wakes while its intention is still `armed`: a loop already closed,
   * expired or already surfaced must not resurface.
   */
  private async armedIntentionOf(cue: Cue): Promise<Intention | null> {
    const intention = await this.store.getIntention(cue.intentionId);
    if (!intention || intention.status !== 'armed') return null;
    return intention;
  }

  async resolveTimeCues(now: Date = this.clock.now()): Promise<Cue[]> {
    const cues = await this.store.listCues({ status: 'armed', kind: 'time', limit: 500 });
    const due: Cue[] = [];

    for (const cue of cues) {
      const spec = cue.triggerSpec as TimeTriggerSpec;
      if (spec.kind !== 'time') continue;

      let isDue = false;
      if (spec.at) {
        const at = new Date(spec.at);
        isDue = !Number.isNaN(at.getTime()) && at.getTime() <= now.getTime();
      } else if (spec.cron) {
        // Reference: the last known wake-up, otherwise the arming time.
        isDue = cronDueSince(spec.cron, cue.firedAt ?? cue.armedAt, now);
      }

      if (!isDue) continue;
      if (!(await this.armedIntentionOf(cue))) continue;
      due.push(cue);
    }

    return due;
  }

  async resolveEventCues(event: AppEvent): Promise<Cue[]> {
    // A commit does not wake an intention, it closes one — that is the
    // post-commit hook's job (S5-03b), not this resolver's.
    if (event.type === 'commit') return [];

    const cues = await this.store.listCues({ status: 'armed', kind: 'event', limit: 500 });
    const matched: Cue[] = [];

    for (const cue of cues) {
      const spec = cue.triggerSpec as EventTriggerSpec;
      if (spec.kind !== 'event') continue;
      if (!eventTriggerMatches(spec, event)) continue;

      const intention = await this.armedIntentionOf(cue);
      if (!intention) continue;
      if (!directoryMatches(intention.directory, (event as any).directory)) continue;

      matched.push(cue);
    }

    return matched;
  }

  /**
   * Marks cue and intention as fired. A cron cue is re-armed after firing: a
   * recurrence that does not re-arm is a one-shot in disguise.
   */
  async fire(cueId: string): Promise<Intention> {
    const cue = await this.store.getCue(cueId);
    if (!cue) throw new Error(`Cue ${cueId} not found`);

    const spec = cue.triggerSpec as TimeTriggerSpec;
    const recurring = spec.kind === 'time' && Boolean(spec.cron);

    await this.store.markCueFired(cueId, { rearm: recurring });
    return this.store.updateIntentionStatus(cue.intentionId, 'fired');
  }

  /**
   * Expires `armed` intentions whose `expiresAt` has passed and cancels their
   * cues — a cue outliving its intention is a ghost wake-up.
   */
  async expireStale(now: Date = this.clock.now()): Promise<number> {
    const armed = await this.store.listIntentions({ status: 'armed', limit: 500 });
    let expired = 0;

    for (const intention of armed) {
      if (!intention.expiresAt || intention.expiresAt.getTime() > now.getTime()) continue;

      await this.store.updateIntentionStatus(intention.id, 'expired');
      for (const cue of await this.store.listCues({ intentionId: intention.id, status: 'armed' })) {
        await this.store.updateCueStatus(cue.id, 'cancelled');
      }
      expired++;
    }

    return expired;
  }
}

/**
 * Wires a resolver onto an event bus: every published event wakes the cues that
 * match. Returns the unsubscribe handle.
 *
 * ```ts
 * const detach = attachResolverToBus(bus, resolver);
 * await bus.publish({ type: 'branch_switch', branch: 'feature/x', directory: '/src' });
 * ```
 */
export function attachResolverToBus(
  bus: EventBus,
  resolver: CueResolver,
  options: { onFired?: (intention: Intention, cue: Cue) => void | Promise<void> } = {}
): Unsubscribe {
  return bus.subscribeAll(async (event) => {
    for (const cue of await resolver.resolveEventCues(event)) {
      const intention = await resolver.fire(cue.id);
      await options.onFired?.(intention, cue);
    }
  });
}
