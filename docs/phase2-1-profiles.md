# Phase 2.1 — Profiles (Issue 2: real member names instead of UUIDs)

> Bug-fix release, NOT Phase 3. No n8n, no AI agent, no new tables beyond
> `profiles`. Migration `0006_phase2_1_profiles.sql` is applied to live
> Supabase by the coordinator; this document describes what it does and what
> the API/UI now do with it.

## Problem

The Team page and ticket assignees showed raw auth-user UUIDs
(`11111111-…`) because there was nowhere to store a member's display name.
Signup collects email + password only, and Supabase Auth has no backend
signup hook in this app (the frontend signs up directly).

## Migration 0006 — `supabase/migrations/0006_phase2_1_profiles.sql`

- **`public.profiles`**: `id uuid PRIMARY KEY REFERENCES auth.users(id) ON
  DELETE CASCADE`, `display_name text`, `avatar_url text NULL`,
  `created_at` / `updated_at timestamptz NOT NULL DEFAULT now()`, plus the
  `set_updated_at()` trigger reused from 0001. **No email column by design**
  — emails can never leak through this table.
- **RLS** (enabled; no `USING (true)` anywhere):
  - `SELECT`: own profile, or a profile of someone who shares a workspace
    with the caller — via the SECURITY DEFINER helper
    `public.shares_workspace_with(uuid)` (same pattern as
    `public.is_workspace_member(uuid)` from 0001; no policy queries
    `workspace_members` directly, avoiding the infinite-recursion bug fixed
    by 0002).
  - `INSERT`: only for self (`id = auth.uid()`). The frontend uses the anon
    key, so the owning user must be able to insert their own row.
  - `UPDATE` / `DELETE`: only self. No user can ever edit another's profile.
- **Backfill** (idempotent): inserts a profile row (`display_name NULL` —
  names are never invented) for every existing `auth.users` row that lacks
  one. Re-running inserts zero new rows.
- **Signup safety net**: trigger `on_auth_user_created_profile` on
  `auth.users` auto-creates a profile, copying `full_name`/`name` from
  `raw_user_meta_data` when present. Its function swallows its own errors,
  so a profile failure can **never** fail a signup.

### Profile creation — which mechanism is primary?

1. **PRIMARY: lazy creation in the API** (`GET /api/profile/me`). The first
   time a signed-in user reads their own profile, the API upserts a row
   keyed by `auth.uid()`, deriving `display_name` from the JWT's
   `user_metadata` `full_name`/`name` when present, else `NULL`.
2. **Backfill** in migration 0006 (existing users at migration time).
3. **Trigger** on `auth.users` (safety net for new signups).

## API

- `GET /api/workspaces/:workspaceId/members` (extended, existing endpoint):
  same membership enforcement (`requireWorkspaceMember`), now returns per
  member `user_id`, `role`, `display_name` (or `"Unnamed member"`),
  `avatar_url`, `initials` (**computed server-side** from the display name
  via shared `profileInitials()`; `"?"` when unnamed), and `member_since`
  (alias of the member row's `created_at`). Only members of that workspace
  are returned; **no emails**.
- `GET /api/profile/me` (new, auth only, NOT workspace-scoped): returns the
  caller's profile, creating it lazily on first read (see above).
- `PATCH /api/profile/me` (new, auth only, NOT workspace-scoped): the caller
  may update only `display_name` (trimmed, max 100 chars; empty becomes
  `NULL`) and `avatar_url` (must be an `https` URL or empty, max 500 chars)
  for their own id. Validated with the strict shared Zod schema
  `updateProfileSchema` — an injected `id` field is rejected (400), and the
  route has no target id at all, so one user can never edit another's
  profile. Returns the updated profile.

## UI

- **Team page**: avatar circle with initials (or the avatar image when
  `avatar_url` is set), display name, role badge, member since. No raw UUID
  in any ordinary label; UUIDs remain only as React keys / internal ids.
- **Tickets list + detail**: assignee shows the member display name from
  the members-with-profiles data the page already fetches; `"Unnamed
  member"` when the assignee has no profile/name, `"Unassigned"` when null.
  The assignee filter / assignee dropdowns also list names now.
- **Shared types** (`packages/shared`): `Profile`, `MemberWithProfile`,
  `updateProfileSchema`, `profileInitials()`, `UNNAMED_MEMBER`.
- **Web API client** (`apps/web/src/lib/api.ts`, additive only):
  `listMembersWithProfiles()`, `getMyProfile()`, `updateMyProfile()`. The
  original `listMembers()` is unchanged (Inbox still uses it — see below).

## Security

- No endpoint returns emails or auth metadata. The `profiles` table has no
  email column.
- Profile reads are limited to shared workspaces (RLS +
  `shares_workspace_with`); direct profile edits are self-only (RLS + the
  API route having no target id).
- `avatar_url` accepts `https` URLs only.

## Known leftover (out of Issue 2 scope)

Inbox still uses the old `listMembers()` and its assignee display was not
changed — it may still show raw UUIDs there. That is a follow-up, not part
of Issue 2 (Team + Tickets only).

## NOT TESTED (honest gaps — parent verifies live)

- **Live backfill / live RLS against real Supabase**: the migration SQL was
  never run against a live database in this task (no live Supabase access,
  no production data touched). The coordinator must apply 0006 in the
  Supabase SQL Editor and verify: backfill row count, a second user in a
  shared workspace can read a profile, a user in a different workspace
  cannot, and signup still succeeds.
- **Live `auth.users` trigger**: same reason — verify a new signup creates a
  profile row without breaking signup.
- **Live avatar image rendering**: only mocked in web tests.
- Covered by tests instead: API behaviour against a mocked Supabase client
  (11 tests) and UI rendering against mocked fetch (5 tests).
