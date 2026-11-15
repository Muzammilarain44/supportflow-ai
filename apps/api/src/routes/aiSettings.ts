// ============================================================================
// SupportFlow AI — Phase 3: AI settings routes (Worker B)
//
// Mounted by the coordinator (app.ts is NOT edited by Worker B) as:
//   app.use('/api/workspaces/:workspaceId/ai-settings', ...authed, aiSettingsRouter(env))
//
// GET returns the workspace's settings row, or the documented defaults
// when no row exists yet. PATCH is owner-only (the workspace's owner_id
// is checked, mirroring how ownership is the gate elsewhere in the app).
// API keys are NEVER accepted or returned here — keys live only in server
// environment variables (see docs/phase3-ai-providers.md).
// ============================================================================

import { Router, type Response } from 'express';
import { DEFAULT_AI_SETTINGS, updateAiSettingsSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

const DEFAULTS = {
  enabled: DEFAULT_AI_SETTINGS.enabled,
  mode: DEFAULT_AI_SETTINGS.mode,
  provider_order: [...DEFAULT_AI_SETTINGS.provider_order],
  auto_reply_require_grounding: DEFAULT_AI_SETTINGS.auto_reply_require_grounding,
  escalation_on_low_confidence: DEFAULT_AI_SETTINGS.escalation_on_low_confidence,
};

export function aiSettingsRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET / — settings row, or defaults when no row exists yet.
  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('ai_settings')
        .select('*')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      if (error) throw new ApiError(500, 'Failed to load AI settings');
      if (!data) return res.json({ settings: { workspace_id: workspaceId, ...DEFAULTS } });
      return res.json({ settings: data });
    } catch (e) {
      return next(e);
    }
  });

  // PATCH / — owner-only upsert. Never accepts or returns API keys
  // (updateAiSettingsSchema is strict and has no key fields).
  router.patch('/', validateBody(updateAiSettingsSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: workspace, error: wsError } = await supabase
        .from('workspaces')
        .select('owner_id')
        .eq('id', workspaceId)
        .maybeSingle();
      if (wsError || !workspace) throw new ApiError(404, 'Workspace not found');
      if ((workspace as { owner_id: string }).owner_id !== req.user!.id) {
        throw new ApiError(403, 'Only the workspace owner can change AI settings');
      }
      const patch: Record<string, unknown> = {};
      for (const key of [
        'enabled',
        'mode',
        'provider_order',
        'auto_reply_require_grounding',
        'escalation_on_low_confidence',
      ] as const) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }
      if (Object.keys(patch).length === 0) {
        throw new ApiError(400, 'No fields to update');
      }
      const { data: existing } = await supabase
        .from('ai_settings')
        .select('id')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      let result;
      if (existing) {
        result = await supabase
          .from('ai_settings')
          .update(patch)
          .eq('workspace_id', workspaceId)
          .select()
          .single();
      } else {
        result = await supabase
          .from('ai_settings')
          .insert({ workspace_id: workspaceId, ...DEFAULTS, ...patch })
          .select()
          .single();
      }
      if (result.error || !result.data) {
        throw new ApiError(500, 'Failed to save AI settings');
      }
      return res.json({ settings: result.data });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
