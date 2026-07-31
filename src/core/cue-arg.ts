/**
 * Parsing des `--cue` de la ligne de commande.
 *
 * Formats acceptés :
 *   time:2026-12-01                      — échéance one-shot (date ou datetime ISO)
 *   cron:0 9 * * 1                       — récurrence
 *   event:file_open:src/auth/service.ts  — ouverture de fichier
 *   event:branch_switch:feature/x        — changement de branche
 *   event:error_pattern:SQLITE_(BUSY)    — motif d'erreur (peut contenir des ':')
 *
 * Vit dans core/ et non dans cli/ : le même format est saisi à la ligne de
 * commande et dans le formulaire du front. Un seul parseur, testé une fois.
 */

import type { TriggerSpec } from '../core/types.js';

export class CueArgError extends Error {}

const EVENT_TYPES = ['file_open', 'branch_switch', 'error_pattern'] as const;

export function parseCueArg(raw: string): TriggerSpec {
  const input = raw.trim();
  if (!input) throw new CueArgError('cue vide');

  const [head, ...rest] = input.split(':');
  const tail = rest.join(':'); // le motif d'erreur ou une heure ISO contiennent des ':'

  switch (head) {
    case 'time': {
      if (!tail) throw new CueArgError('time: attend une date ISO — ex. time:2026-12-01');
      const date = new Date(tail);
      if (Number.isNaN(date.getTime())) throw new CueArgError(`date invalide: ${tail}`);
      return { kind: 'time', at: date.toISOString() };
    }

    case 'cron': {
      if (!tail.trim()) throw new CueArgError('cron: attend une expression — ex. "cron:0 9 * * 1"');
      return { kind: 'time', cron: tail.trim() };
    }

    case 'event': {
      const sep = tail.indexOf(':');
      const type = sep === -1 ? tail : tail.slice(0, sep);
      const value = sep === -1 ? '' : tail.slice(sep + 1);

      if (!EVENT_TYPES.includes(type as any)) {
        throw new CueArgError(`type d'event inconnu: "${type}" (${EVENT_TYPES.join(' | ')})`);
      }
      if (!value) throw new CueArgError(`event:${type}: attend une valeur`);

      switch (type) {
        case 'file_open':
          return { kind: 'event', type: 'file_open', path: value };
        case 'branch_switch':
          return { kind: 'event', type: 'branch_switch', branch: value };
        default:
          return { kind: 'event', type: 'error_pattern', pattern: value };
      }
    }

    default:
      throw new CueArgError(`préfixe inconnu: "${head}" (time | cron | event)`);
  }
}

/** Rend un cue sous sa forme CLI — l'inverse de `parseCueArg`, pour l'affichage. */
export function formatTriggerSpec(spec: TriggerSpec): string {
  if (spec.kind === 'time') {
    return spec.cron ? `cron:${spec.cron}` : `time:${spec.at}`;
  }
  switch (spec.type) {
    case 'file_open':
      return `event:file_open:${spec.path}`;
    case 'branch_switch':
      return `event:branch_switch:${spec.branch}`;
    default:
      return `event:error_pattern:${spec.pattern}`;
  }
}
