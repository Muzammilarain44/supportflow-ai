import type { NextFunction, Response } from 'express';
import type { Env } from '../env.js';
import { getUserSupabase } from '../lib/supabase.js';
import { ApiError } from '../errors.js';
import type { AuthedRequest } from './auth.js';

export function workspaceIdFrom(req: AuthedRequest): string | null {
  return (req.params.id as string) ?? (req.body?.workspaceId as string) ?? (req.body?.workspace_id as string) ?? null;
}

/** Pure, unit-testable membership check. */
export function isMember(members: Array<{ workspace_id: string; user_id: string }>, workspaceId: string, userId: string): boolean {
  return members.some((m) => m.workspace_id === workspaceId && m.user_id === userId);
}

/** 403 unless the authenticated user is a member of the requested workspace. */
export function requireWorkspaceMember(env: Env) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const workspaceId = workspaceIdFrom(req);
    if (!workspaceId) return next(new ApiError(400, 'Workspace id is required'));
    if (!req.user || !req.token) return next(new ApiError(401, 'Authentication required'));
    try {
      const supabase = getUserSupabase(env, req.token);
      const { data, error } = await supabase
        .from('workspace_members')
        .select('workspace_id,user_id')
        .eq('workspace_id', workspaceId)
        .eq('user_id', req.user.id)
        .maybeSingle();
      if (error) return next(new ApiError(500, 'Failed to verify workspace membership'));
      if (!data) return next(new ApiError(403, 'You are not a member of this workspace'));
      return next();
    } catch {
      return next(new ApiError(500, 'Failed to verify workspace membership'));
    }
  };
}
