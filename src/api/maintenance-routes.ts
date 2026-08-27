/**
 * HTTP surface for maintenance health (same testable-sub-router pattern as
 * dream-routes.ts: every path is a parameter, no production files in tests).
 *
 * These routes sit behind the API token like every other data route. `/health`
 * deliberately stays coarse and public — the watchdog only needs liveness, and
 * `lastError` is internal detail that has no business on an unauthenticated
 * endpoint (SECURITY_AUDIT.md L-01).
 */

import { Hono } from 'hono';
import { assessMaintenance, readMaintenanceState, DEFAULT_STALE_AFTER_MS } from '../agent/maintenance-state.js';
import { serverErrorBody } from './errors.js';

export interface MaintenanceLoopHandle {
  runNow(): Promise<void>;
  readonly busy: boolean;
}

export interface MaintenanceRoutesOptions {
  statePath: string;
  staleAfterMs?: number;
  /**
   * Resolves the loop this process hosts, or undefined when an external
   * scheduler drives maintenance instead. A getter rather than a value because
   * the server binds the routes before it decides to start the loop.
   */
  loop?: () => MaintenanceLoopHandle | undefined;
}

export function createMaintenanceRoutes(options: MaintenanceRoutesOptions) {
  const app = new Hono();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  app.get('/maintenance/status', async (c) => {
    try {
      const state = await readMaintenanceState(options.statePath);
      const health = assessMaintenance(state, { staleAfterMs });
      return c.json({
        success: true,
        maintenance: {
          ...health,
          hostedHere: options.loop?.() !== undefined,
          running: options.loop?.()?.busy ?? false,
          staleAfterMs,
        },
      });
    } catch (error) {
      return c.json(serverErrorBody('maintenance status', error), 500);
    }
  });

  // Force a pass — the dashboard's "consolidate now", and the escape hatch when
  // the schedule is known to have missed a window.
  app.post('/maintenance/run', async (c) => {
    const loop = options.loop?.();
    if (!loop) {
      return c.json({ success: false, error: 'No maintenance loop in this process' }, 409);
    }
    if (loop.busy) {
      return c.json({ success: false, error: 'A maintenance pass is already running' }, 409);
    }
    try {
      await loop.runNow();
      const state = await readMaintenanceState(options.statePath);
      return c.json({ success: true, maintenance: assessMaintenance(state, { staleAfterMs }) });
    } catch (error) {
      return c.json(serverErrorBody('maintenance run', error), 500);
    }
  });

  return app;
}
