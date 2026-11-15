-- ============================================================================
-- SupportFlow AI — Phase 2.1 fix (Issue 2): real member names, not UUIDs
-- File: 0006_phase2_1_profiles.sql
-- Apply AFTER 0005_phase2_widget_message_idempotency.sql, in order, in
-- Supabase Dashboard > SQL Editor.
--
-- PROBLEM (Issue 2): the Team page and ticket assignees showed raw auth
-- user UUIDs because there was nowhere to store a member's display name.
-- This migration adds a public.profiles table (one row per auth user) and
-- the RLS rules that let members read each other's profiles ONLY when they
-- share a workspace. Emails and auth metadata are NEVER exposed through
-- this table (it has no email column at all).
--
-- PROFILE CREATION — three mechanisms, in priority order:
--   1. PRIMARY: lazy creation in the API (GET /api/profile/me). The first
--      time a signed-in user reads their own profile, the API upserts a
--      row keyed by auth.uid(), deriving display_name from the JWT's
--      user_metadata full_name/name when present. No backend signup hook
--      exists (Supabase Auth signs up directly from the frontend), so the
--      API is the reliable creation path.
--   2. BACKFILL (this file): inserts a profile row (display_name NULL —
--      names are never invented) for every existing auth.users row that
--      lacks one. Idempotent: re-running inserts zero new rows.
--   3. SAFETY NET: a trigger on auth.users auto-creates a profile row on
--      signup, copying full_name/name from raw_user_meta_data when set.
--      The trigger function swallows its own errors (EXCEPTION WHEN OTHERS)
--      so a profile failure can NEVER fail a signup.
--
-- RLS: membership is checked ONLY through SECURITY DEFINER helpers, the
-- same pattern as public.is_workspace_member(uuid) from 0001 — no policy
-- in this file queries workspace_members directly (that caused infinite
-- recursion, fixed by 0002). No policy uses USING (true) anywhere.
--
-- Idempotent: safe to re-run (create table/index if not exists,
-- drop policy/trigger if exists, create or replace function).
-- 0001–0005 are not edited.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. profiles table — one row per auth user, no email column by design.
-- ============================================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists profiles_display_name_idx on public.profiles (display_name);

-- updated_at trigger (reuses the existing public.set_updated_at() from 0001).
drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ============================================================================
-- 2. SECURITY DEFINER helper: do the caller and the target user share at
--    least one workspace? Runs as the function owner and bypasses RLS, so
--    policies can use it without recursing into workspace_members.
-- ============================================================================
create or replace function public.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm1
    join public.workspace_members wm2
      on wm2.workspace_id = wm1.workspace_id
    where wm1.user_id = auth.uid()
      and wm2.user_id = p_user_id
  );
$$;
revoke all on function public.shares_workspace_with(uuid) from public;
grant execute on function public.shares_workspace_with(uuid) to authenticated;

-- ============================================================================
-- 3. Backfill: one profile row per existing auth user that lacks one.
--    display_name is NULL — names are never invented. Idempotent.
-- ============================================================================
insert into public.profiles (id, display_name, avatar_url)
select u.id, null, null
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

-- ============================================================================
-- 4. Signup safety net: auto-create a profile when an auth user is created.
--    Copies full_name/name from raw_user_meta_data when present, else NULL.
--    The exception handler guarantees a profile failure never fails signup.
-- ============================================================================
create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  begin
    v_name := nullif(trim(coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      ''
    )), '');
    if v_name is not null and char_length(v_name) > 100 then
      v_name := left(v_name, 100);
    end if;
    insert into public.profiles (id, display_name, avatar_url)
    values (new.id, v_name, null)
    on conflict (id) do nothing;
  exception when others then
    -- Never fail signup because the profile row could not be created;
    -- the API's lazy creation on GET /api/profile/me covers this case.
    null;
  end;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute function public.handle_new_user_profile();

-- ============================================================================
-- 5. Row Level Security.
--    SELECT: own profile, or a profile of someone who shares a workspace
--      with the caller. Nobody else — and there is no email column to leak.
--    INSERT: only for self (id = auth.uid()). The frontend uses the anon
--      key, so the owning user must be able to insert their own row; the
--      API's lazy creation relies on this.
--    UPDATE / DELETE: only self (id = auth.uid()). No user can ever edit
--      another user's profile.
-- ============================================================================
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_shared_workspace" on public.profiles;
create policy "profiles_select_shared_workspace" on public.profiles for select
  using (
    profiles.id = auth.uid()
    or public.shares_workspace_with(profiles.id)
  );

drop policy if exists "profiles_insert_self" on public.profiles;
create policy "profiles_insert_self" on public.profiles for insert
  with check (profiles.id = auth.uid());

drop policy if exists "profiles_update_self" on public.profiles;
create policy "profiles_update_self" on public.profiles for update
  using (profiles.id = auth.uid())
  with check (profiles.id = auth.uid());

drop policy if exists "profiles_delete_self" on public.profiles;
create policy "profiles_delete_self" on public.profiles for delete
  using (profiles.id = auth.uid());
