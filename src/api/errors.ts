/**
 * Uniform server-error responses (SECURITY_AUDIT.md L-01).
 *
 * Handlers used to return `String(error)` to the caller, so a SQLite message
 * could hand out the schema, a constraint name or an absolute local path — free
 * reconnaissance on an API that is meant to be reachable only from loopback but
 * may be exposed deliberately. The full error is now logged server-side under a
 * correlation id, and the client gets that id and nothing else.
 */

import { randomUUID } from 'crypto';

/** Body returned for any unexpected failure. */
export interface ServerErrorBody {
  success: false;
  error: string;
  errorId: string;
}

/**
 * Set HUMEMORY_VERBOSE_ERRORS=1 to echo the real message back to the caller.
 * Intended for local debugging only — it re-enables exactly the disclosure this
 * module exists to prevent, so it is opt-in and never the default.
 */
function verboseErrors(): boolean {
  return process.env.HUMEMORY_VERBOSE_ERRORS === '1';
}

/**
 * Logs `error` with a fresh correlation id and builds the client-facing body.
 *
 * `context` should say which operation failed (e.g. `POST /memories`) so the log
 * line is useful without the request body.
 */
export function serverErrorBody(context: string, error: unknown): ServerErrorBody {
  const errorId = randomUUID();
  // Full detail stays here, on the server, where it is useful and not exposed.
  console.error(`[${errorId}] ${context}:`, error);

  return {
    success: false,
    error: verboseErrors() && error instanceof Error ? error.message : 'Internal server error',
    errorId,
  };
}
