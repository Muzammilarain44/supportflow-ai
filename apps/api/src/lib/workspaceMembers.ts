import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../errors.js';

/** True when the user is a member of the workspace (checked via workspace_members). */
export async function isWorkspaceMember(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'Failed to verify workspace membership');
  return Boolean(data);
}

/** Fetch one member row (for assignment display); null when not a member. */
export async function getWorkspaceMember(
  supabase: SupabaseClient,
  workspaceId: string,
  userId: string,
): Promise<{ id: string; workspace_id: string; user_id: string; role: string; created_at: string } | null> {
  const { data, error } = await supabase
    .from('workspace_members')
    .select('id,workspace_id,user_id,role,created_at')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new ApiError(500, 'Failed to verify workspace membership');
  return (data as { id: string; workspace_id: string; user_id: string; role: string; created_at: string } | null) ?? null;
}
