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
import {
  sanitizeTrace,
  wrapUntrusted,
  RECALLED_NOTES_PREFACE,
  DEFAULT_TRACE_CAP,
} from '../core/sanitize.js';

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
  /**
   * Marker-escape attempts neutralized while rendering (6.0.3). Non-zero is a
   * security signal — log the event, never the payload (Claude R3/B11).
   */
  escapeAttempts: { memoryId: string; count: number }[];
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

  const rendered = renderMarkdown({ openLoops, traces, firedNow, branch, now });
  return {
    markdown: rendered.markdown,
    openLoops,
    traces,
    firedNow,
    escapeAttempts: rendered.escapeAttempts,
  };
}

function renderMarkdown(input: {
  openLoops: Intention[];
  traces: Memory[];
  firedNow: Intention[];
  branch?: string;
  now: Date;
}): { markdown: string; escapeAttempts: { memoryId: string; count: number }[] } {
  const { openLoops, traces, firedNow, branch, now } = input;
  const escapeAttempts: { memoryId: string; count: number }[] = [];

  // Nothing to say: write nothing rather than inject an empty block into the prompt.
  if (!openLoops.length && !traces.length && !firedNow.length) return { markdown: '', escapeAttempts };

  const lines: string[] = ['## 🧠 Mnemonic context (humemory)'];
  if (branch) lines.push('', `_Current branch: \`${branch}\`_`);

  if (firedNow.length) {
    lines.push('', '### ⏰ Deadlines reached', RECALLED_NOTES_PREFACE);
    for (const i of firedNow) {
      const s = sanitizeTrace(i.content);
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(s.text)}`);
    }
  }

  if (openLoops.length) {
    lines.push('', '### Open loops (Zeigarnik)', RECALLED_NOTES_PREFACE);
    for (const i of openLoops) {
      const age = humanizeAge(i.createdAt, now);
      const deadline =
        i.expiresAt && i.expiresAt.getTime() > now.getTime()
          ? ` — due in ${humanizeAge(now, i.expiresAt).replace(' ago', '')}`
          : '';
      const s = sanitizeTrace(i.content);
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(s.text)} (armed ${age}${deadline})`);
    }
    lines.push('', `_To close a loop: mention \`Closes ${loopId(openLoops[0].id)}\` in a commit message._`);
  }

  if (traces.length) {
    lines.push('', '### Relevant decayed traces', RECALLED_NOTES_PREFACE);
    for (const m of traces) {
      const s = sanitizeTrace(traceText(m), DEFAULT_TRACE_CAP);
      if (s.escapedMarkers > 0) escapeAttempts.push({ memoryId: m.id, count: s.escapedMarkers });
      // Only traces verified by a human render bare; earned verification
      // (corroborated/reused/grounded) never unwraps content (6.0.3).
      const bare = m.verified === true && m.verificationReason === 'human';
      const body = bare
        ? s.text
        : wrapUntrusted(s.text, {
            source: m.source,
            agent: m.agent,
            verified: m.verified,
            id: m.id,
          });
      lines.push(`- [L${m.currentLevel}] ${body}`);
    }
  }

  return { markdown: `${lines.join('\n')}\n`, escapeAttempts };
}

/** Current salience of a loop — re-exported for consumers of the context. */
export { intentionSaillance };
