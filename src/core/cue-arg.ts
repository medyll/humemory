/**
 * Parsing of `--cue` command-line arguments.
 *
 * Accepted formats:
 *   time:2026-12-01                      — one-shot deadline (ISO date or datetime)
 *   cron:0 9 * * 1                       — recurrence
 *   event:file_open:src/auth/service.ts  — file opened
 *   event:branch_switch:feature/x        — branch changed
 *   event:error_pattern:SQLITE_(BUSY)    — error pattern (may contain ':')
 *
 * It lives in core/ rather than cli/: the same format is typed on the command
 * line and in the front-end form. One parser, tested once.
 */

import type { TriggerSpec } from '../core/types.js';

export class CueArgError extends Error {}

const EVENT_TYPES = ['file_open', 'branch_switch', 'error_pattern'] as const;

export function parseCueArg(raw: string): TriggerSpec {
  const input = raw.trim();
  if (!input) throw new CueArgError('empty cue');

  const [head, ...rest] = input.split(':');
  const tail = rest.join(':'); // error patterns and ISO times contain ':'

  switch (head) {
    case 'time': {
      if (!tail) throw new CueArgError('time: expects an ISO date — e.g. time:2026-12-01');
      const date = new Date(tail);
      if (Number.isNaN(date.getTime())) throw new CueArgError(`invalid date: ${tail}`);
      return { kind: 'time', at: date.toISOString() };
    }

    case 'cron': {
      if (!tail.trim()) throw new CueArgError('cron: expects an expression — e.g. "cron:0 9 * * 1"');
      return { kind: 'time', cron: tail.trim() };
    }

    case 'event': {
      const sep = tail.indexOf(':');
      const type = sep === -1 ? tail : tail.slice(0, sep);
      const value = sep === -1 ? '' : tail.slice(sep + 1);

      if (!EVENT_TYPES.includes(type as any)) {
        throw new CueArgError(`unknown event type: "${type}" (${EVENT_TYPES.join(' | ')})`);
      }
      if (!value) throw new CueArgError(`event:${type}: expects a value`);

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
      throw new CueArgError(`unknown prefix: "${head}" (time | cron | event)`);
  }
}

/** Renders a cue in its CLI form — the inverse of `parseCueArg`, for display. */
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
