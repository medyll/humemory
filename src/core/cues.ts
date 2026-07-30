/**
 * Cue resolver — Phase 5.2.
 *
 * Une intention ne se cherche pas : elle revient. Ce module décide *quand*.
 * Il lit les cues armés et répond à deux questions, l'une temporelle
 * (`resolveTimeCues`), l'autre événementielle (`resolveEventCues`), puis
 * `fire()` marque cue + intention comme remontés à l'agent.
 *
 * La couche données (tables, CRUD) est en Phase 5.1 dans `src/store/sqlite.ts` ;
 * ici il n'y a que de la décision. Voir PHASE5_PLAN.md § 5.2.
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
  /** Cues temporels échus à `now` (non encore firés, ou récurrents dus à nouveau). */
  resolveTimeCues(now?: Date): Promise<Cue[]>;
  /** Cues événementiels qui matchent cet event. */
  resolveEventCues(event: AppEvent): Promise<Cue[]>;
  /** Marque cue + intention comme firés. Renvoie l'intention réveillée. */
  fire(cueId: string): Promise<Intention>;
  /** Passe en `expired` les intentions dont la deadline est dépassée. Renvoie le compte. */
  expireStale(now?: Date): Promise<number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron — matcher minimal, 5 champs (minute heure jour-du-mois mois jour-semaine)
// ─────────────────────────────────────────────────────────────────────────────

const CRON_RANGES: Array<[min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // heure
  [1, 31], // jour du mois
  [1, 12], // mois
  [0, 6], // jour de la semaine, 0 = dimanche
];

/** Développe un champ cron (`*`, `5`, `1-5`, `*\/15`, `1-9/2`, listes) en ensemble de valeurs. */
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

/** Parse une expression cron 5 champs. Renvoie null si elle est invalide. */
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
 * Vrai si `date` (à la minute près, en UTC) tombe sur une occurrence du cron.
 *
 * Quand jour-du-mois et jour-de-semaine sont tous deux restreints, cron standard
 * les combine en OU, pas en ET — `0 9 1 * 1` veut dire « le 1er du mois **ou**
 * le lundi ». On garde cette sémantique pour ne pas surprendre.
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
 * Fenêtre de rattrapage d'un cron, en minutes (7 jours).
 *
 * Le resolver n'est pas un démon : il tourne au SessionStart, donc sporadiquement.
 * Sans rattrapage, une occurrence tombée entre deux sessions serait perdue. On
 * remonte donc le temps minute par minute depuis `now` jusqu'à la dernière
 * référence connue, plafonné à cette fenêtre — au-delà, l'occurrence est
 * considérée comme trop vieille pour valoir un réveil.
 */
export const CRON_CATCHUP_MINUTES = 7 * 24 * 60;

/** Vrai s'il existe une occurrence du cron dans l'intervalle ouvert-fermé (since, now]. */
export function cronDueSince(expr: string, since: Date, now: Date): boolean {
  const parsed = parseCron(expr);
  if (!parsed) return false; // expression invalide → jamais due, jamais de crash

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
// Matching événementiel
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise les séparateurs pour que Windows et POSIX matchent pareil. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Un cue n'est éligible que dans son lieu mental : l'event doit venir du
 * `directory` de l'intention ou d'un sous-dossier. Sans ça, une boucle ouverte
 * sur un projet se réveillerait en travaillant sur un autre — la DB est partagée
 * entre projets.
 */
function directoryMatches(intentionDir: string, eventDir: string | undefined): boolean {
  if (!eventDir) return true; // event sans contexte : on ne filtre pas
  const a = normalizePath(intentionDir).replace(/\/$/, '');
  const b = normalizePath(eventDir).replace(/\/$/, '');
  return b === a || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** Teste un pattern d'erreur. Une regex invalide retombe sur une recherche littérale. */
function errorPatternMatches(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, 'i').test(text);
  } catch {
    return text.toLowerCase().includes(pattern.toLowerCase());
  }
}

/** Vrai si ce déclencheur événementiel correspond à cet event. */
export function eventTriggerMatches(spec: EventTriggerSpec, event: AppEvent): boolean {
  switch (spec.type) {
    case 'file_open': {
      if (event.type !== 'file_open') return false;
      const want = normalizePath(spec.path);
      const got = normalizePath(event.path);
      // Suffixe accepté : un cue armé sur 'src/auth/service.ts' doit matcher un
      // event portant le chemin absolu du même fichier.
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
// Règles décay × intention
// ─────────────────────────────────────────────────────────────────────────────

/** Décroissance de la saillance d'une intention firée, en points par jour (Zeigarnik qui faiblit). */
export const INTENTION_FADE_PER_DAY = 10;

/**
 * Saillance courante d'une intention (PHASE5_PLAN.md § 5.2) :
 * - `armed`   → figée à 100 : une boucle ouverte reste saillante, elle ne décay pas
 * - `fired` non `closed` → décline depuis `firedAt` : l'effet Zeigarnik s'émousse
 * - `closed`  → 0 : archivée, gardée pour l'historique
 * - `expired` → 0 : soft-delete
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
   * Un cue ne réveille que si son intention est encore `armed` : une boucle déjà
   * fermée, expirée ou déjà remontée ne doit pas resurgir.
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
        // Référence = dernier réveil connu, sinon l'armement.
        isDue = cronDueSince(spec.cron, cue.firedAt ?? cue.armedAt, now);
      }

      if (!isDue) continue;
      if (!(await this.armedIntentionOf(cue))) continue;
      due.push(cue);
    }

    return due;
  }

  async resolveEventCues(event: AppEvent): Promise<Cue[]> {
    // Un commit ne réveille pas une intention, il la ferme — c'est le hook
    // post-commit (S5-03b) qui s'en charge, pas ce resolver.
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
   * Marque cue + intention comme firés. Un cue cron est ré-armé après tir : une
   * récurrence qui ne se rearme pas n'est qu'un one-shot déguisé.
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
   * Passe en `expired` les intentions `armed` dont `expiresAt` est dépassé, et
   * annule leurs cues — un cue qui survit à son intention est un réveil fantôme.
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
 * Branche un resolver sur un event bus : chaque event publié réveille les cues
 * qui matchent. Renvoie de quoi se désabonner.
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
