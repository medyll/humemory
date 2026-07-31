/**
 * DTO rehydration.
 *
 * The API serialises dates as ISO strings. Domain functions (`intentionSaillance`,
 * the decay rules) expect real `Date` objects: the front end gets back the same
 * shapes the backend uses, so the business logic can be reused as is instead of
 * being rewritten in form JavaScript.
 */

import type { Intention, Cue } from '../../src/core/types.js';
import type { IntentionDTO, CueDTO } from './client.js';

function date(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

/**
 * An intention on the front end: the backend model plus the short id the API
 * adds. `loopId` is not part of the model — it is a display convenience, so it
 * stays outside `Intention`.
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
