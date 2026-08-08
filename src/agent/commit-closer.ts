/**
 * Closing loops from commits — Phase 5.3.2.
 *
 * The gesture that purges an open loop is the commit. Two paths:
 *
 * 1. **Explicit** — `Closes loop-a1b2c3d4` in the message. The author's
 *    intention, unambiguous: close it.
 * 2. **Heuristic** — overlap between the files touched and the loop's text. This
 *    **never** closes anything automatically: it suggests. Closing the wrong loop
 *    costs more than leaving one open.
 *
 * The logic lives here so it stays testable; `scripts/hook-post-commit.ts` only
 * queries git and prints.
 */

import type { Intention, IntentionStore } from '../core/types.js';
import { extractLoopIds, matchIntentionByShortId, loopId } from '../core/cues.js';

export interface CommitInfo {
  sha: string;
  message: string;
  files: string[];
  /** Mental place of the repository — bounds the heuristic to the current project. */
  directory: string;
}

export interface CloseSuggestion {
  intention: Intention;
  score: number;
  /** Tokens shared between the commit's files and the loop's content. */
  matched: string[];
}

export interface CommitCloseResult {
  closed: Intention[];
  suggestions: CloseSuggestion[];
  /** Ids mentioned in the message but unknown or ambiguous. */
  unresolved: string[];
}

/** Suggestion threshold: at least one meaningful shared token. */
export const SUGGESTION_THRESHOLD = 1;

/** Maximum suggestions shown — beyond that it is noise. */
export const MAX_SUGGESTIONS = 3;

// Words too common to signal anything.
const STOPWORDS = new Set([
  'dans', 'pour', 'avec', 'sans', 'cette', 'leur', 'plus', 'mais', 'donc',
  'index', 'test', 'tests', 'src', 'lib', 'main', 'temp', 'utils', 'util', 'core',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into',
]);

/** Splits a text into meaningful tokens, without accents or case. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** Tokens drawn from a file path: directory segments plus the name without its extension. */
export function tokenizePath(path: string): string[] {
  const normalized = path.replace(/\\/g, '/');
  const withoutExt = normalized.replace(/\.[a-z0-9]+$/i, '');
  return [...new Set(tokenize(withoutExt))];
}

/**
 * Overlap between a commit's files and a loop's content.
 *
 * Deliberately crude: this score closes nothing, it only ranks suggestions put
 * to a human.
 */
export function scoreOverlap(intention: Intention, files: string[]): CloseSuggestion['matched'] {
  const contentTokens = new Set(tokenize(intention.content));
  const matched = new Set<string>();

  for (const file of files) {
    for (const token of tokenizePath(file)) {
      if (contentTokens.has(token)) matched.add(token);
    }
  }

  return [...matched];
}

/**
 * Applies a commit to the open loops.
 *
 * Closes the ones named explicitly (and cancels their remaining cues — a cue
 * outliving its loop is a ghost wake-up). For the rest, it only suggests.
 */
export async function applyCommitToLoops(
  store: IntentionStore,
  commit: CommitInfo,
  memories?: { verify(id: string, by?: string): Promise<unknown> }
): Promise<CommitCloseResult> {
  const armed = await store.listIntentions({ status: 'armed', limit: 500 });

  const closed: Intention[] = [];
  const unresolved: string[] = [];
  const closedIds = new Set<string>();

  // 1. Explicit markers. Deliberately not bound to the directory: if someone
  // types the id by hand, they know what they are closing.
  for (const shortId of extractLoopIds(commit.message)) {
    const target = matchIntentionByShortId(armed, shortId);
    if (!target) {
      unresolved.push(shortId);
      continue;
    }

    const intention = await store.updateIntentionStatus(target.id, 'closed', {
      closedByCommit: commit.sha,
    });
    for (const cue of await store.listCues({ intentionId: target.id, status: 'armed' })) {
      await store.updateCueStatus(cue.id, 'cancelled');
    }

    // Phase 6.0.1 — `grounded` verification: an explicitly-closed loop vouches
    // for the trace it points to. Only this path counts (Claude R1): the fuzzy
    // file-overlap path below only *suggests* and must never become evidence.
    if (intention.relatedMemoryId && memories) {
      await memories.verify(intention.relatedMemoryId, 'grounded');
    }

    closed.push(intention);
    closedIds.add(target.id);
  }

  // 2. Heuristic, bounded to the current project and never applied on its own.
  const suggestions = armed
    .filter((i) => !closedIds.has(i.id) && i.directory === commit.directory)
    .map((intention) => ({ intention, matched: scoreOverlap(intention, commit.files) }))
    .map((s) => ({ ...s, score: s.matched.length }))
    .filter((s) => s.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS);

  return { closed, suggestions, unresolved };
}

/** Renders the report printed after a commit. Empty string when there is nothing to say. */
export function renderCommitReport(result: CommitCloseResult): string {
  const { closed, suggestions, unresolved } = result;
  if (!closed.length && !suggestions.length && !unresolved.length) return '';

  const lines: string[] = [];

  for (const i of closed) {
    lines.push(`✅ ${loopId(i.id)} closed — ${i.content}`);
  }

  for (const shortId of unresolved) {
    lines.push(`⚠️  loop-${shortId}: no single open loop under that id`);
  }

  if (suggestions.length) {
    lines.push('');
    lines.push('💡 Loops this commit may have touched:');
    for (const { intention, matched } of suggestions) {
      lines.push(`   ${loopId(intention.id)} — ${intention.content}`);
      lines.push(`      overlaps: ${matched.join(', ')}`);
    }
    lines.push('');
    lines.push(`   To close: pnpm cli intent close ${loopId(suggestions[0].intention.id)}`);
  }

  return `${lines.join('\n')}\n`;
}
