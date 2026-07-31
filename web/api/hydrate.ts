/**
 * Réhydratation des DTO.
 *
 * L'API sérialise les dates en ISO. Les fonctions du domaine (`intentionSaillance`,
 * règles de décay) attendent de vraies `Date` : on rend au front des objets du
 * même type que le back, ce qui permet de réutiliser la logique métier telle
 * quelle au lieu de la réécrire en JavaScript de formulaire.
 */

import type { Intention, Cue } from '../../src/core/types.js';
import type { IntentionDTO, CueDTO } from './client.js';

function date(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

/**
 * Une intention côté front : le modèle du back, plus l'identifiant court que
 * l'API ajoute. `loopId` n'appartient pas au modèle — c'est une commodité
 * d'affichage, elle reste donc en dehors de `Intention`.
 */
export type IntentionView = Intention & { loopId: string };

export function hydrateIntention(dto: IntentionDTO): IntentionView {
  return {
    ...dto,
    createdAt: new Date(dto.createdAt),
    expiresAt: date(dto.expiresAt),
    firedAt: date(dto.firedAt),
    closedAt: date(dto.closedAt),
  };
}

export function hydrateCue(dto: CueDTO): Cue {
  return {
    ...dto,
    armedAt: new Date(dto.armedAt),
    firedAt: date(dto.firedAt),
  };
}
