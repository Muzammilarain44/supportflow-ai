-- SupportFlow AI — Phase 1 migration
-- Tables: workspaces, workspace_members ONLY. Future tables are documented, not created here.
-- Apply in Supabase Dashboard > SQL Editor. Requires pgcrypto/gen_random_uuid (built-in on Supabase).
-- RLS: no wildcard (USING (true)) policies anywhere.

create extension if not exists "pgcrypto";

-- ---------- workspaces ----------
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) >= 2),
  slug text not null unique check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists workspaces_slug_idx on public.workspaces (slug);
create index if not exists workspaces_owner_idx on public.workspaces (owner_id);

-- ---------- workspace_members ----------
create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists workspace_members_workspace_idx on public.workspace_members (workspace_id);
create index if not exists workspace_members_user_idx on public.workspace_members (user_id);

-- ---------- updated_at trigger ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;
drop trigger if exists workspaces_updated_at on public.workspaces;
create trigger workspaces_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();
drop trigger if exists workspace_members_updated_at on public.workspace_members;
create trigger workspace_members_updated_at before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- ---------- secure workspace creation (atomic, server/DB controlled) ----------
-- SECURITY DEFINER so the insert of workspace + owner member happens in one transaction.
-- The function itself enforces: caller is authenticated, slug format, duplicate slug -> exception.
create or replace function public.create_workspace_with_owner(
  p_name text, p_slug text, p_description text default null
)
returns public.workspaces
language plpgsql security definer
set search_path = public
as $$
declare v_workspace public.workspaces;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  if p_name is null or char_length(trim(p_name)) < 2 then raise exception 'Workspace name is required'; end if;
  if p_slug is null or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then raise exception 'Invalid slug format'; end if;
  insert into public.workspaces (name, slug, description, owner_id)
    values (trim(p_name), p_slug, nullif(trim(coalesce(p_description, '')), ''), auth.uid())
    returning * into v_workspace;
  insert into public.workspace_members (workspace_id, user_id, role)
    values (v_workspace.id, auth.uid(), 'owner');
  return v_workspace;
exception when unique_violation then
  raise exception 'Workspace slug already exists';
end;
$$;
revoke all on function public.create_workspace_with_owner(text, text, text) from public;
grant execute on function public.create_workspace_with_owner(text, text, text) to authenticated;

-- ---------- Row Level Security ----------
-- IMPORTANT: never write a policy on workspace_members that queries
-- workspace_members directly — Postgres evaluates that subquery under the
-- same policy and fails with "infinite recursion detected in policy".
-- Membership is therefore checked through this SECURITY DEFINER helper,
-- whose internal query runs as the function owner and bypasses RLS.
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

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

-- workspaces: a user can read a workspace only if they are a member of it.
drop policy if exists "workspaces_select_members" on public.workspaces;
create policy "workspaces_select_members" on public.workspaces for select
  using (public.is_workspace_member(workspaces.id));
-- No direct INSERT/UPDATE/DELETE policies for workspaces: creation goes through
-- create_workspace_with_owner() (SECURITY DEFINER). Direct writes are denied by default.

-- workspace_members: a user can read members only of workspaces they belong to.
drop policy if exists "workspace_members_select_members" on public.workspace_members;
create policy "workspace_members_select_members" on public.workspace_members for select
  using (public.is_workspace_member(workspace_members.workspace_id));
-- No direct INSERT/UPDATE/DELETE policies: membership is created by the secure function
-- (owner row) and, in later phases, by owner/admin-only server-side operations.
