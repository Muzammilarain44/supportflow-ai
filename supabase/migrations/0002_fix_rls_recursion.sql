-- SupportFlow AI — Phase 1 fix: RLS infinite recursion
-- The 0001 policies queried workspace_members from inside a policy on
-- workspace_members itself. Live Supabase returned:
--   500 "infinite recursion detected in policy for relation workspace_members"
-- on every read of workspaces / workspace_members, which broke all
-- workspace API routes. Fix: check membership through a SECURITY DEFINER
-- helper whose internal query runs as the function owner and bypasses RLS.
-- Apply in Supabase Dashboard > SQL Editor. Idempotent: safe to re-run.

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid()
  );
$$;
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

drop policy if exists "workspaces_select_members" on public.workspaces;
create policy "workspaces_select_members" on public.workspaces for select
  using (public.is_workspace_member(workspaces.id));

drop policy if exists "workspace_members_select_members" on public.workspace_members;
create policy "workspace_members_select_members" on public.workspace_members for select
  using (public.is_workspace_member(workspace_members.workspace_id));
