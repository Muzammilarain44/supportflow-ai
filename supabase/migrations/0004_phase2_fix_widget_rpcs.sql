-- ============================================================================
-- 0004_phase2_fix_widget_rpcs.sql
-- Phase 2 — re-create the SECURITY DEFINER RPCs from 0003 (idempotent).
--
-- WHY THIS FILE EXISTS: migration 0003 partially applied live on Supabase
-- project ylqfcfrqbxeevemkkbha. Tables, triggers, RLS and policies applied
-- fine, but the RPC batch failed and rolled back with:
--   ERROR 42883: function digest(text, unknown) does not exist
-- inside get_widget_visitor_history(), because pgcrypto is installed in the
-- `extensions` schema on this project, not `public`, and the RPCs set
-- `search_path = public`, so unqualified digest()/gen_random_bytes()
-- calls do not resolve. Result: 0 of the 5 RPCs exist live. No data was
-- touched (workspaces 0, members 0).
--
-- FIX: this file creates/replaces the same 5 RPCs with IDENTICAL logic,
-- except pgcrypto calls are schema-qualified as extensions.digest(...) /
-- extensions.gen_random_bytes(...). gen_random_uuid() is a pg_catalog
-- built-in and needs no qualification. SECURITY DEFINER, search_path and
-- revoke/grant statements are unchanged from 0003. Safe to re-run.
-- Do NOT edit 0003 itself.
-- ============================================================================

-- ============================================================================
-- SECURITY DEFINER RPCs
-- All use `set search_path = public`, are revoked from public, and are
-- granted only to the roles listed. Each validates workspace consistency
-- itself; RLS does not apply inside a SECURITY DEFINER function.
-- ============================================================================

-- ---------- record_automation_event ----------
-- Authenticated workspace members only. Validates the event type against
-- the allowed list and inserts one outbox row. Returns the new row id.
create or replace function public.record_automation_event(
  p_workspace_id uuid,
  p_event_type text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'Not a workspace member';
  end if;
  if p_event_type not in ('customer.message.created', 'conversation.created',
                          'ticket.created', 'ticket.priority.changed',
                          'ticket.assigned', 'ticket.resolved') then
    raise exception 'Invalid automation event type: %', p_event_type;
  end if;
  if p_entity_type is null or char_length(trim(p_entity_type)) < 1 then
    raise exception 'entity_type is required';
  end if;
  if p_entity_id is null then
    raise exception 'entity_id is required';
  end if;
  insert into public.automation_events
    (workspace_id, event_type, entity_type, entity_id, payload)
  values (p_workspace_id, p_event_type, p_entity_type, p_entity_id,
          coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_automation_event(uuid, text, text, uuid, jsonb) from public;
grant execute on function public.record_automation_event(uuid, text, text, uuid, jsonb) to authenticated;

-- ---------- create_widget_visitor_session ----------
-- Public entry point for the embeddable widget (anon + authenticated).
-- Looks up widget_settings by public_key (must exist and be enabled),
-- reuses an existing customer when the visitor email matches one in the
-- same workspace (case-insensitive), otherwise creates a customer.
-- Without an email a placeholder address visitor-<hex>@widget.local is
-- used, because customers.email is NOT NULL. Creates a fresh open
-- conversation and a 24-hour session. Generates a random token, stores
-- ONLY its SHA-256 hash, and returns the RAW token exactly once — the
-- caller must hand it to the visitor (cookie / localStorage). It is
-- never stored and cannot be recovered from the database afterwards.
create or replace function public.create_widget_visitor_session(
  p_public_key text,
  p_visitor_name text default null,
  p_visitor_email text default null
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
begin
  if p_public_key is null or char_length(trim(p_public_key)) < 1 then
    raise exception 'public_key is required';
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
    (workspace_id, widget_settings_id, visitor_token_hash, customer_id, conversation_id, expires_at)
  values (
    v_settings.workspace_id,
    v_settings.id,
    encode(extensions.digest(v_token, 'sha256'), 'hex'),
    v_customer_id,
    v_conversation_id,
    v_expires_at
  );

  session_token := v_token;
  conversation_id := v_conversation_id;
  customer_id := v_customer_id;
  expires_at := v_expires_at;
  return next;
end;
$$;
revoke all on function public.create_widget_visitor_session(text, text, text) from public;
grant execute on function public.create_widget_visitor_session(text, text, text) to anon, authenticated;

-- ---------- post_widget_visitor_message ----------
-- Public entry point for the widget (anon + authenticated). Hashes the
-- supplied token, finds a non-expired session, validates the body
-- (1..5000 chars), inserts a customer message into the session's
-- conversation, bumps conversation.last_message_at and session
-- last_seen_at, and records an automation_events row for
-- customer.message.created with ids only (no message body in the payload).
-- Returns the new message id.
create or replace function public.post_widget_visitor_message(
  p_token text,
  p_body text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.widget_visitor_sessions;
  v_message_id uuid;
  v_body text;
begin
  if p_token is null or char_length(trim(p_token)) < 1 then
    raise exception 'Session token is required';
  end if;
  if p_body is null then
    raise exception 'Message body is required';
  end if;
  v_body := trim(p_body);
  if char_length(v_body) < 1 or char_length(v_body) > 5000 then
    raise exception 'Message must be between 1 and 5000 characters';
  end if;

  select * into v_session
  from public.widget_visitor_sessions
  where widget_visitor_sessions.visitor_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and widget_visitor_sessions.expires_at > now();
  if v_session.id is null then
    raise exception 'Invalid or expired session';
  end if;

  insert into public.messages
    (workspace_id, conversation_id, customer_id, sender_type, sender_id, body)
  values (v_session.workspace_id, v_session.conversation_id, v_session.customer_id,
          'customer', null, v_body)
  returning id into v_message_id;

  update public.conversations
  set last_message_at = now()
  where conversations.id = v_session.conversation_id;

  update public.widget_visitor_sessions
  set last_seen_at = now()
  where widget_visitor_sessions.id = v_session.id;

  insert into public.automation_events
    (workspace_id, event_type, entity_type, entity_id, payload)
  values (
    v_session.workspace_id,
    'customer.message.created',
    'message',
    v_message_id,
    jsonb_build_object(
      'workspace_id', v_session.workspace_id,
      'conversation_id', v_session.conversation_id,
      'message_id', v_message_id,
      'customer_id', v_session.customer_id
    )
  );

  return v_message_id;
end;
$$;
revoke all on function public.post_widget_visitor_message(text, text) from public;
grant execute on function public.post_widget_visitor_message(text, text) to anon, authenticated;

-- ---------- get_widget_visitor_history ----------
-- Public entry point for the widget (anon + authenticated). Hashes the
-- supplied token and returns ONLY that session's conversation messages,
-- oldest first. Returns zero rows for an unknown or expired token (it
-- does not reveal whether the token ever existed).
create or replace function public.get_widget_visitor_history(p_token text)
returns table (
  message_id uuid,
  sender_type text,
  body text,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = public
as $$
  select m.id, m.sender_type, m.body, m.created_at
  from public.widget_visitor_sessions s
  join public.messages m on m.conversation_id = s.conversation_id
  where s.visitor_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and s.expires_at > now()
  order by m.created_at asc, m.id asc;
$$;
revoke all on function public.get_widget_visitor_history(text) from public;
grant execute on function public.get_widget_visitor_history(text) to anon, authenticated;

-- ---------- get_widget_config ----------
-- Public entry point for the widget (anon + authenticated). Returns the
-- public display config only — business name, welcome message, primary
-- color, enabled flag. No secrets, no workspace ids, no member data.
-- Returns zero rows for an unknown public_key.
create or replace function public.get_widget_config(p_public_key text)
returns table (
  business_name text,
  welcome_message text,
  primary_color text,
  enabled boolean
)
language sql
security definer
stable
set search_path = public
as $$
  select w.business_name, w.welcome_message, w.primary_color, w.enabled
  from public.widget_settings w
  where w.public_key = p_public_key;
$$;
revoke all on function public.get_widget_config(text) from public;
grant execute on function public.get_widget_config(text) to anon, authenticated;
