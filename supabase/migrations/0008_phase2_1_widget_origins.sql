-- ============================================================================
-- SupportFlow AI — Phase 2.1, Issue 4: enforce widget allowed_origins
-- File: 0008_phase2_1_widget_origins.sql
-- Apply AFTER 0007_phase2_1_last_activity.sql, in order, in
-- Supabase Dashboard > SQL Editor.
--
-- WHY A DB CHANGE IS NEEDED (two things the API cannot do otherwise):
--   1. get_widget_config() (0003) returns display fields only — no
--      allowed_origins, no enabled flag usable for policy — and
--      widget_settings has NO public SELECT policy, so the API cannot read
--      the allow-list as the anon client. A new SECURITY DEFINER RPC
--      exposes exactly the policy fields (enabled + allowed_origins) for
--      one public key, and nothing else (no workspace id, no secrets).
--   2. On session creation the validated parent origin must be STORED on
--      the session, so later message/history calls can be bound to it: a
--      body-supplied origin is never trusted on its own. New nullable
--      column widget_visitor_sessions.parent_origin (null for sessions
--      created before this migration — those fall back to the allow-list
--      check in the API; see docs/phase2-1-origins.md).
--
-- CHANGES:
--   * widget_visitor_sessions.parent_origin text (nullable, no constraint
--     beyond a length check in the RPC — the API normalises before saving).
--   * get_widget_origin_policy(p_public_key) -> (enabled, allowed_origins).
--   * get_widget_session_policy(p_token) -> (parent_origin,
--     allowed_origins, enabled) for one live session, or zero rows for an
--     unknown/expired token (does not reveal whether the token existed).
--   * create_widget_visitor_session() gains an optional 4th parameter
--     p_parent_origin (default null) and stores it. The old 3-arg function
--     is dropped first (same pattern as 0005) so there is exactly one
--     overload; all other logic is IDENTICAL to 0004.
--
-- All RPCs are SECURITY DEFINER with `set search_path = public`, revoked
-- from public, granted to anon + authenticated, and pgcrypto calls are
-- qualified as extensions.digest / extensions.gen_random_bytes (pgcrypto
-- lives in the `extensions` schema on this project — see 0004).
-- The public config response is UNCHANGED: allowed_origins is never added
-- to get_widget_config() and never exposed to unauthenticated callers.
--
-- Idempotent: safe to re-run (ADD COLUMN IF NOT EXISTS, CREATE OR
-- REPLACE, DROP FUNCTION IF EXISTS). 0001–0005 are not edited.
-- ============================================================================

alter table public.widget_visitor_sessions
  add column if not exists parent_origin text;

-- ---------- get_widget_origin_policy ----------
-- Public entry point for the widget API (anon + authenticated). Returns
-- ONLY the enforcement inputs for one public key: whether the widget is
-- enabled and its allow-list. Zero rows for an unknown public_key. No
-- workspace ids, no secrets, no member data.
create or replace function public.get_widget_origin_policy(p_public_key text)
returns table (
  enabled boolean,
  allowed_origins text[]
)
language sql
security definer
stable
set search_path = public
as $$
  select w.enabled, w.allowed_origins
  from public.widget_settings w
  where w.public_key = p_public_key;
$$;
revoke all on function public.get_widget_origin_policy(text) from public;
grant execute on function public.get_widget_origin_policy(text) to anon, authenticated;

-- ---------- get_widget_session_policy ----------
-- Public entry point for the widget API (anon + authenticated). Hashes the
-- supplied token and returns the session's stored parent origin plus the
-- owning widget's allow-list and enabled flag. Zero rows for an unknown
-- or expired token (does not reveal whether the token ever existed).
create or replace function public.get_widget_session_policy(p_token text)
returns table (
  parent_origin text,
  allowed_origins text[],
  enabled boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select s.parent_origin, w.allowed_origins, w.enabled
  from public.widget_visitor_sessions s
  join public.widget_settings w on w.id = s.widget_settings_id
  where s.visitor_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and s.expires_at > now();
$$;
revoke all on function public.get_widget_session_policy(text) from public;
grant execute on function public.get_widget_session_policy(text) to anon, authenticated;

-- ---------- create_widget_visitor_session (4-arg) ----------
-- Same as 0004, plus p_parent_origin: the parent origin the API already
-- validated against the widget's allow-list. Stored on the session so
-- later message/history calls are bound to it. NULL means "no origin was
-- claimed / migration not yet applied" — the API falls back to the
-- allow-list check for such sessions.
drop function if exists public.create_widget_visitor_session(text, text, text);

create or replace function public.create_widget_visitor_session(
  p_public_key text,
  p_visitor_name text default null,
  p_visitor_email text default null,
  p_parent_origin text default null
)
returns table (
  session_token text,
  conversation_id uuid,
  customer_id uuid,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings public.widget_settings;
  v_customer_id uuid;
  v_conversation_id uuid;
  v_token text;
  v_expires_at timestamptz := now() + interval '24 hours';
  v_email text;
  v_name text;
  v_parent_origin text;
begin
  if p_public_key is null or char_length(trim(p_public_key)) < 1 then
    raise exception 'public_key is required';
  end if;
  v_parent_origin := nullif(trim(p_parent_origin), '');
  if v_parent_origin is not null and char_length(v_parent_origin) > 200 then
    raise exception 'parent_origin must be at most 200 characters';
  end if;

  select * into v_settings
  from public.widget_settings
  where widget_settings.public_key = p_public_key;
  if v_settings.id is null then
    raise exception 'Unknown widget key';
  end if;
  if not v_settings.enabled then
    raise exception 'Widget is disabled';
  end if;

  v_email := nullif(lower(trim(coalesce(p_visitor_email, ''))), '');
  v_name := nullif(trim(coalesce(p_visitor_name, '')), '');

  if v_email is not null then
    select id into v_customer_id
    from public.customers
    where customers.workspace_id = v_settings.workspace_id
      and lower(customers.email) = v_email;
  end if;

  if v_customer_id is null then
    insert into public.customers (workspace_id, full_name, email)
    values (
      v_settings.workspace_id,
      coalesce(v_name, 'Website visitor'),
      coalesce(v_email, 'visitor-' || encode(extensions.gen_random_bytes(8), 'hex') || '@widget.local')
    )
    returning id into v_customer_id;
  end if;

  insert into public.conversations (workspace_id, customer_id)
  values (v_settings.workspace_id, v_customer_id)
  returning id into v_conversation_id;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.widget_visitor_sessions
    (workspace_id, widget_settings_id, visitor_token_hash, customer_id, conversation_id, expires_at, parent_origin)
  values (
    v_settings.workspace_id,
    v_settings.id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_customer_id,
    v_conversation_id,
    v_expires_at,
    v_parent_origin
  );

  session_token := v_token;
  conversation_id := v_conversation_id;
  customer_id := v_customer_id;
  expires_at := v_expires_at;
  return next;
end;
$$;
revoke all on function public.create_widget_visitor_session(text, text, text, text) from public;
grant execute on function public.create_widget_visitor_session(text, text, text, text) to anon, authenticated;
