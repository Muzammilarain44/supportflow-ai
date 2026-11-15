import { Router, type Response } from 'express';
import { createWorkspaceSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { validateBody } from '../middleware/validate.js';
import { requireWorkspaceMember } from '../middleware/workspaceAuth.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { enrichMembersWithProfiles } from './profiles.js';

export function workspacesRouter(env: Env) {
  const router = Router();

  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('workspace_members')
        .select('workspace_id, workspaces(id,name,slug,description,owner_id,created_at,updated_at)')
        .eq('user_id', req.user!.id);
      if (error) throw new ApiError(500, 'Failed to list workspaces');
      const workspaces = (data ?? []).map((row: { workspaces: unknown }) => row.workspaces).filter(Boolean);
      return res.json({ workspaces });
    } catch (e) { return next(e); }
  });

  router.post('/', validateBody(createWorkspaceSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      // Secure path: single DB function creates workspace + owner membership atomically.
      const { data, error } = await supabase.rpc('create_workspace_with_owner', {
        p_name: req.body.name, p_slug: req.body.slug, p_description: req.body.description ?? null,
      });
      if (error) {
        const msg = error.message.includes('already exists') ? 'Workspace slug already exists' : 'Failed to create workspace';
        throw new ApiError(error.message.includes('already exists') ? 409 : 400, msg);
      }
      return res.status(201).json({ workspace: data });
    } catch (e) { return next(e); }
  });

  router.get('/:id', requireWorkspaceMember(env), async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase.from('workspaces').select('*').eq('id', req.params.id).single();
      if (error || !data) throw new ApiError(404, 'Workspace not found');
      return res.json({ workspace: data });
    } catch (e) { return next(e); }
  });

  router.get('/:id/members', requireWorkspaceMember(env), async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase.from('workspace_members').select('id,workspace_id,user_id,role,created_at').eq('workspace_id', req.params.id);
      if (error) throw new ApiError(500, 'Failed to list members');
      const members = (data ?? []) as Array<{ id: string; workspace_id: string; user_id: string; role: string; created_at: string }>;
      // Enrich with profile display info (Phase 2.1, Issue 2). Only members
      // of this workspace are ever returned (middleware enforces membership);
      // profiles carry no email, and RLS additionally limits profile reads
      // to users who share a workspace.
      const userIds = members.map((m) => m.user_id);
      const { data: profiles, error: profilesError } = userIds.length > 0
        ? await supabase.from('profiles').select('id,display_name,avatar_url').in('id', userIds)
        : { data: [] as Array<{ id: string; display_name: string | null; avatar_url: string | null }>, error: null };
      if (profilesError) throw new ApiError(500, 'Failed to list members');
      return res.json({ members: enrichMembersWithProfiles(members, (profiles ?? []) as Array<{ id: string; display_name: string | null; avatar_url: string | null }>) });
    } catch (e) { return next(e); }
  });

  return router;
}
