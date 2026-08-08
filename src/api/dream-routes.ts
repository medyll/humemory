/**
 * HTTP routes for dreaming (Phase 6.1). Same testable-sub-router pattern as
 * memory-routes.ts: the store is a parameter, no production DB in tests.
 */

import { Hono } from 'hono';
import type { SQLiteStore } from '../store/sqlite.js';
import { runDreamer, applyDreamProposal } from '../core/dreamer.js';

export function createDreamRoutes(store: SQLiteStore) {
  const app = new Hono();

  app.get('/dreams', async (c) => {
    const status = c.req.query('status') ?? 'pending';
    const proposals = await store.listDreamProposals({ status: status as any });
    return c.json({ success: true, proposals });
  });

  app.post('/dreams/run', async (c) => {
    const report = await runDreamer({ store });
    return c.json({ success: true, report });
  });

  for (const verb of ['approve', 'reject'] as const) {
    app.post(`/dreams/:id/${verb}`, async (c) => {
      try {
        const id = c.req.param('id');
        if (verb === 'approve') {
          const pending = await store.listDreamProposals({ status: 'pending', includeExpired: true });
          const target = pending.find((p) => p.id === id);
          if (!target) return c.json({ success: false, error: 'Not found or not pending' }, 404);
          const effect = await applyDreamProposal(store, target);
          const proposal = await store.resolveDreamProposal(id, 'approved');
          return c.json({ success: true, proposal, effect });
        }
        const proposal = await store.resolveDreamProposal(id, 'rejected');
        return c.json({ success: true, proposal });
      } catch (error) {
        return c.json({ success: false, error: String(error) }, 500);
      }
    });
  }

  return app;
}
