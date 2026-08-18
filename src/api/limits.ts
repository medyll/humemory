/**
 * Request-size and cost limits shared by every route (SECURITY_AUDIT.md M-02).
 *
 * The API accepted JSON of any size and read cost parameters with a bare
 * `parseInt`, so `?limit=999999999` or `NaN` reached the store unchecked and a
 * single request could fill SQLite or pin the process. These caps are the
 * business-level floor; `bodyLimit` in `server.ts` is the transport-level one.
 *
 * The values are deliberately generous — they exist to stop abuse, not to
 * constrain ordinary use. A real learning trace is a few kilobytes at most.
 */

/** Longest memory/intention content accepted on a write. */
export const MAX_CONTENT_LENGTH = 100_000;
/** Longest single keyword, and how many a memory may carry. */
export const MAX_KEYWORD_LENGTH = 200;
export const MAX_KEYWORDS = 100;
/** Longest short free-text field (directory, sessionId, agent, summaries…). */
export const MAX_SHORT_FIELD_LENGTH = 2_000;
/** Longest search query string. */
export const MAX_QUERY_LENGTH = 1_000;
/** How many steps or cues one script/intention may declare. */
export const MAX_COLLECTION_ITEMS = 100;
/** Ceiling for any `limit`-style pagination parameter. */
export const MAX_RESULT_LIMIT = 500;
/** Transport-level cap on a JSON request body, in bytes. */
export const MAX_BODY_BYTES = 1_000_000;

/** Thrown on a limit violation; routes map it to a 400. */
export class LimitExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LimitExceeded';
  }
}

/**
 * Parses a numeric query parameter with a finite, enforced range.
 *
 * Unlike `parseInt`, this rejects `NaN`, `Infinity`, floats and out-of-range
 * values instead of passing them to the store.
 */
export function boundedInt(
  raw: string | undefined,
  opts: { fallback: number; min: number; max: number; name: string }
): number {
  if (raw === undefined || raw === '') return opts.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < opts.min || n > opts.max) {
    throw new LimitExceeded(`"${opts.name}" must be an integer between ${opts.min} and ${opts.max}`);
  }
  return n;
}

/** Same, for an optional parameter with no default. */
export function boundedOptionalInt(
  raw: string | undefined,
  opts: { min: number; max: number; name: string }
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  return boundedInt(raw, { ...opts, fallback: 0 });
}

/** Requires a string no longer than `max`. */
export function boundedString(value: unknown, max: number, name: string): string {
  if (typeof value !== 'string') throw new LimitExceeded(`"${name}" must be a string`);
  if (value.length > max) {
    throw new LimitExceeded(`"${name}" must be at most ${max} characters`);
  }
  return value;
}

/** Same, but tolerates an absent value. */
export function boundedOptionalString(value: unknown, max: number, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return boundedString(value, max, name);
}

/** Requires an array of bounded strings, itself of bounded length. */
export function boundedStringArray(
  value: unknown,
  opts: { maxItems: number; maxItemLength: number; name: string }
): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new LimitExceeded(`"${opts.name}" must be an array`);
  if (value.length > opts.maxItems) {
    throw new LimitExceeded(`"${opts.name}" must hold at most ${opts.maxItems} items`);
  }
  return value.map((item, i) => boundedString(item, opts.maxItemLength, `${opts.name}[${i}]`));
}
