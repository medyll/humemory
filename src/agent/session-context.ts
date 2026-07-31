/**
 * Session-start mnemonic context — Phase 5.3.1.
 *
 * When a Claude Code session begins, the agent has no idea what it left
 * unfinished. This module composes the markdown block that reminds it: the open
 * loops of the current project first (prospective memory), then the decayed but
 * still relevant traces (retrospective memory).
 *
 * The logic lives here so it stays testable; `scripts/hook-session-start.ts` is
 * only a shell that reads the environment and writes to stdout.
 */

import type { Intention, Memory, MemoryStore, IntentionStore, DecayLevel } from '../core/types.js';
import type { CueResolver } from '../core/cues.js';
import { loopId, intentionSaillance } from '../core/cues.js';
import { systemClock, type Clock } from '../core/clock.js';

/** Default budget: maximum number of items listed per section. */
export const DEFAULT_SESSION_BUDGET = 10;

/** A trace is only recalled if it stayed salient despite its decay. */
export const DEFAULT_SAILLANCE_THRESHOLD = 60;

/** Levels that are "degraded but still useful": the detail is gone, the meaning remains. */
export const RELEVANT_LEVELS: DecayLevel[] = [2, 3];

export interface SessionContextOptions {
  store: MemoryStore & IntentionStore;
  directory: string;
  /** Current git branch — shown in the header, gives the agent its bearings. */
  branch?: string;
  /** Resolver: when provided, due cues are fired before composing. */
  resolver?: CueResolver;
  budget?: number;
  saillanceThreshold?: number;
  clock?: Clock;
}

export interface SessionContext {
  markdown: string;
  openLoops: Intention[];
  traces: Memory[];
  /** Loops woken by a time cue during this composition. */
  firedNow: Intention[];
}

/** Renders a duration in short form: "2d ago", "3h ago". */
export function humanizeAge(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes}min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months} months ago`;
}

/** The most relevant content of a trace, given how far it has decayed. */
function traceText(memory: Memory): string {
  switch (memory.currentLevel) {
    case 0:
      return memory.content;
    case 1:
      return memory.level1Summary ?? memory.content;
    case 2:
      return memory.level2Essential ?? memory.level1Summary ?? memory.content;
    case 3:
      return memory.level3Keywords ?? memory.level2Essential ?? memory.content;
    default:
      return memory.level3Keywords ?? memory.content;
  }
}

/** Flattens text onto one line — the block goes into a prompt, not a document. */
function oneLine(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Composes the mnemonic context of the current directory.
 *
 * Side effects, deliberately: overdue intentions are expired and due time cues
 * are fired. The start of a session is exactly when that housekeeping should
 * happen — otherwise nobody ever does it.
 */
export async function buildSessionContext(options: SessionContextOptions): Promise<SessionContext> {
  const {
    store,
    directory,
    branch,
    resolver,
    budget = DEFAULT_SESSION_BUDGET,
    saillanceThreshold = DEFAULT_SAILLANCE_THRESHOLD,
    clock = systemClock,
  } = options;

  const now = clock.now();
  const firedNow: Intention[] = [];

  if (resolver) {
    await resolver.expireStale(now);
    for (const cue of await resolver.resolveTimeCues(now)) {
      const intention = await resolver.fire(cue.id);
      if (intention.directory === directory) firedNow.push(intention);
    }
  }

  const openLoops = (await store.listIntentions({ status: 'armed', directory, limit: budget })).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
  );

  const traces = (
    await store.list({
      directory,
      levels: RELEVANT_LEVELS,
      minSaillance: saillanceThreshold,
      limit: budget,
    })
  ).sort((a, b) => b.saillance - a.saillance);

  return {
    markdown: renderMarkdown({ openLoops, traces, firedNow, branch, now }),
    openLoops,
    traces,
    firedNow,
  };
}

function renderMarkdown(input: {
  openLoops: Intention[];
  traces: Memory[];
  firedNow: Intention[];
  branch?: string;
  now: Date;
}): string {
  const { openLoops, traces, firedNow, branch, now } = input;

  // Nothing to say: write nothing rather than inject an empty block into the prompt.
  if (!openLoops.length && !traces.length && !firedNow.length) return '';

  const lines: string[] = ['## 🧠 Mnemonic context (humemory)'];
  if (branch) lines.push('', `_Current branch: \`${branch}\`_`);

  if (firedNow.length) {
    lines.push('', '### ⏰ Deadlines reached');
    for (const i of firedNow) {
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(i.content)}`);
    }
  }

  if (openLoops.length) {
    lines.push('', '### Open loops (Zeigarnik)');
    for (const i of openLoops) {
      const age = humanizeAge(i.createdAt, now);
      const deadline =
        i.expiresAt && i.expiresAt.getTime() > now.getTime()
          ? ` — due in ${humanizeAge(now, i.expiresAt).replace(' ago', '')}`
          : '';
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(i.content)} (armed ${age}${deadline})`);
    }
    lines.push('', `_To close a loop: mention \`Closes ${loopId(openLoops[0].id)}\` in a commit message._`);
  }

  if (traces.length) {
    lines.push('', '### Relevant decayed traces');
    for (const m of traces) {
      lines.push(`- [L${m.currentLevel}] ${oneLine(traceText(m))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Current salience of a loop — re-exported for consumers of the context. */
export { intentionSaillance };
