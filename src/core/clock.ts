/**
 * Clock seam — permet de piloter le temps en test.
 *
 * humemory est time-driven : toute la dégradation (L0→L4) dépend de l'écart entre
 * `createdAt`/`lastRecalled` et « maintenant ». Tant que ce « maintenant » est un
 * `new Date()` planqué dans le store, une transition de niveau ne peut être testée
 * qu'en attendant réellement 24h. Ce module extrait le seam : la prod injecte
 * `systemClock`, les tests injectent une `FakeClock` qu'ils font avancer à la main.
 *
 * Voir docs/TESTING.md → pilier 2.
 */

export interface Clock {
  now(): Date;
}

/** Horloge de production — lit l'heure système. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Horloge de test — n'avance que sur appel explicite d'`advance()`/`set()`.
 *
 * ```ts
 * const clock = new FakeClock(new Date('2026-01-01T00:00:00Z'));
 * const store = new SQLiteStore(':memory:', { clock });
 * clock.advance(25 * 3600_000); // +25h, L0 → L1
 * ```
 */
export class FakeClock implements Clock {
  private t: Date;

  constructor(start: Date | string | number = new Date('2026-01-01T00:00:00.000Z')) {
    this.t = new Date(start);
  }

  now(): Date {
    // Copie défensive : un appelant qui mute le retour ne doit pas décaler l'horloge.
    return new Date(this.t.getTime());
  }

  /** Avance de `ms` millisecondes. */
  advance(ms: number): this {
    this.t = new Date(this.t.getTime() + ms);
    return this;
  }

  /** Avance de `h` heures — les seuils de decay sont exprimés en heures. */
  advanceHours(h: number): this {
    return this.advance(h * 3600_000);
  }

  /** Avance de `d` jours. */
  advanceDays(d: number): this {
    return this.advance(d * 24 * 3600_000);
  }

  /** Repositionne l'horloge à une date absolue. */
  set(t: Date | string | number): this {
    this.t = new Date(t);
    return this;
  }
}
