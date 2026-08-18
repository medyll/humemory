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

import type { Intention, Memory, MemoryStore, IntentionStore, DecayLevel, Script } from '../core/types.js';
import type { CueResolver } from '../core/cues.js';
import { loopId, intentionSaillance } from '../core/cues.js';
import { scriptEffectiveSaillance } from '../core/scripts.js';
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

/** Max drill steps rendered in one block — the block goes into a prompt. */
export const SCRIPT_STEP_CAP = 8;

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
  /** Drills woken during this composition (Phase 8.2) — at most one renders. */
  firedScripts: Script[];
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
  const firedScripts: Script[] = [];

  if (resolver) {
    await resolver.expireStale(now);
    // Time cues first — dispatch by target kind (8.1): a script cue fired
    // through resolver.fire() would throw by design.
    for (const cue of await resolver.resolveTimeCues(now)) {
      const fired = await resolver.fireAny(cue.id);
      if (fired.kind === 'script') {
        if (fired.script.directory === directory) firedScripts.push(fired.script);
      } else if (fired.intention.directory === directory) {
        firedNow.push(fired.intention);
      }
    }
    // A session opening on a branch is a branch_switch from the drill's point
    // of view (8.2): script cues armed on it fire. Intention behaviour is
    // unchanged — their event cues wake through the bus, not here.
    if (branch) {
      const matched = await resolver.resolveEventCues({
        type: 'branch_switch',
        branch,
        directory,
      } as any);
      for (const cue of matched) {
        if (cue.targetKind !== 'script') continue;
        const script = await resolver.fireScript(cue.id);
        if (script.directory === directory) firedScripts.push(script);
      }
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

  // Phase 6.0.2 — a trace that loses an active contradiction leaves the block
  // (it stays searchable). Cycle: a trace that is both winner and loser stays,
  // flagged `disputed` — last write wins, nothing is inferred.
  const disputedIds = new Set<string>();
  let visibleTraces = traces;
  if (store.listContradictions) {
    const active = await store.listContradictions({ status: 'active' });
    const losers = new Set(active.map((ct) => ct.loserId));
    const winners = new Set(active.map((ct) => ct.winnerId));
    for (const id of losers) if (winners.has(id)) disputedIds.add(id);
    visibleTraces = traces.filter((m) => !losers.has(m.id) || disputedIds.has(m.id));
  }

  const rendered = renderMarkdown({ openLoops, traces: visibleTraces, firedNow, firedScripts, branch, now, disputedIds });
  return {
    markdown: rendered.markdown,
    openLoops,
    traces: visibleTraces,
    firedNow,
    firedScripts,
    escapeAttempts: rendered.escapeAttempts,
  };
}

function renderMarkdown(input: {
  openLoops: Intention[];
  traces: Memory[];
  firedNow: Intention[];
  firedScripts?: Script[];
  branch?: string;
  now: Date;
  disputedIds?: Set<string>;
}): { markdown: string; escapeAttempts: { memoryId: string; count: number }[] } {
  const { openLoops, traces, firedNow, branch, now, disputedIds } = input;
  const escapeAttempts: { memoryId: string; count: number }[] = [];

  // One drill per context block (Q1 conservative default): two scripts firing
  // in the same session is a smell — the sharper one wins, the rest is noise.
  // Sharpness = effective saillance (8.4 disuse included), not the raw bump.
  const script = (input.firedScripts ?? []).sort(
    (a, b) => scriptEffectiveSaillance(b, now) - scriptEffectiveSaillance(a, now)
  )[0];

  // Nothing to say: write nothing rather than inject an empty block into the prompt.
  if (!openLoops.length && !traces.length && !firedNow.length && !script) return { markdown: '', escapeAttempts };

  const lines: string[] = ['## 🧠 Mnemonic context (humemory)'];
  if (branch) lines.push('', `_Current branch: \`${branch}\`_`);

  if (script) {
    const lastFired = script.lastFiredAt ? humanizeAge(script.lastFiredAt, now) : 'never';
    lines.push('', `### 📋 Script: ${script.name} (fired ${script.fireCount}×, last ${lastFired})`);
    const desc = sanitizeTrace(script.description);
    // Escape-attempt telemetry (6.0.3/R3-B11) was missing for scripts —
    // flagged twice in PHASE8_DIALOG.md, closed here: same accounting as
    // the trace loop below, keyed on the script id since a script has no
    // per-step id of its own.
    if (desc.escapedMarkers > 0) escapeAttempts.push({ memoryId: script.id, count: desc.escapedMarkers });
    // Same injection rules as traces (6.0.3): human-authored renders bare,
    // agent/dreamer-authored stays wrapped. The description used to render
    // bare unconditionally while the steps below were correctly gated
    // (SECURITY_AUDIT.md H-03) — both now share the same `bare` check.
    const bare = script.source === 'human';
    lines.push(
      `> ${bare ? oneLine(desc.text) : wrapUntrusted(oneLine(desc.text), { source: script.source, agent: script.agent, id: script.id })}`
    );
    script.steps.slice(0, SCRIPT_STEP_CAP).forEach((step, i) => {
      const s = sanitizeTrace(step);
      if (s.escapedMarkers > 0) escapeAttempts.push({ memoryId: script.id, count: s.escapedMarkers });
      const body = bare
        ? oneLine(s.text)
        : wrapUntrusted(oneLine(s.text), { source: script.source, agent: script.agent, id: script.id });
      lines.push(`${i + 1}. ${body}`);
    });
    if (script.steps.length > SCRIPT_STEP_CAP) {
      lines.push(`_… ${script.steps.length - SCRIPT_STEP_CAP} more steps — \`pnpm cli script fire ${script.id.slice(0, 8)}\` for the full drill._`);
    }
  }

  // Intentions carry the same provenance shape as memories (6.0.1) but used to
  // render bare unconditionally regardless of it (SECURITY_AUDIT.md H-03).
  // Only a human-verified loop skips the untrusted wrapper now.
  const renderIntentionBody = (i: Intention, s: { text: string }): string => {
    const bare = i.verified === true && i.verificationReason === 'human';
    return bare
      ? oneLine(s.text)
      : wrapUntrusted(oneLine(s.text), { source: i.source, agent: i.agent, verified: i.verified, id: i.id });
  };

  if (firedNow.length) {
    lines.push('', '### ⏰ Deadlines reached', RECALLED_NOTES_PREFACE);
    for (const i of firedNow) {
      const s = sanitizeTrace(i.content);
      // Same reporting as scripts and traces: the content was already
      // neutralised, but a swallowed count hides the attempt from the operator.
      if (s.escapedMarkers > 0) escapeAttempts.push({ memoryId: i.id, count: s.escapedMarkers });
      lines.push(`- **[${loopId(i.id)}]** ${renderIntentionBody(i, s)}`);
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
      if (s.escapedMarkers > 0) escapeAttempts.push({ memoryId: i.id, count: s.escapedMarkers });
      lines.push(`- **[${loopId(i.id)}]** ${renderIntentionBody(i, s)} (armed ${age}${deadline})`);
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
      lines.push(`- [L${m.currentLevel}]${disputedIds?.has(m.id) ? ' ⚔️ *disputed*' : ''} ${body}`);
    }
  }

  return { markdown: `${lines.join('\n')}\n`, escapeAttempts };
}

/** Current salience of a loop — re-exported for consumers of the context. */
export { intentionSaillance };
