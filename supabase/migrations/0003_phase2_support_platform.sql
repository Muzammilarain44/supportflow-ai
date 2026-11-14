-- ============================================================================
-- SupportFlow AI — Phase 2 migration: support platform
-- File: 0003_phase2_support_platform.sql
-- Apply AFTER 0001_phase1_workspaces.sql and 0002_fix_rls_recursion.sql,
-- in order, in Supabase Dashboard > SQL Editor.
-- Idempotent: safe to re-run (create table/index if not exists,
-- drop policy/trigger if exists, create or replace function).
--
-- Tables created:
--   customers, conversations, messages, tickets, ticket_events,
--   conversation_notes, widget_settings, widget_visitor_sessions,
--   automation_events (transactional outbox, Phase 3 n8n-ready).
--
-- VERIFICATION NOTE — public.is_workspace_member(uuid):
--   Defined in 0001 and re-asserted in 0002 as:
--     language sql, SECURITY DEFINER, STABLE, set search_path = public,
--     granted EXECUTE to `authenticated` only (revoked from public).
--   It is NOT re-created here. The grants below only re-assert that same
--   state idempotently, so a re-run of this file can never widen access.
--   Membership is checked ONLY through this helper. No policy in this file
--   queries workspace_members directly (that caused infinite recursion,
--   fixed by 0002). No policy uses USING (true) anywhere.
-- ============================================================================

create extension if not exists "pgcrypto";

-- Re-assert the Phase 1 membership helper grants (idempotent, no re-create).
revoke all on function public.is_workspace_member(uuid) from public;
grant execute on function public.is_workspace_member(uuid) to authenticated;

-- ============================================================================
-- 1. customers
-- ============================================================================
create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  full_name text not null check (char_length(trim(full_name)) >= 2),
  email text not null,
  phone text,
  tags text[] not null default '{}',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_activity_at timestamptz
);
-- Workspace-scoped case-insensitive email uniqueness.
create unique index if not exists customers_workspace_email_idx
  on public.customers (workspace_id, lower(email));
create index if not exists customers_workspace_idx
  on public.customers (workspace_id);
create index if not exists customers_workspace_created_idx
  on public.customers (workspace_id, created_at desc);

-- ============================================================================
-- 2. conversations
-- ============================================================================
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  customer_id uuid not null references public.customers (id) on delete cascade,
  status text not null default 'open'
    check (status in ('open', 'pending', 'resolved', 'closed')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  assigned_to uuid references auth.users (id) on delete set null,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz
);
create index if not exists conversations_workspace_last_message_idx
  on public.conversations (workspace_id, last_message_at desc nulls last);
create index if not exists conversations_workspace_status_idx
  on public.conversations (workspace_id, status);
create index if not exists conversations_workspace_assigned_idx
  on public.conversations (workspace_id, assigned_to);
create index if not exists conversations_customer_idx
  on public.conversations (customer_id);

-- ============================================================================
-- 3. messages
-- ============================================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  sender_type text not null
    check (sender_type in ('customer', 'agent', 'system')),
  sender_id uuid, -- auth user id for agents, NULL for customers
  body text not null check (char_length(body) between 1 and 5000),
  client_message_id text, -- idempotency key supplied by the client
  created_at timestamptz not null default now(),
  read_at timestamptz
);
-- Duplicate prevention: same client key can only appear once per conversation.
create unique index if not exists messages_conversation_client_id_idx
  on public.messages (conversation_id, client_message_id)
  where client_message_id is not null;
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at);
create index if not exists messages_workspace_created_idx
  on public.messages (workspace_id, created_at desc);

-- ============================================================================
-- 4. tickets
-- ============================================================================
create table if not exists public.tickets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  customer_id uuid references public.customers (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  subject text not null check (char_length(trim(subject)) between 2 and 200),
  description text,
  category text not null default 'general'
    check (category in ('general', 'billing', 'technical', 'feature', 'bug', 'other')),
  priority text not null default 'medium'
    check (priority in ('low', 'medium', 'high', 'urgent')),
  status text not null default 'open'
    check (status in ('open', 'in_progress', 'waiting_for_customer', 'resolved', 'closed')),
  assigned_to uuid references auth.users (id) on delete set null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists tickets_workspace_status_idx
  on public.tickets (workspace_id, status);
create index if not exists tickets_workspace_priority_idx
  on public.tickets (workspace_id, priority);
create index if not exists tickets_workspace_assigned_idx
  on public.tickets (workspace_id, assigned_to);
create index if not exists tickets_workspace_created_idx
  on public.tickets (workspace_id, created_at desc);
create index if not exists tickets_customer_idx
  on public.tickets (customer_id);
create index if not exists tickets_conversation_idx
  on public.tickets (conversation_id);

-- ============================================================================
-- 5. ticket_events (audit trail for tickets)
-- ============================================================================
create table if not exists public.ticket_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  ticket_id uuid not null references public.tickets (id) on delete cascade,
  actor_id uuid references auth.users (id) on delete set null,
  event_type text not null
    check (event_type in ('created', 'status_changed', 'priority_changed',
                          'assigned', 'unassigned', 'note_added',
                          'comment_added', 'resolved', 'reopened', 'updated')),
  field_name text,
  old_value text,
  new_value text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists ticket_events_ticket_created_idx
  on public.ticket_events (ticket_id, created_at);

-- ============================================================================
-- 6. conversation_notes (internal agent notes, never shown to customers)
-- ============================================================================
create table if not exists public.conversation_notes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null,
  body text not null check (char_length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists conversation_notes_conversation_created_idx
  on public.conversation_notes (conversation_id, created_at);

-- ============================================================================
-- 7. widget_settings (one embeddable chat widget per workspace)
--    public_key is a PUBLIC identifier only: it grants no data access by
--    itself. All visitor data access goes through the SECURITY DEFINER
--    RPCs below, which validate the session token hash.
-- ============================================================================
create table if not exists public.widget_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  public_key text not null unique
    check (public_key ~ '^wgt_[0-9a-f]{32}$')
    default ('wgt_' || encode(gen_random_bytes(16), 'hex')),
  enabled boolean not null default true,
  business_name text not null default 'Support',
  welcome_message text not null default 'Hi! How can we help you today?',
  primary_color text not null default '#7C3AED',
  allowed_origins text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The UNIQUE constraint on public_key already creates a unique index on it.

-- ============================================================================
-- 8. widget_visitor_sessions (guest chat sessions)
--    Only the SHA-256 hash of the visitor token is stored. The raw token is
--    NEVER stored in the database; it is returned once by
--    create_widget_visitor_session() and must be handed to the visitor
--    (e.g. cookie / localStorage) by the caller.
-- ============================================================================
create table if not exists public.widget_visitor_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  widget_settings_id uuid not null references public.widget_settings (id) on delete cascade,
  visitor_token_hash text not null unique,
  customer_id uuid references public.customers (id) on delete set null,
  conversation_id uuid references public.conversations (id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
-- The UNIQUE constraint on visitor_token_hash already creates a unique index.
create index if not exists widget_visitor_sessions_workspace_expires_idx
  on public.widget_visitor_sessions (workspace_id, expires_at);

-- ============================================================================
-- 9. automation_events (transactional outbox, Phase 3 n8n-ready)
--    Record only — NO webhooks are sent from the database. Phase 3 polls
--    this table (see docs/phase2-migrations.md). Payload must contain ids,
--    slugs and status/priority values ONLY: no message bodies, emails or
--    phone numbers. The CHECK below enforces that at the database level.
-- ============================================================================
create table if not exists public.automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event_type text not null
    check (event_type in ('customer.message.created', 'conversation.created',
                          'ticket.created', 'ticket.priority.changed',
                          'ticket.assigned', 'ticket.resolved')),
  entity_type text not null check (char_length(trim(entity_type)) >= 1),
  entity_id uuid not null,
  payload jsonb not null default '{}'::jsonb
    check (not (payload ?| array['body', 'email', 'phone', 'phone_number', 'message', 'content'])),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'processed', 'failed', 'dead')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists automation_events_status_created_idx
  on public.automation_events (status, created_at);
create index if not exists automation_events_workspace_created_idx
  on public.automation_events (workspace_id, created_at desc);

-- ============================================================================
-- Cross-workspace safety: one generic trigger function.
-- Plain (not SECURITY DEFINER) trigger function: triggers run as the table
-- owner and bypass RLS, so the lookups below are not policy-filtered.
-- Fires BEFORE INSERT OR UPDATE on every table that references another
-- workspace-scoped row, and rejects the write when the referenced row
-- belongs to a different workspace. FK constraints alone cannot catch
-- this (they only check the referenced row exists, not its workspace).
-- ============================================================================
create or replace function public.enforce_workspace_consistency()
returns trigger
language plpgsql
as $$
declare
  v_ws uuid;
begin
  if tg_table_name = 'conversations' then
    select workspace_id into v_ws from public.customers where id = new.customer_id;
    if v_ws is null then
      raise exception 'conversations: customer % not found', new.customer_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'conversations: customer belongs to a different workspace';
    end if;

  elsif tg_table_name = 'messages' then
    select workspace_id into v_ws from public.conversations where id = new.conversation_id;
    if v_ws is null then
      raise exception 'messages: conversation % not found', new.conversation_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'messages: conversation belongs to a different workspace';
    end if;
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'messages: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'messages: customer belongs to a different workspace';
      end if;
    end if;

  elsif tg_table_name = 'tickets' then
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'tickets: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'tickets: customer belongs to a different workspace';
      end if;
    end if;
    if new.conversation_id is not null then
      select workspace_id into v_ws from public.conversations where id = new.conversation_id;
      if v_ws is null then
        raise exception 'tickets: conversation % not found', new.conversation_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'tickets: conversation belongs to a different workspace';
      end if;
    end if;

  elsif tg_table_name = 'ticket_events' then
    select workspace_id into v_ws from public.tickets where id = new.ticket_id;
    if v_ws is null then
      raise exception 'ticket_events: ticket % not found', new.ticket_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'ticket_events: ticket belongs to a different workspace';
    end if;

  elsif tg_table_name = 'conversation_notes' then
    select workspace_id into v_ws from public.conversations where id = new.conversation_id;
    if v_ws is null then
      raise exception 'conversation_notes: conversation % not found', new.conversation_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'conversation_notes: conversation belongs to a different workspace';
    end if;

  elsif tg_table_name = 'widget_visitor_sessions' then
    select workspace_id into v_ws from public.widget_settings where id = new.widget_settings_id;
    if v_ws is null then
      raise exception 'widget_visitor_sessions: widget_settings % not found', new.widget_settings_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'widget_visitor_sessions: widget_settings belongs to a different workspace';
    end if;
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'widget_visitor_sessions: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'widget_visitor_sessions: customer belongs to a different workspace';
      end if;
    end if;
    if new.conversation_id is not null then
      select workspace_id into v_ws from public.conversations where id = new.conversation_id;
      if v_ws is null then
        raise exception 'widget_visitor_sessions: conversation % not found', new.conversation_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'widget_visitor_sessions: conversation belongs to a different workspace';
      end if;
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists conversations_workspace_consistency on public.conversations;
create trigger conversations_workspace_consistency
  before insert or update on public.conversations
  for each row execute function public.enforce_workspace_consistency();

drop trigger if exists messages_workspace_consistency on public.messages;
create trigger messages_workspace_consistency
  before insert or update on public.messages
  for each row execute function public.enforce_workspace_consistency();

drop trigger if exists tickets_workspace_consistency on public.tickets;
create trigger tickets_workspace_consistency
  before insert or update on public.tickets
  for each row execute function public.enforce_workspace_consistency();

drop trigger if exists ticket_events_workspace_consistency on public.ticket_events;
create trigger ticket_events_workspace_consistency
  before insert or update on public.ticket_events
  for each row execute function public.enforce_workspace_consistency();

drop trigger if exists conversation_notes_workspace_consistency on public.conversation_notes;
create trigger conversation_notes_workspace_consistency
  before insert or update on public.conversation_notes
  for each row execute function public.enforce_workspace_consistency();

drop trigger if exists widget_visitor_sessions_workspace_consistency on public.widget_visitor_sessions;
create trigger widget_visitor_sessions_workspace_consistency
  before insert or update on public.widget_visitor_sessions
  for each row execute function public.enforce_workspace_consistency();

-- ============================================================================
-- updated_at triggers (uses the existing public.set_updated_at() from 0001)
-- ============================================================================
drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at before update on public.customers
  for each row execute function public.set_updated_at();

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at before update on public.conversations
  for each row execute function public.set_updated_at();

drop trigger if exists tickets_updated_at on public.tickets;
create trigger tickets_updated_at before update on public.tickets
  for each row execute function public.set_updated_at();

drop trigger if exists conversation_notes_updated_at on public.conversation_notes;
create trigger conversation_notes_updated_at before update on public.conversation_notes
  for each row execute function public.set_updated_at();

drop trigger if exists widget_settings_updated_at on public.widget_settings;
create trigger widget_settings_updated_at before update on public.widget_settings
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security — enable on ALL new tables.
-- Member tables: every policy goes through public.is_workspace_member().
-- No USING (true) policy anywhere.
-- ============================================================================
alter table public.customers enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_events enable row level security;
alter table public.conversation_notes enable row level security;
alter table public.widget_settings enable row level security;
alter table public.widget_visitor_sessions enable row level security;
alter table public.automation_events enable row level security;

-- ---------- customers ----------
drop policy if exists "customers_select_members" on public.customers;
create policy "customers_select_members" on public.customers for select
  using (public.is_workspace_member(customers.workspace_id));
drop policy if exists "customers_insert_members" on public.customers;
create policy "customers_insert_members" on public.customers for insert
  with check (public.is_workspace_member(customers.workspace_id));
drop policy if exists "customers_update_members" on public.customers;
create policy "customers_update_members" on public.customers for update
  using (public.is_workspace_member(customers.workspace_id))
  with check (public.is_workspace_member(customers.workspace_id));
drop policy if exists "customers_delete_members" on public.customers;
create policy "customers_delete_members" on public.customers for delete
  using (public.is_workspace_member(customers.workspace_id));

-- ---------- conversations ----------
drop policy if exists "conversations_select_members" on public.conversations;
create policy "conversations_select_members" on public.conversations for select
  using (public.is_workspace_member(conversations.workspace_id));
drop policy if exists "conversations_insert_members" on public.conversations;
create policy "conversations_insert_members" on public.conversations for insert
  with check (public.is_workspace_member(conversations.workspace_id));
drop policy if exists "conversations_update_members" on public.conversations;
create policy "conversations_update_members" on public.conversations for update
  using (public.is_workspace_member(conversations.workspace_id))
  with check (public.is_workspace_member(conversations.workspace_id));
drop policy if exists "conversations_delete_members" on public.conversations;
create policy "conversations_delete_members" on public.conversations for delete
  using (public.is_workspace_member(conversations.workspace_id));

-- ---------- messages ----------
drop policy if exists "messages_select_members" on public.messages;
create policy "messages_select_members" on public.messages for select
  using (public.is_workspace_member(messages.workspace_id));
drop policy if exists "messages_insert_members" on public.messages;
create policy "messages_insert_members" on public.messages for insert
  with check (public.is_workspace_member(messages.workspace_id));
drop policy if exists "messages_update_members" on public.messages;
create policy "messages_update_members" on public.messages for update
  using (public.is_workspace_member(messages.workspace_id))
  with check (public.is_workspace_member(messages.workspace_id));
drop policy if exists "messages_delete_members" on public.messages;
create policy "messages_delete_members" on public.messages for delete
  using (public.is_workspace_member(messages.workspace_id));

-- ---------- tickets ----------
drop policy if exists "tickets_select_members" on public.tickets;
create policy "tickets_select_members" on public.tickets for select
  using (public.is_workspace_member(tickets.workspace_id));
drop policy if exists "tickets_insert_members" on public.tickets;
create policy "tickets_insert_members" on public.tickets for insert
  with check (public.is_workspace_member(tickets.workspace_id));
drop policy if exists "tickets_update_members" on public.tickets;
create policy "tickets_update_members" on public.tickets for update
  using (public.is_workspace_member(tickets.workspace_id))
  with check (public.is_workspace_member(tickets.workspace_id));
drop policy if exists "tickets_delete_members" on public.tickets;
create policy "tickets_delete_members" on public.tickets for delete
  using (public.is_workspace_member(tickets.workspace_id));

-- ---------- ticket_events ----------
drop policy if exists "ticket_events_select_members" on public.ticket_events;
create policy "ticket_events_select_members" on public.ticket_events for select
  using (public.is_workspace_member(ticket_events.workspace_id));
drop policy if exists "ticket_events_insert_members" on public.ticket_events;
create policy "ticket_events_insert_members" on public.ticket_events for insert
  with check (public.is_workspace_member(ticket_events.workspace_id));
drop policy if exists "ticket_events_update_members" on public.ticket_events;
create policy "ticket_events_update_members" on public.ticket_events for update
  using (public.is_workspace_member(ticket_events.workspace_id))
  with check (public.is_workspace_member(ticket_events.workspace_id));
drop policy if exists "ticket_events_delete_members" on public.ticket_events;
create policy "ticket_events_delete_members" on public.ticket_events for delete
  using (public.is_workspace_member(ticket_events.workspace_id));

-- ---------- conversation_notes ----------
drop policy if exists "conversation_notes_select_members" on public.conversation_notes;
create policy "conversation_notes_select_members" on public.conversation_notes for select
  using (public.is_workspace_member(conversation_notes.workspace_id));
drop policy if exists "conversation_notes_insert_members" on public.conversation_notes;
create policy "conversation_notes_insert_members" on public.conversation_notes for insert
  with check (public.is_workspace_member(conversation_notes.workspace_id));
drop policy if exists "conversation_notes_update_members" on public.conversation_notes;
create policy "conversation_notes_update_members" on public.conversation_notes for update
  using (public.is_workspace_member(conversation_notes.workspace_id))
  with check (public.is_workspace_member(conversation_notes.workspace_id));
drop policy if exists "conversation_notes_delete_members" on public.conversation_notes;
create policy "conversation_notes_delete_members" on public.conversation_notes for delete
  using (public.is_workspace_member(conversation_notes.workspace_id));

-- ---------- widget_settings ----------
-- Member-only. No public/anon access: the public widget reads config only
-- through get_widget_config() (SECURITY DEFINER RPC below).
drop policy if exists "widget_settings_select_members" on public.widget_settings;
create policy "widget_settings_select_members" on public.widget_settings for select
  using (public.is_workspace_member(widget_settings.workspace_id));
drop policy if exists "widget_settings_insert_members" on public.widget_settings;
create policy "widget_settings_insert_members" on public.widget_settings for insert
  with check (public.is_workspace_member(widget_settings.workspace_id));
drop policy if exists "widget_settings_update_members" on public.widget_settings;
create policy "widget_settings_update_members" on public.widget_settings for update
  using (public.is_workspace_member(widget_settings.workspace_id))
  with check (public.is_workspace_member(widget_settings.workspace_id));
-- No DELETE policy: widget settings are removed by deleting the workspace
-- (ON DELETE CASCADE) or by a future admin operation.

-- ---------- widget_visitor_sessions ----------
-- INTENTIONALLY NO POLICIES: RLS is enabled and every direct SELECT/INSERT/
-- UPDATE/DELETE by anon or authenticated is denied by default. Visitor
-- access goes ONLY through the SECURITY DEFINER RPCs below, which validate
-- the SHA-256 hash of the visitor token and the session expiry.

-- ---------- automation_events ----------
-- Member SELECT only (read-only for members). No direct INSERT/UPDATE/DELETE
-- policies: rows are written only via record_automation_event() and the
-- widget RPCs (all SECURITY DEFINER, bypassing RLS). Phase 3 consumers
-- update status via a future service-role process, not via member policies.
drop policy if exists "automation_events_select_members" on public.automation_events;
create policy "automation_events_select_members" on public.automation_events for select
  using (public.is_workspace_member(automation_events.workspace_id));

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
      coalesce(v_email, 'visitor-' || encode(gen_random_bytes(8), 'hex') || '@widget.local')
    )
    returning id into v_customer_id;
  end if;

  insert into public.conversations (workspace_id, customer_id)
  values (v_settings.workspace_id, v_customer_id)
  returning id into v_conversation_id;

  v_token := encode(gen_random_bytes(32), 'hex');

  insert into public.widget_visitor_sessions
    (workspace_id, widget_settings_id, visitor_token_hash, customer_id, conversation_id, expires_at)
  values (
    v_settings.workspace_id,
    v_settings.id,
    encode(digest(v_token, 'sha256'), 'hex'),
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
  where widget_visitor_sessions.visitor_token_hash = encode(digest(p_token, 'sha256'), 'hex')
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
  where s.visitor_token_hash = encode(digest(p_token, 'sha256'), 'hex')
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
