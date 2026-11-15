import { Router, type Response } from 'express';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import type { AuthedRequest } from '../middleware/auth.js';

const EVENT_STATUSES = ['pending', 'processing', 'processed', 'failed', 'dead'] as const;

/**
 * GET /api/workspaces/:workspaceId/automation-events
 * Member-only (requireWorkspaceMember is applied where this router is
 * mounted in app.ts). Read-only view of the transactional outbox:
 * status filter + server-side pagination, newest first.
 * Response shape matches the other list endpoints:
 *   { automation_events, total, page, pageSize }
 * Errors are { error } via the shared errorHandler.
 *
 * NOTE: this router is NOT mounted in app.ts yet — mounting is left to
 * the integration step so this worker does not touch app.ts.
 */
export function automationEventsRouter(env: Env) {
  const router = Router({ mergeParams: true });

  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize, status } = parseListQuery(req);
      if (status && !(EVENT_STATUSES as readonly string[]).includes(status)) {
        throw new ApiError(400, `Invalid status filter: ${status}`);
      }
      const supabase = getUserSupabase(env, req.token!);
      let query = supabase
        .from('automation_events')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (status) query = query.eq('status', status);
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list automation events');
      return res.json({ automation_events: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
