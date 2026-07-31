/**
 * Fermeture des boucles par commit — Phase 5.3.2.
 *
 * Le geste qui purge une boucle ouverte, c'est le commit. Deux voies :
 *
 * 1. **Explicite** — `Closes loop-a1b2c3d4` dans le message. Intention de
 *    l'auteur, sans ambiguïté : on ferme.
 * 2. **Heuristique** — recoupement entre les fichiers touchés et le contenu de
 *    la boucle. On ne ferme **jamais** automatiquement là-dessus : on suggère.
 *    Fermer la mauvaise boucle coûte plus cher que d'en laisser une ouverte.
 *
 * La logique vit ici pour rester testable ; `scripts/hook-post-commit.ts` se
 * contente d'interroger git et d'afficher.
 */

import type { Intention, IntentionStore } from '../core/types.js';
import { extractLoopIds, matchIntentionByShortId, loopId } from '../core/cues.js';

export interface CommitInfo {
  sha: string;
  message: string;
  files: string[];
  /** Lieu mental du dépôt — borne l'heuristique au projet courant. */
  directory: string;
}

export interface CloseSuggestion {
  intention: Intention;
  score: number;
  /** Jetons partagés entre les fichiers du commit et le contenu de la boucle. */
  matched: string[];
}

export interface CommitCloseResult {
  closed: Intention[];
  suggestions: CloseSuggestion[];
  /** Identifiants cités dans le message mais introuvables ou ambigus. */
  unresolved: string[];
}

/** Seuil de suggestion : au moins un jeton significatif partagé. */
export const SUGGESTION_THRESHOLD = 1;

/** Nombre max de suggestions affichées — au-delà, c'est du bruit. */
export const MAX_SUGGESTIONS = 3;

// Mots trop fréquents pour signaler quoi que ce soit.
const STOPWORDS = new Set([
  'dans', 'pour', 'avec', 'sans', 'cette', 'cette', 'leur', 'plus', 'mais', 'donc',
  'index', 'test', 'tests', 'src', 'lib', 'main', 'temp', 'utils', 'util', 'core',
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into',
]);

/** Découpe un texte en jetons significatifs, sans accents ni casse. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

/** Jetons tirés d'un chemin de fichier : segments de dossier + nom sans extension. */
export function tokenizePath(path: string): string[] {
  const normalized = path.replace(/\\/g, '/');
  const withoutExt = normalized.replace(/\.[a-z0-9]+$/i, '');
  return [...new Set(tokenize(withoutExt))];
}

/**
 * Recoupement entre les fichiers d'un commit et le contenu d'une boucle.
 * Volontairement grossier : ce score ne ferme rien, il ne fait que classer des
 * suggestions soumises à l'humain.
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
 * Applique un commit aux boucles ouvertes.
 *
 * Ferme celles citées explicitement (et annule leurs cues restants — un cue
 * survivant à sa boucle réveillerait un fantôme). Pour le reste, se contente de
 * proposer.
 */
export async function applyCommitToLoops(
  store: IntentionStore,
  commit: CommitInfo
): Promise<CommitCloseResult> {
  const armed = await store.listIntentions({ status: 'armed', limit: 500 });

  const closed: Intention[] = [];
  const unresolved: string[] = [];
  const closedIds = new Set<string>();

  // 1. Marqueurs explicites. Volontairement non bornés au répertoire : si
  // quelqu'un écrit l'identifiant à la main, il sait ce qu'il ferme.
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

    closed.push(intention);
    closedIds.add(target.id);
  }

  // 2. Heuristique, bornée au projet courant et jamais appliquée d'office.
  const suggestions = armed
    .filter((i) => !closedIds.has(i.id) && i.directory === commit.directory)
    .map((intention) => ({ intention, matched: scoreOverlap(intention, commit.files) }))
    .map((s) => ({ ...s, score: s.matched.length }))
    .filter((s) => s.score >= SUGGESTION_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SUGGESTIONS);

  return { closed, suggestions, unresolved };
}

/** Rend le compte rendu affiché après un commit. Chaîne vide si rien à dire. */
export function renderCommitReport(result: CommitCloseResult): string {
  const { closed, suggestions, unresolved } = result;
  if (!closed.length && !suggestions.length && !unresolved.length) return '';

  const lines: string[] = [];

  for (const i of closed) {
    lines.push(`✅ ${loopId(i.id)} fermée — ${i.content}`);
  }

  for (const shortId of unresolved) {
    lines.push(`⚠️  loop-${shortId} : aucune boucle ouverte unique sous cet identifiant`);
  }

  if (suggestions.length) {
    lines.push('');
    lines.push('💡 Boucles peut-être concernées par ce commit :');
    for (const { intention, matched } of suggestions) {
      lines.push(`   ${loopId(intention.id)} — ${intention.content}`);
      lines.push(`      recoupe : ${matched.join(', ')}`);
    }
    lines.push('');
    lines.push(`   Fermer : pnpm cli intent close ${loopId(suggestions[0].intention.id)}`);
  }

  return `${lines.join('\n')}\n`;
}
