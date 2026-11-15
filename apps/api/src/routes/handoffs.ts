import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { escalateConversation, resumeAi } from '../lib/handoff.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

const handoffSchema = z.object({
  reason: z.string().trim().min(3, 'Reason must be at least 3 characters').max(500),
});

/**
 * Human handoff routes for one conversation.
 * Mounted by the coordinator under
 * /api/workspaces/:workspaceId/conversations/:conversationId
 * (auth + workspace membership come from the standard chain at mount).
 */
export function handoffsRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // POST /handoff — agent-triggered human takeover: escalate + pause AI.
  router.post('/handoff', validateBody(handoffSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const conversationId = req.params.conversationId as string;
      const supabase = getUserSupabase(env, req.token!);
      const result = await escalateConversation(supabase, {
        workspaceId,
        conversationId,
        reason: req.body.reason as string,
        triggeredBy: 'agent',
      });
      return res.status(201).json(result);
    } catch (e) {
      return next(e);
    }
  });

  // POST /ai-resume — resume AI after a handoff, only when the workspace
  // policy allows it. AI is never auto-resumed after a human takeover.
  router.post('/ai-resume', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const conversationId = req.params.conversationId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: settings } = await supabase
        .from('ai_settings')
        .select('*')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      const s = settings as { enabled?: boolean; mode?: string } | null;
      const enabled = s?.enabled ?? false;
      const mode = s?.mode ?? 'disabled';
      if (!enabled || mode === 'disabled' || mode === 'human_only') {
        throw new ApiError(409, 'AI assistance cannot be resumed under the current workspace policy');
      }
      await resumeAi(supabase, {
        workspaceId,
        conversationId,
        resumedBy: req.user!.id,
      });
      return res.json({ resumed: true });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
