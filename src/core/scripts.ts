/**
 * Cognitive scripts — disuse decay (Phase 8.4, the inverse Zeigarnik).
 *
 * A drill does not fade with time like a trace: it fades with DISUSE. A
 * script that fires weekly never decays (firing resets the clock and bumps
 * saillance); a script nobody runs for two months starts rusting, and a
 * rusted script archives itself rather than keep waking sessions with a
 * stale habit — a wrong habit is worse than no habit (PHASE8_PLAN.md §8.4).
 *
 * The sweep runs inside `pnpm consolidate` alongside trace decay. Everything
 * here is a pure function of state + clock: deterministic, hermetic-testable.
 */

import { createHash } from 'crypto';
import type { MemoryStore, Script, ScriptStore } from './types.js';
import { systemClock, type Clock } from './clock.js';

/** Active and unfired for this long before decay even starts. */
export const SCRIPT_DISUSE_GRACE_DAYS = 60;

/** Saillance lost per additional 30 days of disuse past the grace period. */
export const SCRIPT_DISUSE_FADE_PER_MONTH = 10;

/** Below this effective saillance an active script archives itself. */
export const SCRIPT_ARCHIVE_THRESHOLD = 20;

/**
 * Effective saillance of a script at `now`, disuse included.
 *
 * - `pinned` → the stored value, untouched (photographic equivalent).
 * - `draft` / `archived` → the stored value (disuse decay gates on `active`;
 *   a draft is not yet a habit, an archived one no longer matters).
 * - `active` → stored saillance minus 10 per full 30 days of disuse past the
 *   60-day grace, floored at 0. Disuse is measured from the last firing, or
 *   from creation for a drill that never fired.
 */
export function scriptEffectiveSaillance(script: Script, now: Date): number {
  if (script.pinned || script.status !== 'active') return script.saillance;

  const reference = script.lastFiredAt ?? script.createdAt;
  const disuseDays = (now.getTime() - reference.getTime()) / 86_400_000;
  if (disuseDays <= SCRIPT_DISUSE_GRACE_DAYS) return script.saillance;

  const monthsOver = Math.floor((disuseDays - SCRIPT_DISUSE_GRACE_DAYS) / 30);
  return Math.max(0, script.saillance - monthsOver * SCRIPT_DISUSE_FADE_PER_MONTH);
}

export interface ScriptDisuseReport {
  /** Active scripts whose effective saillance fell below the threshold. */
  archived: Script[];
  /** Active scripts losing saillance but still above the threshold. */
  decaying: { script: Script; effective: number }[];
}

function archivalHash(scriptId: string): string {
  // No date component: one notice per script per disuse episode. A script
  // that comes back to active and rusts again gets a fresh id-independent
  // fact to hash against — re-activation always assigns a clean disuse
  // clock, so a second archival of the *same* script id is a new episode
  // worth its own notice, not a duplicate. Hashing on id alone is therefore
  // deliberately permissive: dedup exists to stop a single sweep run from
  // filing the same notice twice, not to suppress a real recurrence.
  return createHash('sha1').update(`script_archived|${scriptId}`).digest('hex');
}

/**
 * The disuse sweep: archives active scripts whose effective saillance dropped
 * under SCRIPT_ARCHIVE_THRESHOLD. Archival goes through updateScriptStatus,
 * which also cancels the script's armed cues — no ghost wake-ups.
 *
 * Archival is human-visible (PHASE8_PLAN.md §8.4): a `script_archived` dream
 * proposal is filed alongside the status change, on a store that supports
 * `fileDreamProposal` (best-effort — the archival itself never depends on
 * the notice succeeding). The proposal is a NOTICE, not a request: the
 * archival has already happened by the time a human sees it in
 * `dream review`; approving/rejecting only acknowledges it.
 */
export async function sweepDisusedScripts(
  store: ScriptStore & Partial<Pick<MemoryStore, 'fileDreamProposal'>>,
  options: { clock?: Clock } = {}
): Promise<ScriptDisuseReport> {
  const now = (options.clock ?? systemClock).now();
  const active = await store.listScripts({ status: 'active', limit: 500 });

  const report: ScriptDisuseReport = { archived: [], decaying: [] };
  for (const script of active) {
    if (script.pinned) continue;
    const effective = scriptEffectiveSaillance(script, now);
    if (effective >= script.saillance) continue; // inside the grace period
    if (effective < SCRIPT_ARCHIVE_THRESHOLD) {
      const archived = await store.updateScriptStatus(script.id, 'archived');
      report.archived.push(archived);
      await store.fileDreamProposal?.({
        kind: 'script_archived',
        payload: JSON.stringify({
          scriptId: archived.id,
          name: archived.name,
          directory: archived.directory,
          storedSaillance: script.saillance,
          effectiveSaillance: effective,
          lastFiredAt: script.lastFiredAt?.toISOString() ?? null,
        }),
        payloadHash: archivalHash(archived.id),
        confidence: 1, // a fact ("this archived"), not a pattern to weigh
      });
    } else {
      report.decaying.push({ script, effective });
    }
  }
  return report;
}
