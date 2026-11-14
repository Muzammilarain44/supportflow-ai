-- ============================================================================
-- SupportFlow AI — Phase 2 fix: widget message idempotency
-- File: 0005_phase2_widget_message_idempotency.sql
-- Apply AFTER 0004_phase2_fix_widget_rpcs.sql, in order, in
-- Supabase Dashboard > SQL Editor.
--
-- BUG (live-tested 2026-11-14): POST /api/widget/messages twice with the
-- same client_message_id stored TWO identical messages. The messages table
-- already has a partial unique index on (conversation_id, client_message_id),
-- and the widget embed already sends a client_message_id per message — but
-- the RPC post_widget_visitor_message(text, text) never accepted or stored
-- it, so the index could never fire.
--
-- FIX: drop the 2-arg function and re-create it as
-- post_widget_visitor_message(p_token, p_body, p_client_message_id DEFAULT
-- NULL) returning TABLE(message_id uuid, is_duplicate boolean). When a
-- non-null client key is supplied, an existing message with the same
-- conversation_id + client_message_id is returned as a duplicate (no second
-- insert, no second outbox event); otherwise the message is inserted with
-- the key stored. A unique_violation handler covers the concurrent-retry
-- race, mirroring the agent-reply endpoint. The API returns 200 for a
-- duplicate and 201 for a new message.
--
-- Idempotent: safe to re-run (drop function if exists + create or replace).
-- 0003 and 0004 are not edited.
-- ============================================================================

drop function if exists public.post_widget_visitor_message(text, text);

-- ---------- post_widget_visitor_message ----------
-- Public entry point for the widget (anon + authenticated). Hashes the
-- supplied token, finds a non-expired session, validates the body
-- (1..5000 chars), and inserts a customer message into the session's
-- conversation — unless the supplied client_message_id already exists in
-- that conversation, in which case the existing message is returned as a
-- duplicate. Bumps conversation.last_message_at and session last_seen_at,
-- and records an automation_events row for customer.message.created with
-- ids only (no message body in the payload) — exactly once per message.
-- Returns the message id plus whether it was a duplicate.
create or replace function public.post_widget_visitor_message(
  p_token text,
  p_body text,
  p_client_message_id text default null
)
returns table (
  message_id uuid,
  is_duplicate boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.widget_visitor_sessions;
  v_message_id uuid;
  v_body text;
  v_client_key text;
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
  v_client_key := nullif(trim(p_client_message_id), '');
  if v_client_key is not null and char_length(v_client_key) > 100 then
    raise exception 'client_message_id must be at most 100 characters';
  end if;

  select * into v_session
  from public.widget_visitor_sessions
  where widget_visitor_sessions.visitor_token_hash = encode(extensions.digest(p_token, 'sha256'), 'hex')
    and widget_visitor_sessions.expires_at > now();
  if v_session.id is null then
    raise exception 'Invalid or expired session';
  end if;

  -- Idempotency: same client key in this conversation returns the existing
  -- message. No second insert, no second outbox event.
  if v_client_key is not null then
    select m.id into v_message_id
    from public.messages m
    where m.conversation_id = v_session.conversation_id
      and m.client_message_id = v_client_key;
    if v_message_id is not null then
      return query select v_message_id, true;
      return;
    end if;
  end if;

  begin
    insert into public.messages
      (workspace_id, conversation_id, customer_id, sender_type, sender_id, body, client_message_id)
    values (v_session.workspace_id, v_session.conversation_id, v_session.customer_id,
            'customer', null, v_body, v_client_key)
    returning id into v_message_id;
  exception
    -- Concurrent-retry race on the (conversation_id, client_message_id)
    -- unique index: return the row the other transaction inserted.
    when unique_violation then
      select m.id into v_message_id
      from public.messages m
      where m.conversation_id = v_session.conversation_id
        and m.client_message_id = v_client_key;
      if v_message_id is null then
        raise;
      end if;
      return query select v_message_id, true;
      return;
  end;

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

  return query select v_message_id, false;
end;
$$;
revoke all on function public.post_widget_visitor_message(text, text, text) from public;
grant execute on function public.post_widget_visitor_message(text, text, text) to anon, authenticated;
