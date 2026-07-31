/**
 * Clock seam — lets tests drive time.
 *
 * humemory is time-driven: all decay (L0→L4) depends on the gap between
 * `createdAt`/`lastRecalled` and "now". As long as that "now" is a `new Date()`
 * buried in the store, a level transition can only be tested by actually waiting
 * 24 hours. This module extracts the seam: production injects `systemClock`,
 * tests inject a `FakeClock` they advance by hand.
 *
 * See docs/TESTING.md → pillar 2.
 */

export interface Clock {
  now(): Date;
}

/** Production clock — reads the system time. */
export const systemClock: Clock = {
  now: () => new Date(),
};

/**
 * Test clock — only moves when `advance()`/`set()` is called.
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
    // Defensive copy: a caller mutating the result must not shift the clock.
    return new Date(this.t.getTime());
  }

  /** Advances by `ms` milliseconds. */
  advance(ms: number): this {
    this.t = new Date(this.t.getTime() + ms);
    return this;
  }

  /** Advances by `h` hours — decay thresholds are expressed in hours. */
  advanceHours(h: number): this {
    return this.advance(h * 3600_000);
  }

  /** Advances by `d` days. */
  advanceDays(d: number): this {
    return this.advance(d * 24 * 3600_000);
  }

  /** Moves the clock to an absolute date. */
  set(t: Date | string | number): this {
    this.t = new Date(t);
    return this;
  }
}
