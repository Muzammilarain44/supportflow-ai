import { Router, type Response } from 'express';
import { profileInitials, UNNAMED_MEMBER, updateProfileSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getSupabase, getUserSupabase } from '../lib/supabase.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

type ProfileRow = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
};

/** Display name derived from the JWT's user_metadata, else null. Never invents a name. */
function displayNameFromMetadata(user: { user_metadata?: Record<string, unknown> } | null): string | null {
  const meta = user?.user_metadata ?? {};
  const raw = meta.full_name ?? meta.name;
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name.length > 0 ? name.slice(0, 100) : null;
}

/**
 * Lazy profile creation (PRIMARY creation mechanism — see migration 0006).
 * Returns the caller's existing profile, or upserts one on first read.
 */
async function ensureProfile(
  supabase: ReturnType<typeof getUserSupabase>,
  userId: string,
  displayName: string | null,
): Promise<ProfileRow> {
  const { data: existing, error: readError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (readError) throw new ApiError(500, 'Failed to load profile');
  if (existing) return existing as ProfileRow;
  const { data, error } = await supabase
    .from('profiles')
    .upsert({ id: userId, display_name: displayName, avatar_url: null }, { onConflict: 'id' })
    .select()
    .single();
  if (error || !data) throw new ApiError(500, 'Failed to create profile');
  return data as ProfileRow;
}

/** Enrich workspace member rows with profile display info. No emails, ever. */
export function enrichMembersWithProfiles(
  members: Array<{ id: string; workspace_id: string; user_id: string; role: string; created_at: string; updated_at?: string }>,
  profiles: Array<{ id: string; display_name: string | null; avatar_url: string | null }>,
): Array<Record<string, unknown>> {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  return members.map((m) => {
    const p = byId.get(m.user_id);
    const rawName = p?.display_name?.trim() ? p.display_name.trim() : null;
    return {
      ...m,
      display_name: rawName ?? UNNAMED_MEMBER,
      avatar_url: p?.avatar_url ?? null,
      initials: profileInitials(rawName),
      member_since: m.created_at,
    };
  });
}

export function profilesRouter(env: Env) {
  const router = Router();

  // GET /api/profile/me — own profile; created lazily on first read.
  router.get('/me', async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      const { data: userData } = await getSupabase(env).auth.getUser(req.token!);
      const displayName = displayNameFromMetadata(
        (userData?.user as { user_metadata?: Record<string, unknown> } | null) ?? null,
      );
      const profile = await ensureProfile(supabase, req.user!.id, displayName);
      return res.json({ profile });
    } catch (e) {
      return next(e);
    }
  });

  // PATCH /api/profile/me — self only. The route has no target id at all:
  // it can only ever update req.user.id, so one user can never edit another's
  // profile. The strict Zod schema also rejects any injected `id` field (400).
  router.patch('/me', validateBody(updateProfileSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const supabase = getUserSupabase(env, req.token!);
      const { data: userData } = await getSupabase(env).auth.getUser(req.token!);
      const displayName = displayNameFromMetadata(
        (userData?.user as { user_metadata?: Record<string, unknown> } | null) ?? null,
      );
      // Ensure the row exists first (signup trigger may have failed silently).
      await ensureProfile(supabase, req.user!.id, displayName);
      const patch: Record<string, unknown> = {};
      if (req.body.display_name !== undefined) {
        const name = typeof req.body.display_name === 'string' ? req.body.display_name.trim() : null;
        patch.display_name = name && name.length > 0 ? name : null;
      }
      if (req.body.avatar_url !== undefined) {
        const url = typeof req.body.avatar_url === 'string' ? req.body.avatar_url.trim() : null;
        patch.avatar_url = url && url.length > 0 ? url : null;
      }
      if (Object.keys(patch).length === 0) throw new ApiError(400, 'No fields to update');
      const { data, error } = await supabase
        .from('profiles')
        .update(patch)
        .eq('id', req.user!.id)
        .select()
        .single();
      if (error || !data) throw new ApiError(500, 'Failed to update profile');
      return res.json({ profile: data });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
