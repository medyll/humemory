/**
 * Contexte mnésique de début de session — Phase 5.3.1.
 *
 * Au démarrage d'une session Claude Code, l'agent ne sait pas ce qu'il avait
 * laissé en plan. Ce module compose le bloc markdown qui le lui rappelle : les
 * boucles ouvertes du projet courant d'abord (mémoire prospective), puis les
 * traces dégradées encore pertinentes (mémoire rétrospective).
 *
 * La logique vit ici pour rester testable ; `scripts/hook-session-start.ts`
 * n'est qu'une coquille qui lit l'environnement et écrit sur stdout.
 */

import type { Intention, Memory, MemoryStore, IntentionStore, DecayLevel } from '../core/types.js';
import type { CueResolver } from '../core/cues.js';
import { loopId, intentionSaillance } from '../core/cues.js';
import { systemClock, type Clock } from '../core/clock.js';

/** Budget par défaut : nombre max d'éléments listés par section. */
export const DEFAULT_SESSION_BUDGET = 10;

/** Une trace n'est rappelée que si elle est restée saillante malgré sa dégradation. */
export const DEFAULT_SAILLANCE_THRESHOLD = 60;

/** Niveaux « dégradés mais encore utiles » : le détail est parti, le sens reste. */
export const RELEVANT_LEVELS: DecayLevel[] = [2, 3];

export interface SessionContextOptions {
  store: MemoryStore & IntentionStore;
  directory: string;
  /** Branche git courante — affichée en en-tête, sert de contexte à l'agent. */
  branch?: string;
  /** Resolver : si fourni, les cues échus sont tirés avant composition. */
  resolver?: CueResolver;
  budget?: number;
  saillanceThreshold?: number;
  clock?: Clock;
}

export interface SessionContext {
  markdown: string;
  openLoops: Intention[];
  traces: Memory[];
  /** Boucles réveillées par un cue temporel pendant cette composition. */
  firedNow: Intention[];
}

/** Rend une durée en formulation courte : « il y a 2j », « il y a 3h ». */
export function humanizeAge(from: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - from.getTime());
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return minutes <= 1 ? "à l'instant" : `il y a ${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `il y a ${days}j`;
  const months = Math.floor(days / 30);
  return `il y a ${months} mois`;
}

/** Contenu le plus pertinent d'une trace selon son niveau de dégradation. */
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

/** Aplati un texte sur une ligne — le bloc est injecté dans un prompt, pas dans un document. */
function oneLine(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Compose le contexte mnésique du répertoire courant.
 *
 * Effets de bord assumés : les intentions périmées passent en `expired` et les
 * cues temporels échus sont tirés. Un début de session est exactement le moment
 * où ce ménage doit avoir lieu — sinon personne ne le fait jamais.
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

  // Rien à dire : on n'écrit rien plutôt que d'injecter un bloc vide dans le prompt.
  if (!openLoops.length && !traces.length && !firedNow.length) return '';

  const lines: string[] = ['## 🧠 Contexte mnésique (humemory)'];
  if (branch) lines.push('', `_Branche courante : \`${branch}\`_`);

  if (firedNow.length) {
    lines.push('', '### ⏰ Échéances atteintes');
    for (const i of firedNow) {
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(i.content)}`);
    }
  }

  if (openLoops.length) {
    lines.push('', '### Boucles ouvertes (Zeigarnik)');
    for (const i of openLoops) {
      const age = humanizeAge(i.createdAt, now);
      const deadline =
        i.expiresAt && i.expiresAt.getTime() > now.getTime()
          ? ` — échéance ${humanizeAge(now, i.expiresAt).replace('il y a', 'dans')}`
          : '';
      lines.push(`- **[${loopId(i.id)}]** ${oneLine(i.content)} (armée ${age}${deadline})`);
    }
    lines.push('', `_Fermer une boucle : mentionner \`Closes ${loopId(openLoops[0].id)}\` dans un message de commit._`);
  }

  if (traces.length) {
    lines.push('', '### Traces pertinentes dégradées');
    for (const m of traces) {
      lines.push(`- [L${m.currentLevel}] ${oneLine(traceText(m))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Saillance courante d'une boucle — réexporté pour les consommateurs du contexte. */
export { intentionSaillance };
