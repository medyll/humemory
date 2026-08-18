/**
 * CORS origin allow-list (SECURITY_AUDIT.md M-04).
 *
 * Extracted from `server.ts` for the same reason as the route modules: importing
 * `server.ts` constructs the store and would open the production database, so
 * anything that needs testing lives outside it (BUG-08).
 */

/**
 * Normalises an origin to its canonical `scheme://host[:port]` form, or null if
 * it is not a parseable absolute URL.
 */
export function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

/**
 * Builds an exact-match origin checker for hono's `cors({ origin })`.
 *
 * The previous check was `origin.includes(allowed)`, a substring test: with a
 * custom CORS_ORIGINS entry, `http://localhost:3456.evil.example` contains the
 * allowed value and passed. Both sides are now parsed and compared as whole
 * origins, and anything unparseable is refused.
 */
export function makeOriginChecker(allowed: string[]): (origin: string) => string | undefined {
  const normalized = new Set(
    allowed.map((a) => normalizeOrigin(a)).filter((a): a is string => a !== null)
  );

  return (origin: string) => {
    // No Origin header (curl, a native client): CORS does not apply, and
    // answering `*` alongside `credentials: true` is a combination browsers
    // reject anyway. Send no allow-origin at all.
    if (!origin) return undefined;
    const candidate = normalizeOrigin(origin);
    return candidate && normalized.has(candidate) ? candidate : undefined;
  };
}
